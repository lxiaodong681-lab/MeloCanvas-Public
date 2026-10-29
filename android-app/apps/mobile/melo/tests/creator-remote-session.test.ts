import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { BilibiliContentScopeReader } from '../core/bilibili-content-scope'
import { CreatorPostCache } from '../core/creator-post-cache'
import { CreatorStore, type Creator } from '../core/creators'
import { Library, migrate, type Database } from '../core/database'
import type { CreatorPostCandidate } from '../creator-api'
import {
	resolveCreatorPost,
	verifyCreatorPost,
} from '../creator-post-selection'
import { CreatorRemoteSession } from '../creator-remote-session'
import {
	creatorSearchTarget,
	creatorSearchView,
} from '../creator-search-selection'
import { CreatorSearchSession } from '../creator-search-session'
import { CreatorSession } from '../creator-session'
import { selectListening } from '../listening-selection'
import { parseListeningVideo, type ListeningVideo } from '../listening-source'
import { PlaybackIntent, playMusicIntent } from '../playback-intent'

import { preparationPort } from './playback-preparation-fixture'

const creator = (mid = '88', fetchedAt = 100): Creator => ({
	source: 'bilibili',
	mid,
	name: `UP${mid}`,
	avatar: 'https://example.com/avatar.jpg',
	bio: '真实资料',
	fetchedAt,
})
const post = (
	bvid = 'BV1vT411i7ET',
	queryCreatorMid = '88',
): CreatorPostCandidate => ({
	bvid,
	queryCreatorMid,
	title: '平台投稿',
	artwork: 'https://example.com/post.jpg',
	duration: 60,
	publishedAt: 1700000000000,
})
const nextPost = post('BV11UBfBMEfQ')
const video = (owner = 99, bvid = post().bvid): ListeningVideo =>
	parseListeningVideo(
		{
			bvid,
			title: '原视频真实标题',
			pic: 'https://example.com/view.jpg',
			owner: { mid: owner, name: `真正UP${owner}` },
			videos: 1,
			pages: [{ cid: 101, page: 1, part: '真实分P', duration: 61 }],
		},
		bvid,
	)
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
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
	const store = new CreatorStore(db),
		library = new Library(db),
		local = new CreatorSession(store, library)
	return {
		raw,
		store,
		library,
		local,
		scopes: new BilibiliContentScopeReader(db),
		postCache: new CreatorPostCache(db),
	}
}

void test('UP分类复用严格准确视频解析，普通昵称/数字mid保持人搜索，坏链接不误查Source', () => {
	assert.equal(creatorSearchTarget('Aimer'), 'creator')
	assert.equal(creatorSearchTarget('1636034895'), 'creator')
	assert.equal(creatorSearchTarget('bv1vT411i7ET'), 'video')
	assert.equal(
		creatorSearchTarget('https://www.bilibili.com/video/BV1vT411i7ET?p=2'),
		'video',
	)
	for (const input of [
		'BV123',
		'https://bilibili.com.evil/video/BV1vT411i7ET',
		'https://evilbilibili.com/video/BV1vT411i7ET',
		'https://bilibili.com/space/88',
		'',
	])
		assert.throws(() => creatorSearchTarget(input))
})

void test('UP搜索旧成功/失败/旧finally不覆盖新词，取消切换保留已读取结果', async () => {
	const a = deferred<{ items: Creator[]; page: number; more: boolean }>(),
		b = deferred<{ items: Creator[]; page: number; more: boolean }>()
	const session = new CreatorSearchSession((keyword) =>
		keyword === 'old' ? a.promise : b.promise,
	)
	const old = session.find('old'),
		newer = session.find('new')
	assert.equal(session.getSnapshot().loading, true)
	a.reject(new Error('stale voucher'))
	await old
	assert.equal(session.getSnapshot().keyword, 'new')
	assert.equal(session.getSnapshot().error, '')
	assert.equal(session.getSnapshot().loading, true)
	b.resolve({ items: [creator('99', 0)], page: 1, more: false })
	await newer
	session.cancel()
	assert.equal(session.getSnapshot().items[0].mid, '99')
})

