import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { builtInThemes } from '../core/theme'
import { CreatorSearchSession } from '../creator-search-session'
import { SearchSession } from '../search-session'
import type { SearchPageProps } from '../search-ui'

import {
	node,
	nodes,
	react,
	renderSearchPage,
	text,
} from './search-page-fixture'

const video = {
	type: 'video',
	bvid: 'BV1vT411i7ET',
	title: '原视频',
	author: 'UP',
	mid: 10,
	pic: '//example.com/image.jpg',
	duration: '03:00',
	typename: '音乐综合',
}
const json = (data: unknown, code = 0) =>
	new Response(JSON.stringify({ code, data }))
function requestUrl(input: unknown): URL {
	assert.ok(typeof input === 'string')
	return new URL(input)
}
function requestHeaders(init: RequestInit | undefined): Record<string, string> {
	assert.ok(init?.headers)
	return init.headers as Record<string, string>
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
/** Execute the actual module with fresh cookie/WBI state; no copy of its algorithm. */
function coldModule(fetch: typeof globalThis.fetch, fixedNow?: number) {
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
			Date:
				fixedNow === undefined
					? Date
					: class extends Date {
							static now() {
								return fixedNow ?? Date.now()
							}
						},
			Error,
			TypeError,
			SyntaxError,
		},
	)
	return exports
}
function fixture(readPage: (url: URL) => Promise<Response>) {
	const paths: string[] = []
	const api = coldModule(async (input, init) => {
		const url = requestUrl(input)
		paths.push(url.pathname)
		assert.equal(init?.credentials, 'omit')
		if (url.pathname.endsWith('/spi')) {
			assert.equal(requestHeaders(init).Cookie, undefined)
			return json({ b_3: 'fixture-anonymous', b_4: '' })
		}
		assert.ok(requestHeaders(init).Cookie)
		if (url.pathname.endsWith('/nav'))
			return json(
				{
					wbi_img: {
						img_url: `https://example.com/${'a'.repeat(32)}.png`,
						sub_url: `https://example.com/${'b'.repeat(32)}.png`,
					},
				},
				-101,
			)
		assert.match(url.searchParams.get('w_rid')!, /^[a-f0-9]{32}$/)
		return readPage(url)
	})
	return {
		api,
		paths,
		pageCalls: () => paths.filter((path) => path.endsWith('/type')).length,
	}
}

function pageView(
	session: SearchSession,
	filter: SearchPageProps['filter'] = 'all',
	theme = builtInThemes.modern,
) {
	const creator = new CreatorSearchSession(async (_query, page) => ({
		items: [],
		page,
		more: false,
	}))
	return renderSearchPage(
		{
			query: 'Aimer',
			filter,
			search: {
				...session.getSnapshot(),
				retry: session.retry,
				setOrder: session.setOrder,
				loadMore: session.loadMore,
			},
			creatorSearch: { state: creator.getSnapshot(), session: creator },
			onQueryChange: () => {},
			onFilterChange: () => {},
			onSubmit: () => {},
			onOpenCreator: () => {},
			renderRow: (item) =>
				react.createElement(
					'Result',
					{ bvid: item.bvid },
					item.originalTitle,
				) as unknown as ReturnType<SearchPageProps['renderRow']>,
		},
		theme,
	)
}

void test('cold course-only response is not a genuine empty search in the actual session/page, and next page remains explicit', async () => {
	const f = fixture(async (url) =>
		json({
			page: Number(url.searchParams.get('page')),
			numPages: 2,
			numResults: 2,
			result:
				url.searchParams.get('page') === '1'
					? [{ type: 'ketang', title: '课程', bvid: '' }]
					: [video],
		}),
	)
	const session = new SearchSession(f.api.search)
	await session.find('Aimer')
	assert.equal(session.getSnapshot().error, '')
	assert.equal(session.getSnapshot().page, 1)
	for (const theme of Object.values(builtInThemes))
		for (const filter of ['all', 'music', 'listening'] as const) {
			const view = pageView(session, filter, theme)
			assert.equal(
				node(view, (item) => item.type === 'State').props.title,
				'当前结果没有可展示的视频',
			)
			assert.match(
				String(node(view, (item) => item.type === 'State').props.message),
				/课程/,
			)
			assert.ok(
				nodes(view).some(
					(item) => item.type === 'Button' && text(item) === '加载更多结果',
				),
			)
		}
	assert.equal(
		f.pageCalls(),
		1,
		'known course filtering must not reread or automatically page',
	)
	await session.loadMore()
	assert.equal(f.pageCalls(), 2)
	assert.equal(
		nodes(pageView(session)).filter((item) => item.type === 'Result').length,
		1,
	)
	assert.equal(session.getSnapshot().error, '')
})

