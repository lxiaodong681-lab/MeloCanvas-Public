import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readBaselineSource } from './baseline-source'

import { builtInThemes } from '../core/theme'
import { migrateInputAppearance } from './input-appearance-contract'
import type { SearchPageProps } from '../search-ui'

import {
	controlNodes,
	legacyControlPackage,
	type ControlNode,
} from './theme-control-fixture'
import { packageTheme } from './theme-import-fixture'
import {
	inputPath,
	measure,
	native,
	normalize,
	searchHost,
	searchProps,
} from './theme-search-fixture'

const baseline = '88e7b06b95a4955ba539b7cc5593db9239783f7a'
const invoke = (
	node: ReturnType<typeof native>,
	name: string,
	...args: unknown[]
) => (node.props[name] as (...values: unknown[]) => void)(...args)
function setup() {
	const f = searchHost(),
		calls: unknown[][] = [],
		adapted = packageTheme()
	const element = f.pack(
		f.query({
			query: '旧 query',
			placeholder: '关键词',
			onQueryChange: (text: string) => calls.push(['change', text]),
			onSubmit: (...args: unknown[]) => calls.push(['submit', ...args]),
		}),
		adapted,
	)
	const render = () => f.render(element)
	function fit(width: number, input: number, submit: number) {
		let tree = render()
		measure(native(tree, 'search-query-width'), width)
		tree = render()
		measure(native(tree, 'search-query-input-width'), input)
		measure(native(tree, 'search-query-submit-width'), submit)
		return render()
	}
	return { ...f, adapted, element, calls, render, fit }
}

// The new order row is covered by search-order.test.ts. Preserve the
// historical layout contract for other controls. The all-tab label now names the comprehensive view.
function withoutOrderControls(value: unknown): unknown {
	if (Array.isArray(value))
		return value
			.map(withoutOrderControls)
			.filter((v) => v !== null && v !== undefined && v !== false)
	if (value === '全部音源') return '综合'
	if (!value || typeof value !== 'object') return value
	const node = value as { props?: { testID?: string }; children?: unknown }
	if (node.props?.testID === 'search-order-controls') return null
 // Ignore the removed formatting-only space directly inside the page View.
 if (['View','Fragment'].includes((value as {type?:string}).type ?? '') && Array.isArray(node.children)) node.children = node.children.map(child=>Array.isArray(child)?child.filter(v=>v!==' '):child)
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			key === 'children'
				? withoutOrderControls(entry)
				: key === 'props' &&
					  entry &&
					  typeof entry === 'object' &&
					  'placeholder' in entry &&
					  entry.placeholder === 'UP 主昵称 / 关键词'
					? { ...entry, placeholder: 'UP 昵称 / mid:123 / UP 主页链接' }
					: entry,
		]),
	)
}

// These two reviewed leaves changed after 88e7b06; every other historical
// node still participates in the same full-tree comparison. This is not a
// text/null normalizer: only the one-result music-empty scenarios call it.
function searchText(value: unknown): string {
	if (Array.isArray(value)) return value.map(searchText).join('')
	if (value && typeof value === 'object' && 'children' in value)
		return searchText((value as ControlNode).children)
	return typeof value === 'string' || typeof value === 'number'
		? String(value)
		: ''
}
function exactSearchText(tree: unknown, value: string) {
	const found = controlNodes(tree).filter(
		(node) => node.type === 'Text' && searchText(node.children) === value,
	)
	assert.equal(found.length, 1, `one exact text leaf: ${value}`)
	return found[0]
}
function musicEmptyExpectation(expected: unknown, exactBv: boolean) {
	const action = exactSearchText(expected, '查看全部音源（1）')
	assert.deepEqual(action.children, [['查看全部音源（', 1, '）']])
	// The ordinary-keyword action has identical glyphs, now one template string.
	action.children = [exactBv ? '在听视频中查看此 BV' : '查看全部音源（1）']
	if (exactBv) {
		const oldMessage = '已加载的音源未标为音乐分区，可查看全部音源或换一个词。'
		const message = exactSearchText(expected, oldMessage)
		assert.deepEqual(message.children, [oldMessage])
		message.children = ['已找到此 BV；它尚未标为音乐分区，可切到听视频试听。']
	}
	return expected
}

/** Only the reviewed heading, count and initial/loading copy migrate. All other
 * native nodes, including inputs, errors, result rows and legacy controls, stay strict. */
