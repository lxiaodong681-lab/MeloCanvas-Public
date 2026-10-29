import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	BilibiliFavoriteFoldersReadError,
	bilibiliFavoriteFoldersLimits,
	createBilibiliFavoriteFoldersTransport,
	readBilibiliFavoriteFolders,
	type FavoriteFoldersErrorCode,
} from '../bilibili-favorite-folders'
import type { DirectoryHttpResponse } from '../directory-http'

const encode = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value))
const input = { userMid: '123' }
const folder = (id: string | number = 1, extra = {}) => ({
	id,
	title: ' 原收藏夹 ',
	media_count: 6,
	fav_state: 0,
	...extra,
})
const list = (folders = [folder()], extra = {}) => ({
	code: 0,
	message: '0',
	envelopeExtra: { retained: true },
	data: { list: folders, dataExtra: ['保留'], ...extra },
})
const read = (value: unknown) =>
	readBilibiliFavoriteFolders(input, async () => encode(value))
const errorCode = (code: FavoriteFoldersErrorCode) => (error: unknown) =>
	error instanceof BilibiliFavoriteFoldersReadError && error.code === code
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function response(
	url: string,
	bytes = encode(list()),
	extra: Partial<DirectoryHttpResponse> = {},
): DirectoryHttpResponse {
	let sent = false
	return {
		status: 200,
		url,
		redirected: false,
		headers: { get: () => null },
		body: {
			getReader: () => ({
				read: async () => {
					if (sent) return { done: true }
					sent = true
					return { done: false, value: bytes }
				},
				cancel: async () => {},
				releaseLock: () => {},
			}),
		},
		...extra,
	}
}

