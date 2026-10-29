import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	BilibiliFavoriteReadError,
	bilibiliFavoriteLimits,
	readBilibiliFavoritePage,
} from '../bilibili-favorite'
import { BilibiliFavoriteCollectionSession } from '../bilibili-favorite-collection'
import {
	createBilibiliFavoriteIndexTransport,
	readBilibiliFavoriteIndex,
} from '../bilibili-favorite-index'
import type { DirectoryHttpResponse } from '../directory-http'

import {
	biliState,
	importHost,
	label,
	mixedTask,
	settle,
	text,
} from './theme-import-fixture'

const encode = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value))
const row = (id: number | string, type = 2) => ({
	id,
	type,
	bvid: 'BV1vT411i7ET',
})
const index = (items: unknown[]) =>
	readBilibiliFavoriteIndex({ favoriteId: '123' }, async () =>
		encode({ code: 0, data: items }),
	)
const page = (items: unknown[], total: number, has_more: boolean) => ({
	code: 0,
	data: {
		info: { id: 123, title: '原夹', media_count: total },
		medias: items,
		has_more,
	},
})
const code = (value: string) => (error: unknown) =>
	error instanceof BilibiliFavoriteReadError && error.code === value

void test('resource/ids is one fixed GET without pagination/cookies and preserves raw index order, repeated and unknown types', async () => {
	const data = [
		row('900719925474099312345'),
		row(2, 12),
		row(2, 999),
		row(2, 12),
	]
	let calls = 0
	const transport = createBilibiliFavoriteIndexTransport(async (url, init) => {
		calls++
		assert.equal(
			url,
			'https://api.bilibili.com/x/v3/fav/resource/ids?media_id=123',
		)
		assert.equal(init.method, 'GET')
		assert.equal(init.credentials, 'omit')
		assert.equal(init.redirect, 'error')
		assert.equal(init.body, undefined)
		assert(
			!Object.keys(init.headers).some((name) =>
				/cookie|authorization/i.test(name),
			),
		)
		let delivered = false
		return {
			status: 200,
			url,
			redirected: false,
			headers: { get: () => null },
			body: {
				getReader: () => ({
					read: async () =>
						delivered
							? { done: true }
							: ((delivered = true),
								{
									done: false,
									value: encode({ code: 0, extra: ['保留'], data }),
								}),
					cancel: async () => {},
					releaseLock() {},
				}),
			},
		} satisfies DirectoryHttpResponse
	})
	const result = await readBilibiliFavoriteIndex(
		{ favoriteId: '123' },
		transport,
	)
	assert.equal(calls, 1)
	assert.deepEqual(
		result.items.map((item) => item.original),
		data,
	)
	assert.deepEqual(
		result.items.map((item) => item.position),
		[0, 1, 2, 3],
	)
	assert.deepEqual(
		result.items.map((item) => item.mediaIdentity),
		['2:900719925474099312345', '12:2', '999:2', '12:2'],
	)
	assert.deepEqual(result.originalEnvelope, { code: 0, extra: ['保留'] })
	assert.equal(Reflect.set(result.items[0], 'position', 5), false)
})

void test('short detail pages require a complete matching index and keep raw39 separate from40 real index slots', async () => {
	const data = Array.from({ length: 83 }, (_, i) => row(i + 1))
	const order = await index(data)
	const details = data.slice(0, 40).filter((_, i) => i !== 7)
	await assert.rejects(
		readBilibiliFavoritePage({ favoriteId: '123', page: 1 }, async () =>
			encode(page(details, 83, true)),
		),
		code('incomplete'),
	)
	const result = await readBilibiliFavoritePage(
		{ favoriteId: '123', page: 1, index: order },
		async () => encode(page(details, 83, true)),
	)
	assert.equal(result.items.length, 39)
	assert.equal(result.indexEntries?.length, 40)
	assert.deepEqual(
		result.items.map((item) => item.indexPosition),
		Array.from({ length: 40 }, (_, i) => i).filter((i) => i !== 7),
	)
	assert.deepEqual(
		result.items.map((item) => item.original),
		details,
	)
	assert.equal(result.indexEntries?.[7].mediaIdentity, '2:8')
	assert.equal(result.hasMore, true)
})

void test('index count, window identity, BV conflict, order, has_more and ambiguous duplicate slots remain strict', async () => {
	const base = [row(1), row(2), row(3)]
	const order = await index(base)
	for (const value of [
		page([row(1)], 4, false),
		page([row(4)], 3, false),
		page([row(2), row(1)], 3, false),
		page([{ ...row(1), bvid: 'BV1ab411c7iS' }], 3, false),
		page([row(1)], 3, true),
	])
		await assert.rejects(
			readBilibiliFavoritePage(
				{ favoriteId: '123', page: 1, index: order },
				async () => encode(value),
			),
			code('incomplete'),
		)
	const repeated = await index([row(1), row(1), row(2)])
	const complete = await readBilibiliFavoritePage(
		{ favoriteId: '123', page: 1, index: repeated },
		async () => encode(page([row(1), row(1), row(2)], 3, false)),
	)
	assert.deepEqual(
		complete.items.map((item) => item.indexPosition),
		[0, 1, 2],
	)
	await assert.rejects(
		readBilibiliFavoritePage(
			{ favoriteId: '123', page: 1, index: repeated },
			async () => encode(page([row(1), row(2)], 3, false)),
		),
		code('incomplete'),
	)
	let calls = 0
	await assert.rejects(
		readBilibiliFavoritePage(
			{ favoriteId: '456', page: 1, index: order },
			async () => {
				calls++
				return encode(page(base, 3, false))
			},
		),
		code('invalid-input'),
	)
	assert.equal(calls, 0)
})

