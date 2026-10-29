import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CreatorPostCacheResponse } from '../core/creator-post-cache'
import { FollowingFeedStore } from '../core/following-feed'

import {
	appFixture,
	deferred,
	fixture,
	flush,
	post,
	video,
} from './creator-post-filter-fixture'

void test('shared reader uses current explicit BV reviews for unfollowed UP, not Source domain, owner or one CID', (t) => {
	const f = fixture(t),
		items = Array.from({ length: 6 }, (_, index) => post(index + 1))
	f.save(items)
	f.classify([
		{ bvid: items[0].bvid, kind: 'song' },
		{ bvid: items[1].bvid, kind: 'musicCollection' },
		{ bvid: items[2].bvid, kind: 'audiobook' },
		{ bvid: items[3].bvid, kind: 'song' },
	])
	const conflicting = f.classify([
		{ bvid: items[3].bvid, kind: 'knowledge' },
		{ bvid: items[4].bvid, kind: 'unknown' },
	])
	f.library.save({ ...video(items[5]).parts[0].source, domain: 'music' })
	assert.equal(f.creators.listSubscriptions('local').length, 0)
	const before = f.raw.prepare('SELECT total_changes() n').get()!.n
	const scopes = f.scopes.load(items.map((item) => item.bvid))
	assert.deepEqual(
		items.map((item) => scopes.get(item.bvid)!.scope),
		['music', 'music', 'listening', 'unknown', 'unknown', 'unknown'],
	)
	assert.equal(f.raw.prepare('SELECT total_changes() n').get()!.n, before)
	f.imports.reviewContent(conflicting, 'e0', { kind: 'song' }, 2)
	assert.equal(
		f.scopes.load([items[3].bvid]).get(items[3].bvid)!.scope,
		'music',
		'no cross-call evidence cache',
	)
	f.creators.follow({
		profileId: 'local',
		creatorMid: '88',
		scope: 'all',
		origin: 'manual',
	})
	const feed = new FollowingFeedStore(f.db).load()
	for (const item of feed.items)
		assert.equal(
			item.contentScope,
			f.scopes.load([item.post.bvid]).get(item.post.bvid)!.scope,
		)
})

void test('reader load owns one read transaction; in-snapshot is non-nesting; failures keep original cause and permit another read', (t) => {
	const f = fixture(t),
		calls: string[] = [],
		exec = f.db.execSync.bind(f.db),
		all = f.db.getAllSync.bind(f.db)
	f.classify([{ bvid: post(1).bvid, kind: 'song' }])
	f.db.execSync = (sql) => {
		calls.push(sql)
		exec(sql)
	}
	f.scopes.load([post(1).bvid])
	assert.deepEqual(calls, ['BEGIN', 'COMMIT'])
	calls.length = 0
	f.db.execSync('BEGIN')
	assert.equal(
		f.scopes.readInSnapshot([post(1).bvid]).get(post(1).bvid)!.scope,
		'music',
	)
	f.db.execSync('COMMIT')
	assert.deepEqual(calls, ['BEGIN', 'COMMIT'])
	const failure = new Error('classification read failed'),
		before = f.raw.prepare('SELECT snapshotJson FROM import_tasks').all()
	f.db.getAllSync = () => {
		throw failure
	}
	f.db.execSync = (sql) => {
		exec(sql)
		if (sql === 'ROLLBACK') throw new Error('cleanup failed')
	}
	assert.throws(
		() => f.scopes.load([post(1).bvid]),
		(error) => error === failure,
	)
	f.db.getAllSync = all
	f.db.execSync = exec
	assert.equal(f.scopes.load([post(1).bvid]).get(post(1).bvid)!.scope, 'music')
	assert.deepEqual(
		f.raw.prepare('SELECT snapshotJson FROM import_tasks').all(),
		before,
	)
})

