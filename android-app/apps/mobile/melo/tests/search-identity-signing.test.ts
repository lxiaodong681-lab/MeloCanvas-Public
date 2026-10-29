import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { PlaybackIntent, playMusicIntent } from '../playback-intent'
import { SearchSession } from '../search-session'

const bvid = 'BV1vT411i7ET'
const otherBvid = 'BV1Q541167Qg'
const video = {
	bvid,
	cid: 1,
	title: '原始标题 &amp; Live',
	pic: '//example.invalid/cover.jpg',
	duration: 300,
	owner: { name: '真实 UP', mid: 88 },
	pages: [{ cid: 111, duration: 299 }],
}
const validKeys = {
	wbi_img: {
		img_url: `https://example.invalid/${'a'.repeat(32)}.png`,
		sub_url: `https://example.invalid/${'b'.repeat(32)}.png`,
	},
}
const json = (data: unknown, code = 0) =>
	new Response(JSON.stringify({ code, data }))

/** Load the actual production module with independent cookie/key caches. */
function coldModule(transport: (url: URL) => Promise<Response>) {
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
			AbortController,
			URL,
			Date,
			Error,
			TypeError,
			SyntaxError,
			fetch: (input: string) => transport(new URL(input)),
			setTimeout,
			clearTimeout,
		},
	)
	return exports
}

void test('music detail and exact BV search reject another valid video identity without retry', async () => {
	let calls = 0
	const api = coldModule(async (url) => {
		calls++
		assert.equal(url.searchParams.get('bvid'), bvid)
		return json({ ...video, bvid: otherBvid })
	})
	await assert.rejects(api.sourceDetails(bvid), /身份不匹配/)
	assert.equal(calls, 1)
	const session = new SearchSession(api.search)
	await session.find(bvid)
	assert.equal(calls, 2)
	assert.equal(session.getSnapshot().page, 0)
	assert.equal(session.getSnapshot().failedPage, 1)
	assert.equal(session.getSnapshot().items.length, 0)
	assert.match(session.getSnapshot().error, /身份不匹配/)
})

void test('wrong BV metadata cannot activate playback; explicit retry can use a corrected response', async () => {
	let reads = 0,
		activated = 0,
		started = 0
	const api = coldModule(async () =>
		json({ ...video, bvid: ++reads === 1 ? otherBvid : bvid }),
	)
	const intent = new PlaybackIntent()
	const actions = {
		resolve: (item: { bvid: string }, signal: AbortSignal) =>
			api.sourceDetails(item.bvid, signal),
		preparation: {
			reservePlayback: async () => ({ token: 1 }),
			isPreparationCurrent: async () => true,
			cancelPreparation: async () => {},
		},
		activate: async () => {
			activated++
			return true
		},
		onPending: () => {},
		onStarted: () => {
			started++
		},
	}
	await assert.rejects(playMusicIntent(intent, { bvid }, actions), /身份不匹配/)
	assert.equal(activated, 0)
	assert.equal(started, 0)
	assert.equal(reads, 1)
	assert.equal(await playMusicIntent(intent, { bvid }, actions), true)
	assert.equal(activated, 1)
	assert.equal(started, 1)
	assert.equal(reads, 2)
})

void test('missing or malformed detail identity is a response error rather than an internal TypeError', async () => {
	for (const data of [null, undefined, [], {}, { ...video, bvid: 7 }]) {
		const api = coldModule(async () => json(data))
		await assert.rejects(api.sourceDetails(bvid), /身份不匹配/)
	}
})

void test('matching music detail preserves first CID, top-level fallback, decoding and BV bypass', async () => {
	let calls = 0
	const api = coldModule(async (url) => {
		calls++
		assert.equal(url.pathname, '/x/web-interface/view')
		return json(calls === 1 ? video : { ...video, pages: [] })
	})
	const source = await api.sourceDetails(bvid)
	assert.equal(source.id, `bilibili:${bvid}:111`)
	assert.equal(source.duration, 299)
	assert.equal(source.originalTitle, '原始标题 & Live')
	assert.equal(source.performer, null)
	assert.equal(source.domain, 'unclassified')
	const result = await api.search(bvid)
	assert.equal(result.items[0].bvid, bvid)
	assert.equal('cid' in result.items[0] && result.items[0].cid, 1)
	assert.equal(result.items[0].category, 'BV 精确查找')
	assert.equal(result.more, false)
	assert.equal(calls, 2)
})