void test('UP搜索翻页失败保留旧页并重试原页，跨页按mid去重且重复点击不重复请求', async () => {
	const calls: number[] = []
	let fail = true
	const second = deferred<{ items: Creator[]; page: number; more: boolean }>()
	const session = new CreatorSearchSession(async (_keyword, page) => {
		calls.push(page)
		if (page === 1) return { items: [creator('88', 0)], page, more: true }
		if (fail) throw new Error('B 站游客请求需要风控验证，请稍后重试')
		return second.promise
	})
	await session.find('UP')
	await session.loadMore()
	assert.equal(session.getSnapshot().page, 1)
	assert.equal(session.getSnapshot().items.length, 1)
	assert.equal(session.getSnapshot().failedPage, 2)
	fail = false
	const retry = session.retry()
	await session.loadMore()
	second.resolve({
		items: [creator('88', 0), creator('99', 0)],
		page: 2,
		more: false,
	})
	await retry
	assert.deepEqual(calls, [1, 2, 2])
	assert.deepEqual(
		session.getSnapshot().items.map((item) => item.mid),
		['88', '99'],
	)
	assert.equal(session.getSnapshot().page, 2)
	await session.loadMore()
	assert.equal(calls.length, 3)
})

void test('UP搜索网络/真空/输入错误分别呈现，不自动重试；坏链接取消旧查询且不触网', async () => {
	let calls = 0
	const session = new CreatorSearchSession(async (_keyword, page) => {
		calls++
		if (calls === 1) throw new Error('HTTP 412')
		return { items: [], page, more: false }
	})
	await session.find('Aimer')
	assert.match(session.getSnapshot().error, /412/)
	assert.equal(calls, 1)
	await session.retry()
	assert.equal(session.getSnapshot().error, '')
	assert.deepEqual(session.getSnapshot().items, [])
	assert.equal(session.getSnapshot().page, 1)
	try {
		creatorSearchTarget('https://bilibili.com.evil/video/BV1vT411i7ET')
	} catch (error) {
		session.rejectInput('bad URL', error)
	}
	await session.retry()
	assert.equal(calls, 2)
	assert.equal(session.getSnapshot().failedPage, null)
	assert.ok(session.getSnapshot().error)
})

void test('首次搜索取消并非真实空结果，旧空回包无效；已完成空页和已加载列表可区分', async () => {
	const response = deferred<{ items: Creator[]; page: number; more: boolean }>()
	const session = new CreatorSearchSession(() => response.promise)
	assert.equal(creatorSearchView(session.getSnapshot()), 'prompt')
	const pending = session.find('UP')
	assert.equal(creatorSearchView(session.getSnapshot()), 'loading')
	session.cancel()
	assert.equal(creatorSearchView(session.getSnapshot()), 'interrupted')
	response.resolve({ items: [], page: 1, more: false })
	await pending
	assert.equal(creatorSearchView(session.getSnapshot()), 'interrupted')
	await session.find('UP')
	assert.equal(creatorSearchView(session.getSnapshot()), 'empty')
	const loaded = new CreatorSearchSession(async (_keyword, page) => ({
		items: [creator()],
		page,
		more: false,
	}))
	await loaded.find('UP')
	loaded.cancel()
	assert.equal(creatorSearchView(loaded.getSnapshot()), null)
	assert.equal(loaded.getSnapshot().items.length, 1)
})

