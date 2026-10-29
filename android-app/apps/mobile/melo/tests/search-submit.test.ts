import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import {
	creatorSearchMid,
	creatorSearchTarget,
} from '../creator-search-selection'
import { SearchHistory } from '../search-history'
import type { SearchPageProps } from '../search-ui'

import {
	byLabel,
	compile,
	node,
	react,
	renderSearchPage,
} from './search-page-fixture'

function fixture(
	query: string,
	filter = 'all',
	videoRequest: (value: string) => Promise<void> = async () => {},
	creatorRequest: (value: string) => Promise<void> = async () => {},
) {
	const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
	const tree = ts.createSourceFile(
		'App.tsx',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	let find = '',
		page = ''
	function visit(astNode: ts.Node) {
		if (ts.isFunctionDeclaration(astNode) && astNode.name?.text === 'find')
			find = astNode.getText(tree)
		if (
			ts.isJsxSelfClosingElement(astNode) &&
			astNode.tagName.getText(tree) === 'SearchPage'
		)
			page = astNode.getText(tree)
		ts.forEachChild(astNode, visit)
	}
	visit(tree)
	assert(find && page)
	const history = new SearchHistory({
		setting: () => null,
		setSetting: () => {},
	})
	const orders: unknown[] = []
	const sent: string[] = [],
		controlled: string[] = [],
		creators: string[] = [],
		filters: string[] = [],
		rejected: string[] = []
	let cancellations = 0
	// Execute App's real submission function and actual SearchPage prop wiring.
	const element = runInNewContext(
		compile(`${find}\nglobalThis.page = ${page}`) + '\npage',
		{
			React: react,
			SearchPage: 'SearchPage',
			query,
			filter,
			searchHistory: { state: history.getSnapshot(), session: history },
			search: {
				order: 'relevance',
				submitted: '',
				items: [],
				page: 0,
				more: false,
				loading: false,
				error: '',
				failedPage: null,
			},
			creatorSearchTarget,
			creatorSearchMid,
			Keyboard: { dismiss: () => {} },
			setQuery: (value: string) => controlled.push(value),
			setFilter: (value: string) => filters.push(value),
			runSearch: async (value: string, _page: number, order: string) => {
				orders.push(order)
				sent.push(value)
				await videoRequest(value)
			},
			openCreatorSummary: () => {},
			row: () => null,
			creatorSearch: {
				state: {},
				session: {
					cancel: () => {
						cancellations++
					},
					find: async (value: string) => {
						creators.push(value)
						await creatorRequest(value)
					},
					rejectInput: (value: string) => rejected.push(value),
				},
			},
		},
	) as { props: SearchPageProps }
	const view = renderSearchPage(element.props)
	const actions = {
		submit: node(view, (item) => item.props.testID === 'search-input').props
			.onSubmitEditing as (event: { nativeEvent: { text: string } }) => void,
		button: byLabel(view, '提交搜索').props.onPress as () => void,
	}
	return {
		actions,
		history,
		replay: element.props.onSelectHistory!,
		sent,
		orders,
		controlled,
		creators,
		filters,
		rejected,
		cancellations: () => cancellations,
	}
}
void test('actual IME submit uses native event text and synchronizes controlled input despite an older render query', async () => {
	const f = fixture('Ai')
	f.actions.submit({ nativeEvent: { text: 'Aimer' } })
	await Promise.resolve()
	assert.deepEqual(f.sent, ['Aimer'])
	assert.deepEqual(f.controlled, ['Aimer'])
	assert.deepEqual(f.creators, ['Aimer'])
})

void test('empty IME text is submitted unchanged; button search still reads the current render query', async () => {
	const f = fixture('old keyword')
	f.actions.submit({ nativeEvent: { text: '' } })
	await Promise.resolve()
	assert.deepEqual(f.sent, [''])
	assert.deepEqual(f.history.getSnapshot().items, [])
	assert.deepEqual(f.controlled, [''])
	f.actions.button()
	await Promise.resolve()
	assert.deepEqual(f.sent, ['', 'old keyword'])
})

void test('actual submit preserves existing UP, strict BV and invalid BV routing', async () => {
	const creator = fixture('old', 'creator')
	creator.actions.submit({ nativeEvent: { text: '真实UP关键词' } })
	await Promise.resolve()
	assert.deepEqual(creator.creators, ['真实UP关键词'])
	assert.deepEqual(creator.sent, [])
	const video = fixture('old', 'creator')
	video.actions.submit({ nativeEvent: { text: 'BV1vT411i7ET' } })
	await Promise.resolve()
	assert.deepEqual(video.sent, ['BV1vT411i7ET'])
	assert.deepEqual(video.filters, ['all'])
	assert.equal(video.cancellations(), 1)
	const invalid = fixture('old', 'creator')
	invalid.actions.submit({ nativeEvent: { text: 'BVbad' } })
	await Promise.resolve()
	assert.deepEqual(invalid.rejected, ['BVbad'])
	assert.deepEqual(invalid.sent, [])
})

void test('comprehensive explicit submit starts both routes without waiting for video completion', async () => {
	let finish!: () => void
	const video = new Promise<void>((resolve) => {
		finish = resolve
	})
	let creatorCompleted = false
	const f = fixture(
		'same keyword',
		'all',
		() => video,
		async () => {
			creatorCompleted = true
		},
	)
	assert.deepEqual(f.sent, [])
	assert.deepEqual(f.creators, [])
	f.actions.button()
	await Promise.resolve()
	assert.deepEqual(f.sent, ['same keyword'])
	assert.deepEqual(f.creators, ['same keyword'])
	assert.equal(creatorCompleted, true)
	finish()
})

void test('exact BV, invalid input and music/listening searches never issue UP requests', async () => {
	for (const [query, filter] of [
		['BV1vT411i7ET', 'all'],
		['BVbad', 'all'],
		['', 'all'],
		['https://example.com/video/BV1vT411i7ET', 'all'],
		['music', 'music'],
		['speech', 'listening'],
	]) {
		const f = fixture(query, filter)
		f.actions.button()
		await Promise.resolve()
		assert.deepEqual(f.sent, [query])
		assert.deepEqual(f.creators, [])
		assert.equal(f.cancellations(), 1)
	}
})

void test('explicit UP identities route only to UP results from every category', async () => {
	for (const filter of ['all', 'music', 'listening', 'creator']) {
		for (const query of [
			'mid:9007199254740993',
			'https://space.bilibili.com/88?from=search',
		]) {
			const f = fixture(query, filter)
			f.actions.button()
			await Promise.resolve()
			assert.deepEqual(f.sent, [])
			assert.deepEqual(f.creators, [query])
			assert.deepEqual(f.filters, ['creator'])
		}
	}
	const invalid = fixture('mid:0')
	invalid.actions.button()
	await Promise.resolve()
	assert.deepEqual(invalid.sent, [])
	assert.deepEqual(invalid.creators, [])
	assert.deepEqual(invalid.rejected, ['mid:0'])
})

void test('actual submission records once including failures; history replay restores query, kind and resubmits', async () => {
	const f = fixture(
		'original',
		'creator',
		async () => {
			throw new Error('offline')
		},
		async () => {
			throw new Error('offline')
		},
	)
	f.actions.button()
	await Promise.resolve()
	assert.deepEqual(f.history.getSnapshot().items, [
		{ query: 'original', kind: 'creator', order: 'relevance' },
	])
	f.replay({ query: 'restored', kind: 'creator', order: 'published' })
	await Promise.resolve()
	assert.deepEqual(f.controlled, ['restored'])
	assert.deepEqual(f.filters, ['creator'])
	assert.deepEqual(f.creators, ['original', 'restored'])
	assert.deepEqual(f.history.getSnapshot().items[0], {
		query: 'restored',
		kind: 'creator',
		order: 'published',
	})
})

void test('actual video history replay restores saved sort instead of current default', async () => {
	const f = fixture('current')
	f.replay({ query: 'saved', kind: 'music', order: 'published' })
	await Promise.resolve()
	assert.deepEqual(f.controlled, ['saved'])
	assert.deepEqual(f.filters, ['music'])
	assert.deepEqual(f.sent, ['saved'])
	assert.deepEqual(f.orders, ['published'])
	assert.deepEqual(f.creators, [])
})
