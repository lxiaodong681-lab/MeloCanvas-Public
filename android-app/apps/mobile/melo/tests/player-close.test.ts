import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import {
	BilibiliPreviewSession,
	type PreviewPlayerIdentity,
} from '../bilibili-preview-session'
import { parseListeningVideo } from '../listening-source'
import { PlaybackIntent } from '../playback-intent'

import { preparationPort } from './playback-preparation-fixture'

const video = parseListeningVideo(
	{
		bvid: 'BV1vT411i7ET',
		title: '原视频',
		owner: { mid: 88, name: 'UP' },
		pic: 'https://example.invalid/cover',
		pages: [{ page: 1, cid: 11, part: '真实P', duration: 200 }],
	},
	'BV1vT411i7ET',
)
const original: PreviewPlayerIdentity = {
	mode: 'listening',
	sourceId: video.parts[0].source.id,
	entryId: 'preview-entry',
}
const music: PreviewPlayerIdentity = {
	mode: 'music',
	sourceId: 'music-source',
	entryId: 'returned-music-entry',
}
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
async function settle() {
	for (let index = 0; index < 12; index++) await Promise.resolve()
}

/** Execute the App's real functions and hardware handler, with deterministic native/React ports. */
async function fixture() {
	const text = readFileSync(
		process.env.MELO_PLAYER_CLOSE_BASELINE ??
			new URL('../App.tsx', import.meta.url),
		'utf8',
	)
	const tree = ts.createSourceFile(
		'App.tsx',
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	const functions = new Map<string, string>()
	let hardware = ''
	function visit(node: ts.Node) {
		if (ts.isFunctionDeclaration(node) && node.name)
			functions.set(node.name.text, node.getText(tree))
		if (
			ts.isVariableDeclaration(node) &&
			node.initializer &&
			ts.isCallExpression(node.initializer) &&
			node.initializer.expression.getText(tree) === 'useCallback'
		)
			functions.set(
				node.name.getText(tree),
				`const ${node.name.getText(tree)} = ${node.initializer.arguments[0].getText(tree)}`,
			)
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(tree) === 'BackHandler.addEventListener'
		)
			hardware = node.arguments[1].getText(tree)
		ts.forEachChild(node, visit)
	}
	visit(tree)
	assert.ok(hardware)
	const playbackIntent = new PlaybackIntent(),
		notices: string[] = [],
		changes: boolean[] = []
	const preview = new BilibiliPreviewSession(() => {}),
		savedPreview = new BilibiliPreviewSession(() => {})
	const reads: ReturnType<typeof deferred<PreviewPlayerIdentity>>[] = []
	let returnActivation: Promise<boolean> = Promise.resolve(true)
	const context = {
		fullPlayer: true,
		sheet: null,
		playerReadingBack: { current: null as (() => boolean) | null },
		playerPresentation: { current: 0 },
		playbackIntent,
		biliImports: {
			state: { playback: { suspended: true } },
			session: { preview },
		},
		videoLibrary: {
			state: { playback: { suspended: false } },
			session: { preview: savedPreview },
		},
		imports: {
			state: { suspended: false },
			session: { resumeFromPlayer: () => true },
		},
		creators: {
			state: { suspended: false },
			session: { resumeFromPlayer: () => {} },
		},
		creatorPlayerReturn: { current: true },
		player: {
			...preparationPort(),
			auditionId: null,
			track: null,
			cancelPending: async () => {},
			returnToMusic: () => returnActivation,
		},
		readNativePlayerIdentity: () => {
			const read = deferred<PreviewPlayerIdentity>()
			reads.push(read)
			return read.promise
		},
		setNotice: (notice: string) => notices.push(notice),
		setFullPlayerState: (value: boolean) => {
			context.fullPlayer = value
			changes.push(value)
		},
		// Baseline has the raw React setter instead of the new thin presentation wrapper.
		setFullPlayer: (value: boolean) => {
			context.fullPlayer = value
			changes.push(value)
		},
	}
	const names = [
		'setFullPlayer',
		'closePlayer',
		'resumeBilibiliPlayer',
		'returnToMusic',
	]
	const code =
		names.map((name) => functions.get(name) ?? '').join('\n') +
		`\nglobalThis.actions = {closePlayer, returnToMusic, open: setFullPlayer, hardware: ${hardware}}`
	const compiled = ts.transpileModule(code, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.None,
		},
	}).outputText
	const actions = runInNewContext(compiled + '\nactions', context) as {
		closePlayer: () => Promise<void>
		returnToMusic: () => Promise<void>
		open: (value: boolean) => void
		hardware: () => boolean
	}
	const start = (entryId = original.entryId!) =>
		preview.play(
			video.parts[0].source,
			'listening',
			video,
			async (_, __, ___, own) => {
				own(playbackIntent.begin())
				return { ...original, entryId }
			},
		)
	await start()
	async function close(entry: 'button' | 'back') {
		if (entry === 'button') return actions.closePlayer()
		assert.equal(actions.hardware(), true)
	}
	return {
		context,
		actions,
		preview,
		savedPreview,
		reads,
		notices,
		changes,
		start,
		close,
		settle,
		activation: (value: Promise<boolean>) => {
			returnActivation = value
		},
		playbackIntent,
	}
}