void test('mixed course/video page keeps video rendering and music-filter empty distinct; a true empty resets course evidence', async () => {
	const f = fixture(async (url) =>
		json({
			page: 1,
			result:
				url.searchParams.get('keyword') === 'empty'
					? []
					: [{ type: 'ketang' }, { ...video, typename: '知识' }],
			numPages: url.searchParams.get('keyword') === 'empty' ? 0 : 1,
		}),
	)
	const session = new SearchSession(f.api.search)
	await session.find('mixed')
	assert.equal(
		nodes(pageView(session)).filter((item) => item.type === 'Result').length,
		1,
	)
	assert.equal(
		node(pageView(session, 'music'), (item) => item.type === 'State').props
			.title,
		'当前筛选没有匹配音源',
	)
	assert.doesNotMatch(
		String(
			node(pageView(session, 'music'), (item) => item.type === 'State').props
				.message,
		),
		/课程/,
	)
	assert.equal(f.pageCalls(), 1)
	await session.find('empty')
	assert.equal(
		node(pageView(session), (item) => item.type === 'State').props.title,
		'没有找到结果',
	)
	assert.equal(f.pageCalls(), 2)
})

void test('only successful pages add confirmed course counts; failed retry, new query and late old course pages keep ownership', async () => {
	let failSecond = true
	const late = deferred<Response>()
	const f = fixture(async (url) => {
		if (url.searchParams.get('keyword') === 'late') return late.promise
		const page = Number(url.searchParams.get('page'))
		if (page === 2 && failSecond) throw new TypeError('offline')
		if (url.searchParams.get('keyword') === 'malformed')
			return json({
				page,
				numPages: 1,
				result: [{ type: 'unknown', title: '不是已确认课程' }],
			})
		return json({
			page,
			numPages: 2,
			numResults: 3,
			result: Array.from({ length: page }, () => ({ type: 'ketang' })),
		})
	})
	const session = new SearchSession(f.api.search)
	await session.find('courses')
	assert.equal(session.getSnapshot().ketangCount, 1)
	await session.loadMore()
	assert.equal(session.getSnapshot().ketangCount, 1)
	assert.equal(session.getSnapshot().failedPage, 2)
	assert.match(session.getSnapshot().error, /网络连接失败/)
	assert.equal(f.pageCalls(), 2, 'network errors are not automatically retried')
	failSecond = false
	await session.retry()
	assert.equal(session.getSnapshot().ketangCount, 3)
	assert.equal(session.getSnapshot().page, 2)
	assert.equal(session.getSnapshot().more, false)
	assert.equal(f.pageCalls(), 3)
	const lastCoursePage = pageView(session)
	assert.equal(
		node(lastCoursePage, (item) => item.type === 'State').props.title,
		'当前结果没有可展示的视频',
	)
	assert.match(
		String(node(lastCoursePage, (item) => item.type === 'State').props.message),
		/课程/,
	)
	assert.ok(
		!nodes(lastCoursePage).some(
			(item) => item.type === 'Button' && text(item) === '加载更多结果',
		),
	)
	const old = session.find('late')
	await session.find('malformed')
	assert.equal(session.getSnapshot().ketangCount, 0)
	assert.match(session.getSnapshot().error, /搜索响应异常/)
	late.resolve(json({ page: 1, numPages: 1, result: [{ type: 'ketang' }] }))
	await old
	assert.equal(session.getSnapshot().ketangCount, 0)
	assert.equal(session.getSnapshot().submitted, 'malformed')
	assert.equal(
		node(pageView(session), (item) => item.type === 'State').props.title,
		'搜索未完成',
	)
})

