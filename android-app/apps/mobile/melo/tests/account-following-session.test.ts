import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import {
	AccountFollowingSession,
	parseAccountFollowings,
	readAccountFollowings,
	type AccountFollowingPageData,
} from '../account-following-session'
import { AccountSession, type AccountSnapshot } from '../account-session'
import { configureBilibiliAccountTransport } from '../bilibili'
import { CreatorStore } from '../core/creators'
import { migrate, type Database } from '../core/database'

const remote = (mid: number, name = `UP ${mid}`) => ({
	mid,
	uname: name,
	face: '',
	sign: '合成测试简介',
})
const page = (ids = [11, 12], pn = 1, total = ids.length) =>
	parseAccountFollowings({ list: ids.map((id) => remote(id)), total }, pn, 100)

function database() {
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
	return { raw, store: new CreatorStore(db) }
}
function account() {
	let state: AccountSnapshot = {
		status: 'authenticated',
		generation: 1,
		account: { mid: '88', name: '合成账号' },
		error: null,
		reason: null,
	}
	const listeners = new Set<() => void>()
	return {
		getSnapshot: () => state,
		getGeneration: () => state.generation,
		subscribe: (listener: () => void) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		change: (status: AccountSnapshot['status'], mid = '99') => {
			state = {
				...state,
				status,
				generation: state.generation + 1,
				account:
					status === 'authenticated' ? { mid, name: '另一个合成账号' } : null,
			}
			for (const listener of listeners) listener()
		},
		listeners,
	}
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

void test('关注响应保留 mid 身份，清理文本和头像；拒绝无效列表、分页与资料', () => {
	const parsed = parseAccountFollowings(
		{
			list: [
				{
					mid: '900719925474099312345',
					uname: '<b>同名 &amp; UP</b>',
					face: '//i0.hdslb.com/a.jpg',
					sign: '',
				},
			],
			total: 55,
		},
		1,
		123,
	)
	assert.equal(parsed.items[0].mid, '900719925474099312345')
	assert.equal(parsed.items[0].name, '同名 & UP')
	assert.equal(parsed.items[0].avatar, 'https://i0.hdslb.com/a.jpg')
	assert.equal(parsed.items[0].fetchedAt, 123)
	assert.equal(parsed.more, true)
	assert.deepEqual(
		parseAccountFollowings({ list: null, total: 0 }, 1, 0).items,
		[],
	)
	for (const value of [
		null,
		[],
		{ list: [], total: -1 },
		{ list: null, total: '1' },
		{ list: [remote(1)], total: 0 },
		{ list: [remote(1), remote(1)], total: 2 },
		{ list: [remote(0)], total: 1 },
		{ list: [{ ...remote(1), mid: Number.MAX_SAFE_INTEGER + 1 }], total: 1 },
		{ list: [{ ...remote(1), uname: ' ' }], total: 1 },
		{
			list: [{ ...remote(1), face: 'https://user:pass@example.com/image' }],
			total: 1,
		},
	])
		assert.throws(() => parseAccountFollowings(value, 1, 0))
	for (const pn of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
		assert.throws(() => parseAccountFollowings({ list: [], total: 0 }, pn, 0))
})

void test('读取复用账号传输且仅请求本人关注 GET；离线和退出后不读取', async () => {
	const requests: { url: string; method?: string }[] = []
	const session = new AccountSession({
		read: async () => null,
		write: async () => {},
		remove: async () => {},
		verify: async () => ({ mid: '88', name: '合成账号' }),
		setNativeCookie: () => {},
		setOfflineAccess: () => {},
		pause: async () => {},
		fetch: async (url, init) => {
			requests.push({ url, method: init.method })
			return new Response(
				JSON.stringify({ code: 0, data: { list: [remote(11)], total: 1 } }),
			)
		},
	})
	configureBilibiliAccountTransport({
		fetch: (url, init) => session.authorizedFetch(url, init),
		generation: session.getGeneration,
		expired: () => session.signOut('expired'),
	})
	await assert.rejects(
		readAccountFollowings(session, 1, new AbortController().signal),
	)
	assert.equal(requests.length, 0)
	await session.login('synthetic-test-cookie')
	assert.equal(
		(await readAccountFollowings(session, 1, new AbortController().signal))
			.items[0].mid,
		'11',
	)
	assert.equal(requests.length, 1)
	const url = new URL(requests[0].url)
	assert.equal(url.origin, 'https://api.bilibili.com')
	assert.equal(url.pathname, '/x/relation/followings')
	assert.equal(url.searchParams.get('vmid'), '88')
	assert.equal(url.searchParams.get('ps'), '50')
	assert.equal(requests[0].method, undefined)
	await session.signOut()
	await assert.rejects(
		readAccountFollowings(session, 1, new AbortController().signal),
	)
	assert.equal(requests.length, 1)
})

void test('打开、分页和取消均不写关注；默认全不选，确认后仅导入选择并保留原设置', async () => {
	const { raw, store } = database()
	const auth = account(),
		requests: number[] = []
	const session = new AccountFollowingSession(
		store,
		auth,
		async (_account, pn) => {
			requests.push(pn)
			return pn === 1 ? page([11, 12], 1, 51) : page([13], 2, 51)
		},
	)
	try {
		store.saveCreator({
			source: 'bilibili',
			mid: '12',
			name: '本地资料',
			fetchedAt: 200,
		})
		store.follow({
			profileId: 'local',
			creatorMid: '12',
			scope: 'listening',
			origin: 'manual',
		})
		assert.deepEqual(requests, [])
		await session.open()
		assert.deepEqual(session.getSnapshot().selectedMids, [])
		assert.equal(store.getCreator('11'), null)
		assert.equal(session.confirmImport(), 0)
		session.toggle('12')
		assert.deepEqual(session.getSnapshot().selectedMids, [])
		session.toggle('11')
		session.setScope('music')
		assert.equal(session.requestImport(), true)
		assert.equal(store.getSubscription('local', '11'), null)
		session.cancelReview()
		await session.loadMore()
		assert.deepEqual(requests, [1, 2])
		assert.deepEqual(session.getSnapshot().selectedMids, ['11'])
		session.toggle('13')
		assert.equal(session.requestImport(), true)
		assert.equal(session.getSnapshot().review?.items.length, 2)
		assert.equal(session.confirmImport(), 2)
		assert.equal(session.confirmImport(), 0)
		assert.equal(store.getSubscription('local', '11')?.origin, 'biliImport')
		assert.equal(store.getSubscription('local', '13')?.scope, 'music')
		assert.equal(store.getSubscription('local', '12')?.origin, 'manual')
		assert.equal(store.getSubscription('local', '12')?.scope, 'listening')
		assert.equal(store.getCreator('12')?.name, '本地资料')
		assert.equal(store.listSubscriptions('local').length, 3)
		assert.deepEqual(session.getSnapshot().selectedMids, [])
		session.close()
		assert.deepEqual(session.getSnapshot().items, [])
		assert.equal(auth.listeners.size, 0)
	} finally {
		session.close()
		raw.close()
	}
})

void test('请求失败可按原页重试，保留当前选择；关闭后晚响应不会重新打开或保存', async () => {
	const { raw, store } = database()
	const auth = account(),
		pending = deferred<AccountFollowingPageData>()
	let count = 0
	const session = new AccountFollowingSession(
		store,
		auth,
		async (_account, pn) => {
			count++
			if (count === 2) throw new Error('synthetic transport detail')
			if (count === 4) return pending.promise
			return page(pn === 1 ? [11] : [12], pn, 51)
		},
	)
	try {
		await session.open()
		session.toggle('11')
		await session.loadMore()
		assert.equal(session.getSnapshot().failedPage, 2)
		assert.deepEqual(session.getSnapshot().selectedMids, ['11'])
		assert.ok(!session.getSnapshot().error.includes('synthetic'))
		await session.retry()
		assert.deepEqual(
			session.getSnapshot().items.map((item) => item.mid),
			['11', '12'],
		)
		const reopening = session.open()
		session.close()
		pending.resolve(page())
		await reopening
		assert.equal(session.getSnapshot().open, false)
		assert.deepEqual(session.getSnapshot().items, [])
		assert.deepEqual(store.listSubscriptions('local'), [])
	} finally {
		session.close()
		raw.close()
	}
})

void test('账号变更清除私有关系列表并取消请求，旧确认不能导入；离线不会请求', async () => {
	const { raw, store } = database()
	const auth = account(),
		pending = deferred<AccountFollowingPageData>()
	let calls = 0,
		signal: AbortSignal | undefined
	const session = new AccountFollowingSession(
		store,
		auth,
		async (_account, _page, activeSignal) => {
			calls++
			signal = activeSignal
			return calls === 1 ? page() : pending.promise
		},
	)
	try {
		await session.open()
		session.toggle('11')
		session.requestImport()
		auth.change('authenticated')
		assert.equal(session.confirmImport(), 0)
		assert.deepEqual(session.getSnapshot().items, [])
		assert.deepEqual(store.listSubscriptions('local'), [])
		const opening = session.open()
		auth.change('offline')
		assert.equal(signal?.aborted, true)
		pending.resolve(page())
		await opening
		assert.deepEqual(session.getSnapshot().items, [])
		await session.open()
		assert.equal(calls, 2)
		assert.match(session.getSnapshot().error, /联网核验/)
	} finally {
		session.close()
		raw.close()
	}
})

void test('本地保存部分失败如实报告，保留未完成选择供再次确认，已有关注不重复写', async () => {
	const { raw, store } = database()
	const session = new AccountFollowingSession(store, account(), async () =>
		page(),
	)
	try {
		await session.open()
		session.toggle('11')
		session.toggle('12')
		session.requestImport()
		raw.exec(
			"CREATE TRIGGER fail_follow BEFORE INSERT ON creator_subscriptions WHEN NEW.creatorMid = '12' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
		)
		assert.equal(session.confirmImport(), 1)
		assert.ok(store.getSubscription('local', '11'))
		assert.equal(store.getSubscription('local', '12'), null)
		assert.deepEqual(session.getSnapshot().selectedMids, ['12'])
		assert.match(session.getSnapshot().error, /已成功导入 1/)
		raw.exec('DROP TRIGGER fail_follow')
		session.requestImport()
		assert.equal(session.confirmImport(), 1)
		assert.equal(store.listSubscriptions('local').length, 2)
	} finally {
		session.close()
		raw.close()
	}
})
