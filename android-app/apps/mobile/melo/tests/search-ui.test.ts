import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SearchItem } from '../core/model'
import { builtInThemes } from '../core/theme'
import { CreatorSearchSession } from '../creator-search-session'
import { SearchSession } from '../search-session'
import type { SearchPageProps } from '../search-ui'

import {
	byLabel,
	node,
	nodes,
	react,
	renderSearchPage,
	text,
} from './search-page-fixture'

const item: SearchItem = {
	bvid: 'BV1vT411i7ET',
	originalTitle: '真实原标题',
	uploader: '上传者',
	uploaderId: 10,
	artwork: '',
	duration: 203,
	category: '音乐现场',
}
const open: SearchPageProps['onOpenCreator'] = () => {}
function fixture(
	fetchPage: ConstructorParameters<typeof SearchSession>[0] = async () => ({
		items: [],
		more: false,
	}),
) {
	const search = new SearchSession(fetchPage)
	let creatorRequests = 0
	const creator = new CreatorSearchSession(async (_keyword, page) => {
		creatorRequests++
		return { items: [], page, more: false }
	})
	const filters: SearchPageProps['filter'][] = [],
		played: SearchItem[] = []
	const rendered: [SearchItem, number][] = []
	const props = (
		filter: SearchPageProps['filter'] = 'all',
	): SearchPageProps => ({
		query: '尚未提交的输入',
		filter,
		search: {
			...search.getSnapshot(),
			retry: search.retry,
			setOrder: search.setOrder,
			loadMore: search.loadMore,
		},
		creatorSearch: { state: creator.getSnapshot(), session: creator },
		onQueryChange: () => {},
		onFilterChange: (value) => {
			filters.push(value)
		},
		onSubmit: (value = '尚未提交的输入') => search.find(value),
		onOpenCreator: open,
		renderRow: (source, index) => {
			rendered.push([source, index])
			return react.createElement(
				'Result',
				{ onPress: () => played.push(source) },
				source.originalTitle,
			) as unknown as ReturnType<SearchPageProps['renderRow']>
		},
	})
	return {
		search,
		creator,
		props,
		filters,
		played,
		rendered,
		creatorRequests: () => creatorRequests,
	}
}
const state = (view: unknown) => node(view, (value) => value.type === 'State')
const button = (view: unknown, title: string) =>
	node(view, (value) => value.type === 'Button' && text(value) === title)
const press = (value: { props: Record<string, unknown> }) =>
	(value.props.onPress as () => void)()
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

void test('search containers do not render raw text outside native text components', () => {
	const f = fixture()
	for (const filter of ['all', 'music', 'listening', 'creator'] as const) {
		for (const view of nodes(renderSearchPage(f.props(filter)))) {
			if (!['Fragment', 'View', 'ScrollView', 'Pressable'].includes(view.type)) continue
			assert.equal(view.children.flat(Infinity).some((child) =>
				typeof child === 'number' || (typeof child === 'string' && child.length > 0)), false,
			`${filter}: ${view.type} must not contain raw text`)
		}
	}
})

void test('render and partition changes are presentation only, preserving prompts and caller ownership', () => {
	let requests = 0
	const f = fixture(async () => {
		requests++
		return { items: [], more: false }
	})
	for (const filter of ['all', 'music', 'listening', 'creator'] as const) {
		const view = renderSearchPage(f.props(filter))
		const input = node(view, (value) => value.props.testID === 'search-input')
		assert.equal(input.props.value, '尚未提交的输入')
		assert.equal(
			input.props.placeholder,
			filter === 'creator'
				? 'UP 昵称 / mid:123 / UP 主页链接'
				: filter === 'listening'
					? '视频标题 / UP 主 / BV 号'
					: '歌曲关键词 / BV 号',
		)
		const tabs = nodes(view).filter(
			(value) => value.props.accessibilityRole === 'tab',
		)
		assert.equal(tabs.length, 4)
		assert.deepEqual(
			tabs.map(
				(value) =>
					(value.props.accessibilityState as { selected: boolean }).selected,
			),
			['all', 'music', 'listening', 'creator'].map((value) => value === filter),
		)
		for (const tab of tabs) press(tab)
		if (filter !== 'creator')
			assert.equal(
				state(view).props.title,
				filter === 'listening'
					? '搜索听视频'
					: '搜索音乐',
			)
	}
	assert.equal(requests, 0)
	assert.equal(f.creatorRequests(), 0)
	assert.deepEqual(
		f.filters,
		Array.from({ length: 4 }, () => [
			'all',
			'music',
			'listening',
			'creator',
		]).flat(),
	)
})

