import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	createAccountFavorites,
	createAccountFavoritesFetch,
} from '../account-favorites'
import type { AccountSnapshot } from '../account-session'
import { readBilibiliFavoritePage } from '../bilibili-favorite'
import { readBilibiliFavoriteFolders } from '../bilibili-favorite-folders'
import { readBilibiliFavoriteIndex } from '../bilibili-favorite-index'
import type { DirectoryFetch } from '../directory-http'

const signal = () => new AbortController().signal
const folders = {
	code: 0,
	data: {
		count: 1,
		list: [{ id: 123, title: '有权私有夹', media_count: 1, fav_state: 0 }],
	},
}
const contents = {
	code: 0,
	data: {
		info: { id: 123, title: '有权私有夹', media_count: 1 },
		has_more: false,
		medias: [
			{
				id: 1,
				type: 2,
				bvid: 'BV1vT411i7ET',
				title: '原视频',
				upper: { mid: 88, name: '原 UP' },
				duration: 200,
			},
		],
	},
}
const response = (value: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(value), init)
function account(
	fetcher: (input: string, init: RequestInit) => Promise<Response> = async (
		input,
	) => response(input.includes('/created/') ? folders : contents),
) {
	let state: AccountSnapshot = {
		status: 'authenticated',
		generation: 1,
		account: { mid: '88', name: '合成账号' },
		error: null,
		reason: null,
	}
	const listeners = new Set<() => void>()
	const calls: { input: string; init: RequestInit }[] = []
	const expired: ('expired' | undefined)[] = []
	const change = (status: AccountSnapshot['status'], mid = '99') => {
		state = {
			...state,
			generation: state.generation + 1,
			status,
			account:
				status === 'authenticated' ? { mid, name: '另一合成账号' } : null,
		}
		for (const listener of listeners) listener()
	}
	return {
		getSnapshot: () => state,
		getGeneration: () => state.generation,
		subscribe: (listener: () => void) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		authorizedFetch: async (input: string, init: RequestInit = {}) => {
			calls.push({ input, init })
			return fetcher(input, init)
		},
		signOut: async (reason?: 'expired') => {
			expired.push(reason)
			change('signed-out')
		},
		change,
		calls,
		expired,
		listeners,
	}
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
const requestInit = (): Parameters<DirectoryFetch>[1] => ({
	method: 'GET',
	headers: {},
	credentials: 'omit',
	redirect: 'error',
	signal: signal(),
})

void test('本人目录及私有内容只走账号授权边界，复用原解析和原条目，不自动保存', async () => {
	const auth = account(),
		port = createAccountFavorites(auth)
	assert.deepEqual(port.getIdentity(), {
		mid: '88',
		name: '合成账号',
		generation: 1,
	})
	const directory = await readBilibiliFavoriteFolders(
		{ userMid: '88' },
		port.folders,
	)
	assert.equal(directory.folders[0].title, '有权私有夹')
	assert.equal(directory.folders[0].favState, 0)
	const page = await readBilibiliFavoritePage(
		{ favoriteId: '123', page: 1 },
		port.page,
	)
	assert.equal(page.items[0].bvid, 'BV1vT411i7ET')
	assert.deepEqual(page.info, contents.data.info)
	assert.equal(auth.calls.length, 2)
	assert.equal(
		auth.calls[0].input,
		'https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=88',
	)
	assert.equal(
		auth.calls[1].input,
		'https://api.bilibili.com/x/v3/fav/resource/list?media_id=123&pn=1&ps=40',
	)
	for (const call of auth.calls) {
		assert.equal(call.init.method, 'GET')
		assert.equal(call.init.body, undefined)
		assert.equal(call.init.credentials, 'omit')
		assert.equal(call.init.redirect, 'error')
		assert.equal(new Headers(call.init.headers).has('Cookie'), false)
		assert.equal(new Headers(call.init.headers).has('Authorization'), false)
	}
	assert.equal(auth.listeners.size, 0)
})

void test('固定目录/详情/索引端点、本人mid和唯一query严格校验，拒绝外域/userinfo/其他path/重复或额外query/写入', async () => {
	const auth = account(),
		fetcher = createAccountFavoritesFetch(auth)
	const base = 'https://api.bilibili.com'
	for (const url of [
		`${base}/x/v3/fav/resource/ids`,
		`${base}/x/v3/fav/resource/ids?media_id=0`,
		`${base}/x/v3/fav/resource/ids?media_id=123&media_id=123`,
		`${base}/x/v3/fav/resource/ids?media_id=123&pn=1`,
		`${base}/x/v3/fav/resource/ids?media_id=123&ps=40`,
		`${base}/x/v3/fav/folder/created/list-all?up_mid=99`,
		`${base}/x/v3/fav/folder/created/list-all?up_mid=88&up_mid=88`,
		`${base}/x/v3/fav/folder/created/list-all?up_mid=88&extra=1`,
		`${base}/x/v3/fav/resource/list?media_id=123&pn=0&ps=40`,
		`${base}/x/v3/fav/resource/list?media_id=123&pn=01&ps=40`,
		`${base}/x/v3/fav/resource/list?media_id=123&pn=1%0A&ps=40`,
		`${base}/x/v3/fav/resource/list?media_id=123&pn=1.5&ps=40`,
		`${base}/x/v3/fav/resource/list?media_id=123&pn=126&ps=40`,
		`${base}/x/v3/fav/resource/list?media_id=123&pn=1&ps=20`,
		`${base}/x/v3/fav/resource/list?media_id=123&pn=1&ps=40&extra=1`,
		`${base}/x/v3/fav/resource/list?media_id=123&pn=1&pn=1`,
		`${base}/x/v3/fav/folder/add?up_mid=88`,
		`${base}/x/web-interface/nav`,
		`${base}/x/v3/fav/folder/created/list-all?up_mid=88#fragment`,
		'https://api.bilibili.com:444/x/v3/fav/folder/created/list-all?up_mid=88',
		'https://@api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=88',
		'https://user@api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=88',
		'https://passport.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=88',
		'https://other.invalid/x/v3/fav/folder/created/list-all?up_mid=88',
		'http://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=88',
	])
		await assert.rejects(fetcher(url, requestInit()), { code: 'invalid-input' })
	const url = `${base}/x/v3/fav/folder/created/list-all?up_mid=88`
	await assert.rejects(fetcher(url, { ...requestInit(), method: 'POST' }), {
		code: 'invalid-input',
	})
	await assert.rejects(fetcher(url, { ...requestInit(), body: '' }), {
		code: 'invalid-input',
	})
	await assert.rejects(
		fetcher(url, {
			...requestInit(),
			headers: { Authorization: 'synthetic-only' },
		}),
		{ code: 'invalid-input' },
	)
	assert.equal(auth.calls.length, 0)
})

void test('私有索引只通过同账号授权transport，固定query不添加Cookie，过期或换代不回退游客', async () => {
	const auth = account(async () => response({ code: 0, data: [{ id: 1, type: 2, bvid: 'BV1vT411i7ET' }] }))
	const port = createAccountFavorites(auth)
	const order = await readBilibiliFavoriteIndex({ favoriteId: '123' }, port.index!)
	assert.equal(order.items.length, 1)
	assert.equal(auth.calls[0].input, 'https://api.bilibili.com/x/v3/fav/resource/ids?media_id=123')
	assert.equal(new Headers(auth.calls[0].init.headers).has('Cookie'), false)
	auth.change('offline')
	await assert.rejects(readBilibiliFavoriteIndex({ favoriteId: '123' }, port.index!), (error: unknown) =>
		error instanceof Error && /联网核验/.test(error.message))
	assert.equal(auth.calls.length, 1)
	const expired = account(async () => response({ code: -101, data: [] }))
	await assert.rejects(readBilibiliFavoriteIndex({ favoriteId: '123' }, createAccountFavorites(expired).index!))
	assert.deepEqual(expired.expired, ['expired'])
	assert.equal(expired.calls.length, 1)
	const slow = deferred<Response>()
	const changed = account(() => slow.promise)
	const stale = readBilibiliFavoriteIndex({ favoriteId: '123' }, createAccountFavorites(changed).index!)
	changed.change('authenticated')
	slow.resolve(response({ code: 0, data: [{ id: 1, type: 2 }] }))
	await assert.rejects(stale, (error: unknown) => error instanceof Error && /变更|取消/.test(error.message))
	assert.equal(changed.calls.length, 1)
})

void test('离线/退出请求前阻断；换号中止未结算请求并丢弃晚到正文', async () => {
	const pending = deferred<Response>(),
		auth = account(() => pending.promise),
		port = createAccountFavorites(auth)
	const reading = readBilibiliFavoriteFolders({ userMid: '88' }, port.folders)
	auth.change('authenticated')
	assert.equal(auth.calls[0].init.signal?.aborted, true)
	pending.resolve(response(folders))
	await assert.rejects(reading, { code: 'cancelled' })
	assert.equal(auth.listeners.size, 0)
	auth.change('offline')
	assert.equal(port.getIdentity(), null)
	await assert.rejects(
		readBilibiliFavoriteFolders({ userMid: '99' }, port.folders),
		{ code: 'permission' },
	)
	auth.change('signed-out')
	await assert.rejects(
		readBilibiliFavoritePage({ favoriteId: '123', page: 1 }, port.page),
		{ code: 'permission' },
	)
	assert.equal(auth.calls.length, 1)
})

void test('读取正文期间退出仍拒绝晚正文，调用者取消与账号变更共同生效', async () => {
	const text = deferred<string>()
	const auth = account(async () => {
		const value = response(folders)
		value.text = () => text.promise
		return value
	})
	const port = createAccountFavorites(auth),
		controller = new AbortController()
	const reading = readBilibiliFavoriteFolders(
		{ userMid: '88', signal: controller.signal },
		port.folders,
	)
	await new Promise((done) => setImmediate(done))
	controller.abort()
	auth.change('signed-out')
	text.resolve(JSON.stringify(folders))
	await assert.rejects(reading, { code: 'cancelled' })
	assert.equal(auth.calls[0].init.signal?.aborted, true)
	await new Promise((done) => setImmediate(done))
	assert.equal(auth.listeners.size, 0)
})

void test('HTTP401与平台-101按原账号边界失效；403/跳转/非法正文/超限不伪装为空目录', async () => {
	for (const value of [
		response({}, { status: 401 }),
		response({ code: -101, data: null }),
	]) {
		const auth = account(async () => value)
		await assert.rejects(
			readBilibiliFavoriteFolders(
				{ userMid: '88' },
				createAccountFavorites(auth).folders,
			),
			{ code: 'permission' },
		)
		assert.deepEqual(auth.expired, ['expired'])
		assert.equal(auth.getSnapshot().status, 'signed-out')
	}
	for (const [value, code] of [
		[response({}, { status: 403 }), 'permission'],
		[response({}, { status: 302 }), 'redirect'],
		[new Response('not-json'), 'response'],
		[response({ code: 0, data: null }), 'response'],
		[
			response(folders, {
				headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
			}),
			'limit',
		],
	] as const) {
		const auth = account(async () => value)
		await assert.rejects(
			readBilibiliFavoriteFolders(
				{ userMid: '88' },
				createAccountFavorites(auth).folders,
			),
			{ code },
		)
		assert.equal(auth.expired.length, 0)
	}
})