void test('hardware Back first exits the player reading view without starting a player-close read', async () => {
	const f = await fixture()
	f.context.playerReadingBack.current = () => true
	assert.equal(f.actions.hardware(), true)
	assert.deepEqual(f.reads, [])
	assert.deepEqual(f.changes, [])
	assert.equal(f.context.fullPlayer, true)
})

for (const entry of ['button', 'back'] as const) {
	void test(`${entry}: stale close cannot collapse a newer return-to-music player`, async () => {
		const f = await fixture(),
			closing = f.close(entry)
		await f.actions.returnToMusic()
		await f.preview.observeCurrent(music, async () => music)
		assert.equal(f.preview.getSnapshot().suspended, false)
		f.reads[0].resolve(original)
		await closing
		await f.settle()
		assert.equal(f.context.fullPlayer, true)
		assert.deepEqual(f.notices, [])
		assert.deepEqual(f.changes, [true])
	})
	void test(`${entry}: a new playback intent revokes close immediately, before activation finishes`, async () => {
		const f = await fixture(),
			closing = f.close(entry),
			activation = deferred<boolean>()
		f.activation(activation.promise)
		const returning = f.actions.returnToMusic()
		await f.settle()
		f.reads[0].resolve(original)
		await closing
		await f.settle()
		assert.equal(f.context.fullPlayer, true)
		assert.deepEqual(f.notices, [])
		assert.deepEqual(f.changes, [])
		activation.resolve(true)
		await returning
		assert.deepEqual(f.changes, [true])
	})
	void test(`${entry}: a newer preview owns the player even before its React open callback`, async () => {
		const f = await fixture(),
			closing = f.close(entry)
		await f.start('new-preview-entry')
		f.reads[0].resolve(original)
		await closing
		await f.settle()
		assert.equal(f.preview.getSnapshot().suspended, true)
		assert.equal(f.context.fullPlayer, true)
		assert.deepEqual(f.notices, [])
		assert.deepEqual(f.changes, [])
	})
	void test(`${entry}: explicit reopen or a subsequently cancelled intent still revoke an old close`, async () => {
		for (const action of ['reopen', 'cancelled-intent'] as const) {
			const f = await fixture(),
				closing = f.close(entry)
			if (action === 'reopen') f.actions.open(true)
			else f.playbackIntent.begin().cancel()
			f.reads[0].resolve(original)
			await closing
			await f.settle()
			assert.equal(f.context.fullPlayer, true)
			assert.deepEqual(f.notices, [])
			assert.deepEqual(f.changes, action === 'reopen' ? [true] : [])
		}
	})
	void test(`${entry}: a later close and reopen invalidate both UI and error from the old check`, async () => {
		const f = await fixture(),
			older = f.close(entry),
			newer = f.close(entry)
		f.reads[1].resolve(original)
		await newer
		await f.settle()
		assert.equal(f.context.fullPlayer, false)
		f.actions.open(true)
		f.reads[0].reject(new Error('late old read failure'))
		await older
		await f.settle()
		assert.equal(f.context.fullPlayer, true)
		assert.deepEqual(f.changes, [false, true])
		assert.deepEqual(f.notices, [])
	})
	void test(`${entry}: current close still collapses on genuine native item change, but a read failure keeps the player`, async () => {
		const f = await fixture(),
			changed = f.close(entry)
		f.reads[0].resolve(music)
		await changed
		await f.settle()
		assert.equal(f.context.fullPlayer, false)
		const error = await fixture(),
			waiting = error.close(entry)
		error.reads[0].reject(new Error('native unavailable'))
		await waiting
		await error.settle()
		assert.equal(error.context.fullPlayer, true)
		assert.equal(error.notices.length, 1)
	})
	void test(`${entry}: existing external import and creator return routes remain intact`, async () => {
		for (const route of ['external', 'creator'] as const) {
			const f = await fixture()
			f.preview.cancel()
			f.context.biliImports.state.playback.suspended = false
			if (route === 'external') f.context.imports.state.suspended = true
			else f.context.creators.state.suspended = true
			await f.close(entry)
			await f.settle()
			assert.equal(f.context.fullPlayer, route === 'creator')
		}
	})
}

void test('intent capture is read-only and rejects null-to-new-to-null ABA through either cancellation API', () => {
	for (const cancel of ['intent', 'request'] as const) {
		const intent = new PlaybackIntent(),
			empty = intent.captureCurrent()
		assert.equal(empty(), true)
		const request = intent.begin(),
			active = intent.captureCurrent()
		assert.equal(request.isCurrent(), true)
		assert.equal(active(), true)
		if (cancel === 'intent') intent.cancel()
		else assert.equal(request.cancel(), true)
		assert.equal(empty(), false)
		assert.equal(active(), false)
		const current = intent.captureCurrent()
		assert.equal(request.cancel(), false)
		assert.equal(
			current(),
			true,
			'a stale request cancellation cannot revoke a newer capture',
		)
	}
})
