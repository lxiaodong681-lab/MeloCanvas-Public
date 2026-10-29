import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

import { createAccountDirectoryFetch } from '../account-directory-fetch'
import { BilibiliReadGate } from '../bilibili-import-network'
import { readDirectoryHttp } from '../directory-http'
import { checkCancelled } from '../core/theme-archive'
import { bilibiliThemeImageUrl, type BilibiliThemePort } from '../bilibili-theme'
import { compile } from './search-page-fixture'

const defaultWorker = async (port: BilibiliThemePort, signal: AbortSignal) => port.image('https://i0.hdslb.com/thumb.png', 128, signal)
const defaultNormalize = async () => new Uint8Array([7])
function fixture() {
	let access = { onlineAllowed: true, sessionGeneration: 1 }
	const listeners = new Set<() => void>(), requests: { url: string; headers: Record<string, string> }[] = [], normalized: number[] = []
	let worker = defaultWorker
	let size = 3
	let normalize: () => Promise<Uint8Array> = defaultNormalize
	const api = {} as Pick<typeof import('../bilibili-theme-mobile'), 'importMobileBilibiliTheme'>
	runInNewContext(compile(readFileSync(new URL('../bilibili-theme-mobile.ts', import.meta.url), 'utf8')), {
		exports: api, AbortController, Uint8Array, setTimeout, clearTimeout,
		require: (key: string) => {
			if (key === './account-access') return { getAccountAccess: () => access }
			if (key === './account-runtime') return { accountSession: { subscribe: (f: () => void) => { listeners.add(f); return () => listeners.delete(f) } } }
			if (key === './account-directory-fetch') return { createAccountDirectoryFetch }
			if (key === './bilibili-import-network') return { BilibiliReadGate }
			if (key === './bilibili') return { beginBilibiliRequest: () => ({ result: Promise.resolve({}), settled: Promise.resolve() }) }
			if (key === './directory-http') return { readDirectoryHttp }
			if (key === './core/theme-archive') return { checkCancelled }
			if (key === './theme-image-decoder') return { createThemeImageDecoder: () => ({}) }
			if (key === './bilibili-theme') return { bilibiliThemeImageUrl, importBilibiliTheme: async (_item: unknown, port: BilibiliThemePort, signal: AbortSignal) => worker(port, signal) }
			if (key === '@bbplayer/native') return { normalizeThemeImageAsync: async (_bytes: Uint8Array, edge: number) => { normalized.push(edge); return normalize() } }
			if (key === 'expo/fetch') return { fetch: async (url: string, init: { headers: Record<string, string> }) => {
				requests.push({ url, headers: init.headers }); let read = false
				return { status: 200, url, redirected: false, headers: { get: () => String(size) }, body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: new Uint8Array(size) }), cancel: async () => {}, releaseLock: () => {} }) } }
			} }
			throw new Error(key)
		},
	})
	return { api, requests, normalized,
		worker: (value: typeof worker) => { worker = value }, size: (n: number) => { size = n }, normalize: (fn: typeof normalize) => { normalize = fn },
		logout: () => { access = { onlineAllowed: false, sessionGeneration: 2 }; for (const f of listeners) f() }, listeners,
	}
}
const item = { id: 'suit-1', name: '主题', kind: 'suit' as const, itemId: 1, actId: 0, lotteryId: 0 }
const tick = () => new Promise((resolve) => setImmediate(resolve))
void test('mobile assets use credential-free bounded transport and one import-time normalization', async () => {
	const f = fixture()
	assert.equal((await f.api.importMobileBilibiliTheme(item, new AbortController().signal, () => {}))[0], 7)
	assert.deepEqual(f.normalized, [128]); assert.equal(f.requests.length, 1)
	assert.equal(f.requests[0].headers.Cookie, undefined); assert.equal(f.listeners.size, 0)
	f.size(8 * 1024 * 1024 + 1)
	await assert.rejects(f.api.importMobileBilibiliTheme(item, new AbortController().signal, () => {}), /8MiB/)
	assert.equal(f.normalized.length, 1)
})
void test('logout while normalizing rejects late data; admission stays locked until native work settles', async () => {
	const f = fixture(); let finish!: (bytes: Uint8Array) => void
	f.normalize(() => new Promise((resolve) => { finish = resolve }))
	const pending = f.api.importMobileBilibiliTheme(item, new AbortController().signal, () => {})
	await tick(); f.logout()
	await assert.rejects(f.api.importMobileBilibiliTheme(item, new AbortController().signal, () => {}), /仍在处理/)
	finish(new Uint8Array([7])); await assert.rejects(pending, /取消/)
	assert.equal(f.listeners.size, 0)
})
void test('aggregate download budget is enforced even when each asset fits the per-image bound', async () => {
	const f = fixture(); f.size(8 * 1024 * 1024)
	f.worker(async (port, signal) => { for (let i = 0; i < 5; i++) await port.image(`https://i0.hdslb.com/${i}.png`, 128, signal); return new Uint8Array([1]) })
	await assert.rejects(f.api.importMobileBilibiliTheme(item, new AbortController().signal, () => {}), /32 MiB/)
	assert.equal(f.normalized.length, 4)
})