void test('主页不自动联网，profile -352与posts412各自失败，本地资料关注音源仍完整', async () => {
	const { raw, store, library, local, postCache, scopes } = setup()
	try {
		const saved = creator()
		store.saveCreator(saved)
		const source = video(88).parts[0].source
		library.setLiked(source, true)
		local.openSummary({ ...saved, name: '旧搜索摘要', fetchedAt: 0 })
		local.requestScope()
		local.saveScope()
		let profileCalls = 0,
			postCalls = 0
		const remote = new CreatorRemoteSession(
			{
				profile: async () => {
					profileCalls++
					throw new Error('B 站错误：-352 风控校验失败')
				},
				posts: async () => {
					postCalls++
					throw new Error('HTTP 412')
				},
			},
			local.acceptProfile,
			postCache,
			scopes,
		)
		remote.select('88')
		assert.equal(profileCalls + postCalls, 0)
		await Promise.all([remote.refreshProfile(), remote.readPosts()])
		assert.match(remote.getSnapshot().profileError, /-352/)
		assert.match(remote.getSnapshot().postsError, /412/)
		assert.deepEqual(store.getCreator('88'), saved)
		assert.equal(local.getSnapshot().sources[0].id, source.id)
		assert.ok(store.getSubscription('local', '88'))
		assert.equal(library.likes().length, 1)
		assert.equal(profileCalls, 1)
		assert.equal(postCalls, 1)
		await remote.retryPosts()
		assert.equal(postCalls, 2)
	} finally {
		raw.close()
	}
})

void test('搜索摘要0不覆盖rich cache，只有真实资料成功落库；保存后本地读失败仍归属当前UP', async () => {
	const { raw, store, library, local, postCache, scopes } = setup()
	try {
		store.saveCreator(creator())
		local.openSummary({
			...creator(),
			name: '搜索昵称',
			avatar: undefined,
			bio: undefined,
			fetchedAt: 0,
		})
		assert.equal(local.getSnapshot().creator?.name, 'UP88')
		assert.equal(store.getCreator('88')?.fetchedAt, 100)
		const remote = new CreatorRemoteSession(
			{
				profile: async () => ({ ...creator('88', 200), name: '最新真实昵称' }),
				posts: async (_mid, page) => ({
					items: [],
					page,
					more: false,
					total: 0,
				}),
			},
			local.acceptProfile,
			postCache,
			scopes,
		)
		remote.select('88')
		library.sourcesByUploader = () => {
			throw new Error('local read failed after save')
		}
		await remote.refreshProfile()
		assert.equal(remote.getSnapshot().profileUpdated, true)
		assert.equal(remote.getSnapshot().profileError, '')
		assert.equal(local.getSnapshot().creator?.name, '最新真实昵称')
		assert.match(local.getSnapshot().error, /local read failed/)
		assert.equal(store.getCreator('88')?.fetchedAt, 200)
		assert.throws(
			() => local.acceptProfile({ ...creator(), fetchedAt: 0 }),
			/不匹配/,
		)
	} finally {
		raw.close()
	}
})

void test('离页再进同mid时旧profile/posts结果不能写缓存、覆盖新页或结束新loading', async () => {
	const { raw, store, local, postCache, scopes } = setup()
	try {
		local.openSummary(creator('88', 0))
		const oldProfile = deferred<Creator>(),
			freshProfile = deferred<Creator>()
		const oldPosts = deferred<{
				items: CreatorPostCandidate[]
				page: number
				more: boolean
				total: number
			}>(),
			freshPosts = deferred<{
				items: CreatorPostCandidate[]
				page: number
				more: boolean
				total: number
			}>()
		let p = 0,
			v = 0
		const remote = new CreatorRemoteSession(
			{
				profile: () => (++p === 1 ? oldProfile.promise : freshProfile.promise),
				posts: () => (++v === 1 ? oldPosts.promise : freshPosts.promise),
			},
			local.acceptProfile,
			postCache,
			scopes,
		)
		remote.select('88')
		const before = [remote.refreshProfile(), remote.readPosts()]
		remote.select(null)
		remote.select('88')
		const after = [remote.refreshProfile(), remote.readPosts()]
		oldProfile.resolve(creator('88', 999))
		oldPosts.resolve({ items: [nextPost], page: 1, more: false, total: 1 })
		await Promise.all(before)
		assert.equal(store.getCreator('88'), null)
		assert.equal(remote.getSnapshot().profileLoading, true)
		assert.equal(remote.getSnapshot().postsLoading, true)
		assert.deepEqual(remote.getSnapshot().posts, [])
		freshProfile.resolve(creator('88', 200))
		freshPosts.resolve({ items: [post()], page: 1, more: false, total: 1 })
		await Promise.all(after)
		assert.equal(store.getCreator('88')?.fetchedAt, 200)
		assert.equal(remote.getSnapshot().posts[0].bvid, post().bvid)
	} finally {
		raw.close()
	}
})