void test('malformed signing material is not cached or used for content; only explicit retry rereads nav', async () => {
	for (const wbi_img of [
		null,
		[],
		{},
		{ ...validKeys.wbi_img, img_url: 42 },
		{ ...validKeys.wbi_img, sub_url: null },
		{
			img_url: 'https://example.invalid/a.png',
			sub_url: 'https://example.invalid/b.png',
		},
		{
			...validKeys.wbi_img,
			img_url: `https://example.invalid/${'z'.repeat(32)}.png`,
		},
		{
			...validKeys.wbi_img,
			img_url: `https://example.invalid/invalid.png?redirect=/${'a'.repeat(32)}.png`,
		},
		{
			...validKeys.wbi_img,
			img_url: `https://example.invalid/invalid.png#/${'a'.repeat(32)}.png`,
		},
	]) {
		let navCalls = 0,
			searchCalls = 0,
			spiCalls = 0
		const api = coldModule(async (url) => {
			if (url.pathname.endsWith('/spi')) {
				spiCalls++
				return json({ b_3: 'fixture-anonymous' })
			}
			if (url.pathname.endsWith('/nav'))
				return json(++navCalls === 1 ? { wbi_img } : validKeys, -101)
			searchCalls++
			assert.equal(url.pathname, '/x/web-interface/wbi/search/type')
			assert.match(url.searchParams.get('w_rid') ?? '', /^[0-9a-f]{32}$/)
			return json({ page: 1, result: [], numPages: 0, numResults: 0 })
		})
		const session = new SearchSession(api.search)
		await session.find('歌曲')
		assert.match(session.getSnapshot().error, /签名信息暂不可用/)
		assert.equal(session.getSnapshot().page, 0)
		assert.equal(session.getSnapshot().failedPage, 1)
		assert.equal(navCalls, 1)
		assert.equal(searchCalls, 0)
		await session.retry()
		assert.equal(navCalls, 2)
		assert.equal(searchCalls, 1)
		assert.equal(session.getSnapshot().error, '')
		assert.equal(session.getSnapshot().page, 1)
		await session.find('下一首')
		assert.equal(navCalls, 2, 'Only valid signing material warms the cache')
		assert.equal(spiCalls, 1)
		assert.equal(searchCalls, 2)
	}
})

void test('signing URL query and fragment do not replace valid path materials or change the signature', async () => {
	const params = { keyword: '歌曲', wts: 'fixture' }
	const plain = coldModule(async () => json(validKeys, -101))
	const decorated = coldModule(async () =>
		json(
			{
				wbi_img: {
					img_url: `${validKeys.wbi_img.img_url}?cache=example.invalid`,
					sub_url: `${validKeys.wbi_img.sub_url}#/${'c'.repeat(32)}.png`,
				},
			},
			-101,
		),
	)
	// Freeze only the timestamp input, retaining real MD5 and production mixing.
	const originalNow = Date.now
	Date.now = () => 1700000000000
	try {
		assert.equal(await decorated.signed(params), await plain.signed(params))
	} finally {
		Date.now = originalNow
	}
})

void test('non-URLs and missing filename extensions cannot truncate into a cached signing key', async () => {
	for (const img_url of [
		'a'.repeat(33),
		`${'a'.repeat(32)}.png`,
		`https://example/${'a'.repeat(33)}`,
		`https://example.invalid/${'a'.repeat(32)}.`,
		`https://example.invalid/${'a'.repeat(32)}.png/`,
		`file:///${'a'.repeat(32)}.png`,
	]) {
		let navCalls = 0
		const api = coldModule(async () => {
			navCalls++
			return json({ wbi_img: { ...validKeys.wbi_img, img_url } }, -101)
		})
		await assert.rejects(api.signed({ keyword: '歌曲' }), /签名信息暂不可用/)
		await assert.rejects(api.signed({ keyword: '歌曲' }), /签名信息暂不可用/)
		assert.equal(navCalls, 2, 'Rejected material never warms the shared cache')
	}
})

void test('batch option disables incomplete-payload reread while ordinary search keeps bounded compatibility', async () => {
	for (const reread of [false, true]) {
		const paths: string[] = []
		const api = coldModule(async (url) => {
			paths.push(url.pathname)
			if (url.pathname.endsWith('/spi'))
				return json({ b_3: 'fixture-anonymous', b_4: '' })
			if (url.pathname.endsWith('/nav')) return json(validKeys, -101)
			return json({ unexpected: 'synthetic incomplete response' })
		})
		await assert.rejects(
			api.search(
				'翻唱 Live 实际表演者',
				1,
				new AbortController().signal,
				'relevance',
				reread,
			),
			/响应异常/,
		)
		assert.equal(
			paths.filter((path) => path.endsWith('/search/type')).length,
			reread ? 2 : 1,
		)
		assert.equal(paths.filter((path) => path.endsWith('/spi')).length, 1)
		assert.equal(paths.filter((path) => path.endsWith('/nav')).length, 1)
	}
})