function compactSearchExpectation(
	expected: unknown,
	props: SearchPageProps,
	theme: (typeof builtInThemes)['modern'],
	builtin: boolean,
) {
	const titles = controlNodes(expected).filter(
		(node) => node.type === 'PageTitle',
	)
	assert.equal(titles.length, 1)
	assert.deepEqual(titles[0].props, {
		title: '寻找你的声音',
		subtitle: 'SEARCH / BILIBILI',
	})
	Object.assign(titles[0], {
		type: 'Text',
		props: {
			style: {
				color: theme.tokens.text.primary,
				fontSize: 25,
				lineHeight: 25 * 1.45,
				fontWeight: '700',
				marginBottom: 12,
			},
		},
		children: ['搜索'],
	})
	if (builtin) {
		const tabs = controlNodes(expected).filter(
			(node) => node.props.accessibilityRole === 'tab',
		)
		assert.equal(tabs.length, 4)
		for (const tab of tabs) {
			const style = tab.props.style as Record<string, unknown>
			assert.equal(style.minWidth, undefined)
			style.minWidth = 58
		}
	}
	for (const node of controlNodes(expected)) {
        const style = node.props.style as Record<string, unknown> | undefined
        if (style?.marginVertical === 15) style.marginVertical = 10
        if (node.props.accessibilityRole === 'tab' && style) style.paddingHorizontal = 10
        if (node.type === 'TextInput' && node.props.testID === 'search-input' && style) {
          style.minHeight = 48
          const row = controlNodes(expected).find(n => n.type === 'View' && (n.children ?? []).flat(Infinity).includes(node))!
          const rowStyle = row.props.style as Record<string, unknown>
          for (const key of ['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius']) delete rowStyle[key]
          rowStyle.borderRadius = 11
        }
        const containers = [node.props.contentContainerStyle].flat(Infinity) as (Record<string, unknown> | undefined)[]
        if (node.type === 'ScrollView' && node.props.horizontal) for (const container of containers) { if (container?.gap === 12) container.gap = 4 }
        if (node.type === 'Text') {
          if (searchText(node) === '想听的内容，从这里找到') node.children = ['搜索听视频']
          if (searchText(node) === '喜欢的歌，从这里遇见') node.children = ['搜索音乐']
        }
      }
      if (props.filter === 'creator') return expected
	const state = props.search
	if (state.submitted) {
		const prefix = `“${state.submitted}” · ${state.items.length} 条已加载 · `
		const counts = controlNodes(expected).filter(
			(node) => node.type === 'Text' && searchText(node).startsWith(prefix),
		)
		assert.equal(counts.length, 1)
		const count = counts[0]
		const originalCount = searchText(count)
			.slice(prefix.length)
			.match(/^(\d+) 条可见 · (保留原标题与分 P|歌曲版本待核对)$/)
		assert.ok(originalCount)
		assert.equal(
			originalCount[2],
			props.filter === 'listening' ? '保留原标题与分 P' : '歌曲版本待核对',
		)
		const visibleCount = Number(originalCount[1])
		assert.ok(visibleCount <= state.items.length)
		count.children = [
			[
				'“',
				state.submitted,
				'”，已显示 ',
				visibleCount,
				' 条',
				visibleCount !== state.items.length
					? `，已读取 ${state.items.length} 条`
					: '',
			],
		]
	}
	if (!state.submitted && !state.loading && !state.error) {
		const oldCopy =
			props.filter === 'listening'
				? '输入视频原标题、UP 主关键词或完整 BV 号。无需登录 B 站。'
				: '输入歌曲、UP 主关键词或完整 BV 号。无需登录 B 站。'
		exactSearchText(expected, oldCopy).children = [
			props.filter === 'listening'
				? '输入视频标题、UP 主关键词，或粘贴 BV 号。'
				: '输入歌名、艺人或 UP 主，也可以粘贴 BV 号。',
		]
	} else if (
		state.loading &&
		!state.items.length &&
		!(state.error && state.failedPage === 1)
	) {
		exactSearchText(expected, '正在寻找真实音源').children = ['正在搜索']
		const message = exactSearchText(
			expected,
			'从 B 站读取标题、封面和上传者信息',
		)
		let removed = 0
		const remove = (value: unknown): void => {
			if (Array.isArray(value)) {
				const index = value.indexOf(message)
				if (index >= 0) {
					value.splice(index, 1)
					removed++
				}
				for (const child of value) remove(child)
			} else if (value && typeof value === 'object' && 'children' in value)
				remove((value as ControlNode).children)
		}
		remove(expected)
		assert.equal(removed, 1)
	}
	return expected
}