void test('切换另一UP后旧profile失败不覆盖新页，profile缓存SQL失败不丢rich旧值或伪称刷新成功', async () => {
	const { raw, store, local, postCache, scopes } = setup()
	try {
		store.saveCreator(creator('99'))
		local.openSummary(creator('88', 0))
		const old = deferred<Creator>()
		const remote = new CreatorRemoteSession(
			{
				profile: (mid) =>
					mid === '88' ? old.promise : Promise.resolve(creator('99', 200)),
				posts: async (_mid, page) => ({
					items: [],
					page,
					more: false,
					total: 0,
				}),
			},
			local.acceptProfile,
			postCache,
			scopes,
		)
		remote.select('88')
		const pending = remote.refreshProfile()
		local.openSummary(creator('99', 0))
		remote.select('99')
		old.reject(new Error('stale -352'))
		await pending
		assert.equal(remote.getSnapshot().profileError, '')
		raw.exec(
			"CREATE TRIGGER fail_profile BEFORE UPDATE ON creators BEGIN SELECT RAISE(ABORT,'cache write failed'); END",
		)
		await remote.refreshProfile()
		assert.match(remote.getSnapshot().profileError, /cache write failed/)
		assert.equal(remote.getSnapshot().profileUpdated, false)
		assert.equal(store.getCreator('99')?.fetchedAt, 100)
		assert.equal(local.getSnapshot().creator?.mid, '99')
	} finally {
		raw.close()
	}
})

void test('投稿分页失败原页重试、跨页去重、刷新失败保留已加载候选，不造Source', async () => {
	const { raw, library, local, postCache, scopes } = setup()
	try {
		const calls: number[] = []
		const firstPage = Array.from({ length: 30 }, (_, index) =>
			index === 0 ? post() : post(`BV${String(index).padStart(10, '0')}`),
		)
		let fail = false
		const remote = new CreatorRemoteSession(
			{
				profile: async () => creator(),
				posts: async (_mid, page) => {
					calls.push(page)
					if (fail) throw new Error('HTTP 412')
					return {
						items: page === 1 ? firstPage : [post(), nextPost],
						page,
						more: page === 1,
						total: 32,
					}
				},
			},
			local.acceptProfile,
			postCache,
			scopes,
		)
		remote.select('88')
		await remote.readPosts()
		fail = true
		await remote.loadMore()
		assert.equal(remote.getSnapshot().page, 1)
		assert.equal(remote.getSnapshot().posts.length, 30)
		assert.equal(remote.getSnapshot().failedPage, 2)
		fail = false
		await remote.retryPosts()
		assert.equal(remote.getSnapshot().page, 2)
		assert.deepEqual(
			remote.getSnapshot().posts.map((item) => item.bvid),
			[...firstPage.map((item) => item.bvid), nextPost.bvid],
		)
		assert.deepEqual(calls, [1, 2, 2])
		await remote.loadMore()
		assert.equal(calls.length, 3)
		fail = true
		await remote.readPosts()
		assert.equal(remote.getSnapshot().page, 2)
		assert.equal(remote.getSnapshot().posts.length, 31)
		assert.equal(remote.getSnapshot().failedPage, 1)
		assert.deepEqual(library.sourcesByUploader('88'), [])
		assert.equal(raw.prepare('SELECT count(*) AS n FROM sources').get()?.n, 0)
	} finally {
		raw.close()
	}
})

