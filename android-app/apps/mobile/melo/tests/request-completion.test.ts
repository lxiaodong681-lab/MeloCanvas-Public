import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BilibiliReadGate, readBilibiliView } from '../bilibili-import-network'

import {
	cancellation,
	checkpoint,
	deferred,
	json,
	observe,
	requestFixture,
} from './request-completion-fixture'

for (const phase of ['fetch', 'json'] as const)
	for (const cancel of [false, true])
		void test(`never-settling ${phase} releases request waiter on ${cancel ? 'explicit cancel' : '15s deadline'} with cleanup`, async () => {
			const wait = deferred<never>(),
				entered = deferred<void>(),
				external = cancellation()
			let internal: AbortSignal | null = null
			const f = requestFixture(async (_path, signal) => {
				internal = signal
				if (phase === 'fetch') {
					entered.resolve()
					return wait.promise
				}
				return {
					ok: true,
					json: () => {
						entered.resolve()
						return wait.promise
					},
				} as unknown as Response
			})
			const result = observe(f.api.request('/fixture', external.signal))
			await entered.promise
			if (cancel) external.controller.abort()
			else f.expire()
			await checkpoint()
			assert.equal(
				result.get().status,
				'error',
				'a transport that ignores abort cannot keep the caller pending',
			)
			assert.match(String(result.get().error), cancel ? /取消/ : /超时/)
			assert.equal((internal as AbortSignal | null)?.aborted, true)
			assert.equal(f.pendingTimers(), 0)
			assert.equal(external.pendingListeners(), 0)
			assert.equal(f.pendingInternalListeners(), 0)
			assert.equal(f.fetches(), 1, 'completion must not automatically retry')
		})

void test('explicit cancellation in the deadline turn keeps cancellation priority even when transport never settles', async () => {
	const wait = deferred<never>(),
		entered = deferred<void>(),
		external = cancellation()
	const f = requestFixture(async () => {
		entered.resolve()
		return wait.promise
	})
	const result = observe(f.api.request('/fixture', external.signal))
	await entered.promise
	f.expire()
	external.controller.abort()
	await checkpoint()
	assert.equal(result.get().status, 'error')
	assert.match(String(result.get().error), /取消/)
	assert.doesNotMatch(String(result.get().error), /超时/)
	assert.equal(external.pendingListeners(), 0)
	assert.equal(f.pendingTimers(), 0)
})

for (const phase of ['fetch', 'json'] as const)
	void test(`abandoned ${phase} rejection is consumed; result is bounded but settlement remains honest`, async () => {
		const wait = deferred<Response>(),
			body = deferred<unknown>(),
			entered = deferred<void>(),
			external = cancellation()
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason)
		}
		process.on('unhandledRejection', onUnhandled)
		try {
			const f = requestFixture(async () => {
				if (phase === 'fetch') {
					entered.resolve()
					return wait.promise
				}
				return {
					ok: true,
					json: () => {
						entered.resolve()
						return body.promise
					},
				} as Response
			})
			const read = f.api.beginBilibiliRequest('/fixture', external.signal)
			const result = observe(read.result),
				settled = observe(read.settled)
			await entered.promise
			f.expire()
			await checkpoint()
			assert.equal(result.get().status, 'error')
			assert.match(String(result.get().error), /超时/)
			assert.equal(settled.get().status, 'pending')
			assert.equal(external.pendingListeners(), 0)
			assert.equal(f.pendingInternalListeners(), 0)
			if (phase === 'fetch') wait.reject(new TypeError('late fetch failure'))
			else body.reject(new SyntaxError('late JSON failure'))
			await checkpoint()
			await checkpoint()
			assert.equal(settled.get().status, 'success')
			assert.match(String(result.get().error), /超时/)
			assert.deepEqual(unhandled, [])
			assert.equal(f.fetches(), 1)
		} finally {
			process.removeListener('unhandledRejection', onUnhandled)
		}
	})

