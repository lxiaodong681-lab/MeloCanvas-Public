import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { CreatorStore, type Creator } from '../core/creators'
import { Library, migrate, type Database } from '../core/database'
import { sourceId, type Source } from '../core/model'
import {
	creatorFromSource,
	creatorMid,
	creatorSpaceUrl,
} from '../creator-selection'
import { CreatorSession } from '../creator-session'
import { selectListening } from '../listening-selection'
import type { ListeningVideo } from '../listening-source'
import {
	PlaybackIntent,
	playMusicIntent,
	type PlaybackRequest,
} from '../playback-intent'

import { preparationPort } from './playback-preparation-fixture'

const source = (uploaderId = 88, cid = 1): Source => ({
	id: sourceId('BV1vT411i7ET', cid),
	bvid: 'BV1vT411i7ET',
	cid,
	originalTitle: `音源${cid}`,
	uploader: '同昵称 UP',
	uploaderId,
	performer: null,
	artwork: 'https://example.com/video-cover.jpg',
	duration: 100,
	domain: 'unclassified',
	audioAvailability: 'unknown',
})
const cached: Creator = {
	source: 'bilibili',
	mid: '88',
	name: '缓存的新昵称',
	avatar: 'https://example.com/avatar.jpg',
	bio: '已知简介',
	fetchedAt: 999,
}
function setup() {
	const raw = new DatabaseSync(':memory:')
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
	migrate(db)
	const library = new Library(db),
		store = new CreatorStore(db)
	return { raw, library, store, session: new CreatorSession(store, library) }
}
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

