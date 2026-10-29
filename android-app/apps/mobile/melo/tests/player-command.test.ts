import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import type { PlaybackSnapshot } from '@bbplayer/orpheus'
import ts from 'typescript'

import { playbackError } from '../core/model'

const text = readFileSync(new URL('../player.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile(
	'player.ts',
	text,
	ts.ScriptTarget.Latest,
	true,
)
const code = new Map<string, string>()
function visit(node: ts.Node) {
	if (ts.isFunctionDeclaration(node) && node.name)
		code.set(node.name.text, node.getText(tree))
	if (
		ts.isVariableDeclaration(node) &&
		['apply', 'sync'].includes(node.name.getText(tree)) &&
		node.initializer &&
		ts.isCallExpression(node.initializer)
	)
		code.set(
			node.name.getText(tree),
			`const ${node.name.getText(tree)} = ${node.initializer.arguments[0].getText(tree)}`,
		)
	if (
		ts.isCallExpression(node) &&
		node.expression.getText(tree) === 'Orpheus.addListener' &&
		ts.isStringLiteral(node.arguments[0]) &&
		node.arguments[0].text === 'onIsPlayingChanged'
	)
		code.set('event', node.arguments[1].getText(tree))
	ts.forEachChild(node, visit)
}
visit(tree)
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
async function settle() {
	for (let index = 0; index < 20; index++) await Promise.resolve()
}
const snapshot = (
	id: string,
	playing: boolean,
	positionSeconds = 100,
): PlaybackSnapshot => ({
	mode: 'listening',
	tracks: [{ id, title: id, url: 'orpheus://example' }],
	currentEntryId: id,
	currentSourceId: id,
	playing,
	positionSeconds,
	durationSeconds: 300,
	speed: 1.5,
	resumePoints: [],
	inactiveSession: null,
	updatedAt: 10,
})
function harness(formatError = (value: string) => value) {
	let native = snapshot('new-queue', true, 160),
		current = true,
		reads = 0
	const ui = {
		playing: false,
		sourceId: '',
		queue: [] as string[],
		position: 0,
		sleepTimer: undefined as PlaybackSnapshot['sleepTimer'],
		error: '',
		errorCause: null as unknown,
	}
	let read = async () => structuredClone(native),
		query = async () => current
	const operationVersion = { current: 0 }
	const scope = {
		controller: {
			canReturnMusic: () => true,
			syncError: '',
			syncCause: null,
			sync: () => {
				reads++
				return read()
			},
			isPreparationCurrent: () => query(),
			finishPreparation: async () => {},
			reservePlayback: async () => ({ token: 8 }),
			cancelPending: async () => {},
		},
		alive: { current: true },
		syncVersion: { current: 0 },
		operationVersion,
		fmContextRef: { current: null },
		lastSynced: { current: 0 },
		Date,
		Error,
		setSleepTimer: (value: PlaybackSnapshot['sleepTimer']) => {
			ui.sleepTimer = value
		},
		setPlaying: (value: boolean) => {
			ui.playing = value
		},
		setPosition: (value: number) => {
			ui.position = value
		},
		setTrack: (value: { id: string } | null) => {
			ui.sourceId = value?.id ?? ''
		},
		setQueue: (value: { id: string }[]) => {
			ui.queue = Array.from(value, (item) => item.id)
		},
		setError: (value: string) => {
			ui.error = value
		},
		setErrorCause: (cause: unknown) => {
			ui.errorCause = cause
		},
		setSwitching() {},
		setMode() {},
		setFmContext() {},
		setSpeedState() {},
		setQueueIsSequential() {},
		setRepeatMode() {},
		progress: { update() {} },
		setShuffleEntryIds() {},
		setMusicQueueUndo() {},
		setDuration() {},
		setResumePoints() {},
		setCanReturnMusic() {},
		setNativePersistenceError() {},
		setAuditionId() {},
		setSyncError() {},
		setSyncCause() {},
		playbackError: formatError,
	}
	const compiled = ts.transpileModule(
		[
			code.get('apply'),
			code.get('sync'),
			code.get('operation'),
			code.get('command'),
			code.get('reservePlayback'),
			code.get('cancelPending'),
			`({operation,command,reservePlayback,cancelPending,sync,event:${code.get('event')}})`,
		].join('\n'),
		{
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.None,
			},
		},
	).outputText
	const actions = runInNewContext(compiled, scope) as {
		command: (action: () => Promise<void>) => Promise<void>
		reservePlayback: () => Promise<{ token: number }>
		cancelPending: () => Promise<void>
		operation: (
			action: () => Promise<PlaybackSnapshot>,
			preparation: { token: number },
		) => Promise<boolean>
		sync: () => Promise<unknown>
		event: (event: { status: boolean }) => void
	}
	return {
		...actions,
		ui,
		reads: () => reads,
		native: (value: PlaybackSnapshot) => {
			native = value
		},
		read: (value: typeof read) => {
			read = value
		},
		query: (value: typeof query) => {
			query = value
		},
		invalidate: () => {
			current = false
		},
		unmount: () => {
			scope.alive.current = false
		},
		newOperation: () => {
			operationVersion.current++
		},
	}
}