void test('投稿连续点击只发一次、坏query归属/错页拒绝且不推进游标', async (context) => {
	const { raw, postCache, scopes } = setup()
	context.after(() => raw.close())
	const response = deferred<{
		items: CreatorPostCandidate[]
		page: number
		more: boolean
		total: number
	}>()
	let calls = 0
	const remote = new CreatorRemoteSession(
		{
			profile: async () => creator(),
			posts: () => {
				calls++
				return response.promise
			},
		},
		() => {},
		postCache,
		scopes,
	)
	remote.select('88')
	const first = remote.readPosts()
	await remote.readPosts()
	assert.equal(calls, 1)
	response.resolve({
		items: [post(undefined, '99')],
		page: 1,
		more: false,
		total: 1,
	})
	await first
	assert.match(remote.getSnapshot().postsError, /分页异常/)
	assert.equal(remote.getSnapshot().page, 0)
	assert.deepEqual(remote.getSnapshot().posts, [])
})

void test('合作候选经view使用真实owner/标题/CID，queryMid不构造Source，显式owner冲突拒绝', async () => {
	const candidate = post(),
		actual = video(99)
	const source = await resolveCreatorPost(
		candidate,
		new AbortController().signal,
		async () => actual,
	)
	assert.equal(source.uploaderId, 99)
	assert.equal(source.originalTitle, '原视频真实标题')
	assert.equal(source.cid, 101)
	assert.equal(source.domain, 'unclassified')
	assert.equal(source.performer, null)
	assert.doesNotThrow(() =>
		verifyCreatorPost({ ...candidate, ownerMid: '99' }, actual),
	)
	assert.throws(
		() => verifyCreatorPost({ ...candidate, ownerMid: '88' }, actual),
		/资料已变化/,
	)
	assert.throws(
		() => verifyCreatorPost(candidate, video(99, nextPost.bvid)),
		/身份不匹配/,
	)
	assert.throws(
		() =>
			verifyCreatorPost(candidate, {
				...actual,
				parts: [{ ...actual.parts[0], source: { ...source, cid: 0 } }],
			}),
		/分 P/,
	)
	assert.throws(() => video(0), /上传者/)
})

void test('候选播放核验在音乐/听视频实际激活前完成，失败保留旧播放，取消晚view不激活', async () => {
	const played: number[] = []
	const intent = new PlaybackIntent()
	await assert.rejects(
		playMusicIntent(
			intent,
			{ ...post(), ownerMid: '88' },
			{
				resolve: (item, signal) =>
					resolveCreatorPost(item, signal, async () => video(99)),
				preparation: preparationPort(),
				activate: async (value) => {
					played.push(value.uploaderId)
					return true
				},
				onPending: () => {},
				onStarted: () => {},
			},
		),
		/资料已变化/,
	)
	assert.equal(played.length, 0)
	let confirmed = 0
	const selected = await selectListening(
		{ bvid: post().bvid },
		new AbortController().signal,
		{
			load: async () => {
				const loaded = video(99)
				verifyCreatorPost(post(), loaded)
				return loaded
			},
			current: () => ({ mode: 'music', playing: true }),
			confirm: async () => {
				confirmed++
				return true
			},
			play: async (value) => {
				played.push(value.uploaderId)
				return true
			},
		},
	)
	assert.equal(selected?.parts[0].source.uploaderId, 99)
	assert.equal(confirmed, 1)
	assert.deepEqual(played, [99])
	const late = deferred<ListeningVideo>()
	const pending = playMusicIntent(intent, post(), {
		resolve: (item, signal) =>
			resolveCreatorPost(item, signal, () => late.promise),
		preparation: preparationPort(),
		activate: async (value) => {
			played.push(value.uploaderId)
			return true
		},
		onPending: () => {},
		onStarted: () => {},
	})
	await Promise.resolve()
	intent.cancel()
	late.resolve(video(88))
	assert.equal(await pending, false)
	assert.deepEqual(played, [99])
})