void test('one fixed official endpoint, canonical string mid and no credential/login/content requests', async () => {
	let calls = 0
	const userMid = '900719925474099312345'
	const transport = createBilibiliFavoriteFoldersTransport(
		async (url, init) => {
			calls++
			assert.equal(
				url,
				`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${userMid}`,
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
			return response(url)
		},
	)
	const value = await readBilibiliFavoriteFolders({ userMid }, transport)
	assert.equal(value.userMid, userMid)
	assert.equal(value.observedCount, 1)
	assert.equal(calls, 1)
})

void test('preserves raw folder order, huge string IDs, title and unknown fields without guessing permissions', async () => {
	const raw = list(
		[
			folder('900719925474099312345', {
				media_count: 6001,
				fav_state: 42,
				custom: { tags: ['原信息'] },
			}),
			folder(7),
			folder(Number.MAX_SAFE_INTEGER),
		],
		{ count: 3 },
	)
	const value = await read(raw)
	assert.deepEqual(
		value.folders.map((f) => [f.index, f.folderId]),
		[
			[0, '900719925474099312345'],
			[1, '7'],
			[2, String(Number.MAX_SAFE_INTEGER)],
		],
	)
	assert.equal(value.reportedCount, 3)
	assert.equal(value.folders[0].mediaCount, 6001)
	assert.equal(value.folders[0].favState, 42)
	assert.equal(value.folders[0].title, ' 原收藏夹 ')
	assert.deepEqual(
		value.folders.map((f) => f.original),
		raw.data.list,
	)
	assert.deepEqual(value.originalEnvelope, {
		code: 0,
		message: '0',
		envelopeExtra: { retained: true },
	})
	assert.deepEqual(value.originalData, { count: 3, dataExtra: ['保留'] })
	assert(!('list' in value.originalData))
})

void test('only explicit empty list succeeds, missing count stays unknown rather than a fabricated total', async () => {
	for (const extra of [{}, { count: 0 }]) {
		const value = await read(list([], extra))
		assert.equal(value.observedCount, 0)
		assert.deepEqual(value.folders, [])
		assert.equal(value.reportedCount, 'count' in extra ? 0 : null)
	}
	assert.equal((await read(list())).reportedCount, null)
})

void test('null/missing envelopes, data and list never become a successful empty account', async () => {
	for (const raw of [
		null,
		[],
		{},
		{ code: null },
		{ code: 0 },
		{ code: 0, data: null },
		{ code: 0, data: [] },
		{ code: 0, data: {} },
		{ code: 0, data: { list: null } },
		{ code: 0, data: { list: {} } },
	])
		await assert.rejects(read(raw), errorCode('response'))
})

void test('code zero with data null remains a one-request response failure with an explicitly unknown empty state', async () => {
	let calls = 0
	await assert.rejects(
		readBilibiliFavoriteFolders(input, async () => {
			calls++
			return encode({ code: 0, data: null })
		}),
		(error: unknown) => {
			assert(error instanceof BilibiliFavoriteFoldersReadError)
			assert.equal(error.code, 'response')
			assert.equal(
				error.message,
				'平台未返回可读取的收藏夹列表，暂时无法判断是否为空。',
			)
			return true
		},
	)
	assert.equal(calls, 1)
	await assert.rejects(
		read({ code: 0, data: { list: null } }),
		(error: unknown) => {
			assert(error instanceof BilibiliFavoriteFoldersReadError)
			assert.equal(error.code, 'response')
			assert.equal(error.message, '收藏夹列表缺失，不能当作没有收藏夹')
			return true
		},
	)
})

void test('platform failures and root/data vouchers are explicit, never empty and never leak voucher tokens', async () => {
	await assert.rejects(
		read({ code: -352, message: 'upstream private message' }),
		(error: unknown) => {
			assert(error instanceof BilibiliFavoriteFoldersReadError)
			assert.equal(error.code, 'platform')
			assert.equal(error.diagnostics.platformCode, -352)
			assert(!JSON.stringify(error).includes('private message'))
			return true
		},
	)
	for (const raw of [
		{ code: 0, v_voucher: 'secret-voucher' },
		{ code: 0, data: { list: [], v_voucher: 'secret-voucher' } },
	])
		await assert.rejects(read(raw), (error: unknown) => {
			assert(error instanceof BilibiliFavoriteFoldersReadError)
			assert.equal(error.code, 'restricted')
			assert.match(error.message, /风控/)
			assert(!JSON.stringify(error).includes('secret-voucher'))
			return true
		})
})

void test('invalid mid is refused before raw transport and valid request captures identity before await', async () => {
	let calls = 0
	for (const userMid of [
		'',
		'0',
		'01',
		' 123',
		'123 ',
		'-1',
		'1e3',
		'https://example.com/123',
		'1'.repeat(129),
		123,
	]) {
		await assert.rejects(
			readBilibiliFavoriteFolders({ userMid: userMid as string }, async () => {
				calls++
				return encode(list())
			}),
			errorCode('invalid-input'),
		)
	}
	assert.equal(calls, 0)
	const slow = deferred<Uint8Array>(),
		mutable = { userMid: '123' }
	const pending = readBilibiliFavoriteFolders(mutable, async (request) => {
		assert.equal(request.userMid, '123')
		return slow.promise
	})
	mutable.userMid = '456'
	slow.resolve(encode(list()))
	assert.equal((await pending).userMid, '123')
})

void test('folder IDs must retain safe precision and duplicate identities are errors, not deduplicated rows', async () => {
	for (const id of [
		0,
		-1,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
		'01',
		'0',
		' 1',
		'1'.repeat(129),
	])
		await assert.rejects(read(list([folder(id)])), errorCode('response'))
	await assert.rejects(
		read(list([folder(7), folder('7')])),
		errorCode('response'),
	)
	await assert.rejects(
		read(list([folder(7), folder(7)])),
		errorCode('response'),
	)
})

void test('optional count is checked against returned length; item counts and states require nonnegative safe integers', async () => {
	for (const count of [null, '1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
		await assert.rejects(
			read(list([folder()], { count })),
			errorCode('response'),
		)
	for (const count of [0, 2])
		await assert.rejects(
			read(list([folder()], { count })),
			errorCode('incomplete'),
		)
	for (const key of ['media_count', 'fav_state']) {
		for (const value of [null, '1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
			await assert.rejects(
				read(list([folder(1, { [key]: value })])),
				errorCode('response'),
			)
	}
	for (const title of ['', ' ', null, 123])
		await assert.rejects(
			read(list([folder(1, { title })])),
			errorCode('response'),
		)
})

void test('malformed UTF-8/JSON/byte values and nonfinite JSON numbers are response errors', async () => {
	for (const bytes of [
		new Uint8Array([0xc3, 0x28]),
		new TextEncoder().encode('{broken'),
		'not bytes',
	])
		await assert.rejects(
			readBilibiliFavoriteFolders(input, async () => bytes as Uint8Array),
			errorCode('response'),
		)
	for (const text of [
		'{"code":0,"data":{"list":[],"extra":1e309}}',
		'{"code":0,"data":{"list":[{"id":1,"title":"原","media_count":0,"fav_state":0,"extra":1e309}]}}',
	])
		await assert.rejects(
			readBilibiliFavoriteFolders(input, async () =>
				new TextEncoder().encode(text),
			),
			errorCode('response'),
		)
})

void test('header/item/depth/count/actual bytes stay within existing budgets without truncation', async () => {
	await assert.rejects(
		read(
			list([], { huge: 'h'.repeat(bilibiliFavoriteFoldersLimits.headerBytes) }),
		),
		errorCode('limit'),
	)
	await assert.rejects(
		read(
			list([
				folder(1, {
					huge: 'i'.repeat(bilibiliFavoriteFoldersLimits.itemBytes),
				}),
			]),
		),
		errorCode('limit'),
	)
	let deep: unknown = 0
	for (let i = 0; i < 12; i++) deep = { deep }
	await assert.rejects(read(list([folder(1, { deep })])), errorCode('limit'))
	await assert.rejects(
		read(list(Array.from({ length: 5001 }, (_, i) => folder(i + 1)))),
		errorCode('limit'),
	)
	await assert.rejects(read(list([], { count: 5001 })), errorCode('limit'))
	await assert.rejects(
		readBilibiliFavoriteFolders(
			input,
			async () =>
				new Uint8Array(bilibiliFavoriteFoldersLimits.responseBytes + 1),
		),
		errorCode('limit'),
	)
	// Raw body is under 8MiB, but derived title + original object would exceed the result budget.
	const raw = list(
		Array.from({ length: 600 }, (_, i) =>
			folder(i + 1, { title: 't'.repeat(8000) }),
		),
	)
	assert(encode(raw).length < bilibiliFavoriteFoldersLimits.responseBytes)
	await assert.rejects(read(raw), errorCode('limit'))
})

void test('pre-cancel never invokes transport; in-flight cancellation ignores late successful bytes', async () => {
	const controller = new AbortController()
	controller.abort()
	let calls = 0
	await assert.rejects(
		readBilibiliFavoriteFolders(
			{ ...input, signal: controller.signal },
			async () => {
				calls++
				return encode(list())
			},
		),
		errorCode('cancelled'),
	)
	assert.equal(calls, 0)
	const live = new AbortController(),
		slow = deferred<Uint8Array>()
	const pending = readBilibiliFavoriteFolders(
		{ ...input, signal: live.signal },
		async () => slow.promise,
	)
	live.abort()
	await assert.rejects(pending, errorCode('cancelled'))
	slow.resolve(encode(list()))
	await tick()
})

void test('timeout ends waiter without retry or falsely draining the underlying request', async (context) => {
	context.mock.timers.enable({ apis: ['setTimeout'] })
	try {
		const slow = deferred<Uint8Array>()
		let calls = 0,
			settled = false
		const pending = readBilibiliFavoriteFolders(input, () => {
			calls++
			return slow.promise.finally(() => {
				settled = true
			})
		})
		context.mock.timers.tick(bilibiliFavoriteFoldersLimits.timeoutMs)
		await assert.rejects(pending, errorCode('timeout'))
		assert.equal(calls, 1)
		assert.equal(settled, false)
		slow.reject(new Error('late transport failure'))
		await tick()
		assert.equal(settled, true)
	} finally {
		context.mock.timers.reset()
	}
})

void test('raw transport remains pending until the actual body read settles after abort', async () => {
	const body = deferred<{ done: boolean; value?: Uint8Array }>()
	let settled = false,
		calls = 0
	const raw = createBilibiliFavoriteFoldersTransport(async (url) => {
		calls++
		return response(url, encode(list()), {
			body: {
				getReader: () => ({
					read: () => body.promise,
					cancel: async () => {},
					releaseLock: () => {},
				}),
			},
		})
	})
	const controller = new AbortController()
	const pending = raw(input, controller.signal).finally(() => {
		settled = true
	})
	await tick()
	controller.abort()
	await tick()
	assert.equal(settled, false)
	assert.equal(calls, 1)
	const rejected = assert.rejects(
		pending,
		(error: unknown) =>
			error instanceof Error && 'code' in error && error.code === 'cancelled',
	)
	body.resolve({ done: true })
	await rejected
	assert.equal(settled, true)
})

void test('proven redirects/HTTP failures are mapped accurately; generic fetch errors remain network', async () => {
	for (const [extra, code] of [
		[{ redirected: true }, 'redirect'],
		[{ status: 302 }, 'redirect'],
		[{ url: 'https://example.invalid/redirect' }, 'redirect'],
		[{ status: 403 }, 'permission'],
		[{ status: 412 }, 'platform'],
		[{ body: null }, 'response'],
	] as const)
		await assert.rejects(
			readBilibiliFavoriteFolders(
				input,
				createBilibiliFavoriteFoldersTransport(async (url) =>
					response(url, encode(list()), extra),
				),
			),
			errorCode(code),
		)
	await assert.rejects(
		readBilibiliFavoriteFolders(
			input,
			createBilibiliFavoriteFoldersTransport(async () => {
				throw new TypeError('possibly redirect')
			}),
		),
		errorCode('network'),
	)
})

void test('shared raw stream rejects excessive declared and accumulated actual bytes', async () => {
	for (const extra of [
		{
			headers: {
				get: () => String(bilibiliFavoriteFoldersLimits.responseBytes + 1),
			},
		},
		{
			body: {
				getReader: () => ({
					read: async () => ({
						done: false,
						value: new Uint8Array(
							bilibiliFavoriteFoldersLimits.responseBytes + 1,
						),
					}),
					cancel: async () => {},
					releaseLock: () => {},
				}),
			},
		},
	])
		await assert.rejects(
			readBilibiliFavoriteFolders(
				input,
				createBilibiliFavoriteFoldersTransport(async (url) =>
					response(url, encode(list()), extra),
				),
			),
			errorCode('limit'),
		)
})
