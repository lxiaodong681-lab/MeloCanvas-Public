import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	BilibiliFavoriteReadError,
	bilibiliFavoriteLimits,
	createBilibiliFavoriteTransport,
	readBilibiliFavoritePage,
	type BilibiliFavoriteInput,
	type FavoriteReadErrorCode,
} from '../bilibili-favorite'
import { DirectoryReadError } from '../external-directory'
import {
	createExternalDirectoryTransport,
	type DirectoryHttpResponse,
} from '../external-directory-transport'

const input: BilibiliFavoriteInput = { favoriteId: '123', page: 1 }
const encode = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value))
const media = (id: number | string = 1, overrides = {}) => ({
	id,
	type: 2,
	bvid: 'BV1vT411i7ET',
	title: '原视频标题',
	attr: 0,
	upper: {
		mid: '900719925474099312345',
		name: '原UP',
		face: 'https://example.invalid/image',
	},
	duration: 321,
	page: 3,
	pubdate: 123456,
	custom: { preserve: ['one', 'two'] },
	...overrides,
})
function page(items = [media()], total = items.length, more = false) {
	return {
		code: 0,
		message: '0',
		unknownEnvelope: { retained: true },
		data: {
			info: {
				id: '123',
				title: '原收藏夹',
				media_count: total,
				intro: '原简介',
				upper: { mid: 7, name: '原作者' },
				unknown: ['原字段'],
			},
			medias: items,
			has_more: more,
			ttl: 0,
			unknownData: { retained: true },
		},
	}
}
const read = (value: unknown, options: Partial<BilibiliFavoriteInput> = {}) =>
	readBilibiliFavoritePage({ ...input, ...options }, async () => encode(value))
const errorCode = (code: FavoriteReadErrorCode) => (error: unknown) =>
	error instanceof BilibiliFavoriteReadError && error.code === code
function response(
	url: string,
	chunks: Uint8Array[],
	extra: Partial<DirectoryHttpResponse> = {},
) {
	let reads = 0,
		cancels = 0,
		releases = 0
	return {
		get reads() {
			return reads
		},
		get cancels() {
			return cancels
		},
		get releases() {
			return releases
		},
		value: {
			status: 200,
			url,
			redirected: false,
			headers: { get: () => null },
			body: {
				getReader: () => ({
					read: async () =>
						reads < chunks.length
							? { done: false, value: chunks[reads++] }
							: { done: true },
					cancel: async () => {
						cancels++
					},
					releaseLock: () => {
						releases++
					},
				}),
			},
			...extra,
		} satisfies DirectoryHttpResponse,
	}
}

void test('fixed official GET performs exactly one explicit page request without cookie/bootstrap/view', async () => {
	let calls = 0
	const transport = createBilibiliFavoriteTransport(async (url, init) => {
		calls++
		assert.equal(
			url,
			'https://api.bilibili.com/x/v3/fav/resource/list?media_id=123&pn=2&ps=40',
		)
		assert.equal(init.method, 'GET')
		assert.equal(init.credentials, 'omit')
		assert.equal(init.redirect, 'error')
		assert.equal(init.body, undefined)
		assert(
			!Object.keys(init.headers).some((key) =>
				/cookie|authorization/i.test(key),
			),
		)
		return response(url, [
			encode(
				page(
					Array.from({ length: 40 }, (_, index) => media(index + 41)),
					81,
					true,
				),
			),
		]).value
	})
	const result = await readBilibiliFavoritePage(
		{ ...input, page: 2 },
		transport,
	)
	assert.equal(calls, 1)
	assert.equal(result.page, 2)
	assert.equal(result.pageSize, 40)
	assert.equal(result.reportedTotal, 81)
	assert.equal(result.hasMore, true)
	assert.equal(result.items.length, 40)
	assert.deepEqual(
		result.items.map((item) => item.pageIndex),
		Array.from({ length: 40 }, (_, index) => index),
	)
	assert(!('entries' in result))
	assert(!('taskId' in result))
	assert(!('cid' in result.items[0]))
})

void test('full and final pages reconcile counts but neither is a full favorite directory', async () => {
	const first = await read(
		page(
			Array.from({ length: 40 }, (_, index) => media(index + 1)),
			60,
			true,
		),
	)
	const last = await read(
		page(
			Array.from({ length: 20 }, (_, index) => media(index + 41)),
			60,
			false,
		),
		{ page: 2 },
	)
	assert.equal(first.items.length, 40)
	assert.equal(first.hasMore, true)
	assert.equal(last.items.length, 20)
	assert.equal(last.reportedTotal, 60)
	assert.equal(last.items[0].pageIndex, 0)
})

