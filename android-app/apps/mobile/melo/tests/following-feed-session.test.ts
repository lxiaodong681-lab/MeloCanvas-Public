import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { FollowingFeedSession } from '../following-feed-session'
import { PlaybackIntent } from '../playback-intent'

import { feedFixture } from './following-feed-fixture'
import { preparationPort } from './playback-preparation-fixture'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
const settle = async () => {
	for (let index = 0; index < 30; index++) await Promise.resolve()
}

void test('actual Intent reserve rejection remains a visible current preparation failure rather than cancellation', async () => {
	const f = feedFixture(),
		intent = new PlaybackIntent(),
		failure = new Error('native reserve unavailable')
	try {
		f.session.open()
		assert.equal(
			await f.session.play(
				f.post.bvid,
				'music',
				(_item, _mode, own) =>
					intent.run({
						preparation: {
							reservePlayback: async () => {
								throw failure
							},
							isPreparationCurrent: async () => true,
							cancelPreparation: async () => {},
						},
						onRequest: own,
						prepare: async () => 1,
						activate: async () => true,
						onSuccess: () => assert.fail(),
					}),
				() => assert.fail(),
			),
			false,
		)
		assert.equal(f.session.getSnapshot().playError, failure.message)
		assert.equal(f.session.getSnapshot().playingBvid, null)
	} finally {
		f.raw.close()
	}
})

void test('closed feed performs no reads; open/filter use actual local eligibility without creating Sources or playback', () => {
	const f = feedFixture()
	try {
		assert.equal(f.reads(), 0)
		assert.equal(f.session.load(), false)
		assert.equal(f.reads(), 0)
		f.session.open()
		assert.equal(f.session.getSnapshot().snapshot!.items.length, 1)
		f.session.rememberScroll(125)
		f.session.setFilter('music')
		assert.equal(f.session.getSnapshot().snapshot!.status, 'filtered-empty')
		assert.equal(f.session.getScrollOffset(), 0)
		f.session.setFilter('all')
		assert.equal(f.session.getScrollOffset(), 125)
		assert.equal(f.raw.prepare('SELECT count(*) AS n FROM sources').get()!.n, 0)
		f.session.close()
		assert.equal(f.session.load(), false)
	} finally {
		f.raw.close()
	}
})

void test('play re-reads current subscriptions and cache; failed reads preserve last content but cannot activate it', async () => {
	const f = feedFixture()
	try {
		f.session.open()
		const first = f.session.getSnapshot().snapshot
		f.fail(new Error('SQLite read failed'))
		let activations = 0
		assert.equal(
			await f.session.play(
				f.post.bvid,
				'music',
				async () => {
					activations++
					return true
				},
				() => assert.fail(),
			),
			false,
		)
		assert.equal(activations, 0)
		assert.equal(f.session.getSnapshot().snapshot, first)
		assert.equal(f.session.getSnapshot().stale, true)
		f.fail(null)
		f.creators.unfollow('local', '88')
		assert.equal(
			await f.session.play(
				f.post.bvid,
				'listening',
				async () => {
					activations++
					return true
				},
				() => assert.fail(),
			),
			false,
		)
		assert.equal(activations, 0)
		assert.equal(f.session.getSnapshot().snapshot!.status, 'no-subscriptions')
		assert.match(f.session.getSnapshot().playError, /不在当前本地关注范围/)
	} finally {
		f.raw.close()
	}
})

