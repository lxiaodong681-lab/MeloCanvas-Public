import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import type { SearchItem } from '../core/model'
import { CreatorSearchSession } from '../creator-search-session'
import { canSortSearch, type SearchOrder } from '../search-order'
import { SearchSession } from '../search-session'

import { byLabel, nodes, renderSearchPage } from './search-page-fixture'

const item = (bvid: string): SearchItem => ({
	bvid,
	originalTitle: bvid,
	uploader: 'UP',
	uploaderId: 1,
	artwork: '',
	duration: 10,
	category: '音乐',
})
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

void test('order selection is explicit, resets pages and courses, and late old pages cannot enter the new order', async () => {
	const old = deferred<{
		items: SearchItem[]
		more: boolean
		ketangCount?: number
	}>()
	const calls: { page: number; order: SearchOrder; signal: AbortSignal }[] = []
	const session = new SearchSession(async (_input, page, signal, order) => {
		calls.push({ page, order, signal })
		if (calls.length === 2) return old.promise
		return {
			items: [item(order)],
			more: true,
			ketangCount: order === 'relevance' ? 2 : 0,
		}
	})
	await session.find('歌')
	const paging = session.loadMore()
	await session.setOrder('published')
	assert.equal(calls[1].signal.aborted, true)
	assert.deepEqual(
		calls.map(({ page, order }) => [page, order]),
		[
			[1, 'relevance'],
			[2, 'relevance'],
			[1, 'published'],
		],
	)
	assert.equal(session.getSnapshot().ketangCount, 0)
	old.resolve({ items: [item('old-page')], more: false, ketangCount: 8 })
	await paging
	assert.deepEqual(
		session.getSnapshot().items.map((x) => x.bvid),
		['published'],
	)
	assert.equal(session.getSnapshot().page, 1)
	await session.loadMore()
	assert.deepEqual(calls.at(-1) && [calls.at(-1)!.page, calls.at(-1)!.order], [
		2,
		'published',
	])
	await session.setOrder('published')
	assert.equal(calls.length, 4)
})

void test('failed first and next page retry retain order, submitted keyword and cursor', async () => {
	const calls: [string, number, SearchOrder][] = []
	let fail = true
	const session = new SearchSession(async (input, page, _signal, order) => {
		calls.push([input, page, order])
		if (fail) throw Error('暂时失败')
		return { items: [item(String(page))], more: true }
	})
	await session.setOrder('published')
	assert.equal(calls.length, 0)
	await session.find('歌')
	assert.equal(session.getSnapshot().failedPage, 1)
	fail = false
	await session.retry()
	fail = true
	await session.loadMore()
	assert.equal(session.getSnapshot().page, 1)
	assert.equal(session.getSnapshot().failedPage, 2)
	fail = false
	await session.retry()
	assert.deepEqual(calls, [
		['歌', 1, 'published'],
		['歌', 1, 'published'],
		['歌', 2, 'published'],
		['歌', 2, 'published'],
	])
	assert.equal(session.getSnapshot().page, 2)
})

void test('rapid order reversal rejects old success and failure without clearing new loading state', async () => {
	const requests = [
		deferred<{ items: SearchItem[]; more: boolean }>(),
		deferred<{ items: SearchItem[]; more: boolean }>(),
		deferred<{ items: SearchItem[]; more: boolean }>(),
	]
	let i = 0
	const session = new SearchSession(() => requests[i++].promise)
	const first = session.find('歌')
	const next = session.setOrder('published')
	const latest = session.setOrder('relevance')
	requests[1].reject(Error('旧排序失败'))
	await next
	requests[0].resolve({ items: [item('old')], more: false })
	await first
	assert.equal(session.getSnapshot().loading, true)
	assert.equal(session.getSnapshot().error, '')
	requests[2].resolve({ items: [item('latest')], more: false })
	await latest
	assert.deepEqual(
		session.getSnapshot().items.map((x) => x.bvid),
		['latest'],
	)
})