void test('a seek completing after selecting a new source does not start an obsolete refresh', async () => {
	const h = harness(),
		seek = deferred<void>()
	await h.sync()
	const work = h.command(() => seek.promise)
	await h.reservePlayback()
	const reads = h.reads()
	seek.resolve()
	await work
	assert.equal(h.reads(), reads)
	assert.equal(h.ui.sourceId, 'new-queue')
})
for (const outcome of ['success', 'failure'] as const) {
	void test(`a pending control refresh ${outcome} after cancelling or changing source cannot publish`, async () => {
		for (const takeover of ['cancel', 'reserve', 'unmount'] as const) {
			const h = harness(),
				refresh = deferred<PlaybackSnapshot>()
			await h.sync()
			const before = { ...h.ui, queue: [...h.ui.queue] }
			h.read(() => refresh.promise)
			const work = h.command(async () => {})
			await settle()
			if (takeover === 'cancel') await h.cancelPending()
			else if (takeover === 'reserve') await h.reservePlayback()
			else h.unmount()
			if (outcome === 'success')
				refresh.resolve(snapshot('obsolete-queue', false, 3))
			else refresh.reject(new Error('obsolete control refresh'))
			await work
			assert.deepEqual(h.ui, before)
		}
	})
}
void test('current control refresh still applies state and reports a genuine read failure', async () => {
	const h = harness()
	await h.command(async () => {})
	assert.equal(h.ui.sourceId, 'new-queue')
	assert.equal(h.ui.position, 160)
	assert.equal(h.ui.sleepTimer, null)
	const cause = new Error('current bridge read failed')
	h.read(async () => {
		throw cause
	})
	await h.command(async () => {})
	assert.match(h.ui.error, /播放器连接失败/)
	assert.equal(h.ui.errorCause, cause)
})
void test('obsolete rejected native control cannot overwrite a newer operation error', async () => {
	const h = harness(),
		action = deferred<void>()
	const old = h.command(() => action.promise)
	await h.operation(
		async () => {
			throw new Error('new playback failure')
		},
		{ token: 8 },
	)
	action.reject(new Error('old seek failure'))
	await old
	assert.equal(h.ui.error, 'new playback failure')
})

void test('native offline failure with Chinese detail uses the friendly message and retains its cause', async () => {
	const h = harness(playbackError)
	const cause = new Error("Call to function 'Orpheus.replacePlayback' has been rejected.\n→ Caused by: java.io.IOException: 离线内容缺失或不完整，请联网后重新保存")
	assert.equal(await h.operation(async () => { throw cause }, { token: 8 }), false)
	assert.equal(h.ui.error, '这首歌曲尚未完整下载，离线时无法播放。请联网后重新保存。')
	assert.equal(h.ui.errorCause, cause)
	assert.doesNotMatch(h.ui.error, /Orpheus|IOException|Caused by/)
	const localCause = new Error('本地播放记录无法读取，原记录已保留')
	await h.operation(async () => { throw localCause }, { token: 8 })
	assert.equal(h.ui.error, localCause.message)
})
