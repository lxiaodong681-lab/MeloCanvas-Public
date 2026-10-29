import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	activeSubtitleLines,
	BilibiliSubtitleError,
	BilibiliSubtitleProvider,
	parseSubtitleLines,
	type SubtitleTarget,
	type SubtitleDependencies,
} from '../bilibili-subtitles'
const target: SubtitleTarget = { bvid: 'BV1vT411i7ET', cid: 11, page: 2 }
const row = {
	id_str: '9007199254740993',
	lan: 'zh-CN',
	lan_doc: '中文',
	subtitle_url:
		'//aisubtitle.hdslb.com/bfs/subtitle/synthetic.json?auth_key=redacted-fixture',
}
const view = () => ({
	bvid: target.bvid,
	aid: 100,
	pages: [
		{ page: 1, cid: 10, duration: 100 },
		{ page: 2, cid: 11, duration: 100 },
	],
})
const metadata = () => ({
	aid: 100,
	cid: 11,
	login_mid: 1,
	subtitle: { subtitles: [{ ...row }] },
})
const lines = {
	body: [
		{ from: 1, to: 2, content: '合成甲' },
		{ from: 4, to: 5, content: '合成乙' },
	],
}
const reason = (expected: string) => (error: unknown) =>
	error instanceof BilibiliSubtitleError && error.reason === expected