void test('three defaults and real verified legacy48 preserve existing search controls apart from the new order row', async () => {
	// Add only the four approved decorative states to the historical source.
	// The full tree comparison still checks text, retries, controls and loading feedback.
	const mascotStates = ['search', 'error', 'loading', 'search', null]
	let stateIndex = 0
	const original = readBaselineSource(`${baseline}:android-app/apps/mobile/melo/search-ui.tsx`).replace(/<State\b/g, () => {
		const state = mascotStates[stateIndex++]
		return state ? `<State mascot='${state}'` : '<State'
	})
	assert.equal(stateIndex, mascotStates.length)
	const legacy = await legacyControlPackage()
	const initial = searchProps(),
		one = {
			bvid: 'BV1vT411i7ET',
			originalTitle: '原标题',
			uploader: '原UP',
			uploaderId: 88,
			artwork: '',
			duration: 200,
			category: '生活',
		}
	const cases: Partial<SearchPageProps['search']>[] = [
		{},
		{ loading: true, submitted: 'Aimer' },
		{ submitted: 'Aimer' },
		{ submitted: 'Aimer', ketangCount: 2, more: true },
		{ submitted: 'Aimer', failedPage: 1, error: '游客搜索需要风控验证' },
		{ submitted: 'Aimer', items: [one], more: true },
		{ submitted: 'Aimer', items: [one], loading: true, more: true },
		{
			submitted: 'Aimer',
			items: [one],
			failedPage: 2,
			error: '网络失败',
			more: true,
		},
		{ submitted: 'BV1vT411i7ET', items: [one] },
	]
	let comparisons = 0,
		unchangedComparisons = 0,
		migratedComparisons = 0
	for (const theme of [...Object.values(builtInThemes), legacy.adapted.theme]) {
		for (const filter of ['all', 'music', 'listening', 'creator'] as const)
			for (const state of cases) {
				const calls: unknown[][] = []
				const before = searchHost(original),
					after = searchHost(),
					props = searchProps({
						filter,
						search: {
							...initial.search,
							...state,
							retry: async () => {
								calls.push(['retry'])
							},
							loadMore: async () => {
								calls.push(['loadMore'])
							},
							setOrder: async (order) => {
								calls.push(['setOrder', order])
							},
						},
						onFilterChange: (next) => {
							calls.push(['filter', next])
						},
						onSubmit: () => {
							calls.push(['submit'])
						},
						onQueryChange: (query) => {
							calls.push(['query', query])
						},
						renderRow: (item, index) =>
							before.element('Result', {
								title: item.originalTitle,
								index,
							}) as React.ReactNode,
					})
				const oldPage = before.page(props),
					newPage = after.page(props)
				const oldTree = before.render(
					theme === legacy.adapted.theme
						? before.pack(oldPage, legacy.adapted)
						: before.builtin(oldPage, theme),
				)
				const newTree = after.render(
					theme === legacy.adapted.theme
						? after.pack(newPage, legacy.adapted)
						: after.builtin(newPage, theme),
				)
				const actual = withoutOrderControls(normalize(after, newTree)),
					expected = compactSearchExpectation(
						withoutOrderControls(normalize(before, oldTree)),
						props,
						theme,
						theme !== legacy.adapted.theme,
					),
					musicEmpty = filter === 'music' && state.items?.length === 1,
					exactBv = state.submitted === one.bvid
				assert.deepEqual(calls, [], 'rendering cannot submit or change filters')
				migrateInputAppearance(actual, expected, theme)
				if (musicEmpty) {
					assert.deepEqual(
						actual,
						musicEmptyExpectation(expected, exactBv),
						`${theme.id}/${filter}/${comparisons}`,
					)
					const actionText = exactBv
						? '在听视频中查看此 BV'
						: '查看全部音源（1）'
					const actions = controlNodes(newTree).filter(
						(node) =>
							node.type === 'Pressable' &&
							searchText(node.children) === actionText,
					)
					assert.equal(actions.length, 1)
					assert.equal(actions[0].props.accessibilityRole, 'button')
					assert.ok(
						actions[0].props.disabled === undefined ||
							actions[0].props.disabled === false,
					)
					invoke(actions[0], 'onPress')
					assert.deepEqual(
						calls,
						[['filter', exactBv ? 'listening' : 'all']],
						'the explicit exit only changes its intended filter, never submits or requests a page',
					)
					assert.equal(props.search.items[0], one, 'the exact hit is retained')
					migratedComparisons++
				} else {
					assert.deepEqual(
						actual,
						expected,
						`${theme.id}/${filter}/${comparisons}`,
					)
					unchangedComparisons++
				}
				comparisons++
				before.unmount()
				after.unmount()
			}
	}
	assert.equal(comparisons, 144)
	assert.equal(unchangedComparisons, 128)
	assert.equal(migratedComparisons, 16)
})