void test('only page1/explicit total0/empty array/no more is a true empty page', async () => {
	const empty = await read(page([], 0, false))
	assert.equal(empty.reportedTotal, 0)
	assert.equal(empty.hasMore, false)
	assert.deepEqual(empty.items, [])
	for (const value of [
		null,
		[],
		{},
		{ code: 0 },
		{ code: 0, data: null },
		{ code: 0, data: { info: null, medias: [], has_more: false } },
		{
			code: 0,
			data: { info: { id: 123, title: 'x' }, medias: [], has_more: false },
		},
		{
			code: 0,
			data: { info: { id: 123, title: 'x', media_count: 0 }, has_more: false },
		},
		{
			code: 0,
			data: {
				info: { id: 123, title: 'x', media_count: 0 },
				medias: null,
				has_more: false,
			},
		},
		{
			code: 0,
			data: {
				info: { id: 123, title: 'x', media_count: 0 },
				medias: [],
				has_more: 0,
			},
		},
	])
		await assert.rejects(read(value), errorCode('response'))
	await assert.rejects(read(page([], 0), { page: 2 }), errorCode('incomplete'))
})

void test('deleted, non-video, unknown media types and repeated occurrences retain raw original values', async () => {
	const original = [
		media(1, { attr: 9, title: '已失效视频', bvid: '' }),
		media(2, { type: 12, bvid: null }),
		media(2, { type: 21, bvid: undefined }),
		media(2, { type: 999, bvid: '' }),
		media(1),
	]
	const result = await read(page(original))
	assert.deepEqual(
		result.items.map((item) => [item.mediaIdentity, item.bvid]),
		[
			['2:1', null],
			['12:2', null],
			['21:2', null],
			['999:2', null],
			['2:1', 'BV1vT411i7ET'],
		],
	)
	assert.deepEqual(
		result.items.map((item) => item.original),
		JSON.parse(JSON.stringify(original)),
	)
	assert.equal(result.items.length, 5)
	assert.notEqual(result.items[0].pageIndex, result.items[4].pageIndex)
	for (const item of result.items) {
		assert(!('source' in item))
		assert(!('domain' in item))
		assert(!('playable' in item))
		assert(!('cid' in item))
	}
})

void test('all unknown envelope/info/data/item fields and original array order remain reconstructible', async () => {
	const original = page([media(2), media(1), media(2)])
	const result = await read(original)
	assert(!('data' in result.originalEnvelope))
	assert(!('info' in result.originalData))
	assert(!('medias' in result.originalData))
	assert.deepEqual(
		{
			...result.originalEnvelope,
			data: {
				...result.originalData,
				info: result.info,
				medias: result.items.map((item) => item.original),
			},
		},
		original,
	)
})

void test('canonical decimal string IDs preserve large identities, unsafe numbers and invalid identities fail', async () => {
	const large = '900719925474099312345',
		value = page([media(large)])
	value.data.info.id = large
	const result = await read(value, { favoriteId: large })
	assert.equal(result.favoriteId, large)
	assert.equal(result.items[0].mediaId, large)
	for (const item of [
		media(Number.MAX_SAFE_INTEGER + 1),
		media('01'),
		media(0),
		media(1, { type: 1.5 }),
		media(1, { type: 0 }),
		media(1, { bvid: 'invalid' }),
	])
		await assert.rejects(read(page([item])), errorCode('response'))
	await assert.rejects(
		read(page(), { favoriteId: '456' }),
		errorCode('response'),
	)
	for (const options of [
		{ favoriteId: '01' },
		{ favoriteId: '' },
		{ favoriteId: ' 123' },
		{ favoriteId: 'https://example.invalid/' },
		{ page: 0 },
		{ page: 126 },
		{ page: 1.5 },
	]) {
		let calls = 0
		await assert.rejects(
			readBilibiliFavoritePage({ ...input, ...options }, async () => {
				calls++
				return encode(page())
			}),
			errorCode('invalid-input'),
		)
		assert.equal(calls, 0)
	}
})