function fixture() {
	let finalUrl: string | null = null
	let generation = 1,
		current: SubtitleTarget | null = { ...target }
	let getView: () => unknown = view
	let getMetadata: () => unknown = metadata
	let getBody: () => Response | Promise<Response> = () =>
		new Response(JSON.stringify(lines))
	const requests: { path: string; params: Record<string, string> }[] = []
	const bodies: { input: string; signal?: AbortSignal }[] = []
	const provider = new BilibiliSubtitleProvider({
		getSessionGeneration: () => generation,
		getCurrentTarget: () => current,
		requestAuthenticatedJson: async (path, params) => {
			requests.push({ path, params })
			return path === '/x/web-interface/view' ? getView() : getMetadata()
		},
		classifyFailure: () => 'unavailable',
		requestSubtitleBody: async (input, signal) => {
			bodies.push({ input, signal })
			const response = await getBody()
			return {
				status: response.status,
				body: await response.text(),
				url: finalUrl ?? input,
			}
		},
	})
	return {
		provider,
		setFinalUrl: (url: string) => {
			finalUrl = url
		},
		requests,
		bodies,
		setGeneration: () => {
			generation++
		},
		setCurrent: (value: SubtitleTarget | null) => {
			current = value
		},
		setView: (fn: typeof getView) => {
			getView = fn
		},
		setMetadata: (fn: typeof getMetadata) => {
			getMetadata = fn
		},
		setBody: (fn: typeof getBody) => {
			getBody = fn
		},
	}
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
void test('discovers exact selected P using signed metadata transport; no subtitle URL in public tracks', async () => {
	const f = fixture(),
		result = await f.provider.discover(target)
	assert.equal(result.status, 'tracks')
	assert.deepEqual(f.requests, [
		{ path: '/x/web-interface/view', params: { bvid: target.bvid } },
		{ path: '/x/player/wbi/v2', params: { aid: '100', cid: '11' } },
	])
	assert.equal(result.tracks[0].id, row.id_str)
	assert.equal(result.tracks[0].platformAiType, null)
	assert.equal(JSON.stringify(result).includes('auth_key'), false)
	assert.equal(f.bodies.length, 0)
})
void test('CDN native transport receives only URL/signal; preserves line ends and gaps', async () => {
	const f = fixture()
	await f.provider.discover(target)
	const doc = await f.provider.load(row.id_str)
	assert.deepEqual(doc.lines, [
		{ startMs: 1000, endMs: 2000, text: '合成甲' },
		{ startMs: 4000, endMs: 5000, text: '合成乙' },
	])
	assert.deepEqual(Object.keys(f.bodies[0]).sort(), ['input', 'signal'])
	assert.equal(activeSubtitleLines(doc.lines, 1000).length, 1)
	assert.equal(activeSubtitleLines(doc.lines, 2000).length, 0)
	assert.equal(activeSubtitleLines(doc.lines, 3000).length, 0)
	assert.equal(activeSubtitleLines(doc.lines, NaN).length, 0)
})
void test('repetitions and overlapping lines survive; sort is chronological and stable', () => {
	const result = parseSubtitleLines(
		{
			body: [
				{ from: 3, to: 4, content: '重复' },
				{ from: 1, to: 2, content: '重复' },
				{ from: 1, to: 3, content: '叠行' },
			],
		},
		10000,
	)
	assert.equal(result.length, 3)
	assert.deepEqual(
		activeSubtitleLines(result, 1500).map((line) => line.text),
		['重复', '叠行'],
	)
})
for (const [name, bad] of [
	['negative', { from: -1, to: 2, content: 'a' }],
	['reversed', { from: 2, to: 1, content: 'a' }],
	['nan', { from: NaN, to: 2, content: 'a' }],
	['infinity', { from: 1, to: Infinity, content: 'a' }],
	['duration', { from: 1, to: 500, content: 'a' }],
	['rounded-empty', { from: 1, to: 1.00001, content: 'a' }],
	['missing-text', { from: 1, to: 2 }],
	['control-text', { from: 1, to: 2, content: '\0' }],
] as const)
	void test(`rejects malformed line ${name}`, () => {
		assert.throws(
			() => parseSubtitleLines({ body: [bad] }, 10000),
			reason('invalid-response'),
		)
	})
void test('empty tracks stay distinct from malformed payload and logged out metadata', async () => {
	const f = fixture()
	f.setMetadata(() => ({ ...metadata(), subtitle: { subtitles: [] } }))
	assert.equal((await f.provider.discover(target)).status, 'no-tracks')
	f.setMetadata(() => ({ ...metadata(), subtitle: {} }))
	await assert.rejects(f.provider.discover(target), reason('invalid-response'))
	f.setMetadata(() => ({ ...metadata(), login_mid: 0 }))
	await assert.rejects(f.provider.discover(target), reason('login-required'))
})
for (const kind of [
	'view-bv',
	'view-page',
	'metadata-cid',
	'metadata-aid',
	'metadata-missing-cid',
] as const)
	void test(`rejects identity mismatch ${kind} without body request`, async () => {
		const f = fixture()
		if (kind === 'view-bv')
			f.setView(() => ({ ...view(), bvid: 'BV0000000000' }))
		if (kind === 'view-page')
			f.setView(() => ({
				...view(),
				pages: [{ page: 2, cid: 99, duration: 100 }],
			}))
		if (kind === 'metadata-cid')
			f.setMetadata(() => ({ ...metadata(), cid: 99 }))
		if (kind === 'metadata-aid')
			f.setMetadata(() => ({ ...metadata(), aid: 99 }))
		if (kind === 'metadata-missing-cid')
			f.setMetadata(() => ({ subtitle: { subtitles: [] } }))
		await assert.rejects(
			f.provider.discover(target),
			reason('identity-mismatch'),
		)
		assert.equal(f.bodies.length, 0)
	})
for (const url of [
	'http://aisubtitle.hdslb.com/bfs/subtitle/x',
	'https://evil.invalid/bfs/subtitle/x',
	'https://aisubtitle.hdslb.com.evil.invalid/bfs/subtitle/x',
	'https://u:p@aisubtitle.hdslb.com/bfs/subtitle/x',
	'https://aisubtitle.hdslb.com/other/x',
	'https://127.0.0.1/bfs/subtitle/x',
])
	void test(`rejects unsafe CDN source ${url}`, async () => {
		const f = fixture()
		f.setMetadata(() => ({
			...metadata(),
			subtitle: { subtitles: [{ ...row, subtitle_url: url }] },
		}))
		await assert.rejects(f.provider.discover(target), reason('restricted'))
		assert.equal(f.bodies.length, 0)
	})
for (const status of [401, 403, 412, 429, 500])
	void test(`CDN HTTP ${status} is not no-tracks`, async () => {
		const f = fixture()
		f.setBody(() => new Response('', { status }))
		await f.provider.discover(target)
		await assert.rejects(
			f.provider.load(row.id_str),
			reason(
				status === 401
					? 'login-required'
					: status === 500
						? 'unavailable'
						: 'restricted',
			),
		)
		assert.equal(f.bodies.length, 1)
	})
void test('session change after metadata starts rejects late data', async () => {
	const f = fixture(),
		pending = deferred<unknown>()
	f.setMetadata(() => pending.promise)
	const task = f.provider.discover(target)
	await new Promise((yes) => setImmediate(yes))
	f.setGeneration()
	pending.resolve(metadata())
	await assert.rejects(task, reason('stale'))
})
void test('P change before body settles rejects data even without explicit invalidation', async () => {
	const f = fixture(),
		pending = deferred<Response>()
	f.setBody(() => pending.promise)
	await f.provider.discover(target)
	const task = f.provider.load(row.id_str)
	f.setCurrent({ ...target, cid: 12, page: 3 })
	pending.resolve(new Response(JSON.stringify(lines)))
	await assert.rejects(task, reason('stale'))
})
void test('logout/invalidation rejects body and subsequent track load', async () => {
	const f = fixture(),
		pending = deferred<Response>()
	f.setBody(() => pending.promise)
	await f.provider.discover(target)
	const task = f.provider.load(row.id_str)
	f.provider.invalidate()
	pending.resolve(new Response(JSON.stringify(lines)))
	await assert.rejects(task, reason('stale'))
	await assert.rejects(f.provider.load(row.id_str), reason('stale'))
})
void test('late discovery cannot replace newer discovery', async () => {
	const f = fixture(),
		pending = deferred<unknown>()
	f.setMetadata(() => pending.promise)
	const first = f.provider.discover(target)
	await new Promise((yes) => setImmediate(yes))
	f.setMetadata(metadata)
	await f.provider.discover(target)
	pending.resolve(metadata())
	await assert.rejects(first, reason('stale'))
	assert.equal((await f.provider.load(row.id_str)).lines.length, 2)
})
void test('caller abort before request prevents network; abort during body prevents delivery', async () => {
	const f = fixture(),
		controller = new AbortController()
	controller.abort()
	await assert.rejects(
		f.provider.discover(target, controller.signal),
		reason('cancelled'),
	)
	assert.equal(f.requests.length, 0)
	await f.provider.discover(target)
	const next = new AbortController(),
		pending = deferred<Response>()
	f.setBody(() => pending.promise)
	const task = f.provider.load(row.id_str, next.signal)
	next.abort()
	pending.resolve(new Response(JSON.stringify(lines)))
	await assert.rejects(task, reason('cancelled'))
})
void test('error text does not expose signed CDN url, payload or arbitrary network errors', async () => {
	const f = fixture()
	await f.provider.discover(target)
	f.setBody(() => {
		throw new Error('secret-cookie=' + row.subtitle_url)
	})
	await assert.rejects(f.provider.load(row.id_str), (error: unknown) => {
		assert.ok(error instanceof BilibiliSubtitleError)
		assert.equal(error.reason, 'unavailable')
		assert.equal(error.cause, undefined)
		assert.equal(error.message.includes('secret'), false)
		return true
	})
})

void test('new track load supersedes older track result without cancelling current discovery', async () => {
	const f = fixture(),
		pending = deferred<Response>()
	await f.provider.discover(target)
	f.setBody(() => pending.promise)
	const first = f.provider.load(row.id_str)
	f.setBody(() => new Response(JSON.stringify(lines)))
	const second = await f.provider.load(row.id_str)
	pending.resolve(new Response(JSON.stringify(lines)))
	await assert.rejects(first, reason('stale'))
	assert.equal(second.lines.length, 2)
})
void test('public track edits cannot change internal fetch target or identity', async () => {
	const f = fixture(),
		result = await f.provider.discover(target)
	result.target.cid = 99
	result.tracks[0].id = '999'
	result.tracks[0].label = 'changed'
	const loaded = await f.provider.load(row.id_str)
	assert.equal(loaded.target.cid, 11)
	assert.equal(loaded.track.label, '中文')
	await assert.rejects(f.provider.load('999'), reason('identity-mismatch'))
})

void test('caller target mutation during discovery cannot redirect the selected P', async () => {
	const f = fixture(),
		pending = deferred<unknown>(),
		original = { ...target }
	f.setView(() => pending.promise)
	const task = f.provider.discover(original)
	original.cid = 99
	original.page = 3
	pending.resolve(view())
	const result = await task
	assert.equal(result.target.cid, 11)
	assert.equal(f.requests[1].params.cid, '11')
})

void test('changed native response URL is rejected without reading it as current subtitle', async () => {
	const f = fixture()
	await f.provider.discover(target)
	f.setFinalUrl('https://evil.invalid/redirect')
	await assert.rejects(f.provider.load(row.id_str), reason('restricted'))
})
void test('missing safe native transport fails closed instead of using global fetch', async () => {
	const provider = new BilibiliSubtitleProvider({
		getSessionGeneration: () => 1,
		getCurrentTarget: () => target,
		classifyFailure: () => 'unavailable',
		requestAuthenticatedJson: async (path: string) =>
			path === '/x/web-interface/view' ? view() : metadata(),
	} as unknown as SubtitleDependencies)
	await provider.discover(target)
	await assert.rejects(provider.load(row.id_str), reason('restricted'))
})