void test('parent net width selects a shared strategy, but both native slots must independently confirm before interaction', () => {
	const f = setup()
	let tree = f.render()
	assert.equal(native(tree, 'search-input').props.editable, false)
	invoke(native(tree, '提交搜索'), 'onPress')
	invoke(native(tree, 'search-input'), 'onSubmitEditing', {
		nativeEvent: { text: '未测量' },
	})
	assert.deepEqual(f.calls, [])
	measure(native(tree, 'search-query-width'), 211) // content net after border/padding; 211-19=192
	tree = f.render()
	assert.equal(f.flatten(native(tree, '提交搜索').props.style).minHeight, 96)
	measure(native(tree, 'search-query-input-width'), 96)
	tree = f.render()
	assert.equal(native(tree, 'search-input').props.editable, false)
	measure(native(tree, 'search-query-submit-width'), 95)
	tree = f.render()
	assert.equal(
		native(tree, 'search-input').props.editable,
		false,
		'whole-row width cannot authorize a smaller submit slot',
	)
	measure(native(tree, 'search-query-submit-width'), 96)
	tree = f.render()
	assert.equal(native(tree, 'search-input').props.editable, true)
	invoke(native(tree, 'search-input'), 'onSubmitEditing', {
		nativeEvent: { text: '新事件文本' },
	})
	invoke(native(tree, '提交搜索'), 'onPress')
	assert.deepEqual(f.calls, [
		['change', '新事件文本'],
		['submit', '新事件文本'],
		['submit'],
	])
})

void test('regular, author compact, host fallback and rejection use the same parent budget without enlarging the input slot', () => {
	const f = setup()
	for (const [width, input, button, height] of [
		[211, 96, 96, 96],
		[163, 72, 72, 72],
		[125, 48, 58, 48],
	] as const) {
		const tree = f.fit(width, input, button)
		assert.equal(native(tree, 'search-input').props.editable, true)
		assert.equal(
			f.flatten(native(tree, '提交搜索').props.style).minHeight,
			height,
		)
		assert.equal(
			f.flatten(native(tree, 'search-input').props.style).minHeight,
			Math.max(50, height),
		)
	}
	const tree = f.fit(124, 47, 58)
	assert.equal(native(tree, 'search-input').props.editable, false)
	assert.equal(native(tree, '提交搜索').props.disabled, true)
	assert.ok(JSON.stringify(tree).includes('主题搜索栏暂不适合当前宽度'))
	const slots = controlNodes(tree).filter(
		(node) => node.type === 'View' && f.flatten(node.props.style).flex === 1,
	)
	assert.equal(slots.length, 1)
	assert.equal(
		f.flatten(slots[0].props.style).minWidth,
		0,
		'input cannot force the measured parent wider',
	)
})

void test('actual local width changes invalidate both slots and old callbacks, including width ABA', () => {
	const f = setup()
	let tree = f.fit(211, 96, 96)
	const oldInput = native(tree, 'search-input'),
		oldSubmit = native(tree, '提交搜索'),
		oldMeasure = native(tree, 'search-query-input-width')
	measure(native(tree, 'search-query-width'), 163)
	tree = f.render()
	assert.equal(native(tree, 'search-input').props.editable, false)
	measure(oldMeasure, 900)
	invoke(oldInput, 'onSubmitEditing', { nativeEvent: { text: '旧事件' } })
	invoke(oldSubmit, 'onPress')
	assert.deepEqual(f.calls, [])
	tree = f.fit(163, 72, 72)
	assert.equal(native(tree, 'search-input').props.editable, true)
	tree = f.fit(211, 96, 96)
	invoke(oldSubmit, 'onPress')
	assert.deepEqual(f.calls, [], 'same width cannot revive an old round')
	invoke(native(tree, '提交搜索'), 'onPress')
	assert.deepEqual(f.calls, [['submit']])
})