void test('Source mid仅接受安全正整数，规范字符串空间URL不损失大mid且防路径/尾换行', () => {
	assert.equal(creatorMid(88), '88')
	assert.equal(
		creatorMid(Number.MAX_SAFE_INTEGER),
		String(Number.MAX_SAFE_INTEGER),
	)
	for (const bad of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
		assert.throws(() => creatorMid(bad), /可靠/)
	const known = creatorFromSource(source())
	assert.deepEqual(known, {
		source: 'bilibili',
		mid: '88',
		name: '同昵称 UP',
		fetchedAt: 0,
	})
	assert.equal(known.avatar, undefined)
	assert.throws(() => creatorFromSource({ ...source(), uploader: ' ' }), /昵称/)
	assert.equal(
		creatorSpaceUrl('900719925474099312345'),
		'https://space.bilibili.com/900719925474099312345',
	)
	for (const mid of ['0', '088', '88\n', ' 88', '+88', '88/foo', '88?x=1'])
		assert.throws(() => creatorSpaceUrl(mid), /无效/)
})

void test('本地音源按真实mid读取，保留分类/不同CID，昵称相同不混入；大字符串无误配', () => {
	const { raw, library } = setup()
	try {
		library.save(source(88, 2))
		library.save({ ...source(88, 1), domain: 'music' })
		library.setLiked(source(99, 3), true)
		assert.deepEqual(
			library.sourcesByUploader('88').map((item) => [item.cid, item.domain]),
			[
				[1, 'music'],
				[2, 'unclassified'],
			],
		)
		assert.deepEqual(library.sourcesByUploader('900719925474099312345'), [])
		for (const mid of ['0', '088', '88\n', '88 OR 1=1'])
			assert.throws(() => library.sourcesByUploader(mid), /无效/)
		assert.equal(library.likes()[0].uploaderId, 99)
	} finally {
		raw.close()
	}
})

void test('浏览不写关注，缓存资料优先于Source摘要；保存默认all且重复点击无第二条', () => {
	const { raw, library, store, session } = setup()
	try {
		store.saveCreator(cached)
		library.save(source())
		session.openSource(source())
		assert.deepEqual(session.getSnapshot().creator, cached)
		assert.equal(store.getSubscription('local', '88'), null)
		session.requestScope()
		assert.equal(session.getSnapshot().scopeForm, 'all')
		assert.equal(session.saveScope(), true)
		assert.equal(session.saveScope(), false)
		const subscription = store.getSubscription('local', '88')!
		assert.equal(subscription.scope, 'all')
		assert.equal(subscription.origin, 'manual')
		assert.equal(subscription.notifications, false)
		assert.equal(store.listSubscriptions('local').length, 1)
		assert.deepEqual(store.getCreator('88'), cached)
		session.requestScope()
		session.setScope('music')
		session.saveScope()
		assert.equal(store.getSubscription('local', '88')?.scope, 'music')
		session.requestScope()
		assert.equal(session.getSnapshot().scopeForm, 'music')
		session.setScope('listening')
		session.saveScope()
		assert.equal(store.getSubscription('local', '88')?.scope, 'listening')
		assert.equal(library.get(source().id)?.domain, 'unclassified')
		assert.equal(library.get(source().id)?.performer, null)
	} finally {
		raw.close()
	}
})

void test('首次摘要只在显式关注时保存，SQL失败保留范围供重试，不伪装关注成功', () => {
	const { raw, store, session } = setup()
	try {
		session.openSource(source())
		assert.equal(store.getCreator('88'), null)
		session.requestScope()
		session.setScope('listening')
		raw.exec(
			"CREATE TRIGGER fail_follow BEFORE INSERT ON creator_subscriptions BEGIN SELECT RAISE(ABORT,'write failed'); END",
		)
		assert.equal(session.saveScope(), false)
		assert.equal(session.getSnapshot().scopeForm, 'listening')
		assert.equal(session.getSnapshot().subscription, null)
		assert.match(session.getSnapshot().error, /write failed/)
		assert.equal(store.getSubscription('local', '88'), null)
		raw.exec('DROP TRIGGER fail_follow')
		assert.equal(session.saveScope(), true)
		assert.equal(store.getSubscription('local', '88')?.scope, 'listening')
		assert.equal(store.getCreator('88')?.avatar, undefined)
	} finally {
		raw.close()
	}
})

void test('关注已提交后刷新失败仍保留正确UP关系，新主页读失败不遗留旧UP操作对象', () => {
	const { raw, library, store, session } = setup()
	try {
		session.openSource(source())
		session.requestScope()
		const read = library.sourcesByUploader.bind(library)
		library.sourcesByUploader = () => {
			throw new Error('read failed after save')
		}
		assert.equal(session.saveScope(), true)
		assert.equal(session.getSnapshot().creator?.mid, '88')
		assert.equal(session.getSnapshot().subscription?.creatorMid, '88')
		assert.equal(session.getSnapshot().scopeForm, null)
		assert.match(session.getSnapshot().error, /read failed/)
		session.openSource(source(99))
		assert.equal(session.getSnapshot().creator?.mid, '99')
		assert.equal(session.getSnapshot().subscription, null)
		assert.deepEqual(session.getSnapshot().sources, [])
		assert.equal(session.getSnapshot().profileLoaded, false)
		session.requestUnfollow()
		assert.equal(session.unfollow(), false)
		session.requestScope()
		assert.equal(session.saveScope(), false)
		assert.ok(store.getSubscription('local', '88'))
		library.sourcesByUploader = read
		session.refresh()
		session.requestScope()
		session.saveScope()
		assert.ok(store.getSubscription('local', '99'))
		assert.equal(store.listSubscriptions('local').length, 2)
	} finally {
		raw.close()
	}
})

void test('取消仅删local关系，SQL失败可重试，喜欢/资料/其他profile保留', () => {
	const { raw, library, store, session } = setup()
	try {
		library.setLiked(source(), true)
		session.openSource(source())
		session.requestScope()
		session.saveScope()
		store.follow({
			profileId: 'other',
			creatorMid: '88',
			scope: 'music',
			origin: 'manual',
		})
		session.requestUnfollow()
		raw.exec(
			"CREATE TRIGGER fail_delete BEFORE DELETE ON creator_subscriptions BEGIN SELECT RAISE(ABORT,'delete failed'); END",
		)
		assert.equal(session.unfollow(), false)
		assert.equal(session.getSnapshot().unfollowConfirm, true)
		assert.ok(session.getSnapshot().subscription)
		raw.exec('DROP TRIGGER fail_delete')
		assert.equal(session.unfollow(), true)
		assert.equal(session.unfollow(), false)
		assert.equal(store.getSubscription('local', '88'), null)
		assert.ok(store.getSubscription('other', '88'))
		assert.ok(store.getCreator('88'))
		assert.equal(library.likes().length, 1)
	} finally {
		raw.close()
	}
})

void test('管理列表与大mid缓存主页可进入/返回并取消，原站地址保持字符串身份', async () => {
	const { raw, store, session } = setup()
	try {
		const mid = '900719925474099312345'
		store.saveCreator({ ...cached, mid })
		store.follow({
			profileId: 'local',
			creatorMid: mid,
			scope: 'all',
			origin: 'manual',
		})
		session.openFollowing()
		assert.equal(session.getSnapshot().following[0].creator.mid, mid)
		session.openProfile(mid)
		assert.equal(session.getSnapshot().creator?.mid, mid)
		assert.equal(session.getSnapshot().profileLoaded, true)
		assert.deepEqual(session.getSnapshot().sources, [])
		let url = ''
		await session.openSpace(async (value) => {
			url = value
		})
		assert.equal(url, `https://space.bilibili.com/${mid}`)
		session.requestUnfollow()
		session.unfollow()
		assert.equal(store.getSubscription('local', mid), null)
		session.back()
		assert.equal(session.getSnapshot().routes.at(-1)?.kind, 'following')
		assert.deepEqual(session.getSnapshot().following, [])
		session.back()
		assert.equal(session.getSnapshot().routes.length, 0)
	} finally {
		raw.close()
	}
})

void test('旧主页播放晚成功/晚失败不覆盖新主页或清除较新请求busy，返回后不弹回旧页', async () => {
	const { raw, session } = setup()
	try {
		session.openSource(source())
		const a = deferred<boolean>()
		let presented = 0
		let cancelled = 0
		const old = session.presentPlayback(
			() => a.promise,
			() => {
				presented++
			},
			() => {
				cancelled++
			},
		)
		session.openSource(source(99))
		assert.equal(cancelled, 1)
		const b = deferred<boolean>()
		const next = session.presentPlayback(
			() => b.promise,
			() => {
				presented++
			},
		)
		a.resolve(true)
		await old
		assert.equal(presented, 0)
		assert.equal(session.getSnapshot().creator?.mid, '99')
		assert.equal(session.getSnapshot().suspended, false)
		assert.equal(session.getSnapshot().playbackBusy, true)
		b.resolve(true)
		await next
		assert.equal(presented, 1)
		assert.equal(session.getSnapshot().suspended, true)
		session.resumeFromPlayer()
		assert.equal(session.getSnapshot().creator?.mid, '99')
		const failed = deferred<boolean>()
		const pending = session.presentPlayback(
			() => failed.promise,
			() => {
				presented++
			},
		)
		session.back()
		failed.reject(new Error('stale error'))
		await pending
		assert.equal(session.getSnapshot().routes.length, 0)
		assert.equal(session.getSnapshot().error, '')
		assert.equal(presented, 1)
	} finally {
		raw.close()
	}
})

void test('播放取消或失败保留主页，打开较新关注设置时旧播放不抢走表单', async () => {
	const { raw, session } = setup()
	try {
		session.openSource(source())
		let presented = false
		assert.equal(
			await session.presentPlayback(
				async () => false,
				() => {
					presented = true
				},
			),
			false,
		)
		assert.equal(session.getSnapshot().error, '')
		assert.equal(session.getSnapshot().suspended, false)
		await session.presentPlayback(
			async () => {
				throw new Error('audio failed')
			},
			() => {
				presented = true
			},
		)
		assert.match(session.getSnapshot().error, /audio failed/)
		assert.equal(presented, false)
		const request = deferred<boolean>()
		const pending = session.presentPlayback(
			() => request.promise,
			() => {
				presented = true
			},
		)
		session.requestScope()
		request.resolve(true)
		await pending
		assert.equal(session.getSnapshot().scopeForm, 'all')
		assert.equal(presented, false)
	} finally {
		raw.close()
	}
})

void test('外部空间打开晚失败不污染新UP，明确取消播放会取消当前预检且不报告错误', async () => {
	const { raw, session } = setup()
	try {
		session.openSource(source())
		const external = deferred<void>()
		const opening = session.openSpace(() => external.promise)
		session.openSource(source(99))
		external.reject(new Error('stale external error'))
		await opening
		assert.equal(session.getSnapshot().error, '')
		let cancelled = false,
			presented = false
		const request = deferred<boolean>()
		const playing = session.presentPlayback(
			() => request.promise,
			() => {
				presented = true
			},
			() => {
				cancelled = true
			},
		)
		session.cancelPlayback()
		assert.equal(cancelled, true)
		assert.equal(session.getSnapshot().playbackBusy, false)
		request.resolve(false)
		await playing
		assert.equal(presented, false)
		assert.equal(session.getSnapshot().error, '')
		assert.equal(session.getSnapshot().creator?.mid, '99')
	} finally {
		raw.close()
	}
})

for (const nextMode of ['music', 'listening'] as const) {
	void test(`旧UP离页只取消自己的request，不取消后来${nextMode}意图及其真实激活`, async () => {
		const { raw, session } = setup()
		try {
			const intent = new PlaybackIntent()
			const owned: { request: PlaybackRequest | null } = { request: null }
			const next: { request: PlaybackRequest | null } = { request: null }
			const oldSource = deferred<Source>(),
				newSource = deferred<Source>(),
				video = deferred<ListeningVideo>()
			const played: number[] = []
			let nativeCancels = 0
			const cancelNative = async () => {
				nativeCancels++
			}
			session.openSource(source())
			const creatorPlaying = session.presentPlayback(
				() =>
					playMusicIntent(intent, source(), {
						resolve: () => oldSource.promise,
						preparation: preparationPort(cancelNative),
						activate: async (value) => {
							played.push(value.cid)
							return true
						},
						onPending: () => {},
						onStarted: () => {},
						onRequest: (request) => {
							owned.request = request
						},
					}),
				() => {
					assert.fail('Old creator must not reopen its player')
				},
				() => {
					if (owned.request?.cancel()) void cancelNative()
				},
			)
			await Promise.resolve()
			const b = source(99, 2)
			let newer: Promise<unknown>
			if (nextMode === 'music') {
				newer = playMusicIntent(intent, b, {
					resolve: () => newSource.promise,
					preparation: preparationPort(cancelNative),
					activate: async (value) => {
						played.push(value.cid)
						return true
					},
					onPending: () => {},
					onStarted: () => {},
					onRequest: (request) => {
						next.request = request
					},
				})
			} else {
				// useListening begins this same owned request before its view-pages preflight.
				const request = intent.begin()
				next.request = request
				await cancelNative()
				newer = selectListening(b, request.signal, {
					load: () => video.promise,
					current: () => ({ mode: 'listening', playing: false }),
					confirm: async () => true,
					play: async (value) => {
						played.push(value.cid)
						return true
					},
				})
			}
			await Promise.resolve()
			const before = nativeCancels
			assert.equal(next.request?.isCurrent(), true)
			session.back()
			assert.equal(next.request?.isCurrent(), true)
			assert.equal(next.request?.signal.aborted, false)
			assert.equal(nativeCancels, before)
			oldSource.resolve(source())
			assert.equal(await creatorPlaying, false)
			newSource.resolve(b)
			video.resolve({
				bvid: b.bvid,
				title: b.originalTitle,
				uploader: b.uploader,
				parts: [{ source: b, page: 1, title: '真实分P' }],
			})
			assert.ok(await newer)
			assert.deepEqual(played, [2])
			assert.equal(session.getSnapshot().routes.length, 0)
		} finally {
			raw.close()
		}
	})
}