void test('search landing keeps the input ahead of secondary tools and never contradicts the account login gate', () => {
	const f = fixture()
	const view = renderSearchPage({ ...f.props(), query: '' })
	assert.ok(
		nodes(view).some((viewNode) => viewNode.props.testID === 'search-input'),
	)
	assert.equal(
		nodes(view).some(
			(viewNode) => viewNode.props.testID === 'search-order-controls',
		),
		false,
	)
	assert.doesNotMatch(String(state(view).props.message), /无需登录/)
	assert.equal(
		nodes(view).some((viewNode) => viewNode.type === 'PageTitle'),
		false,
	)
	assert.equal(f.creatorRequests(), 0)
})

void test('first-page failure, pending and successful empty remain distinct; retry uses the submitted keyword', async () => {
	const calls: [string, number][] = []
	let fail = true
	const f = fixture(async (keyword, page) => {
		calls.push([keyword, page])
		if (fail) throw new Error('游客风控，请稍后再试')
		return { items: [], more: false }
	})
	const pending = f.search.find('Aimer')
	assert.equal(state(renderSearchPage(f.props())).props.busy, true)
	await pending
	const failed = renderSearchPage(f.props())
	assert.equal(state(failed).props.title, '搜索未完成')
	assert.equal(state(failed).props.message, '游客风控，请稍后再试')
	assert.ok(text(failed).includes('“Aimer”，已显示 0 条'))
	assert.ok(
		!nodes(failed).some((value) => value.props.title === '没有找到结果'),
	)
	fail = false
	;(state(failed).props.retry as () => void)()
	await settle()
	assert.deepEqual(calls, [
		['Aimer', 1],
		['Aimer', 1],
	])
	assert.equal(state(renderSearchPage(f.props())).props.title, '没有找到结果')
})

void test('music filter empty retains real counts and offers next page only when one exists', async () => {
	for (const more of [false, true]) {
		const f = fixture(async () => ({
			items: [{ ...item, category: '知识' }],
			more,
		}))
		await f.search.find('原词')
		const view = renderSearchPage(f.props('music'))
		assert.equal(state(view).props.title, '当前筛选没有匹配音源')
		assert.equal(
			state(view).props.message,
			more
				? '已加载的音源未标为音乐分区，可查看全部音源，或继续加载下一页。'
				: '已加载的音源未标为音乐分区，可查看全部音源或换一个词。',
		)
		assert.ok(text(view).includes('“原词”，已显示 0 条，已读取 1 条'))
		assert.equal(
			nodes(view).some(
				(value) => value.type === 'Button' && text(value) === '加载更多结果',
			),
			more,
		)
		press(button(view, '查看全部音源（1）'))
		assert.deepEqual(f.filters, ['all'])
		assert.equal(f.rendered.length, 0)
	}
})

void test('later-page failure keeps rows and their exact source callbacks; pagination and retry remain explicit', async () => {
	const calls: [string, number][] = []
	let fail = true
	const second = {
		...item,
		bvid: 'BV11UBfBMEfQ',
		originalTitle: '第二个原标题',
	}
	const f = fixture(async (keyword, page) => {
		calls.push([keyword, page])
		if (page === 2 && fail) throw new Error('下一页暂不可读')
		return { items: page === 1 ? [item] : [second], more: page === 1 }
	})
	await f.search.find('已提交词')
	let view = renderSearchPage(f.props())
	assert.equal(calls.length, 1)
	press(button(view, '加载更多结果'))
	view = renderSearchPage(f.props())
	assert.equal(button(view, '正在加载…').props.disabled, true)
	await settle()
	view = renderSearchPage(f.props())
	assert.equal(state(view).props.title, '下一页加载失败')
	assert.equal(nodes(view).filter((value) => value.type === 'Result').length, 1)
	press(node(view, (value) => value.type === 'Result'))
	assert.equal(f.played[0], item)
	assert.equal(f.rendered[0][0], item)
	assert.equal(f.rendered[0][1], 0)
	fail = false
	;(state(view).props.retry as () => void)()
	await settle()
	view = renderSearchPage(f.props('listening'))
	assert.deepEqual(calls, [
		['已提交词', 1],
		['已提交词', 2],
		['已提交词', 2],
	])
	assert.deepEqual(
		nodes(view)
			.filter((value) => value.type === 'Result')
			.map(text),
		[item.originalTitle, second.originalTitle],
	)
	assert.ok(text(view).includes('“已提交词”，已显示 2 条'))
	assert.ok(!nodes(view).some((value) => value.type === 'State'))
})

void test('UP branch forwards the real independent session, state and open callback without leaking video errors', async () => {
	const f = fixture(async () => {
		throw new Error('视频错误')
	})
	await f.search.find('视频词')
	await f.creator.find('UP词')
	const props = f.props('creator')
	const view = renderSearchPage(props)
	const creator = node(view, (value) => value.type === 'CreatorSearchResults')
	assert.equal(creator.props.state, props.creatorSearch.state)
	assert.equal(creator.props.session, f.creator)
	assert.equal(creator.props.onOpen, props.onOpenCreator)
	assert.ok(
		!nodes(view).some(
			(value) => value.type === 'State' || value.type === 'Result',
		),
	)
	assert.ok(!text(view).includes('视频词'))
	assert.equal(f.creatorRequests(), 1)
})