void test('concurrent cold keywords and a later warm repeat retain their own actual responses without initialization changes', async () => {
	const firstDevice = deferred<Response>(),
		secondDevice = deferred<Response>()
	let devices = 0,
		navs = 0,
		searches = 0
	const api = coldModule(async (input) => {
		const url = requestUrl(input)
		if (url.pathname.endsWith('/spi'))
			return ++devices === 1 ? firstDevice.promise : secondDevice.promise
		if (url.pathname.endsWith('/nav')) {
			navs++
			return json(
				{
					wbi_img: {
						img_url: `https://example.com/${'a'.repeat(32)}.png`,
						sub_url: `https://example.com/${'b'.repeat(32)}.png`,
					},
				},
				-101,
			)
		}
		searches++
		return json({
			page: 1,
			result: [{ ...video, title: url.searchParams.get('keyword') }],
			numPages: 1,
		})
	})
	const first = api.search('first'),
		second = api.search('second')
	secondDevice.resolve(json({ b_3: 'second-fixture-token' }))
	assert.equal((await second).items[0].originalTitle, 'second')
	firstDevice.resolve(json({ b_3: 'first-fixture-token' }))
	assert.equal((await first).items[0].originalTitle, 'first')
	const beforeRepeat = { devices, navs }
	assert.equal((await api.search('first')).items[0].originalTitle, 'first')
	assert.deepEqual({ devices, navs }, beforeRepeat)
	assert.equal(searches, 3)
})

void test('cancelled cold signing cannot overwrite a later initialization or search when its nav arrives late', async () => {
	const oldNav = deferred<Response>(),
		navEntered = deferred<void>(),
		controller = new AbortController()
	let navs = 0,
		contentCalls = 0
	const signatures: string[] = []
	const signingData = {
		wbi_img: {
			img_url: `https://example.com/${'a'.repeat(32)}.png`,
			sub_url: `https://example.com/${'b'.repeat(32)}.png`,
		},
	}
	const api = coldModule(async (input) => {
		const url = requestUrl(input)
		if (url.pathname.endsWith('/spi')) return json({ b_3: 'fixture-token' })
		if (url.pathname.endsWith('/nav')) {
			if (++navs === 1) {
				navEntered.resolve()
				return oldNav.promise
			}
			return json(signingData, -101)
		}
		contentCalls++
		signatures.push(url.searchParams.get('w_rid')!)
		return json({ page: 1, result: [video], numPages: 1 })
	}, 1792368000000)
	const old = api.search('old', 1, controller.signal)
	await navEntered.promise
	controller.abort()
	assert.equal((await api.search('new')).items.length, 1)
	oldNav.resolve(
		json(
			{ wbi_img: { img_url: 'late-invalid-url', sub_url: 'late-invalid-url' } },
			-101,
		),
	)
	await assert.rejects(old, /取消/)
	assert.equal((await api.search('new')).items.length, 1)
	assert.equal(navs, 2)
	assert.equal(contentCalls, 2)
	assert.equal(
		signatures[0],
		signatures[1],
		'cancelled late nav must not replace the accepted signing key',
	)
})

void test('explicit BV search clears previous course evidence and still bypasses keyword initialization', async () => {
	const calls: string[] = []
	const api = coldModule(async (input) => {
		const url = requestUrl(input)
		calls.push(url.pathname)
		if (url.pathname.endsWith('/spi')) return json({ b_3: 'fixture-token' })
		if (url.pathname.endsWith('/nav'))
			return json(
				{
					wbi_img: {
						img_url: `https://example.com/${'a'.repeat(32)}.png`,
						sub_url: `https://example.com/${'b'.repeat(32)}.png`,
					},
				},
				-101,
			)
		if (url.pathname.endsWith('/view'))
			return json({
				bvid: video.bvid,
				cid: 11,
				title: video.title,
				pic: video.pic,
				duration: 180,
				owner: { mid: 10, name: 'UP' },
				pages: [{ cid: 11, duration: 180 }],
			})
		return json({ page: 1, result: [{ type: 'ketang' }], numPages: 1 })
	})
	const session = new SearchSession(api.search)
	await session.find('course')
	assert.equal(session.getSnapshot().ketangCount, 1)
	const beforeBv = calls.length
	await session.find(video.bvid)
	assert.deepEqual(calls.slice(beforeBv), ['/x/web-interface/view'])
	assert.equal(session.getSnapshot().ketangCount, 0)
	assert.equal(session.getSnapshot().items.length, 1)
	assert.equal(session.getSnapshot().items[0].category, 'BV 精确查找')
})

void test('cold keyword initialization completes before signed search; warm keyword reuses it, while a cold BV lookup bypasses it', async () => {
	const f = fixture(async () =>
		json({ page: 1, result: [video], numPages: 1, numResults: 1 }),
	)
	assert.equal((await f.api.search('Aimer')).items.length, 1)
	assert.deepEqual(f.paths, [
		'/x/frontend/finger/spi',
		'/x/web-interface/nav',
		'/x/web-interface/wbi/search/type',
	])
	await f.api.search('Aimer')
	assert.equal(f.paths.length, 4)
	const paths: string[] = []
	const bv = coldModule(async (input) => {
		paths.push(requestUrl(input).pathname)
		return json({
			bvid: video.bvid,
			cid: 11,
			title: video.title,
			pic: video.pic,
			duration: 180,
			owner: { mid: 10, name: 'UP' },
			pages: [{ cid: 11, duration: 180 }],
		})
	})
	assert.equal((await bv.search(video.bvid)).items.length, 1)
	assert.deepEqual(paths, ['/x/web-interface/view'])
})

