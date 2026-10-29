import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'
import * as creatorSearchSelection from '../creator-search-selection'

import { fixture, post } from './creator-post-filter-fixture'
import { controlFixture, controlNodes } from './theme-control-fixture'

function text(value: unknown): string {
	if (Array.isArray(value)) return value.map(text).join('')
	if (value && typeof value === 'object' && 'children' in value)
		return text(value.children)
	return typeof value === 'string' || typeof value === 'number'
		? String(value)
		: ''
}
const component = (value: unknown) =>
	value as (props: Record<string, unknown>) => unknown

void test('actual three-theme controls select local filters, distinguish partial/filter-empty/error/true-empty and preserve explicit more/row actions', async (t) => {
	const f = fixture(t),
		rows = Array.from({ length: 30 }, (_, index) => post(index + 1))
	f.save(rows, 31)
	f.classify([{ bvid: post(1).bvid, kind: 'song' }])
	let networkCalls = 0
	f.api.posts = async (_mid, page) => {
		networkCalls++
		return { items: [post(31)], page, more: false, total: 31 }
	}
	for (const theme of Object.values(builtInThemes)) {
		f.save(rows, 31)
		const h = controlFixture(
				{},
				{
					'./creator-ui': { CreatorAvatar: 'Avatar' },
					'./creator-search-selection': creatorSearchSelection,
				},
			),
			ui = h.load('ui'),
			remoteUi = h.load('creator-remote-ui'),
			remote = f.remote(),
			played: unknown[][] = []
		remote.select('88', {})
		let busy = false
		const render = () =>
			h.render(
				h.element(
					component(ui.ThemeProvider),
					{ value: theme },
					h.element(component(remoteUi.CreatorPostsRead), {
						state: remote.getSnapshot(),
						session: remote,
						playbackBusy: busy,
						onPlay: (...args: unknown[]) => played.push(args),
					}),
				),
			)
		const labelled = (tree: unknown, name: string) => {
			const node = controlNodes(tree).find(
				(item) =>
					item.props.accessibilityLabel === name ||
					(item.type === 'Pressable' && text(item.children) === name),
			)
			assert.ok(node, name)
			return node
		}
		let tree = render()
		assert.equal(
			controlNodes(tree).filter(
				(item) => item.props.accessibilityRole === 'tab',
			).length,
			3,
		)
		for (const label of ['全部', '音乐', '听视频']) {
			const node = labelled(tree, `UP 投稿筛选${label}`),
				style = h.flatten(
					typeof node.props.style === 'function'
						? node.props.style({ pressed: false })
						: node.props.style,
				)
			assert.equal(style.minHeight, 48)
			assert.equal(
				style.height,
				undefined,
				'labels may grow rather than clip at fixed height',
			)
			assert.equal(
				style.flex,
				1,
				'siblings share the measured parent row budget',
			)
		}
		const before = networkCalls
		;(labelled(tree, 'UP 投稿筛选音乐').props.onPress as () => void)()
		tree = render()
		assert.equal(networkCalls, before)
		assert.equal(
			(
				labelled(tree, 'UP 投稿筛选音乐').props.accessibilityState as {
					selected: boolean
				}
			).selected,
			true,
		)
		assert.match(text(tree), /当前可见 1 项.*还有未读取的投稿页/)
		;(
			labelled(tree, `核对并收听投稿 ${post(1).title}`).props
				.onPress as () => void
		)()
		assert.equal(played[0][1], 'listening')
		;(labelled(tree, 'UP 投稿筛选听视频').props.onPress as () => void)()
		tree = render()
		assert.match(text(tree), /当前筛选没有已确认的投稿/)
		assert.ok(labelled(tree, '加载更多投稿'))
		await remote.loadMore()
		tree = render()
		assert.equal(remote.getSnapshot().page, 2)
		assert.equal(remote.getSnapshot().more, false)
		assert.match(text(tree), /当前筛选没有已确认的投稿/)
		assert.equal(
			controlNodes(tree).some(
				(item) =>
					item.type === 'Pressable' && text(item.children) === '加载更多投稿',
			),
			false,
		)
		remote.setPostFilter('all')
		busy = true
		tree = render()
		assert.equal(
			labelled(tree, `核对并收听投稿 ${post(1).title}`).props.disabled,
			true,
		)
		const load = f.scopes.load.bind(f.scopes)
		f.scopes.load = () => {
			throw new Error('classification read error')
		}
		remote.reloadPostsCache()
		tree = render()
		assert.match(text(tree), /本地投稿分类读取失败/)
		assert.doesNotMatch(
			text(tree),
			/当前筛选没有已确认的投稿|已缓存的读取结果没有投稿/,
		)
		f.scopes.load = load
		h.unmount()
		assert.equal(h.writesAfterUnmount, 0)
	}
})

void test('actual TSX keeps never-read separate from a successful cached empty result and does not fetch on render', async (t) => {
	const f = fixture(t),
		remote = f.remote(),
		h = controlFixture(
			{},
			{
				'./creator-ui': { CreatorAvatar: 'Avatar' },
				'./creator-search-selection': creatorSearchSelection,
			},
		),
		ui = h.load('ui'),
		page = h.load('creator-remote-ui')
	remote.select('88', {})
	const render = () =>
		h.render(
			h.element(
				component(ui.ThemeProvider),
				{ value: builtInThemes.modern },
				h.element(component(page.CreatorPostsRead), {
					state: remote.getSnapshot(),
					session: remote,
					playbackBusy: false,
					onPlay: () => assert.fail('render never plays'),
				}),
			),
		)
	assert.match(text(render()), /尚无本地投稿缓存/)
	assert.doesNotMatch(
		text(render()),
		/已缓存的读取结果没有投稿|当前筛选没有已确认的投稿/,
	)
	await remote.readPosts()
	assert.match(text(render()), /已缓存的读取结果没有投稿/)
	assert.equal(remote.getSnapshot().total, 0)
	h.unmount()
})