void test('platform codes and root/data vouchers fail once without exposing or saving challenge values', async () => {
	for (const value of [
		{ code: -101, data: null },
		{ code: -352 },
		{ code: -403 },
	])
		await assert.rejects(read(value), (error: unknown) => {
			assert(error instanceof BilibiliFavoriteReadError)
			assert.equal(error.code, 'platform')
			assert.equal(error.diagnostics.platformCode, value.code)
			assert.equal(error.partial, undefined)
			return true
		})
	for (const value of [
		{ code: 0, v_voucher: 'challenge-secret' },
		{ code: 0, data: { v_voucher: 'challenge-secret' } },
		{
			...page([], 0),
			data: { ...page([], 0).data, v_voucher: 'challenge-secret' },
		},
	]) {
		let calls = 0
		await assert.rejects(
			readBilibiliFavoritePage(input, async () => {
				calls++
				return encode(value)
			}),
			(error: unknown) => {
				assert(error instanceof BilibiliFavoriteReadError)
				assert.equal(error.code, 'restricted')
				assert.match(error.message, /风控验证/)
				assert(!JSON.stringify(error).includes('challenge-secret'))
				assert.equal(error.partial, undefined)
				return true
			},
		)
		assert.equal(calls, 1)
	}
	assert.deepEqual((await read({ ...page([], 0), v_voucher: '' })).items, [])
})

void test('pagination contradictions/out-of-range pages return bounded evidence, never genuine empty or automatic next page', async () => {
	for (const [value, currentPage] of [
		[page([], 3, false), 1],
		[page([media()], 1, true), 1],
		[
			page(
				Array.from({ length: 39 }, () => media()),
				80,
				true,
			),
			1,
		],
		[
			page(
				Array.from({ length: 40 }, () => media()),
				80,
				false,
			),
			1,
		],
		[page([], 40, false), 2],
		[page([media()], 1, false), 2],
	] as const) {
		let calls = 0
		await assert.rejects(
			readBilibiliFavoritePage({ ...input, page: currentPage }, async () => {
				calls++
				return encode(value)
			}),
			(error: unknown) => {
				assert(error instanceof BilibiliFavoriteReadError)
				assert.equal(error.code, 'incomplete')
				assert.deepEqual(error.partial?.originalData, value.data)
				assert.equal(error.partial?.page, currentPage)
				assert(!('items' in error.partial))
				return true
			},
		)
		assert.equal(calls, 1)
	}
})

void test('pagination mismatch explains only safe counts and next-page state, never response text or account details', async () => {
	for (const [received, total, more] of [
		[20, 83, true],
		[0, 83, false],
		[1, 0, false],
	] as const) {
		const value = page(
			Array.from({ length: received }, (_, index) =>
				media(index + 1, { title: 'private-media-marker' }),
			),
			total,
			more,
		)
		value.data.info.title = 'private-folder-marker'
		value.message = 'server-message-marker'
		await assert.rejects(read(value), (error: unknown) => {
			assert(error instanceof BilibiliFavoriteReadError)
			assert.equal(error.code, 'incomplete')
			const expected = Math.min(40, total)
			assert.equal(
				error.message,
				`B 站收藏页总数、页码或分页状态不一致（本页收到 ${received} 项，预期 ${expected} 项；目录报告 ${total} 项；还有下一页：${more ? '是' : '否'}），请重新核对目录`,
			)
			assert.deepEqual(error.diagnostics, {
				reportedTotal: total,
				receivedCount: received,
				expectedCount: expected,
				hasMore: more,
			})
			assert(!/marker|https?:|cookie|token|mid/i.test(error.message))
			assert.deepEqual(error.partial?.originalData, value.data)
			return true
		})
	}
})

void test('shape errors can preserve safe original page evidence, but invalid or oversized metadata cannot', async () => {
	const value = { ...page(), data: { ...page().data, medias: [null] } }
	await assert.rejects(read(value), (error: unknown) => {
		assert(error instanceof BilibiliFavoriteReadError)
		assert.equal(error.code, 'response')
		assert.deepEqual(error.partial?.originalData.medias, [null])
		return true
	})
	const overflow = JSON.stringify(page()).replace(
		'"retained":true',
		'"overflow":1e309',
	)
	for (const bytes of [
		new Uint8Array([0xff]),
		new TextEncoder().encode('{"code":0'),
		new TextEncoder().encode(overflow),
	])
		await assert.rejects(
			readBilibiliFavoritePage(input, async () => bytes),
			(error: unknown) =>
				error instanceof BilibiliFavoriteReadError &&
				error.code === 'response' &&
				!error.partial,
		)
})

