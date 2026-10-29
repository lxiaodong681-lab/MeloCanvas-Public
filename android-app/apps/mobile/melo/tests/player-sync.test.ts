import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import type { PlaybackSnapshot } from '@bbplayer/orpheus'
import ts from 'typescript'

import type { Source } from '../core/model'
import { PlaybackIntent, playMusicIntent } from '../playback-intent'
import { RecommendationSession } from '../recommendation-session'

import { preparationPort } from './playback-preparation-fixture'

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
function harness() {
	let native = snapshot('new-queue', true, 160),
		current = true,
		reads = 0
	const ui = {
		playing: false,
		sourceId: '',
		queue: [] as string[],
		position: 0,
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
		},
		alive: { current: true },
		syncVersion: { current: 0 },
		operationVersion,
		fmContextRef: { current: null },
		lastSynced: { current: 0 },
		Date,
		Error,
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
		setSleepTimer() {},
		setDuration() {},
		setResumePoints() {},
		setCanReturnMusic() {},
		setNativePersistenceError() {},
		setAuditionId() {},
		setSyncError() {},
		setSyncCause() {},
		playbackError: (value: string) => value,
	}
	const compiled = ts.transpileModule(
		[
			code.get('apply'),
			code.get('sync'),
			code.get('operation'),
			`({operation,sync,event:${code.get('event')}})`,
		].join('\n'),
		{
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.None,
			},
		},
	).outputText
	const actions = runInNewContext(compiled, scope) as {
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

void test('actual operation cannot overwrite a newer playing event and sync while its token query waits', async () => {
	const h = harness(),
		waiting = deferred<boolean>(),
		entered = deferred<void>()
	let queries = 0
	h.query(() => {
		if (++queries === 1) {
			entered.resolve()
			return waiting.promise
		}
		return Promise.resolve(true)
	})
	const work = h.operation(async () => snapshot('new-queue', false, 157), {
		token: 7,
	})
	await entered.promise
	h.event({ status: true })
	await settle()
	assert.equal(h.ui.playing, true)
	waiting.resolve(true)
	assert.equal(await work, true)
	assert.equal(h.ui.playing, true)
	assert.equal(h.ui.position, 160)
	assert.equal(h.reads(), 2)
})

void test('a sync begun before commit may show the old queue; stale operation must refresh rather than merely skip its result', async () => {
	const h = harness(),
		action = deferred<PlaybackSnapshot>()
	h.native(snapshot('old-music', true, 80))
	const work = h.operation(() => action.promise, { token: 7 })
	await h.sync()
	assert.equal(h.ui.sourceId, 'old-music')
	h.native(snapshot('new-queue', true, 160))
	action.resolve(snapshot('new-queue', false, 157))
	assert.equal(await work, true)
	assert.equal(h.ui.sourceId, 'new-queue')
	assert.deepEqual(h.ui.queue, ['new-queue'])
	assert.equal(h.ui.playing, true)
	assert.equal(h.ui.position, 160)
})

void test('native control during the refresh invalidates the original operation and cannot report onStarted', async () => {
	const h = harness(),
		action = deferred<PlaybackSnapshot>(),
		refresh = deferred<PlaybackSnapshot>(),
		entered = deferred<void>()
	const work = h.operation(() => action.promise, { token: 7 })
	await h.sync()
	h.read(() => {
		entered.resolve()
		return refresh.promise
	})
	action.resolve(snapshot('new-queue', false, 157))
	await entered.promise
	h.invalidate()
	refresh.resolve(snapshot('new-queue', false, 160))
	let started = 0
	if (await work) started++
	assert.equal(started, 0)
	assert.equal(h.ui.playing, false)
})

void test('refresh failure retains the last successful UI and reports failure, never old result success', async () => {
	const h = harness(),
		action = deferred<PlaybackSnapshot>()
	const work = h.operation(() => action.promise, { token: 7 })
	await h.sync()
	h.read(async () => {
		throw new Error('native read failed')
	})
	action.resolve(snapshot('stale-queue', false, 157))
	assert.equal(await work, false)
	assert.equal(h.ui.sourceId, 'new-queue')
	assert.equal(h.ui.playing, true)
	assert.match(h.ui.error, /播放器连接失败/)
})

void test('the refresh keeps existing sync ordering: an older in-flight read cannot publish after it', async () => {
	const h = harness(),
		action = deferred<PlaybackSnapshot>(),
		oldSync = deferred<PlaybackSnapshot>()
	const work = h.operation(() => action.promise, { token: 7 })
	h.read(() => oldSync.promise)
	const earlier = h.sync()
	h.read(async () => snapshot('new-queue', true, 160))
	action.resolve(snapshot('new-queue', false, 157))
	assert.equal(await work, true)
	oldSync.resolve(snapshot('old-music', false, 80))
	await earlier
	assert.equal(h.ui.sourceId, 'new-queue')
	assert.equal(h.ui.playing, true)
})

void test('without intervening sync the current operation keeps the fast path and genuine current errors remain visible', async () => {
	const h = harness()
	assert.equal(
		await h.operation(async () => snapshot('new-queue', false, 157), {
			token: 7,
		}),
		true,
	)
	assert.equal(h.reads(), 0)
	assert.equal(h.ui.sourceId, 'new-queue')
	assert.equal(
		await h.operation(
			async () => {
				throw new Error('当前真实错误')
			},
			{ token: 7 },
		),
		false,
	)
	assert.equal(h.ui.error, '当前真实错误')
})

void test('refresh cannot succeed after unmount/new operation, while a successful superseding sync retains success', async () => {
	for (const invalidation of ['unmount', 'operation', 'sync'] as const) {
		const h = harness(),
			action = deferred<PlaybackSnapshot>(),
			refresh = deferred<PlaybackSnapshot>(),
			entered = deferred<void>()
		const work = h.operation(() => action.promise, { token: 7 })
		await h.sync()
		h.read(() => {
			entered.resolve()
			return refresh.promise
		})
		action.resolve(snapshot('earlier-result', false, 157))
		await entered.promise
		if (invalidation === 'unmount') h.unmount()
		else if (invalidation === 'operation') h.newOperation()
		else {
			h.read(async () => snapshot('latest-native', true, 180))
			await h.sync()
		}
		refresh.resolve(snapshot('earlier-refresh', false, 160))
		assert.equal(await work, invalidation === 'sync')
		if (invalidation === 'sync') {
			assert.equal(h.ui.sourceId, 'latest-native')
			assert.equal(h.ui.playing, true)
		}
	}
})

void test('actual intent and recommendation keep superseded read/rejection distinct from current failure and native cancellation', async () => {
	for (const resultKind of [
		'success',
		'superseded-error',
		'cancelled',
	] as const) {
		const cancelled = resultKind === 'cancelled'
		const source: Source = {
			id: 'bilibili:BV1vT411i7ET:11',
			bvid: 'BV1vT411i7ET',
			cid: 11,
			originalTitle: '本地歌曲',
			uploader: 'UP',
			uploaderId: 88,
			performer: null,
			artwork: '',
			duration: 300,
			domain: 'music',
			audioAvailability: 'unknown',
		}
		const value = {
			localDate: '2026-10-19',
			revision: 0,
			items: [{ source, reasons: ['liked' as const] }],
			canUndo: false,
		}
		const session = new RecommendationSession({
			load: () => value,
			refresh: () => value,
			dismiss: () => value,
			undo: () => value,
			restoreSource: () => value,
			resetLocalRecommendations: () => value,
			listDismissed: () => ({
				items: [],
				page: 1,
				pageSize: 20,
				total: 0,
				totalPages: 0,
			}),
		})
		session.open()
		const h = harness(),
			intent = new PlaybackIntent(),
			preparation = preparationPort()
		const action = deferred<PlaybackSnapshot>(),
			actionEntered = deferred<void>(),
			refresh = deferred<PlaybackSnapshot>(),
			refreshEntered = deferred<void>()
		let opened = 0
		const work = session.play(
			source.id,
			(item, own) =>
				playMusicIntent(intent, item, {
					preparation,
					resolve: async (selected) => selected,
					activate: (_, token) =>
						h.operation(() => {
							actionEntered.resolve()
							return action.promise
						}, token),
					onRequest: own,
					onPending() {},
					onStarted() {},
				}),
			() => {
				opened++
			},
		)
		await actionEntered.promise
		await h.sync()
		h.read(() => {
			refreshEntered.resolve()
			return refresh.promise
		})
		action.resolve(snapshot('new-queue', false, 157))
		await refreshEntered.promise
		h.read(async () => snapshot('latest-native', true, 180))
		await h.sync()
		if (cancelled) {
			await preparation.reservePlayback()
			h.invalidate()
		}
		if (resultKind === 'superseded-error')
			refresh.reject(new Error('obsolete read failed'))
		else refresh.resolve(snapshot('earlier-refresh', false, 160))
		assert.equal(await work, !cancelled)
		assert.equal(opened, cancelled ? 0 : 1)
		assert.equal(session.getSnapshot().playError, '')
		assert.equal(h.ui.error, '')
		assert.equal(h.ui.sourceId, 'latest-native')
	}
})

for (const invalidation of ['operation', 'native-token', 'unmount'] as const) {
	void test(`operation refresh rejection after ${invalidation} cannot publish an obsolete connection error`, async () => {
		const h = harness(),
			action = deferred<PlaybackSnapshot>(),
			refresh = deferred<PlaybackSnapshot>(),
			entered = deferred<void>()
		const work = h.operation(() => action.promise, { token: 7 })
		await h.sync()
		h.read(() => {
			entered.resolve()
			return refresh.promise
		})
		action.resolve(snapshot('stale-result', false, 157))
		await entered.promise
		if (invalidation === 'operation') h.newOperation()
		else if (invalidation === 'native-token') h.invalidate()
		else h.unmount()
		refresh.reject(new Error('obsolete refresh failed'))
		assert.equal(await work, false)
		assert.equal(h.ui.error, '')
		assert.equal(h.ui.sourceId, 'new-queue')
		assert.equal(h.ui.playing, true)
	})
}

void test('ordinary global sync still reports a current connection failure', async () => {
	const h = harness()
	h.read(async () => {
		throw new Error('current global read failed')
	})
	await h.sync()
	assert.match(h.ui.error, /播放器连接失败/)
})

for (const takeover of ['success', 'failure', 'none'] as const) {
	void test(`final token query cannot publish an old refresh error after sync takeover: ${takeover}`, async () => {
		const h = harness(),
			action = deferred<PlaybackSnapshot>(),
			refresh = deferred<PlaybackSnapshot>(),
			refreshEntered = deferred<void>(),
			query = deferred<boolean>(),
			queryEntered = deferred<void>()
		const oldError = new Error('old refresh failed'),
			latestError = new Error('latest global read failed')
		let queries = 0
		h.query(() => {
			if (++queries === 2) {
				queryEntered.resolve()
				return query.promise
			}
			return Promise.resolve(true)
		})
		const work = h.operation(() => action.promise, { token: 7 })
		await h.sync()
		h.read(() => {
			refreshEntered.resolve()
			return refresh.promise
		})
		action.resolve(snapshot('stale-result', false, 157))
		await refreshEntered.promise
		refresh.reject(oldError)
		await queryEntered.promise
		if (takeover === 'success') {
			h.read(async () => snapshot('latest-success', true, 180))
			await h.sync()
		} else if (takeover === 'failure') {
			h.read(async () => {
				throw latestError
			})
			await h.sync()
		}
		query.resolve(true)
		assert.equal(await work, takeover !== 'none')
		if (takeover === 'success') {
			assert.equal(h.ui.error, '')
			assert.equal(h.ui.errorCause, null)
			assert.equal(h.ui.sourceId, 'latest-success')
			assert.equal(h.ui.playing, true)
		} else {
			assert.match(h.ui.error, /播放器连接失败/)
			assert.equal(
				h.ui.errorCause,
				takeover === 'failure' ? latestError : oldError,
			)
		}
	})
}
