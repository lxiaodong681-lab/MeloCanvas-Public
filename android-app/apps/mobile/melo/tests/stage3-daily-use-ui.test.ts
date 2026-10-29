import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'
import { CreatorRemoteSession } from '../creator-remote-session'
import * as creatorSearchSelection from '../creator-search-selection'
import { CreatorSearchSession } from '../creator-search-session'
import { CreatorSession } from '../creator-session'

import { feedFixture } from './following-feed-fixture'
import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const component = (value: unknown) => value as ControlNode['type']
const text = (value: unknown): string => {
	if (Array.isArray(value)) return value.map(text).join('')
	if (value && typeof value === 'object' && 'children' in value)
		return text((value as ControlNode).children)
	return typeof value === 'string' || typeof value === 'number'
		? String(value)
		: ''
}
const visible = (value: unknown): ControlNode[] => {
	if (Array.isArray(value)) return value.flatMap(visible)
	if (!value || typeof value !== 'object' || !('type' in value)) return []
	const node = value as ControlNode
	if (node.type === 'Modal' && node.props.visible === false) return []
	return [node, ...visible(node.children)]
}
const label = (tree: unknown, name: string) => {
	const found = visible(tree).find(
		(node) =>
			node.props.accessibilityLabel === name ||
			(typeof node.props.onPress === 'function' && text(node) === name),
	)
	assert.ok(found, name)
	return found
}
const press = (tree: unknown, name: string) =>
	(label(tree, name).props.onPress as () => void)()
const noop = () => {}

void test('comprehensive UP summary renders one real creator, standalone search keeps all results, and neither render makes a request', async () => {
	let reads = 0
	const creators = [
		{
			source: 'bilibili' as const,
			mid: '88',
			name: '结果甲',
			bio: '简介甲',
			fetchedAt: 1,
		},
		{
			source: 'bilibili' as const,
			mid: '99',
			name: '结果乙',
			bio: '简介乙',
			fetchedAt: 1,
		},
	]
	const session = new CreatorSearchSession(async (_keyword, page) => {
		reads++
		return { items: creators, page, more: false }
	})
	await session.find('测试关键词')
	for (const theme of Object.values(builtInThemes)) {
		const ui = controlFixture(
			{},
			{
				'./creator-search-selection': creatorSearchSelection,
				'./creator-ui': {
					CreatorAvatar: 'Avatar',
					creatorScopeLabel: { all: '全部投稿' },
				},
			},
		)
		const Component = component(
			ui.load('creator-remote-ui').CreatorSearchResults,
		)
		const Provider = component(ui.load('ui').ThemeProvider)
		const events: unknown[] = []
		const render = (compact: boolean) =>
			ui.render(
				ui.element(
					Provider,
					{ value: theme },
					ui.element(Component, {
						state: session.getSnapshot(),
						session,
						onOpen: (creator: unknown) => events.push(creator),
						...(compact
							? {
									preview: {
										compact: true,
										onViewAll: () => events.push('all'),
									},
								}
							: {}),
					}),
				),
			)
		const before = reads
		let tree = render(true)
		assert.match(text(tree), /结果甲/)
		assert.doesNotMatch(text(tree), /结果乙/)
		press(tree, '查看搜索 UP 主 结果甲，mid 88')
		press(tree, '查看全部 UP 主')
		assert.deepEqual(events, [session.getSnapshot().items[0], 'all'])
		tree = render(false)
		assert.match(text(tree), /结果甲/)
		assert.match(text(tree), /结果乙/)
		assert.equal(reads, before)
		ui.unmount()
	}
})

void test('following tools open in the actual shared menu, close before callbacks, and preserve filter, row and return actions', () => {
	const data = feedFixture()
	try {
		data.session.open()
		for (const theme of Object.values(builtInThemes)) {
			const dependencies: Record<string, unknown> = {}
			const ui = controlFixture({}, dependencies)
			dependencies['./creator-ui'] = ui.load('creator-ui')
			const Page = component(ui.load('following-feed-ui').FollowingFeedPage)
			const Provider = component(ui.load('ui').ThemeProvider)
			const events: unknown[] = []
			const render = () =>
				ui.render(
					ui.element(
						Provider,
						{ value: theme },
						ui.element(Page, {
							state: data.session.getSnapshot(),
							session: data.session,
							onCreator: (creator: { mid: string }) => events.push(creator.mid),
							onPlay: (...args: unknown[]) => events.push(args),
							onManage: () => {
								assert.equal(
									visible(render()).filter((node) => node.type === 'Modal')
										.length,
									0,
								)
								events.push('manage')
							},
							onSearch: () => events.push('search'),
						}),
					),
				)
			const before = data.reads()
			let tree = render()
			assert.equal(data.reads(), before)
			assert.equal(
				visible(tree).some(
					(node) =>
						text(node) === '管理本地关注的 UP 主' &&
						typeof node.props.onPress === 'function',
				),
				false,
			)
			assert.doesNotMatch(text(visible(tree)), /尚未核验音轨|位缓存仍有后续页/)
			press(tree, '关注更新更多操作')
			tree = render()
			press(tree, '管理本地关注的 UP 主')
			assert.equal(events.at(-1), 'manage')
			press(render(), '关注更新更多操作')
			press(render(), '查看缓存范围与缺页')
			tree = render()
			assert.equal(data.session.getSnapshot().coverageOpen, true)
			assert.match(text(tree), /尚未核验音轨|位缓存仍有后续页/)
			press(tree, '关注更新：音乐')
			assert.equal(data.session.getSnapshot().filter, 'music')
			press(render(), '关注更新：全部')
			tree = render()
			press(tree, '核对并收听关注投稿 缓存原视频')
			assert.deepEqual(events.at(-1), [data.post.bvid, 'listening'])
			press(tree, '返回音乐库')
			assert.equal(data.session.getSnapshot().open, false)
			ui.unmount()
			data.session.open()
			data.session.setCoverageOpen(false)
		}
	} finally {
		data.raw.close()
	}
})

