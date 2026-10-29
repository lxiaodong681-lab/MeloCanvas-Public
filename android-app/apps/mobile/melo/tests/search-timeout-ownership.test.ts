import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { SearchSession } from '../search-session'

const json = (data: unknown, code = 0) =>
	new Response(JSON.stringify({ code, data }))
const keys = {
	wbi_img: {
		img_url: `https://example.invalid/${'a'.repeat(32)}.png`,
		sub_url: `https://example.invalid/${'b'.repeat(32)}.png`,
	},
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
/** Real isolated production module. Only transport and its 15s deadline are controlled. */
function coldModule(
	transport: (path: string, signal: AbortSignal) => Promise<Response>,
) {
	const path = new URL('../bilibili.ts', import.meta.url)
	const exports = {} as typeof import('../bilibili')
	const timers = new Map<number, () => void>()
	let next = 0
	runInNewContext(
		ts.transpileModule(readFileSync(path, 'utf8'), {
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.CommonJS,
			},
		}).outputText,
		{
			exports,
			require: createRequire(path),
			AbortController,
			URL,
			Date,
			Error,
			TypeError,
			SyntaxError,
			fetch: async (input: string, init: RequestInit) => {
				assert.ok(init.signal)
				return transport(new URL(input).pathname, init.signal)
			},
			setTimeout: (callback: () => void, delay: number) => {
				assert.equal(delay, 15000)
				const id = ++next
				timers.set(id, callback)
				return id
			},
			clearTimeout: (id: number) => {
				timers.delete(id)
			},
		},
	)
	return {
		api: exports,
		expire: () => {
			assert.equal(timers.size, 1)
			const [id, callback] = [...timers][0]
			timers.delete(id)
			callback()
		},
		pendingTimers: () => timers.size,
	}
}

for (const endpoint of ['spi', 'nav'] as const)
	void test(`late successful cold ${endpoint} after its deadline cannot initialize cache or issue a content request`, async () => {
		const response = deferred<Response>(),
			entered = deferred<void>()
		let attempts = 0,
			searches = 0,
			signal: AbortSignal | null = null
		const f = coldModule(async (path, requestSignal) => {
			if (path.endsWith(`/${endpoint}`) && ++attempts === 1) {
				signal = requestSignal
				entered.resolve()
				return response.promise // Deliberately late transport completion despite abort.
			}
			if (path.endsWith('/spi')) return json({ b_3: 'fixture-anonymous' })
			if (path.endsWith('/nav')) return json(keys, -101)
			assert.ok(path.endsWith('/type'))
			searches++
			return json({ page: 1, result: [], numPages: 0, numResults: 0 })
		})
		const session = new SearchSession(f.api.search)
		const first = session.find('Aimer')
		await entered.promise
		f.expire()
		assert.equal((signal as AbortSignal | null)?.aborted, true)
		response.resolve(
			endpoint === 'spi' ? json({ b_3: 'expired-fixture' }) : json(keys, -101),
		)
		await first
		assert.equal(searches, 0)
		assert.equal(session.getSnapshot().page, 0)
		assert.equal(session.getSnapshot().failedPage, 1)
		assert.match(session.getSnapshot().error, /超时/)
		assert.equal(f.pendingTimers(), 0)
		await session.retry()
		assert.equal(
			attempts,
			2,
			'Expired initialization must be requested anew, not warmed by late completion',
		)
		assert.equal(searches, 1, 'Only explicit retry may issue content request')
		assert.equal(session.getSnapshot().page, 1)
		assert.equal(session.getSnapshot().error, '')
	})

void test('late first search empty success after deadline remains a timeout, not a successful zero result', async () => {
	const response = deferred<Response>(),
		entered = deferred<void>()
	let calls = 0
	const f = coldModule(async (path) => {
		if (path.endsWith('/spi')) return json({ b_3: 'fixture-anonymous' })
		if (path.endsWith('/nav')) return json(keys, -101)
		assert.ok(path.endsWith('/type'))
		if (++calls === 1) {
			entered.resolve()
			return response.promise
		}
		return json({ page: 1, result: [], numPages: 0, numResults: 0 })
	})
	const session = new SearchSession(f.api.search)
	const first = session.find('Aimer')
	await entered.promise
	f.expire()
	response.resolve(json({ page: 1, result: [], numPages: 0, numResults: 0 }))
	await first
	assert.equal(session.getSnapshot().page, 0)
	assert.equal(session.getSnapshot().failedPage, 1)
	assert.match(session.getSnapshot().error, /超时/)
	assert.equal(
		calls,
		1,
		'Timeout does not use the shape reread or retry itself',
	)
	await session.retry()
	assert.equal(calls, 2)
	assert.equal(session.getSnapshot().page, 1)
	assert.equal(session.getSnapshot().error, '')
})

for (const cancel of [false, true])
	void test(`deadline while JSON decoding ${cancel ? 'preserves explicit cancellation priority' : 'rejects late successful body'}`, async () => {
		const body = deferred<unknown>(),
			entered = deferred<void>(),
			controller = new AbortController()
		const f = coldModule(
			async () =>
				({
					ok: true,
					json: () => {
						entered.resolve()
						return body.promise
					},
				}) as Response,
		)
		const result = f.api.request('/fixture', controller.signal)
		const rejected = assert.rejects(result, cancel ? /取消/ : /超时/)
		await entered.promise
		f.expire()
		if (cancel) controller.abort()
		body.resolve({ code: 0, data: { result: [], numPages: 0 } })
		await rejected
		assert.equal(f.pendingTimers(), 0)
	})
