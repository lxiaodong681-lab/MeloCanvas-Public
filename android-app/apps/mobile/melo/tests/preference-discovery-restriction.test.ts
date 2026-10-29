import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { BilibiliRequestRestrictedError } from '../bilibili-request-error'
import { emptyMusicPreferences } from '../core/music-preferences'
import { PreferenceDiscoverySession } from '../preference-discovery-session'

const preferences = {
	...emptyMusicPreferences(),
	artists: ['合成歌手甲', '合成歌手乙', '合成歌手丙'],
}
const video = {
	bvid: 'BVsynthetic',
	title: '合成歌曲',
	author: '合成作者',
	mid: 1,
	pic: '',
	duration: '03:00',
	typename: '音乐综合',
}
const json = (data: unknown, code = 0) =>
	new Response(
		JSON.stringify({ code, data, message: 'private-response-marker' }),
	)
function coldModule(fetch: typeof globalThis.fetch) {
	const path = new URL('../bilibili.ts', import.meta.url)
	const exports = {} as typeof import('../bilibili')
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
			fetch,
			AbortController,
			URL,
			setTimeout,
			clearTimeout,
			Error,
			TypeError,
			SyntaxError,
		},
	)
	return exports
}
function fixture(reply: (stage: string) => Response) {
	const calls: string[] = []
	const api = coldModule(async (input) => {
		assert.equal(typeof input, 'string')
		const path = new URL(input as string).pathname
		const stage = path.endsWith('/spi')
			? 'device'
			: path.endsWith('/nav')
				? 'signing'
				: 'search'
		calls.push(stage)
		return reply(stage)
	})
	return { api, calls }
}
function success(stage: string): Response {
	if (stage === 'device') return json({ b_3: 'synthetic-device', b_4: '' })
	if (stage === 'signing')
		return json(
			{
				wbi_img: {
					img_url: `https://example.com/${'a'.repeat(32)}.png`,
					sub_url: `https://example.com/${'b'.repeat(32)}.png`,
				},
			},
			-101,
		) // Guest signing remains compatible with its ordinary nav envelope.
	return json({ result: [video], numPages: 1 })
}
const restricted = [
	['HTTP 429', () => new Response('private-response-marker', { status: 429 })],
	['HTTP 412', () => new Response('private-response-marker', { status: 412 })],
	...[-412, -352, -799].map(
		(code) => [`platform ${code}`, () => json({}, code)] as const,
	),
	['data voucher', () => json({ v_voucher: 'private-response-marker' })],
	[
		'envelope voucher',
		() =>
			new Response(
				JSON.stringify({ code: 0, v_voucher: 'private-response-marker' }),
			),
	],
	[
		'voucher without normal envelope',
		() =>
			new Response(JSON.stringify({ v_voucher: 'private-response-marker' })),
	],
] as const
for (const stage of ['device', 'signing', 'search']) {
	for (const [label, response] of restricted) {
		void test(`${stage} ${label} stops this discovery run without reread, further initialization or seed requests`, async () => {
			const f = fixture((current) =>
				current === stage ? response() : success(current),
			)
			const session = new PreferenceDiscoverySession(f.api.search)
			await session.load(preferences)
			assert.deepEqual(
				f.calls,
				['device', 'signing', 'search'].slice(
					0,
					['device', 'signing', 'search'].indexOf(stage) + 1,
				),
			)
			assert.deepEqual(session.getSnapshot().pendingSeeds, preferences.artists)
			assert.equal(session.getSnapshot().loading, false)
			assert.match(session.getSnapshot().error, /请求受限.*稍后再试/)
			assert.doesNotMatch(
				session.getSnapshot().error,
				/private-response-marker/,
			)
			await new Promise((done) => setImmediate(done))
			assert.equal(
				f.calls.length,
				['device', 'signing', 'search'].indexOf(stage) + 1,
			)
		})
	}
}
void test('restriction preserves earlier results and pending queries; only explicit retry resumes them', async () => {
	let searches = 0
	let blocked = true
	const f = fixture((stage) => {
		if (stage === 'search' && ++searches === 2 && blocked) return json({}, -412)
		return success(stage)
	})
	const session = new PreferenceDiscoverySession(f.api.search)
	await session.load(preferences)
	assert.equal(searches, 2)
	assert.equal(session.getSnapshot().items.length, 1)
	assert.deepEqual(
		session.getSnapshot().pendingSeeds,
		preferences.artists.slice(1),
	)
	blocked = false
	await session.retry()
	assert.equal(searches, 4)
	assert.deepEqual(session.getSnapshot().pendingSeeds, [])
	assert.equal(session.getSnapshot().error, '')
})
void test('normal empty results and ordinary query failures still continue; malformed payload keeps default single reread', async () => {
	let searches = 0
	const f = fixture((stage) => {
		if (stage !== 'search') return success(stage)
		searches++
		if (searches === 1) return new Response('', { status: 500 })
		if (searches === 2) return json({ result: [], numPages: 0, numResults: 0 })
		if (searches === 3) return json({})
		return success(stage)
	})
	const session = new PreferenceDiscoverySession(f.api.search)
	await session.load(preferences)
	assert.equal(searches, 4)
	assert.deepEqual(
		session.getSnapshot().pendingSeeds,
		preferences.artists.slice(0, 1),
	)
	assert.equal(session.getSnapshot().items.length, 1)
	assert.doesNotMatch(session.getSnapshot().error, /请求受限/)
})
void test('late restricted response after cancel and replacement cannot stop the newer run', async () => {
	let reject!: (error: Error) => void
	let first = true
	const session = new PreferenceDiscoverySession(async () => {
		if (first) {
			first = false
			return new Promise((_, no) => {
				reject = no
			})
		}
		return { items: [], more: false }
	})
	const old = session.load(preferences)
	session.cancel()
	await session.retry()
	reject(new BilibiliRequestRestrictedError())
	await old
	assert.equal(session.getSnapshot().error, '')
	assert.equal(session.getSnapshot().loading, false)
	assert.deepEqual(session.getSnapshot().pendingSeeds, [])
})
void test('restriction error retains no server payload', async () => {
	const f = fixture(() => json({ v_voucher: 'private-response-marker' }, -412))
	await assert.rejects(f.api.request('/synthetic'), (error: unknown) => {
		assert.ok(error instanceof BilibiliRequestRestrictedError)
		assert.equal(error.message, 'B 站请求受限，请稍后再试')
		assert.equal(error.cause, undefined)
		assert.doesNotMatch(JSON.stringify(error), /private-response-marker/)
		return true
	})
})