void test('actual search signs pubdate only for latest keywords; default and exact BV keep existing transport', async () => {
	const path = new URL('../bilibili.ts', import.meta.url),
		require = createRequire(path),
		exports = {} as typeof import('../bilibili')
	const paths: URL[] = []
	runInNewContext(
		ts.transpileModule(readFileSync(path, 'utf8'), {
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.CommonJS,
			},
		}).outputText,
		{
			exports,
			require,
			URL,
			AbortController,
			Date,
			Error,
			TypeError,
			SyntaxError,
			setTimeout,
			clearTimeout,
			fetch: async (input: string) => {
				const url = new URL(input)
				paths.push(url)
				let data: unknown = {
					page: Number(url.searchParams.get('page')),
					result: [],
					numPages: 0,
					numResults: 0,
				}
				if (url.pathname.endsWith('/spi')) data = { b_3: 'fixture' }
				if (url.pathname.endsWith('/nav'))
					data = {
						wbi_img: {
							img_url: `https://example.invalid/${'a'.repeat(32)}.png`,
							sub_url: `https://example.invalid/${'b'.repeat(32)}.png`,
						},
					}
				if (url.pathname.endsWith('/view'))
					data = {
						bvid: 'BV1vT411i7ET',
						cid: 1,
						title: 'exact',
						pic: '',
						owner: { name: 'UP', mid: 1 },
						pages: [],
						duration: 1,
					}
				return new Response(JSON.stringify({ code: 0, data }))
			},
		},
	)
	await exports.search('歌')
	await exports.search('歌', 2, undefined, 'published')
	await exports.search('BV1vT411i7ET', 1, undefined, 'published')
	const searches = paths.filter((x) => x.pathname.endsWith('/type'))
	assert.equal(searches[0].searchParams.has('order'), false)
	assert.equal(searches[1].searchParams.get('order'), 'pubdate')
	assert.equal(searches[1].searchParams.get('page'), '2')
	assert.match(searches[1].searchParams.get('w_rid')!, /^[0-9a-f]{32}$/)
	assert.equal(paths.at(-1)!.pathname, '/x/web-interface/view')
	assert.equal(searches.length, 2)
})

void test('real search page exposes accessible order choices, uses submitted query, and hides them for UP or BV', async () => {
	const calls: [string, SearchOrder][] = []
	const search = new SearchSession(async (input, _page, _signal, order) => {
		calls.push([input, order])
		return { items: [], more: false }
	})
	await search.find('已提交')
	const creator = new CreatorSearchSession(async (_input, page) => ({
		items: [],
		page,
		more: false,
	}))
	const props = () => ({
		query: '还没提交',
		filter: 'music' as const,
		search: {
			...search.getSnapshot(),
			retry: search.retry,
			loadMore: search.loadMore,
			setOrder: search.setOrder,
		},
		creatorSearch: { state: creator.getSnapshot(), session: creator },
		onQueryChange: () => {},
		onFilterChange: () => {},
		onSubmit: () => {},
		onOpenCreator: () => {},
		renderRow: () => null,
	})
	const page = renderSearchPage(props())
	assert.equal(
		(
			byLabel(page, '相关优先').props.accessibilityState as {
				selected: boolean
			}
		).selected,
		true,
	)
	;(byLabel(page, '最新发布').props.onPress as () => void)()
	await Promise.resolve()
	assert.deepEqual(calls, [
		['已提交', 'relevance'],
		['已提交', 'published'],
	])
	assert.equal(
		(
			byLabel(renderSearchPage(props()), '最新发布').props
				.accessibilityState as { selected: boolean }
		).selected,
		true,
	)
	assert.equal(
		nodes(renderSearchPage({ ...props(), filter: 'creator' })).some(
			(x) => x.props.accessibilityLabel === '最新发布',
		),
		false,
	)
	await search.find('BV1vT411i7ET')
	assert.equal(
		nodes(renderSearchPage(props())).some(
			(x) => x.props.accessibilityLabel === '最新发布',
		),
		false,
	)
	assert.equal(
		canSortSearch('https://www.bilibili.com/video/BV1vT411i7ET'),
		false,
	)
})