void test('successful explicit playback receives the latest cached candidate; leaving later never cancels completed playback', async () => {
	const f = feedFixture(),
		intent = new PlaybackIntent(),
		port = preparationPort()
	try {
		f.session.open()
		f.cache.savePage(
			'88',
			{
				items: [{ ...f.post, title: '最新本地观察' }],
				page: 1,
				more: false,
				total: 1,
			},
			200,
			1,
		)
		let presented = 0,
			activeToken = 0
		assert.equal(
			await f.session.play(
				f.post.bvid,
				'music',
				(item, mode, own) =>
					intent.run({
						preparation: port,
						onRequest: own,
						prepare: async () => {
							assert.equal(item.post.title, '最新本地观察')
							assert.equal(mode, 'music')
							return item
						},
						activate: async (_item, preparation) => {
							activeToken = preparation.token
							return true
						},
						onSuccess: () => {},
					}),
				() => {
					presented++
				},
			),
			true,
		)
		assert.equal(presented, 1)
		f.session.pauseForOverlay()
		assert.equal(await port.isPreparationCurrent({ token: activeToken }), true)
		f.session.close()
		assert.equal(await port.isPreparationCurrent({ token: activeToken }), true)
	} finally {
		f.raw.close()
	}
})

for (const leave of ['close', 'filter', 'overlay', 'reload'] as const) {
	void test(`${leave} cancels only feed-owned pending metadata; late success cannot activate or reopen`, async () => {
		const f = feedFixture(),
			intent = new PlaybackIntent(),
			port = preparationPort(),
			metadata = deferred<number>()
		try {
			f.session.open()
			let activated = 0,
				opened = 0
			const work = f.session.play(
				f.post.bvid,
				'music',
				(_item, _mode, own) =>
					intent.run({
						preparation: port,
						onRequest: own,
						prepare: () => metadata.promise,
						activate: async () => {
							activated++
							return true
						},
						onSuccess: () => {},
					}),
				() => {
					opened++
				},
			)
			await settle()
			if (leave === 'close') f.session.close()
			if (leave === 'filter') f.session.setFilter('music')
			if (leave === 'overlay') f.session.pauseForOverlay()
			if (leave === 'reload') f.session.load()
			assert.equal(f.session.getSnapshot().playingBvid, null)
			metadata.resolve(1)
			assert.equal(await work, false)
			assert.equal(activated, 0)
			assert.equal(opened, 0)
			assert.equal(f.session.getSnapshot().playError, '')
		} finally {
			f.raw.close()
		}
	})
}

void test('opening an overlay cancels preparation, returning re-reads scope/cache locally and keeps browsing position', () => {
	const f = feedFixture()
	try {
		f.session.open()
		f.session.rememberScroll(350)
		f.session.pauseForOverlay()
		f.creators.updateScope('local', '88', 'music')
		const reads = f.reads()
		assert.equal(f.session.load(), false)
		f.session.resumeFromOverlay()
		assert.equal(f.reads(), reads + 1)
		assert.equal(f.session.getSnapshot().snapshot!.status, 'filtered-empty')
		assert.equal(f.session.getScrollOffset(), 350)
		f.session.resumeFromOverlay()
		assert.equal(f.reads(), reads + 1)
	} finally {
		f.raw.close()
	}
})

for (const activated of [true, false])
	void test(`native query rejection after ${activated ? 'success' : 'activation error'} settles without rejection or presentation`, async () => {
		const f = feedFixture(),
			intent = new PlaybackIntent()
		let failQuery = false,
			token = 0
		const port = {
			reservePlayback: async () => ({ token: ++token }),
			cancelPreparation: async () => {},
			isPreparationCurrent: async () => {
				if (failQuery) throw new Error('native bridge unavailable')
				return true
			},
		}
		try {
			f.session.open()
			let opened = 0
			const action = async (
				_item: unknown,
				_mode: unknown,
				own: Parameters<Parameters<FollowingFeedSession['play']>[2]>[2],
			) => {
				try {
					const result = await intent.run({
						preparation: port,
						onRequest: own,
						prepare: async () => 1,
						activate: async () => {
							if (!activated) throw new Error('original activation failed')
							return true
						},
						onSuccess: () => {},
					})
					failQuery = true
					return result
				} catch (error) {
					failQuery = true
					throw error
				}
			}
			assert.equal(
				await f.session.play(f.post.bvid, 'music', action, () => {
					opened++
				}),
				false,
			)
			assert.equal(opened, 0)
			assert.equal(f.session.getSnapshot().playingBvid, null)
			assert.match(f.session.getSnapshot().playError, /无法核对本次播放/)
		} finally {
			f.raw.close()
		}
	})