for (const nonEmpty of [false, true])
	void test(`wrong-page ${nonEmpty ? 'video result' : 'empty result'} cannot be accepted as the requested first search`, async () => {
		const result = nonEmpty ? [video] : []
		const f = fixture(async () =>
			json({
				page: 2,
				result,
				numPages: result.length ? 2 : 0,
				numResults: result.length,
			}),
		)
		const session = new SearchSession(f.api.search)
		await session.find('Aimer')
		assert.match(session.getSnapshot().error, /搜索响应异常/)
		assert.equal(session.getSnapshot().page, 0)
		assert.equal(session.getSnapshot().failedPage, 1)
		assert.equal(
			f.pageCalls(),
			2,
			'use only the existing bounded shape re-read',
		)
	})

void test('present malformed page fields are rejected; missing page remains compatible, and matching real/beyond-end empties are not retried', async () => {
	for (const page of [null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		const f = fixture(async () =>
			json({ page, result: [], numPages: 0, numResults: 0 }),
		)
		await assert.rejects(f.api.search('Aimer'), /搜索响应异常/)
		assert.equal(f.pageCalls(), 2)
	}
	for (const [requestPage, data] of [
		[1, { result: [], numPages: 0, numResults: 0 }],
		[1, { page: 1, result: [], numPages: 0, numResults: 0 }],
		[2, { page: 2, result: [], numPages: 1, numResults: 1 }],
	] as const) {
		const f = fixture(async () => json(data))
		const result = await f.api.search('Aimer', requestPage)
		assert.equal(result.items.length, 0)
		assert.equal(result.more, false)
		assert.equal(f.pageCalls(), 1)
	}
})

void test('only the existing shape re-read can recover a mismatched page; explicit retry keeps its requested page after failure', async () => {
	let wrong = true
	const f = fixture(async (url) => {
		assert.equal(url.searchParams.get('page'), '1')
		return json({ page: wrong ? 2 : 1, result: [], numPages: 0, numResults: 0 })
	})
	const session = new SearchSession(f.api.search)
	await session.find('Aimer')
	assert.equal(session.getSnapshot().failedPage, 1)
	assert.equal(f.pageCalls(), 2)
	wrong = false
	await session.retry()
	assert.equal(f.pageCalls(), 3)
	assert.equal(session.getSnapshot().page, 1)
	assert.equal(session.getSnapshot().error, '')
	let calls = 0
	const recovered = fixture(async () =>
		json({
			page: ++calls === 1 ? 2 : 1,
			result: [video],
			numPages: 1,
			numResults: 1,
		}),
	)
	assert.equal((await recovered.api.search('Aimer')).items.length, 1)
	assert.equal(recovered.pageCalls(), 2)
})

void test('cancelled cold initialization cannot publish its late device token or continue into signing/search', async () => {
	const oldDevice = deferred<Response>()
	const controller = new AbortController()
	const cookies: string[] = []
	let spiCalls = 0,
		contentCalls = 0
	const api = coldModule(async (input, init) => {
		const path = requestUrl(input).pathname
		if (path.endsWith('/spi'))
			return ++spiCalls === 1
				? oldDevice.promise
				: json({ b_3: 'new-fixture-token' })
		cookies.push(requestHeaders(init).Cookie)
		if (path.endsWith('/nav'))
			return json(
				{
					wbi_img: {
						img_url: `https://example.com/${'a'.repeat(32)}.png`,
						sub_url: `https://example.com/${'b'.repeat(32)}.png`,
					},
				},
				-101,
			)
		contentCalls++
		return json({ page: 1, result: [video], numPages: 1 })
	})
	const old = api.search('Aimer', 1, controller.signal)
	controller.abort()
	assert.equal((await api.search('Aimer')).items.length, 1)
	oldDevice.resolve(json({ b_3: 'old-fixture-token' }))
	await assert.rejects(old, /取消/)
	await api.search('Aimer')
	assert.equal(spiCalls, 2)
	assert.equal(contentCalls, 2)
	assert.ok(
		cookies.every(
			(cookie) =>
				cookie.includes('new-fixture-token') &&
				!cookie.includes('old-fixture-token'),
		),
	)
})