void test('fresh render uses current callbacks, and each existing theme keeps its input shape, tokens and 48dp targets', () => {
	for (const theme of Object.values(builtInThemes)) {
		const f = fixture()
		let submitted = 0
		const props = {
			...f.props('music'),
			onSubmit: () => {
				submitted++
			},
		}
		const view = renderSearchPage(props, theme)
		const input = node(view, (value) => value.type === 'TextInput')
		assert.equal(input.props.onChangeText, props.onQueryChange)
		assert.equal(
			(input.props.style as { color: string }).color,
			theme.tokens.text.primary,
		)
		assert.equal(input.props.placeholderTextColor, theme.tokens.text.secondary)
		const frame = node(
			view,
			(value) => value.type === 'View' && Array.isArray(value.props.style),
		)
		const styles = frame.props.style as Record<string, unknown>[]
		assert.equal(
			JSON.stringify(styles[1]),
			JSON.stringify({ borderRadius: 11 }),
		)
		assert.equal(styles[2].backgroundColor, theme.tokens.surface.card)
		assert.equal(styles[2].borderColor, theme.tokens.border.subtle)
		assert.equal(
			node(view, (value) => value.type === 'Icon').props.color,
			theme.tokens.text.secondary,
		)
		const submit = byLabel(view, '提交搜索')
		assert.equal((submit.props.style as { minHeight: number }).minHeight, 48)
		assert.equal(
			(
				node(submit, (value) => value.type === 'T').props.style as {
					color: string
				}
			).color,
			theme.tokens.action.primary,
		)
		press(submit)
		assert.equal(submitted, 1)
		const newer = renderSearchPage(
			{
				...props,
				onSubmit: () => {
					submitted += 10
				},
			},
			theme,
		)
		press(byLabel(newer, '提交搜索'))
		assert.equal(submitted, 11)
	}
})

void test('comprehensive preview uses submitted identity and opens all UPs with the same keyword', async () => {
	const f = fixture(async () => ({ items: [item], more: false }))
	await f.search.find('shared keyword')
	await f.creator.find('shared keyword')
	const values: string[] = []
	const props = {
		...f.props(),
		onQueryChange: (value: string) => values.push(value),
	}
	const view = renderSearchPage(props)
	const preview = node(view, (x) => x.props.testID === 'search-creator-preview')
	const group = node(preview, (x) => x.type === 'CreatorSearchResults')
	assert.equal(group.props.state, props.creatorSearch.state)
	;(group.props.preview as { onViewAll: () => void }).onViewAll()
	assert.deepEqual(values, ['shared keyword'])
	assert.deepEqual(f.filters, ['creator'])
	assert.equal(f.creatorRequests(), 1)
	assert.equal(nodes(view).filter((x) => x.type === 'Result').length, 1)
	await f.creator.find('other keyword')
	assert.equal(
		nodes(renderSearchPage(f.props())).some(
			(x) => x.props.testID === 'search-creator-preview',
		),
		false,
	)
})

void test('UP failure and video failure leave the other comprehensive group usable', async () => {
	const f = fixture(async () => ({ items: [item], more: false }))
	await f.search.find('same')
	f.creator.rejectInput('same', new Error('UP failed'))
	const videoAvailable = renderSearchPage(f.props())
	assert.equal(
		nodes(videoAvailable).filter((x) => x.type === 'Result').length,
		1,
	)
	assert.equal(
		(
			node(videoAvailable, (x) => x.type === 'CreatorSearchResults').props
				.state as { error: string }
		).error,
		'UP failed',
	)
	const g = fixture(async () => {
		throw new Error('video failed')
	})
	await g.search.find('same')
	await g.creator.find('same')
	const creatorsAvailable = renderSearchPage(g.props())
	assert.equal(
		node(creatorsAvailable, (x) => x.type === 'CreatorSearchResults').props
			.state,
		g.creator.getSnapshot(),
	)
	assert.equal(state(creatorsAvailable).props.title, '搜索未完成')
})

void test('exact BV filtered out of music remains discoverable through listening without another request', async () => {
	let requests = 0
	const f = fixture(async () => {
		requests++
		return { items: [{ ...item, category: 'BV 精确查找' }], more: false }
	})
	await f.search.find(item.bvid)
	const view = renderSearchPage(f.props('music'))
	assert.match(String(state(view).props.message), /已找到此 BV/)
	press(button(view, '在听视频中查看此 BV'))
	assert.deepEqual(f.filters, ['listening'])
	const listening = renderSearchPage(f.props('listening'))
	assert.equal(nodes(listening).filter((x) => x.type === 'Result').length, 1)
	assert.equal(requests, 1)
})