void test('response/header/item/depth/40-page-items/5000-total limits reject without oversized partials', async () => {
	let nested: unknown = 'x'
	for (let index = 0; index < 9; index++) nested = { nested }
	for (const value of [
		page(
			Array.from({ length: 41 }, () => media()),
			41,
		),
		page([], 5001),
		{ ...page(), big: 'x'.repeat(bilibiliFavoriteLimits.headerBytes) },
		page([media(1, { big: 'x'.repeat(bilibiliFavoriteLimits.itemBytes) })]),
		{ ...page(), nested },
	])
		await assert.rejects(
			read(value),
			(error: unknown) =>
				error instanceof BilibiliFavoriteReadError &&
				error.code === 'limit' &&
				!error.partial,
		)
	await assert.rejects(
		readBilibiliFavoritePage(
			input,
			async () => new Uint8Array(bilibiliFavoriteLimits.responseBytes + 1),
		),
		(error: unknown) =>
			error instanceof BilibiliFavoriteReadError &&
			error.code === 'limit' &&
			!error.partial,
	)
	const lastAllowed = await read(
		page(
			Array.from({ length: 40 }, () => media()),
			5000,
			false,
		),
		{ page: 125 },
	)
	assert.equal(lastAllowed.items.length, 40)
})

void test('HTTP permission/redirect and unproven network failures stay distinct in favorite adapter', async () => {
	for (const [extra, code] of [
		[{ status: 403 }, 'permission'],
		[{ status: 412 }, 'platform'],
		[{ status: 302 }, 'redirect'],
		[{ redirected: true }, 'redirect'],
		[{ url: 'https://evil/' }, 'redirect'],
		[{ body: null }, 'response'],
	] as const) {
		let calls = 0
		const transport = createBilibiliFavoriteTransport(async (url) => {
			calls++
			return response(url, [], extra).value
		})
		await assert.rejects(
			readBilibiliFavoritePage(input, transport),
			errorCode(code),
		)
		assert.equal(calls, 1)
	}
	const transport = createBilibiliFavoriteTransport(async () => {
		throw new TypeError('generic redirect or connection error')
	})
	await assert.rejects(
		readBilibiliFavoritePage(input, transport),
		errorCode('network'),
	)
})

void test('shared actual stream byte limit cancels before subsequent chunks and preserves cleanup behavior', async () => {
	let stream: ReturnType<typeof response> | undefined
	const transport = createBilibiliFavoriteTransport(async (url) => {
		stream = response(url, [
			new Uint8Array(bilibiliFavoriteLimits.responseBytes),
			new Uint8Array(1),
			encode(page()),
		])
		return stream.value
	})
	await assert.rejects(
		readBilibiliFavoritePage(input, transport),
		errorCode('limit'),
	)
	assert.equal(stream?.reads, 2)
	assert.equal(stream.cancels, 1)
	assert.equal(stream.releases, 1)
})

void test('cancel before request and late ignored transport cannot return stale page; arguments are captured', async () => {
	const before = new AbortController()
	before.abort()
	let calls = 0
	await assert.rejects(
		readBilibiliFavoritePage({ ...input, signal: before.signal }, async () => {
			calls++
			return encode(page())
		}),
		errorCode('cancelled'),
	)
	assert.equal(calls, 0)
	const controller = new AbortController()
	let finish!: (bytes: Uint8Array) => void
	const pending = readBilibiliFavoritePage(
		{ ...input, signal: controller.signal },
		async () =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	controller.abort()
	await assert.rejects(pending, errorCode('cancelled'))
	finish(encode(page()))
	const mutable = { ...input }
	let reply!: (bytes: Uint8Array) => void
	const captured = readBilibiliFavoritePage(
		mutable,
		async () =>
			new Promise((resolve) => {
				reply = resolve
			}),
	)
	mutable.favoriteId = '456'
	mutable.page = 2
	reply(encode(page()))
	assert.equal((await captured).favoriteId, '123')
})

void test('timeout rejects ignored late page transport without pretending native has drained', async (context) => {
	context.mock.timers.enable({ apis: ['setTimeout'] })
	try {
		const pending = readBilibiliFavoritePage(
			input,
			async () => new Promise(() => {}),
		)
		context.mock.timers.tick(bilibiliFavoriteLimits.timeoutMs)
		await assert.rejects(pending, errorCode('timeout'))
	} finally {
		context.mock.timers.reset()
	}
})

void test('shared extraction leaves raw transport promise pending until the underlying ignored fetch settles', async () => {
	let finish!: (value: DirectoryHttpResponse) => void,
		requested = '',
		settled = false
	const transport = createExternalDirectoryTransport(async (url) => {
		requested = url
		return new Promise((resolve) => {
			finish = resolve
		})
	})
	const controller = new AbortController()
	const pending = transport(
		{ provider: 'qq', originalPlaylistId: '456' },
		controller.signal,
	).finally(() => {
		settled = true
	})
	controller.abort()
	await Promise.resolve()
	await Promise.resolve()
	assert.equal(settled, false)
	finish(response(requested, []).value)
	await assert.rejects(
		pending,
		(error: unknown) =>
			error instanceof DirectoryReadError && error.code === 'cancelled',
	)
	assert.equal(settled, true)
})
