import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parseExternalDirectoryUrl, DirectoryReadError } from '../external-directory'
import { PlaybackProgress } from '../playback-progress'

void test('extracts a mobile share with synthetic account identifiers without depending on its prose, rejects ambiguity and foreign hosts', () => {
	const url = 'https://y.music.163.com/m/playlist?id=1234567890&userid=9876543210&creatorId=9876543210'
	for (const share of [url, `分享示例用户创建的歌单「合成歌单」: ${url} (来自@网易云音乐)`, `任意说明\n（${url}）。`]) {
		assert.deepEqual(parseExternalDirectoryUrl(share), { provider: 'netease', originalPlaylistId: '1234567890' })
	}
	for (const share of [`${url} https://music.163.com/playlist?id=2`, 'https://y.music.163.com.evil/m/playlist?id=1', 'https://y.music.163.com/song?id=1'])
		assert.throws(() => parseExternalDirectoryUrl(share), DirectoryReadError)
})

void test('progress subscribers receive ticks without shell setters or redundant notifications', () => {
	const progress = new PlaybackProgress()
	let updates = 0, shellUpdates = 0
	const unsubscribe = progress.subscribe(() => updates++)
	const text = readFileSync(new URL('../player.ts', import.meta.url), 'utf8')
	const ast = ts.createSourceFile('player.ts', text, ts.ScriptTarget.Latest, true)
	let listener = ''
	function visit(node: ts.Node) {
		if (ts.isCallExpression(node) && node.arguments[0]?.getText(ast) === "'onPositionUpdate'") listener = node.arguments[1].getText(ast)
		ts.forEachChild(node, visit)
	}
	visit(ast)
	assert.ok(listener)
	const onTick = runInNewContext(ts.transpileModule(`(${listener})`, {}).outputText, {
		progress, setPosition: () => shellUpdates++, setDuration: () => shellUpdates++,
		lastSynced: { current: Date.now() }, periodicSyncPending: { current: false }, sync() {}, Date,
	}) as (event: { position: number; duration: number }) => void
	onTick({ position: 1.2, duration: 180 }); onTick({ position: 1.2, duration: 180 })
	assert.equal(updates, 1); assert.equal(shellUpdates, 0)
	assert.deepEqual(progress.getSnapshot(), { position: 1.2, duration: 180 })
	unsubscribe(); onTick({ position: 1.4, duration: 180 }); assert.equal(updates, 1)
})

void test('slow periodic snapshot reads never pile up on progress events; failed reads retry at bounded intervals', async () => {
	const ast = ts.createSourceFile('player.ts', readFileSync(new URL('../player.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
	let listener = ''
	function visit(node: ts.Node) {
		if (ts.isCallExpression(node) && node.arguments[0]?.getText(ast) === "'onPositionUpdate'") listener = node.arguments[1].getText(ast)
		ts.forEachChild(node, visit)
	}
	visit(ast)
	let now = 5000, reads = 0
	const completions: (() => void)[] = []
	const progress = new PlaybackProgress()
	const onTick = runInNewContext(ts.transpileModule(`(${listener})`, {}).outputText, {
		progress, lastSynced: { current: 0 }, periodicSyncPending: { current: false }, Date: { now: () => now },
		sync: () => { reads++; return new Promise<void>((resolve) => completions.push(resolve)) },
	}) as (event: { position: number; duration: number }) => void
	const tick = () => onTick({ position: now / 1000, duration: 300 })
	tick()
	for (now = 5100; now <= 20000; now += 100) tick()
	assert.equal(reads, 1)
	assert.equal(progress.getSnapshot().position, 20, 'progress keeps moving while the full read is pending')
	completions.shift()!()
	await new Promise((resolve) => setImmediate(resolve))
	now = 21000; tick()
	assert.equal(reads, 2)
	completions.shift()!()
	await new Promise((resolve) => setImmediate(resolve))
	for (now = 21100; now < 26000; now += 100) tick()
	assert.equal(reads, 2, 'a settled read without updating last-success time still observes backoff')
	now = 26000; tick()
	assert.equal(reads, 3)
	completions.shift()!()
})

void test('local/recent/likes collections return to their caller, library collections remain in library', () => {
	const text = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
	const ast = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
	let open = '', close = ''
	function visit(node: ts.Node) {
		if (ts.isFunctionDeclaration(node) && node.name?.text === 'openLibraryCollection') open = node.getText(ast)
		if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'closeLibraryCollection') close = node.initializer!.getText(ast)
		ts.forEachChild(node, visit)
	}
	visit(ast)
	for (const tab of ['home', 'profile', 'library']) for (const collection of ['local', 'recent', 'likes']) {
		let activeTab = tab, activeCollection = 'root', playlistClosed = false, listeningOpen = true
		const context = { tab, collectionOrigin: null as string | null, setCollectionOrigin: (value: string | null) => { context.collectionOrigin = value }, useCallback: (fn: unknown) => fn,
			setTab: (value: string) => { activeTab = value }, setLibraryCollection: (value: string) => { activeCollection = value },
			setListeningLibraryOpen: (value: boolean) => { listeningOpen = value }, playlists: { session: { close() { playlistClosed = true } } },
		}
		const actions = runInNewContext(ts.transpileModule(`${open}\n({open: openLibraryCollection, close: ${close}})`, {}).outputText, context)
		actions.open(collection); assert.equal(activeTab, 'library'); assert.equal(activeCollection, collection)
		assert.equal(listeningOpen, false); assert.equal(playlistClosed, true)
		actions.close(); assert.equal(activeTab, tab); assert.equal(activeCollection, 'root'); assert.equal(context.collectionOrigin, null)
	}
})