void test('a fetch success after result timeout does not even start late JSON work', async () => {
	const wait = deferred<Response>(),
		entered = deferred<void>()
	let jsonCalls = 0
	const f = requestFixture(async () => {
		entered.resolve()
		return wait.promise
	})
	const read = f.api.beginBilibiliRequest('/fixture'),
		result = observe(read.result)
	await entered.promise
	f.expire()
	await checkpoint()
	assert.equal(result.get().status, 'error')
	wait.resolve({
		ok: true,
		json: async () => {
			jsonCalls++
			return { code: 0, data: 'late data' }
		},
	} as Response)
	await read.settled
	assert.equal(jsonCalls, 0)
	assert.match(String(result.get().error), /超时/)
})

for (const endpoint of ['spi', 'nav'] as const)
	void test(`late cold ${endpoint} JSON cannot warm cache, and only an explicit next call retries initialization`, async () => {
		const body = deferred<unknown>(),
			entered = deferred<void>()
		let attempts = 0
		const data =
			endpoint === 'spi'
				? { b_3: 'test-anonymous-device' }
				: {
						wbi_img: {
							img_url: `https://example.invalid/${'a'.repeat(32)}.png`,
							sub_url: `https://example.invalid/${'b'.repeat(32)}.png`,
						},
					}
		const f = requestFixture(async (path) => {
			assert.ok(path.endsWith(`/${endpoint}`))
			if (++attempts === 1)
				return {
					ok: true,
					json: () => {
						entered.resolve()
						return body.promise
					},
				} as Response
			return json(data, endpoint === 'nav' ? -101 : 0)
		})
		const call = () =>
			endpoint === 'spi'
				? f.api.ensureGuest()
				: f.api.signed({ keyword: 'fixture' })
		const first = observe<void | string>(call())
		await entered.promise
		f.expire()
		await checkpoint()
		assert.equal(first.get().status, 'error')
		assert.match(String(first.get().error), /超时/)
		body.resolve({ code: endpoint === 'nav' ? -101 : 0, data })
		await checkpoint()
		assert.equal(
			attempts,
			1,
			'no automatic retry or downstream content request',
		)
		await call()
		assert.equal(attempts, 2, 'late data did not initialize the cache')
		await call()
		assert.equal(
			attempts,
			2,
			'a timely explicit initialization still warms the normal cache',
		)
		assert.equal(f.pendingTimers(), 0)
		assert.equal(f.pendingInternalListeners(), 0)
	})

const bv = 'BV1vT411i7ET'
const video = {
	bvid: bv,
	title: '原视频',
	owner: { mid: 88, name: '原UP' },
	pic: 'https://example.invalid/art',
	videos: 1,
	pages: [{ cid: 11, page: 1, part: 'P1', duration: 200 }],
}

for (const cancel of [false, true])
	void test(`actual view receipt keeps raw gate closed after ${cancel ? 'cancel' : 'deadline'} and releases only after late body settlement`, async () => {
		const body = deferred<unknown>(),
			entered = deferred<void>(),
			external = cancellation()
		let calls = 0
		const f = requestFixture(async (path) => {
			assert.equal(path, '/x/web-interface/view')
			if (++calls === 1)
				return {
					ok: true,
					json: () => {
						entered.resolve()
						return body.promise
					},
				} as Response
			return json(video)
		})
		const gate = new BilibiliReadGate()
		const pending = observe(
			readBilibiliView(
				gate,
				f.listening.beginListeningSourceDetails,
				bv,
				external.signal,
			),
		)
		await entered.promise
		if (cancel) external.controller.abort()
		else f.expire()
		await checkpoint()
		assert.equal(pending.get().status, 'error')
		assert.match(String(pending.get().error), cancel ? /取消/ : /超时/)
		assert.equal(gate.getSnapshot(), true)
		const next = new AbortController()
		await assert.rejects(
			readBilibiliView(
				gate,
				f.listening.beginListeningSourceDetails,
				bv,
				next.signal,
			),
			/尚未真正结束/,
		)
		assert.equal(calls, 1)
		body.resolve({ code: 0, data: video })
		await checkpoint()
		assert.equal(gate.getSnapshot(), false)
		assert.equal(
			pending.get().value,
			undefined,
			'late video cannot be published',
		)
		assert.equal(
			(
				await readBilibiliView(
					gate,
					f.listening.beginListeningSourceDetails,
					bv,
					next.signal,
				)
			).parts[0].source.cid,
			11,
		)
		assert.equal(calls, 2)
		assert.equal(gate.getSnapshot(), false)
		assert.equal(f.pendingTimers(), 0)
		assert.equal(f.pendingInternalListeners(), 0)
	})