void test('remote local filters retain full cache/pagination, unknown only all, explicit next page and new visits reset', async (t) => {
	const f = fixture(t),
		items = Array.from({ length: 30 }, (_, index) => post(index + 1)),
		calls: number[] = []
	f.save(items, 31)
	f.classify([
		{ bvid: post(1).bvid, kind: 'song' },
		{ bvid: post(2).bvid, kind: 'musicCollection' },
		{ bvid: post(3).bvid, kind: 'knowledge' },
		{ bvid: post(31).bvid, kind: 'audiobook' },
	])
	f.api.posts = async (_mid, page) => {
		calls.push(page)
		return { items: [post(31)], page, total: 31, more: false }
	}
	const remote = f.remote()
	remote.select('88', {})
	assert.equal(remote.getSnapshot().visiblePosts.length, 30)
	remote.setPostFilter('music')
	assert.deepEqual(
		remote.getSnapshot().visiblePosts.map((item) => item.bvid),
		[post(1).bvid, post(2).bvid],
	)
	assert.equal(remote.getSnapshot().posts.length, 30)
	assert.equal(remote.getSnapshot().more, true)
	assert.deepEqual(calls, [])
	remote.setPostFilter('listening')
	await remote.loadMore()
	assert.deepEqual(calls, [2])
	assert.deepEqual(
		remote.getSnapshot().visiblePosts.map((item) => item.bvid),
		[post(3).bvid, post(31).bvid],
	)
	assert.equal(remote.getSnapshot().posts.length, 31)
	assert.equal(remote.getSnapshot().page, 2)
	assert.equal(remote.getSnapshot().more, false)
	remote.select('88', {})
	assert.equal(remote.getSnapshot().postFilter, 'all')
	assert.equal(remote.getSnapshot().visiblePosts.length, 31)
	assert.equal(f.creators.listSubscriptions('local').length, 0)
})

void test('unread/real-empty/filtered-empty stay distinct and classification failure cannot reverse committed cache success', async (t) => {
	const f = fixture(t),
		remote = f.remote()
	remote.select('88', {})
	assert.equal(remote.getSnapshot().page, 0)
	await remote.readPosts()
	assert.equal(remote.getSnapshot().page, 1)
	assert.equal(remote.getSnapshot().total, 0)
	assert.deepEqual(remote.getSnapshot().posts, [])
	f.save([post(1)])
	remote.setPostFilter('music')
	assert.equal(remote.getSnapshot().posts.length, 1)
	assert.equal(remote.getSnapshot().visiblePosts.length, 0)
	const load = f.scopes.load.bind(f.scopes)
	f.scopes.load = () => {
		throw new Error('local classification unavailable')
	}
	f.api.posts = async () => ({
		items: [post(2)],
		page: 1,
		total: 1,
		more: false,
	})
	await remote.readPosts()
	assert.equal(f.cache.load('88')!.pages[0].items[0].bvid, post(2).bvid)
	assert.equal(remote.getSnapshot().posts[0].bvid, post(2).bvid)
	assert.equal(remote.getSnapshot().cacheStatus, 'ready')
	assert.equal(remote.getSnapshot().cacheError, '')
	assert.equal(remote.getSnapshot().postsError, '')
	assert.match(
		remote.getSnapshot().filterError,
		/local classification unavailable/,
	)
	f.scopes.load = load
	f.classify([{ bvid: post(2).bvid, kind: 'song' }])
	assert.equal(remote.reloadPostsCache(), true)
	assert.equal(remote.getSnapshot().filterError, '')
	assert.equal(remote.getSnapshot().visiblePosts[0].bvid, post(2).bvid)
})

void test('filter changes while a page is pending filter its accepted rows, and old visit late pages cannot publish', async (t) => {
	const f = fixture(t),
		remote = f.remote(),
		pending = deferred<CreatorPostCacheResponse>()
	f.save([post(1)])
	f.classify([{ bvid: post(1).bvid, kind: 'song' }])
	f.api.posts = () => pending.promise
	remote.select('88', {})
	const reading = remote.readPosts()
	remote.setPostFilter('listening')
	pending.resolve({ items: [post(1)], page: 1, total: 1, more: false })
	await reading
	assert.equal(remote.getSnapshot().posts.length, 1)
	assert.equal(remote.getSnapshot().visiblePosts.length, 0)
	const late = deferred<CreatorPostCacheResponse>()
	f.api.posts = () => late.promise
	const old = remote.readPosts()
	remote.select('88', {})
	late.resolve({ items: [post(2)], page: 1, total: 1, more: false })
	await old
	assert.equal(remote.getSnapshot().posts[0].bvid, post(1).bvid)
	assert.equal(remote.getSnapshot().postFilter, 'all')
})