void test('index never invents an empty directory or valid identity from malformed/restricted/oversized responses', async () => {
	for (const [value, expected] of [
		[{ code: 0, data: null }, 'response'],
		[{ code: 0, data: {} }, 'response'],
		[{ code: -101, data: [] }, 'platform'],
		[{ code: 0, v_voucher: 'secret-marker', data: [] }, 'restricted'],
		[{ code: 0, data: [row(Number.MAX_SAFE_INTEGER + 1)] }, 'response'],
		[{ code: 0, data: [{ ...row(1), type: 0 }] }, 'response'],
		[{ code: 0, data: [{ ...row(1), bvid: 'invalid' }] }, 'response'],
		[{ code: 0, data: Array.from({ length: 5001 }, () => row(1)) }, 'limit'],
		[
			{
				code: 0,
				data: [
					{ ...row(1), huge: 'x'.repeat(bilibiliFavoriteLimits.itemBytes) },
				],
			},
			'limit',
		],
	] as const)
		await assert.rejects(
			readBilibiliFavoriteIndex({ favoriteId: '123' }, async () =>
				encode(value),
			),
			code(expected),
		)
	assert.equal((await index([])).items.length, 0)
	assert.equal(
		(await index(Array.from({ length: 5000 }, (_, i) => row(i + 1)))).items
			.length,
		5000,
	)
	await assert.rejects(
		readBilibiliFavoriteIndex(
			{ favoriteId: '123' },
			async () => new Uint8Array([0xff]),
		),
		code('response'),
	)
	await assert.rejects(
		readBilibiliFavoriteIndex(
			{ favoriteId: '123' },
			async () => new Uint8Array(bilibiliFavoriteLimits.responseBytes + 1),
		),
		code('limit'),
	)
})

void test('index cancellation and timeout ignore late responses and do not expose underlying transport text', async (context) => {
	let complete!: (value: Uint8Array) => void
	const slow = new Promise<Uint8Array>((resolve) => {
		complete = resolve
	})
	const controller = new AbortController()
	const reading = readBilibiliFavoriteIndex(
		{ favoriteId: '123', signal: controller.signal },
		() => slow,
	)
	controller.abort()
	await assert.rejects(reading, code('cancelled'))
	complete(encode({ code: 0, data: [row(1)] }))
	context.mock.timers.enable({ apis: ['setTimeout'] })
	try {
		const timed = readBilibiliFavoriteIndex(
			{ favoriteId: '123' },
			() => new Promise(() => {}),
		)
		const rejected = assert.rejects(timed, code('timeout'))
		context.mock.timers.tick(bilibiliFavoriteLimits.timeoutMs)
		await rejected
	} finally {
		context.mock.timers.reset()
	}
	await assert.rejects(
		readBilibiliFavoriteIndex({ favoriteId: '123' }, async () => {
			throw new Error('https://private.invalid/token-secret')
		}),
		(error: unknown) => {
			assert(error instanceof BilibiliFavoriteReadError)
			assert.equal(error.code, 'network')
			assert.equal(error.message, '收藏夹索引连接失败')
			return true
		},
	)
})

void test('real import TSX displays index/detail gap and keeps missing-detail playback disabled without auto selection', () => {
	const h = importHost()
	try {
		const collection = new BilibiliFavoriteCollectionSession(async () =>
			encode({}),
		).getSnapshot()
		let tree = settle(
			h,
			h.page(
				'BilibiliImportPage',
				biliState({
					route: 'collection',
					collection: { ...collection, indexCount: 83, missingDetailCount: 1 },
				}),
			),
			240,
		)
		assert.match(text(tree), /真实索引\s*83\s*项/)
		assert.match(text(tree), /1\s*项未返回详情，保留原位置且不可播放/)
		const task = mixedTask(1)
		task.entries[0].selected = false
		task.entries[0].originalMetadata = {
			detailState: 'not-returned',
			resourceIndex: row(1),
			observed: { bvid: null },
		}
		task.originalMetadata.missingDetailCount = 1
		tree = settle(
			h,
			h.page('BilibiliImportPage', biliState({ route: 'task', task })),
			240,
		)
		;(label(tree, '调整导入条目').props.onPress as () => void)()
		tree = settle(h, h.page('BilibiliImportPage', biliState({ route: 'task', task })), 240)
		assert.match(text(tree), /平台未返回详情（不可播放）/)
		assert.equal(label(tree, '核对保存去向，已选 0').props.disabled, true)
		tree = settle(
			h,
			h.page(
				'BilibiliImportPage',
				biliState({ route: 'entry', task, entryId: 'e0' }),
			),
			240,
		)
		assert.equal(label(tree, '读取原BV真实分 P').props.disabled, true)
		assert.match(text(tree), /不自动确认音源或判断失效原因/)
		assert(
			!h.calls.some(([name]) =>
				['setSelected', 'readVideo', 'prepare', 'commit', 'preview'].includes(
					String(name),
				),
			),
		)
	} finally {
		h.unmount()
	}
})