void test('a pre-cancelled request remains a zero-transport cancellation', async () => {
	const external = cancellation()
	external.controller.abort()
	const f = requestFixture(async () => {
		throw new Error('must not fetch')
	})
	await assert.rejects(f.api.request('/fixture', external.signal), /取消/)
	assert.equal(f.fetches(), 0)
	assert.equal(f.pendingTimers(), 0)
	assert.equal(external.pendingListeners(), 0)
	const read = f.api.beginBilibiliRequest('/fixture', external.signal)
	await assert.rejects(read.result, /取消/)
	await read.settled
	assert.equal(f.fetches(), 0)
})

void test('timely success and ordinary fetch/HTTP/JSON failures clean the same timer and listeners', async () => {
	for (const kind of ['success', 'fetch', 'http', 'json'] as const) {
		const external = cancellation()
		const cause =
			kind === 'fetch'
				? new TypeError('connection failed')
				: new SyntaxError('invalid JSON')
		const f = requestFixture(async () => {
			if (kind === 'fetch') throw cause
			if (kind === 'http') return new Response('', { status: 412 })
			if (kind === 'json')
				return {
					ok: true,
					json: () => Promise.reject(cause),
				} as unknown as Response
			return json({ value: 'timely' })
		})
		const read = f.api.beginBilibiliRequest<{ value: string }>(
			'/fixture',
			external.signal,
		)
		if (kind === 'success') assert.equal((await read.result).value, 'timely')
		else
			await assert.rejects(read.result, (error: unknown) => {
				assert.ok(error instanceof Error)
				assert.equal(
					error.message,
					kind === 'fetch'
						? '网络连接失败，请检查网络后重试'
						: kind === 'http'
							? 'B 站请求受限，请稍后再试'
							: 'B 站响应无法读取，请稍后重试',
				)
				assert.equal(error.cause, kind === 'http' ? undefined : cause)
				return true
			})
		await read.settled
		assert.equal(f.pendingTimers(), 0)
		assert.equal(f.pendingInternalListeners(), 0)
		assert.equal(external.pendingListeners(), 0)
		assert.equal(f.fetches(), 1)
	}
})

void test('a rejected settlement receipt also releases its gate and is consumed without replacing the result error', async () => {
	const settlement = deferred<void>(),
		gate = new BilibiliReadGate(),
		unhandled: unknown[] = []
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason)
	}
	process.on('unhandledRejection', onUnhandled)
	try {
		const original = new Error('result failed')
		const result = observe(
			gate.run(() => ({
				result: Promise.reject(original),
				settled: settlement.promise,
			})),
		)
		await checkpoint()
		assert.equal(result.get().error, original)
		assert.equal(gate.getSnapshot(), true)
		settlement.reject(new Error('provider settlement failed'))
		await checkpoint()
		await checkpoint()
		assert.equal(gate.getSnapshot(), false)
		assert.equal(result.get().error, original)
		assert.deepEqual(unhandled, [])
		assert.equal(await gate.run(async () => 'next raw read'), 'next raw read')
		assert.equal(gate.getSnapshot(), false)
	} finally {
		process.removeListener('unhandledRejection', onUnhandled)
	}
})
