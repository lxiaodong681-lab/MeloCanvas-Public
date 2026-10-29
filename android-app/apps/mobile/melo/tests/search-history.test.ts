import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'
import { CreatorSearchSession } from '../creator-search-session'
import { SearchHistory, SEARCH_HISTORY_KEY } from '../search-history'
import { SearchSession } from '../search-session'
import type { SearchPageProps } from '../search-ui'

import { byLabel, node, renderSearchPage, text } from './search-page-fixture'

function fixture(raw: string | null = null) {
	let value = raw
	let fail = false
	const writes: string[] = []
	const storage = {
		setting: (key: string) => {
			assert.equal(key, SEARCH_HISTORY_KEY)
			return value
		},
		setSetting: (key: string, next: string) => {
			assert.equal(key, SEARCH_HISTORY_KEY)
			if (fail) throw new Error('Disk unavailable')
			writes.push(next)
			value = next
		},
	}
	return {
		history: new SearchHistory(storage),
		storage,
		writes,
		fail: () => {
			fail = true
		},
	}
}
void test('explicit submissions trim edges only, deduplicate by exact query/kind/order and cap at 30', () => {
	const { history } = fixture()
	history.record('   ', 'all', 'relevance')
	assert.equal(history.getSnapshot().items.length, 0)
	for (let i = 0; i < 32; i++) history.record(`q${i}`, 'all', 'relevance')
	assert.equal(history.getSnapshot().items.length, 30)
	assert.equal(history.getSnapshot().items.at(-1)?.query, 'q2')
	history.record(' q10 ', 'all', 'relevance')
	assert.equal(history.getSnapshot().items[0].query, 'q10')
	assert.equal(history.getSnapshot().items.length, 30)
	for (const entry of [
		['BVAbCd', 'music', 'relevance'],
		['BVabcd', 'music', 'relevance'],
		['BVAbCd', 'listening', 'relevance'],
		['BVAbCd', 'music', 'published'],
		['a  b', 'all', 'relevance'],
		['a b', 'all', 'relevance'],
	] as const)
		history.record(entry[0], entry[1], entry[2])
	assert.equal(
		new Set(
			history
				.getSnapshot()
				.items.slice(0, 6)
				.map((item) => JSON.stringify(item)),
		).size,
		6,
	)
})
void test('restart restores valid local data without trusting malformed entries', () => {
	const { history, storage } = fixture()
	history.record('test', 'creator', 'relevance')
	assert.deepEqual(
		new SearchHistory(storage).getSnapshot().items,
		history.getSnapshot().items,
	)
	assert.equal(fixture('{broken').history.getSnapshot().items.length, 0)
	assert.match(fixture('{}').history.getSnapshot().error, /无法读取/)
	const raw = JSON.stringify([
		null,
		{},
		{ query: 'ok', kind: 'all', order: 'published' },
		{ query: 'bad', kind: 'unknown', order: 'published' },
	])
	assert.deepEqual(fixture(raw).history.getSnapshot().items, [
		{ query: 'ok', kind: 'all', order: 'published' },
	])
})
void test('clear requires confirmation; cancel and failed clear preserve original records', () => {
	const f = fixture()
	f.history.record('keep', 'music', 'relevance')
	f.history.confirmClear()
	assert.equal(f.history.getSnapshot().items.length, 1)
	f.history.requestClear()
	f.history.cancelClear()
	f.history.confirmClear()
	assert.equal(f.history.getSnapshot().items.length, 1)
	f.fail()
	f.history.requestClear()
	f.history.confirmClear()
	assert.equal(f.history.getSnapshot().items.length, 1)
	assert.match(f.history.getSnapshot().error, /清空失败/)
})
void test('network completions cannot resurrect cleared history and subsequent submissions remain valid', async () => {
	const f = fixture()
	let finish!: (result: { items: []; more: false }) => void
	const search = new SearchSession(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	f.history.record('old', 'all', 'relevance')
	const pending = search.find('old')
	f.history.requestClear()
	f.history.confirmClear()
	finish({ items: [], more: false })
	await pending
	assert.deepEqual(f.history.getSnapshot().items, [])
	assert.deepEqual(new SearchHistory(f.storage).getSnapshot().items, [])
	f.history.record('new', 'all', 'relevance')
	assert.equal(new SearchHistory(f.storage).getSnapshot().items[0].query, 'new')
})
void test('failed network searches remain recorded; persistence failure never prevents searching', async () => {
	const f = fixture()
	f.fail()
	const search = new SearchSession(async () => {
		throw new Error('offline')
	})
	f.history.record('retry me', 'all', 'relevance')
	await search.find('retry me')
	assert.equal(search.getSnapshot().error, 'offline')
	assert.equal(f.history.getSnapshot().items[0].query, 'retry me')
	assert.match(f.history.getSnapshot().error, /暂未保存/)
})
void test('actual App records only at submission and restores explicit query, kind and order on history taps', () => {
	const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
	assert.equal(source.match(/searchHistory\.session\.record\(/g)?.length, 1)
	assert.match(
		source,
		/async function find\(value = query, kind = filter, order = search.order\)/,
	)
	assert.ok(
		source.indexOf('searchHistory.session.record(value, kind, order)') <
			source.indexOf('await creatorSearch.session.find(value)'),
	)
	assert.match(
		source,
		/setQuery\(entry.query\)[\s\S]*setFilter\(entry.kind\)[\s\S]*void find\(entry.query, entry.kind, entry.order\)/,
	)
	assert.match(source, /onQueryChange=\{setQuery\}/)
	assert.equal(source.match(/runSearch\(value, 1, order\)/g)?.length, 3)
})
void test('real themed search UI exposes compact replay and explicit clear/cancel without showing history over results', () => {
	const f = fixture()
	f.history.record('keyword', 'listening', 'published')
	const search = new SearchSession(async () => ({ items: [], more: false }))
	const creator = new CreatorSearchSession(async (_query, page) => ({
		items: [],
		more: false,
		page,
	}))
	let selected: unknown
	const props = (): SearchPageProps => ({
		query: '',
		filter: 'all',
		search: {
			...search.getSnapshot(),
			retry: search.retry,
			loadMore: search.loadMore,
			setOrder: search.setOrder,
		},
		creatorSearch: { state: creator.getSnapshot(), session: creator },
		onQueryChange() {},
		onFilterChange() {},
		onSubmit() {},
		onOpenCreator() {},
		renderRow() {
			return null
		},
		history: { state: f.history.getSnapshot(), session: f.history },
		onSelectHistory(entry) {
			selected = entry
		},
	})
	for (const theme of Object.values(builtInThemes)) {
		const view = renderSearchPage(props(), theme)
		const chip = byLabel(view, '再次搜索 keyword，听视频，最新')
		assert.equal(chip.props.minimumWidthDp, 96)
		;(chip.props.onPress as () => void)()
		assert.deepEqual(selected, {
			query: 'keyword',
			kind: 'listening',
			order: 'published',
		})
	}
	;(
		byLabel(renderSearchPage(props()), '清空搜索历史').props
			.onPress as () => void
	)()
	assert.equal(f.history.getSnapshot().items.length, 1)
	const confirmed = renderSearchPage(props())
	node(confirmed, (n) => n.props.testID === 'search-history-clear-confirmation')
	const modal = node(confirmed, (n) => n.type === 'Modal')
	assert.ok(modal, 'clear confirmation must be a modal')
	;(modal.props.onRequestClose as () => void)()
	assert.equal(f.history.getSnapshot().confirmClear, false)
	assert.equal(f.history.getSnapshot().items.length, 1)
	f.history.requestClear()
	;(
		node(confirmed, (n) => n.type === 'Button' && text(n) === '取消清空').props
			.onPress as () => void
	)()
	assert.equal(f.history.getSnapshot().confirmClear, false)
	assert.equal(
		text(renderSearchPage({ ...props(), query: 'typing' })).includes(
			'最近搜索',
		),
		false,
	)
})

void test('history chips retain 96dp measured package targets and larger-font labels', async () => {
	const { controlNodes } = await import('./theme-control-fixture')
	const { packageTheme } = await import('./theme-import-fixture')
	const { searchHost, searchProps, measure, native } =
		await import('./theme-search-fixture')
	const f = searchHost(),
		history = fixture().history
	history.record('a long searchable title', 'music', 'relevance')
	f.viewport.fontScale = 2
	const element = f.pack(
		f.page(
			searchProps({
				query: '',
				history: { state: history.getSnapshot(), session: history },
			}),
		),
		packageTheme(),
	)
	let tree = f.render(element)
	const section = native(tree, 'search-history')
	for (const measurement of controlNodes(section).filter(
		(n) => typeof n.props.onLayout === 'function',
	))
		measure(measurement, 180)
	tree = f.render(element)
	const chip = native(tree, '再次搜索 a long searchable title，音乐分区')
	const style = f.flatten(
		(chip.props.style as (v: unknown) => unknown)({ pressed: false }),
	)
	assert.equal(style.minHeight, 96)
	assert.ok(Number(style.minWidth) >= 96)
	assert.equal(style.height, undefined)
	assert.notEqual(chip.props.disabled, true)
})

void test('backup restore and undo reload history before subsequent submissions', () => {
	const { history, storage } = fixture()
	history.record('old in-memory query', 'all', 'relevance')
	history.requestClear()
	const restored = [
		{ query: 'restored query', kind: 'music', order: 'published' },
	]
	storage.setSetting(SEARCH_HISTORY_KEY, JSON.stringify(restored))
	history.reload()
	assert.deepEqual(history.getSnapshot().items, restored)
	assert.equal(history.getSnapshot().confirmClear, false)
	history.record('next query', 'all', 'relevance')
	assert.deepEqual(
		history.getSnapshot().items.map((item) => item.query),
		['next query', 'restored query'],
	)
	storage.setSetting(SEARCH_HISTORY_KEY, '[]')
	history.reload()
	assert.deepEqual(history.getSnapshot().items, [])
	const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
	assert.match(
		app,
		/<LibraryBackupEntry\s+onRestored=\{\(\) => \{[^}]*searchHistory\.session\.reload\(\)/,
	)
})

void test('failed restore reload cannot write stale history over restored SQLite data', () => {
	let value = JSON.stringify([
		{ query: 'before', kind: 'all', order: 'relevance' },
	])
	let unreadable = false
	let writes = 0
	const history = new SearchHistory({
		setting: () => {
			if (unreadable) throw new Error('synthetic read failure')
			return value
		},
		setSetting: (_key, next) => {
			writes++
			value = next
		},
	})
	value = JSON.stringify([
		{ query: 'restored', kind: 'music', order: 'published' },
	])
	unreadable = true
	history.reload()
	history.record('must not overwrite', 'all', 'relevance')
	assert.equal(writes, 0)
	unreadable = false
	history.record('retry after recovery', 'all', 'relevance')
	assert.equal(writes, 1)
	assert.deepEqual(
		history.getSnapshot().items.map((item) => item.query),
		['retry after recovery', 'restored'],
	)
})