void test('compact UP failure stays actionable without hiding the independent session error or retrying on render', async () => {
	let reads = 0,
		all = 0
	const session = new CreatorSearchSession(async () => {
		reads++
		throw new Error('访问受限')
	})
	await session.find('测试UP')
	const ui = controlFixture(
		{},
		{
			'./creator-search-selection': creatorSearchSelection,
			'./creator-ui': { CreatorAvatar: 'Avatar' },
		},
	)
	const Page = component(ui.load('creator-remote-ui').CreatorSearchResults)
	const tree = ui.render(
		ui.element(Page, {
			state: session.getSnapshot(),
			session,
			onOpen: noop,
			preview: {
				compact: true,
				onViewAll: () => {
					all++
				},
			},
		}),
	)
	assert.match(text(tree), /UP 主搜索暂时未完成/)
	press(tree, '查看全部 UP 主')
	assert.equal(all, 1)
	assert.equal(reads, 1)
	assert.ok(session.getSnapshot().error)
	ui.unmount()
})

void test('creator read details expand locally while filters and source callbacks remain usable', () => {
	const data = feedFixture()
	let requests = 0
	const session = new CreatorRemoteSession(
		{
			profile: async () => {
				requests++
				return data.creator
			},
			posts: async (_mid, page) => {
				requests++
				return { items: [data.post], page, more: false, total: 1 }
			},
		},
		noop,
		data.cache,
		{ load: () => new Map() },
	)
	try {
		session.select('88')
		const ui = controlFixture(
			{},
			{
				'./creator-ui': { CreatorAvatar: 'Avatar' },
				'./creator-search-selection': creatorSearchSelection,
			},
		)
		const Page = component(ui.load('creator-remote-ui').CreatorPostsRead)
		const played: unknown[][] = []
		const render = () =>
			ui.render(
				ui.element(Page, {
					state: session.getSnapshot(),
					session,
					playbackBusy: false,
					onPlay: (...args: unknown[]) => played.push(args),
				}),
			)
		let tree = render()
		assert.doesNotMatch(text(tree), /不代表实时或完整投稿列表/)
		press(tree, '展开投稿读取范围')
		tree = render()
		assert.match(text(tree), /不代表实时或完整投稿列表/)
		assert.match(text(tree), /第 1 页读取时间/)
		assert.equal(requests, 0)
		press(tree, 'UP 投稿筛选音乐')
		assert.equal(session.getSnapshot().postFilter, 'music')
		press(render(), 'UP 投稿筛选全部')
		press(render(), '核对并收听投稿 缓存原视频')
		assert.equal(played[0][1], 'listening')
		press(render(), '收起投稿读取范围')
		assert.doesNotMatch(text(render()), /不代表实时或完整投稿列表/)
		assert.equal(requests, 0)
		ui.unmount()
	} finally {
		data.raw.close()
	}
})

void test('UP profile has a compact saved-empty section and keeps independent follow scope, cancel and back behavior', () => {
	const data = feedFixture(),
		session = new CreatorSession(data.creators, { sourcesByUploader: () => [] })
	try {
		session.openProfile('88')
		const ui = controlFixture()
		const Page = component(ui.load('creator-ui').CreatorOverlay)
		const render = () =>
			ui.render(
				ui.element(Page, {
					state: session.getSnapshot(),
					session,
					playbackError: '',
					onPlay: noop,
					onOpenSpace: async () => {},
					topInset: 0,
					bottomInset: 0,
					reducedMotion: true,
					remotePosts: ui.element('Text', {}, '平台投稿入口'),
				}),
			)
		let tree = render()
		assert.match(text(tree), /还没有保存这位 UP 主的音源/)
		assert.equal(
			controlNodes(tree).some(
				(node) => node.props.title === '本机还没有保存该 UP 的音源',
			),
			false,
		)
		assert.match(text(tree), /平台投稿入口/)
		press(tree, '已关注 · 修改范围')
		tree = render()
		assert.match(text(tree), /不同步到 B 站/)
		press(tree, '关注范围：音乐投稿')
		press(render(), '保存关注范围')
		assert.equal(session.getSnapshot().subscription?.scope, 'music')
		press(render(), '取消本地关注')
		tree = render()
		assert.match(text(tree), /只取消对「真实UP」的本机关注/)
		const confirmation = controlNodes(tree).find(node => node.type === 'Modal' && text(node).startsWith('取消本地关注？'))!
		assert.ok(confirmation)
		;(confirmation.props.onRequestClose as () => void)()
		assert.equal(session.getSnapshot().unfollowConfirm, false)
		assert.ok(session.getSnapshot().subscription)
		ui.unmount()
	} finally {
		data.raw.close()
	}
})
