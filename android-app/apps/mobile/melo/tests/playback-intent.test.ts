import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Source } from '../core/model'
import { PlaybackIntent, playMusicIntent } from '../playback-intent'

import { preparationPort } from './playback-preparation-fixture'

async function settle() {
	for (let i = 0; i < 16; i++) await Promise.resolve()
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

void test('音乐A元信息晚于较新的听视频B返回时，A不能接管音频或打开页面', async () => {
	const intent = new PlaybackIntent()
	const metadataA = deferred<string>()
	const activated: string[] = []
	const opened: string[] = []
	let signalA: AbortSignal | undefined
	const musicA = intent.run({
		preparation: preparationPort(),
		prepare: (signal) => {
			signalA = signal
			return metadataA.promise
		},
		activate: async (source) => {
			activated.push(source)
			return true
		},
		onSuccess: (source) => opened.push(source),
	})
	await settle()
	const listeningB = intent.begin()
	activated.push('listening-B')
	metadataA.resolve('music-A')
	assert.equal(await musicA, false)
	assert.equal(signalA?.aborted, true)
	assert.equal(listeningB.isCurrent(), true)
	assert.deepEqual(activated, ['listening-B'])
	assert.deepEqual(opened, [])
})

void test('返回音乐与显式取消都会使尚未解析完的旧播放意图失效', async () => {
	for (const action of ['return', 'cancel']) {
		const intent = new PlaybackIntent()
		const old = deferred<string>()
		const activated: string[] = []
		const pending = intent.run({
			preparation: preparationPort(),
			prepare: () => old.promise,
			activate: async (value) => {
				activated.push(value)
				return true
			},
			onSuccess: () => {},
		})
		if (action === 'return')
			await intent.run({
				preparation: preparationPort(),
				prepare: async () => 'return-music',
				activate: async (value) => {
					activated.push(value)
					return true
				},
				onSuccess: () => {},
			})
		else intent.cancel()
		old.resolve('stale')
		assert.equal(await pending, false)
		assert.deepEqual(activated, action === 'return' ? ['return-music'] : [])
	}
})

void test('切换尚未完成时的新意图阻止旧成功回调，取消导致的迟到失败不报错', async () => {
	const intent = new PlaybackIntent()
	const activation = deferred<boolean>()
	let opened = false
	const pending = intent.run({
		preparation: preparationPort(),
		prepare: async () => 'music',
		activate: () => activation.promise,
		onSuccess: () => {
			opened = true
		},
	})
	await settle()
	intent.begin()
	activation.resolve(true)
	assert.equal(await pending, false)
	assert.equal(opened, false)
	const obsolete = deferred<string>()
	const failing = intent.run({
		preparation: preparationPort(),
		prepare: () => obsolete.promise,
		activate: async () => true,
		onSuccess: () => {},
	})
	await settle()
	intent.cancel()
	obsolete.reject(new Error('late network failure'))
	assert.equal(await failing, false)
})

void test('当前意图成功时回调一次，真正失败向调用方保留错误', async () => {
	const intent = new PlaybackIntent()
	const opened: string[] = []
	assert.equal(
		await intent.run({
			preparation: preparationPort(),
			prepare: async () => 'music',
			activate: async () => true,
			onSuccess: (value) => opened.push(value),
		}),
		true,
	)
	assert.deepEqual(opened, ['music'])
	await assert.rejects(
		intent.run({
			preparation: preparationPort(),
			prepare: async () => {
				throw new Error('offline')
			},
			activate: async () => true,
			onSuccess: () => {},
		}),
		/offline/,
	)
})

void test('音乐预解析的旧finally不会清掉较新请求busy，较新请求仍可完成', async () => {
	const sourceA: Source = {
		id: 'bilibili:BV1vT411i7ET:123',
		bvid: 'BV1vT411i7ET',
		cid: 123,
		originalTitle: 'A',
		uploader: 'UP',
		uploaderId: 8,
		performer: null,
		artwork: '',
		duration: 10,
		domain: 'unclassified',
		audioAvailability: 'unknown',
	}
	const sourceB: Source = {
		...sourceA,
		id: 'bilibili:BV1Ws4y1A7fS:456',
		bvid: 'BV1Ws4y1A7fS',
		cid: 456,
		originalTitle: 'B',
	}
	const pendingA = deferred<Source>()
	const pendingB = deferred<Source>()
	const intent = new PlaybackIntent()
	let busy = ''
	const played: string[] = []
	const actions = {
		resolve: (item: { bvid: string }) =>
			item.bvid === sourceA.bvid ? pendingA.promise : pendingB.promise,
		preparation: preparationPort(),
		activate: async (source: Source) => {
			played.push(source.id)
			return true
		},
		onPending: (bvid: string) => {
			busy = bvid
		},
		onStarted: () => {},
	}
	const first = playMusicIntent(intent, sourceA, actions)
	await settle()
	const second = playMusicIntent(intent, sourceB, actions)
	await settle()
	pendingA.resolve(sourceA)
	assert.equal(await first, false)
	assert.equal(busy, sourceB.bvid)
	assert.deepEqual(played, [])
	pendingB.resolve(sourceB)
	assert.equal(await second, true)
	assert.equal(busy, '')
	assert.deepEqual(played, [sourceB.id])
})

void test('owned finish releases metadata-failure pending without invalidating its token or replacing the original error', async () => {
	let generation = 0,
		pending: number | null = null,
		finishes = 0
	const failure = new Error('candidate SQL read failed')
	const port = {
		reservePlayback: async () => {
			pending = ++generation
			return { token: generation }
		},
		isPreparationCurrent: async ({ token }: { token: number }) =>
			token === generation,
		cancelPreparation: async ({ token }: { token: number }) => {
			if (token === generation) {
				generation++
				pending = null
			}
		},
		finishPreparation: async ({ token }: { token: number }) => {
			finishes++
			if (token === pending) pending = null
		},
	}
	await assert.rejects(
		new PlaybackIntent().run({
			preparation: port,
			prepare: async () => {
				throw failure
			},
			activate: async () => true,
			onSuccess: () => assert.fail('failure cannot start'),
		}),
		(error) => error === failure,
	)
	assert.equal(finishes, 1)
	assert.equal(pending, null)
	assert.equal(generation, 1)
	let opened = 0
	assert.equal(
		await new PlaybackIntent().run({
			preparation: port,
			prepare: async () => 1,
			activate: async () => true,
			onSuccess: () => {
				opened++
			},
		}),
		true,
	)
	assert.equal(opened, 1)
	assert.equal(pending, null)
	assert.equal(generation, 2)
})

void test('late owned finish cannot clear a newer reservation, and cleanup rejection cannot replace success or metadata error', async () => {
	const intent = new PlaybackIntent(),
		old = deferred<number>(),
		next = deferred<number>()
	let generation = 0,
		pending: number | null = null
	const port = {
		reservePlayback: async () => {
			pending = ++generation
			return { token: generation }
		},
		isPreparationCurrent: async ({ token }: { token: number }) =>
			token === generation,
		cancelPreparation: async ({ token }: { token: number }) => {
			if (token === generation) {
				generation++
				pending = null
			}
		},
		finishPreparation: async ({ token }: { token: number }) => {
			if (token === pending) pending = null
		},
	}
	const first = intent.run({
		preparation: port,
		prepare: () => old.promise,
		activate: async () => true,
		onSuccess: () => assert.fail('old request'),
	})
	await settle()
	const second = intent.run({
		preparation: port,
		prepare: () => next.promise,
		activate: async () => true,
		onSuccess: () => {},
	})
	await settle()
	const latest = pending
	old.resolve(1)
	assert.equal(await first, false)
	assert.equal(pending, latest)
	next.resolve(2)
	assert.equal(await second, true)
	assert.equal(pending, null)
	const failing = {
		...port,
		finishPreparation: async () => {
			throw new Error('cleanup failed')
		},
	}
	const failure = new Error('original prepare error')
	await assert.rejects(
		intent.run({
			preparation: failing,
			prepare: async () => {
				throw failure
			},
			activate: async () => true,
			onSuccess: () => {},
		}),
		(error) => error === failure,
	)
	assert.equal(
		await intent.run({
			preparation: failing,
			prepare: async () => 1,
			activate: async () => true,
			onSuccess: () => {},
		}),
		true,
	)
})

for (const outcome of ['success', 'error'] as const) {
	for (const takeover of ['new-request', 'native-cancel'] as const) {
		void test(`delayed finish then ${takeover} prevents old ${outcome} publication`, async () => {
			const intent = new PlaybackIntent(),
				release = deferred<void>(),
				entered = deferred<void>(),
				cause = new Error('old metadata failure')
			let generation = 0,
				finishes = 0
			const opened: number[] = []
			const port = {
				reservePlayback: async () => ({ token: ++generation }),
				isPreparationCurrent: async ({ token }: { token: number }) =>
					token === generation,
				cancelPreparation: async ({ token }: { token: number }) => {
					if (token === generation) generation++
				},
				finishPreparation: async () => {
					finishes++
					entered.resolve()
					await release.promise
				},
			}
			const work = intent
				.run({
					preparation: port,
					prepare: async () => {
						if (outcome === 'error') throw cause
						return 1
					},
					activate: async () => true,
					onSuccess: (value) => opened.push(value),
				})
				.then(
					(value) => ({ value }),
					(error) => ({ error }),
				)
			await entered.promise
			if (takeover === 'new-request') intent.begin()
			else generation++ // Native-only user control, without a new JS intent.
			release.resolve()
			assert.deepEqual(await work, { value: false })
			assert.deepEqual(opened, [])
			assert.equal(finishes, 1)
			let started = false
			assert.equal(
				await intent.run({
					preparation: port,
					prepare: async () => 2,
					activate: async () => true,
					onSuccess: () => {
						started = true
					},
				}),
				true,
			)
			assert.equal(started, true)
		})
	}
}

void test('current delayed finish preserves successful publication and the original failure even when cleanup rejects', async () => {
	for (const outcome of ['success', 'error'] as const) {
		const release = deferred<void>(),
			entered = deferred<void>(),
			original = new Error('current metadata failure')
		let opened = 0,
			finishes = 0
		const work = new PlaybackIntent()
			.run({
				preparation: {
					...preparationPort(),
					finishPreparation: async () => {
						finishes++
						entered.resolve()
						await release.promise
						throw new Error('cleanup failure')
					},
				},
				prepare: async () => {
					if (outcome === 'error') throw original
					return 1
				},
				activate: async () => true,
				onSuccess: () => {
					opened++
				},
			})
			.then(
				(value) => ({ value }),
				(error) => ({ error }),
			)
		await entered.promise
		assert.equal(opened, 0)
		release.resolve()
		assert.deepEqual(
			await work,
			outcome === 'success' ? { value: true } : { error: original },
		)
		assert.equal(opened, outcome === 'success' ? 1 : 0)
		assert.equal(finishes, 1)
	}
})
