import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAccountDirectoryFetch } from '../account-directory-fetch'
import { readDirectoryHttp, type DirectoryFetch, type DirectoryHttpResponse } from '../directory-http'

const url = 'https://example.invalid/directory'
const request = { url, method: 'GET' as const, headers: { Referer: 'https://example.invalid' } }
const init = () => ({ ...request, credentials: 'omit' as const, redirect: 'error' as const, signal: new AbortController().signal })
function access() {
	let state = { onlineAllowed: true, sessionGeneration: 1 }
	const listeners = new Set<() => void>()
	return {
		get: () => state,
		subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
		set: (next: typeof state) => { state = next; for (const listener of listeners) listener() },
		count: () => listeners.size,
	}
}
function response(read: () => Promise<{ done: boolean; value?: Uint8Array }>) {
	let cancelled = 0
	let released = 0
	const value: DirectoryHttpResponse = { status: 200, url, redirected: false, headers: { get: () => null }, body: { getReader: () => ({ read, cancel: async () => { cancelled++ }, releaseLock: () => { released++ } }) } }
	return { value, cancelled: () => cancelled, released: () => released }
}

void test('offline blocks the request before fetch without adding credentials', async () => {
	const a = access()
	a.set({ onlineAllowed: false, sessionGeneration: 1 })
	let calls = 0
	const fetcher: DirectoryFetch = async () => { calls++; throw new Error('must not fetch') }
	await assert.rejects(createAccountDirectoryFetch(fetcher, a.get, a.subscribe)(url, init()), { code: 'permission' })
	assert.equal(calls, 0)
	assert.equal(a.count(), 0)
})

void test('streaming success preserves request destination headers and cleans subscription', async () => {
	const a = access()
	let chunks = 0
	const r = response(async () => chunks++ === 0 ? { done: false, value: new Uint8Array([1, 2]) } : { done: true })
	const fetcher: DirectoryFetch = async (target, options) => {
		assert.equal(target, url)
		assert.deepEqual(options.headers, request.headers)
		assert.equal(options.credentials, 'omit')
		assert.equal(options.redirect, 'error')
		assert.equal('Cookie' in options.headers, false)
		return r.value
	}
	const bytes = await readDirectoryHttp(createAccountDirectoryFetch(fetcher, a.get, a.subscribe), request, new AbortController().signal)
	assert.deepEqual([...bytes], [1, 2])
	assert.equal(r.released(), 1)
	assert.equal(a.count(), 0)
})

void test('changed generation aborts pending fetch and discards its late body', async () => {
	const a = access()
	let resolve!: (value: DirectoryHttpResponse) => void
	let signal: AbortSignal | undefined
	const fetcher: DirectoryFetch = (_url, options) => { signal = options.signal; return new Promise((done) => { resolve = done }) }
	const pending = createAccountDirectoryFetch(fetcher, a.get, a.subscribe)(url, init())
	a.set({ onlineAllowed: true, sessionGeneration: 2 })
	assert.equal(signal?.aborted, true)
	const r = response(async () => ({ done: true }))
	resolve(r.value)
	await assert.rejects(pending, { code: 'cancelled' })
	assert.ok(r.cancelled() > 0)
	assert.equal(a.count(), 0)
})

void test('logout during pending body read cancels and rejects late chunk', async () => {
	const a = access()
	let resolve!: (value: { done: boolean; value?: Uint8Array }) => void
	const r = response(() => new Promise((done) => { resolve = done }))
	const wrapped = await createAccountDirectoryFetch(async () => r.value, a.get, a.subscribe)(url, init())
	const reader = wrapped.body!.getReader()
	const pending = reader.read()
	a.set({ onlineAllowed: false, sessionGeneration: 2 })
	resolve({ done: false, value: new Uint8Array([9]) })
	await assert.rejects(pending, { code: 'cancelled' })
	assert.ok(r.cancelled() > 0)
	reader.releaseLock()
	assert.equal(a.count(), 0)
})

void test('caller abort is composed with the account cancellation signal', async () => {
	const a = access()
	const controller = new AbortController()
	const r = response(async () => ({ done: true }))
	const wrapped = await createAccountDirectoryFetch(async () => r.value, a.get, a.subscribe)(url, { ...init(), signal: controller.signal })
	controller.abort()
	await assert.rejects(wrapped.body!.getReader().read(), { code: 'cancelled' })
	assert.ok(r.cancelled() > 0)
	assert.equal(a.count(), 0)
})

void test('existing 8MiB streamed size guard remains enforced', async () => {
	const a = access()
	const r = response(async () => ({ done: false, value: new Uint8Array(8 * 1024 * 1024 + 1) }))
	await assert.rejects(readDirectoryHttp(createAccountDirectoryFetch(async () => r.value, a.get, a.subscribe), request, new AbortController().signal), { code: 'limit' })
	assert.ok(r.cancelled() > 0)
	assert.equal(a.count(), 0)
})