void test('actual App/hook/Intent music preparation is cancelled by filter without touching later playback; lost classification blocks activation', async (t) => {
	const f = fixture(t),
		loaded = deferred<ReturnType<typeof video>>()
	f.save([post(1)])
	const task = f.classify([{ bvid: post(1).bvid, kind: 'song' }])
	const h = appFixture(f, () => loaded.promise)
	t.after(h.dispose)
	h.render()(post(1), 'music')
	await flush()
	h.creators.remote.setPostFilter('music')
	loaded.resolve(video())
	assert.equal(await h.pending(), false)
	assert.deepEqual(h.activated, [])
	assert.deepEqual(h.presented, [])
	h.render()(post(1), 'music')
	assert.equal(await h.pending(), true)
	assert.deepEqual(h.activated, ['music'])
	h.creators.remote.setPostFilter('all')
	assert.deepEqual(
		h.activated,
		['music'],
		'filter does not stop completed playback',
	)
	h.creators.remote.setPostFilter('music')
	const late = deferred<ReturnType<typeof video>>(),
		other = appFixture(f, () => late.promise)
	t.after(other.dispose)
	other.creators.remote.setPostFilter('music')
	other.render()(post(1), 'music')
	await flush()
	f.imports.reviewContent(task, 'e0', { kind: 'knowledge' }, 1)
	late.resolve(video())
	assert.equal(await other.pending(), false)
	assert.deepEqual(other.activated, [])
	assert.match(other.creators.session.getSnapshot().error, /已不在当前本地筛选/)
})

void test('actual App/hook/selection rechecks after delayed listening confirmation and preserves valid one-play path', async (t) => {
	const f = fixture(t)
	f.save([post(1)])
	const task = f.classify([{ bvid: post(1).bvid, kind: 'knowledge' }])
	const h = appFixture(f)
	t.after(h.dispose)
	h.creators.remote.setPostFilter('listening')
	h.render()(post(1), 'listening')
	await flush()
	assert.equal(h.alerts.length, 1)
	f.imports.reviewContent(task, 'e0', { kind: 'song' }, 1)
	h.alerts[0].buttons[1].onPress()
	assert.equal(await h.pending(), false)
	assert.deepEqual(h.activated, [])
	assert.match(h.creators.session.getSnapshot().error, /已不在当前本地筛选/)
	f.imports.reviewContent(task, 'e0', { kind: 'knowledge' }, 2)
	h.render()(post(1), 'listening')
	await flush()
	h.alerts[1].buttons[1].onPress()
	assert.equal(await h.pending(), true)
	assert.deepEqual(h.activated, ['listening'])
	assert.deepEqual(h.presented, [true])
})

void test('actual listening optional final hook never runs for reject/dismiss/JS cancellation/native-stale preparations', async (t) => {
	const f = fixture(t),
		h = appFixture(f)
	t.after(h.dispose)
	let checked = 0,
		validated = 0
	for (const action of [
		'reject',
		'dismiss',
		'cancel',
		'native-stale',
	] as const) {
		const start = h.listening.start(post(1), {
			validateVideo: () => {
				validated++
			},
			validateBeforePlay: () => {
				checked++
			},
		})
		await flush()
		const alert = h.alerts.at(-1)!
		if (action === 'reject') alert.buttons[0].onPress()
		else if (action === 'dismiss') alert.options.onDismiss()
		else {
			if (action === 'cancel') h.intent.cancel()
			else await h.player.reservePlayback()
			alert.buttons[1].onPress()
		}
		assert.equal(await start, false)
	}
	assert.equal(validated, 4)
	assert.equal(checked, 0)
	assert.deepEqual(h.activated, [])
})

void test('fresh cache removal cannot make Sources or present stale old-visit callbacks', async (t) => {
	const f = fixture(t)
	f.save([post(1)])
	const h = appFixture(f)
	t.after(h.dispose)
	const oldCallback = h.render()
	h.creators.session.openSummary(f.profile)
	oldCallback(post(1), 'music')
	assert.equal(await h.pending(), false)
	assert.deepEqual(h.activated, [])
	f.save([post(2)])
	h.render()(post(1), 'music')
	assert.equal(await h.pending(), false)
	assert.deepEqual(h.activated, [])
	assert.equal(f.raw.prepare('SELECT count(*) n FROM sources').get()!.n, 0)
})

for (const mode of ['music', 'listening'] as const)
	void test(`actual App ${mode} revalidation retains the new cache's real optional owner check`, async (t) => {
		const f = fixture(t),
			loaded = deferred<ReturnType<typeof video>>()
		f.save([post(1)])
		const h = appFixture(f, () => loaded.promise)
		t.after(h.dispose)
		h.render()(post(1), mode)
		await flush()
		if (mode === 'music') {
			f.save([{ ...post(1), ownerMid: '77' }])
			loaded.resolve(video())
		} else {
			loaded.resolve(video())
			await flush()
			f.save([{ ...post(1), ownerMid: '77' }])
			h.alerts[0].buttons[1].onPress()
		}
		assert.equal(await h.pending(), false)
		assert.deepEqual(h.activated, [])
		assert.deepEqual(h.presented, [])
		assert.match(h.creators.session.getSnapshot().error, /上传者资料已变化/)
	})