void test('late native ownership rejection after closing/reopening cannot publish into the new visit', async () => {
	const f = feedFixture(),
		query = deferred<boolean>(),
		entered = deferred<void>(),
		request = new PlaybackIntent().begin()
	request.checkCurrent = () => {
		entered.resolve()
		return query.promise
	}
	try {
		f.session.open()
		const work = f.session.play(
			f.post.bvid,
			'music',
			async (_item, _mode, own) => {
				own(request)
				return true
			},
			() => assert.fail(),
		)
		await entered.promise
		f.session.close()
		f.session.open()
		query.resolve(true)
		assert.equal(await work, false)
		assert.equal(f.session.getSnapshot().playError, '')
		assert.equal(f.session.getSnapshot().playingBvid, null)
	} finally {
		f.raw.close()
	}
})

void test('a newer real Intent retains its token when leaving an obsolete feed preparation; old activation failure stays cancelled', async () => {
	const f = feedFixture(),
		intent = new PlaybackIntent(),
		port = preparationPort(),
		metadata = deferred<number>()
	try {
		f.session.open()
		const old = f.session.play(
			f.post.bvid,
			'music',
			(_item, _mode, own) =>
				intent.run({
					preparation: port,
					onRequest: own,
					prepare: () => metadata.promise,
					activate: async () => {
						throw new Error('obsolete activation failure')
					},
					onSuccess: () => assert.fail(),
				}),
			() => assert.fail(),
		)
		await settle()
		let nextToken = 0
		assert.equal(
			await intent.run({
				preparation: port,
				prepare: async () => 1,
				activate: async (_value, reserved) => {
					nextToken = reserved.token
					return true
				},
				onSuccess: () => {},
			}),
			true,
		)
		f.session.close()
		metadata.resolve(1)
		assert.equal(await old, false)
		assert.equal(await port.isPreparationCurrent({ token: nextToken }), true)
		assert.equal(f.session.getSnapshot().playError, '')
	} finally {
		f.raw.close()
	}
})

void test('native-only invalidation of a real Intent suppresses an obsolete metadata failure without hiding current errors', async () => {
	const f = feedFixture(),
		intent = new PlaybackIntent()
	let token = 0,
		reject!: (cause: Error) => void
	const metadata = new Promise<number>((_resolve, fail) => {
		reject = fail
	})
	const port = {
		reservePlayback: async () => ({ token: ++token }),
		isPreparationCurrent: async (value: { token: number }) =>
			value.token === token,
		cancelPreparation: async (value: { token: number }) => {
			if (value.token === token) token++
		},
	}
	try {
		f.session.open()
		const old = f.session.play(
			f.post.bvid,
			'music',
			(_item, _mode, own) =>
				intent.run({
					preparation: port,
					onRequest: own,
					prepare: () => metadata,
					activate: async () => true,
					onSuccess: () => assert.fail(),
				}),
			() => assert.fail(),
		)
		await settle()
		token++
		reject(new Error('old network failure'))
		assert.equal(await old, false)
		assert.equal(f.session.getSnapshot().playError, '')
		const cause = new Error('current metadata failure')
		assert.equal(
			await f.session.play(
				f.post.bvid,
				'music',
				(_item, _mode, own) =>
					intent.run({
						preparation: port,
						onRequest: own,
						prepare: async () => {
							throw cause
						},
						activate: async () => true,
						onSuccess: () => assert.fail(),
					}),
				() => assert.fail(),
			),
			false,
		)
		assert.equal(f.session.getSnapshot().playError, cause.message)
	} finally {
		f.raw.close()
	}
})