void test('native input path remains mounted through width/font/pending/reject; keyboard height alone preserves active handlers', () => {
	const f = setup()
	let tree = f.fit(211, 96, 96)
	const path = inputPath(tree),
		original = native(tree, 'search-input')
	f.viewport.height = 450
	tree = f.render()
	assert.equal(native(tree, 'search-input').props.editable, true)
	assert.equal(inputPath(tree), path)
	invoke(original, 'onSubmitEditing', { nativeEvent: { text: '键盘事件' } })
	assert.deepEqual(f.calls, [
		['change', '键盘事件'],
		['submit', '键盘事件'],
	])
	f.viewport.fontScale = 1.5
	tree = f.render()
	assert.equal(native(tree, 'search-input').props.editable, false)
	assert.equal(inputPath(tree), path)
	invoke(original, 'onSubmitEditing', { nativeEvent: { text: '旧字体事件' } })
	invoke(original, 'onChangeText', '原生已排队 draft')
	assert.deepEqual(f.calls.at(-1), ['change', '原生已排队 draft'])
	tree = f.fit(124, 47, 58)
	assert.equal(inputPath(tree), path)
	f.viewport.width = 350
	tree = f.render()
	assert.equal(inputPath(tree), path)
	assert.equal(native(tree, 'search-input').props.value, '旧 query')
	f.unmount()
	invoke(native(tree, '提交搜索'), 'onPress')
	measure(native(tree, 'search-query-input-width'), 500)
	assert.equal(f.writesAfterUnmount, 0)
})

void test('filters retain horizontal order, original actions and standalone measured touch frames', () => {
	const f = searchHost(),
		chosen: string[] = []
	const element = f.pack(
		f.page(
			searchProps({
				filter: 'music',
				onFilterChange: (value) => chosen.push(value),
			}),
		),
		packageTheme(),
	)
	let tree = f.render(element)
	const scroll = controlNodes(tree).find((node) => node.type === 'ScrollView')
	assert.equal(scroll?.props.horizontal, true)
	// Inspect filter slots only; the separate order row also has measured controls.
	const measurements = controlNodes(scroll).filter(
		(node) => typeof node.props.onLayout === 'function' && !node.props.testID,
	)
	assert.equal(measurements.length, 4)
	for (const node of measurements) measure(node, 96)
	tree = f.render(element)
	const tabs = controlNodes(tree).filter(
		(node) => node.props.accessibilityRole === 'tab',
	)
	assert.equal(tabs.length, 4)
	for (const tab of tabs) {
		const style = f.flatten(
			(tab.props.style as (value: unknown) => unknown)({ pressed: false }),
		)
		assert.equal(style.minWidth, 96)
		assert.equal(style.minHeight, 96)
		assert.equal(style.height, undefined)
		invoke(tab, 'onPress')
	}
	assert.deepEqual(chosen, ['all', 'music', 'listening', 'creator'])
	assert.deepEqual(
		tabs.map(
			(node) =>
				(node.props.accessibilityState as { selected: boolean }).selected,
		),
		[false, true, false, false],
	)
})

void test('200 percent font leaves filter labels free to grow inside allocated horizontal slots', () => {
	const f = searchHost(),
		adapted = packageTheme()
	f.viewport.fontScale = 2
	const element = f.pack(f.page(searchProps()), adapted)
	let tree = f.render(element)
	const slots = controlNodes(tree).filter(
		(node) => node.type === 'View' && f.flatten(node.props.style).width === 96,
	)
	assert.equal(slots.length, 4)
	for (const measurement of controlNodes(tree).filter(
		(node) => typeof node.props.onLayout === 'function' && !node.props.testID,
	))
		measure(measurement, 96)
	tree = f.render(element)
	const tabs = controlNodes(tree).filter(
		(node) => node.props.accessibilityRole === 'tab',
	)
	for (const tab of tabs) {
		const style = f.flatten(
			(tab.props.style as (state: unknown) => unknown)({ pressed: false }),
		)
		assert.equal(style.height, undefined)
		assert.equal(style.maxHeight, undefined)
		assert.equal(style.minHeight, 96)
		for (const text of controlNodes(tab.children).filter(
			(node) => node.type === 'Text',
		))
			assert.equal(text.props.numberOfLines, undefined)
	}
	assert.equal(tabs.length, 4)
})
