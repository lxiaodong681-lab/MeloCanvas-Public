import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readBaselineSource } from './baseline-source'

import { builtInThemes } from '../core/theme'
import type { AdaptedPackageTheme } from '../core/theme-package-adapter'
import * as creatorSearchSelection from '../creator-search-selection'
import { emptyFeedRefresh } from '../following-feed-refresh'

import {
	controlFixture,
	controlNodes,
	legacyControlPackage,
	type ControlNode,
} from './theme-control-fixture'

const baseline = '21210b3771419e2b2e13c9b9d6dcf75cf9a712fa'
const names = [
	'creator-ui',
	'creator-remote-ui',
	'following-feed-ui',
	'recommendation-ui',
] as const
const component = (value: unknown) => value as ControlNode['type']
const creator = {
	source: 'bilibili',
	mid: '123',
	name: '已知 UP',
	fetchedAt: 1,
}
const subscription = {
	profileId: 'local',
	creatorMid: '123',
	scope: 'all',
	createdAt: 1,
	notifications: false,
	origin: 'manual',
}
const music = {
	id: 'bilibili:BV1234567890:10',
	bvid: 'BV1234567890',
	cid: 10,
	originalTitle: '音乐原题',
	uploader: 'UP',
	uploaderId: 123,
	performer: null,
	artwork: '',
	duration: 120,
	domain: 'music',
	audioAvailability: 'unknown',
}
const video = {
	...music,
	id: 'bilibili:BV1234567890:20',
	cid: 20,
	originalTitle: '视频原题',
	domain: 'unclassified',
}
const post = {
	bvid: music.bvid,
	title: '缓存投稿',
	artwork: '',
	duration: 200,
	publishedAt: 1000,
	queryCreatorMid: '123',
}
const origin = { creator, subscription, page: 1, fetchedAt: 1000, post }
const item = {
	post,
	contentScope: 'unknown',
	contentKinds: [],
	origins: [origin],
}
const snapshot = {
	profileId: 'local',
	filter: 'all',
	status: 'ready',
	items: [item],
	subscriptions: [
		{
			creator,
			subscription,
			status: 'partial',
			cache: {
				revision: 1,
				lastPage: 1,
				more: true,
				total: 2,
				complete: false,
				pages: [{ page: 1, fetchedAt: 1000, itemCount: 1 }],
			},
		},
	],
	coverage: {
		cachedSubscriptions: 1,
		uncachedSubscriptions: 0,
		partialSubscriptions: 1,
		cachedPostCount: 1,
	},
}
const creatorState = (change = {}) => ({
	routes: [{ kind: 'profile', mid: '123' }],
	creator,
	subscription,
	sources: [music, video],
	following: [{ creator, subscription }],
	profileLoaded: true,
	scopeForm: null,
	unfollowConfirm: false,
	suspended: false,
	playbackBusy: false,
	error: '',
	notice: '',
	...change,
})
const remoteState = (change = {}) => ({
	mid: '123',
	visit: {},
	profileLoading: false,
	profileError: '',
	profileUpdated: true,
	posts: [post],
	postFilter: 'all',
	visiblePosts: [post],
	filterError: '',
	postsLoading: false,
	postsError: '',
	page: 1,
	more: true,
	total: 2,
	failedPage: null,
	cacheStatus: 'ready',
	cacheError: '',
	postsNotice: '',
	postsReadTimes: [{ page: 1, fetchedAt: 1000 }],
	restartRequired: false,
	...('posts' in change ? { visiblePosts: change.posts } : {}),
	...change,
})
const searchState = (change = {}) => ({
	keyword: '昵称',
	items: [creator],
	page: 1,
	more: true,
	loading: false,
	error: '',
	failedPage: null,
	...change,
})
const feedState = (change = {}) => ({
	refresh: emptyFeedRefresh(),
	open: true,
	filter: 'all',
	coverageOpen: true,
	snapshot,
	stale: false,
	overlay: false,
	error: '',
	playError: '',
	playingBvid: null,
	...change,
})
const recommendationState = (change = {}) => ({
	open: true,
	view: 'daily',
	feedbackPage: null,
	feedbackRequestedPage: 1,
	feedbackRevision: 3,
	feedbackError: '',
	feedbackStale: false,
	restoredSourceIds: [],
	resetConfirming: false,
	snapshot: {
		localDate: '2026-10-19',
		revision: 1,
		items: [{ source: music, reasons: ['liked', 'imported-song'] }],
		canUndo: true,
	},
	busy: false,
	error: '',
	notice: '',
	playingId: null,
	playError: '',
	...change,
})
const feedbackPage = {
	items: [
		{ sourceId: music.id, source: music, dismissedAt: 1000 },
		{ sourceId: 'missing', source: null, dismissedAt: 1 },
	],
	page: 2,
	pageSize: 20,
	total: 41,
	totalPages: 3,
}

function host(sources: Record<string, string> = {}) {
	const dependencies: Record<string, unknown> = {
		'./creator-search-selection': creatorSearchSelection,
	}
	const f = controlFixture(sources, dependencies),
		ui = f.load('ui'),
		events: unknown[][] = []
	const creatorUi = f.load('creator-ui')
	dependencies['./creator-ui'] = creatorUi
	const remote = f.load('creator-remote-ui'),
		feed = f.load('following-feed-ui'),
		recommendations = f.load('recommendation-ui')
	let currentFeed = feedState()
	// Explicit callback port; actual business sessions are exercised by their unchanged related tests.
	const session = new Proxy(
		{},
		{
			get: (_target, key) =>
				key === 'getSnapshot'
					? () => currentFeed
					: key === 'getScrollOffset'
						? () => 0
						: (...args: unknown[]) => {
								events.push([String(key), ...args])
							},
		},
	)
	const modules = { ...creatorUi, ...remote, ...feed, ...recommendations }
	const props = (name: string, state: Record<string, unknown> = {}) => {
		if (name === 'FollowingFeedPage')
			currentFeed = state as ReturnType<typeof feedState>
		return {
			state,
			session,
			onPress: () => events.push(['entry']),
			onOpen: (value: unknown) => events.push(['open', value]),
			onPlay: (...args: unknown[]) => events.push(['play', ...args]),
			onCreator: (value: unknown) => events.push(['creator', value]),
			onManage: () => events.push(['manage']),
			onSearch: () => events.push(['search']),
			onOpenSpace: async () => {},
			playbackBusy: false,
			playbackError: '',
			topInset: 0,
			bottomInset: 12,
			reducedMotion: true,
		}
	}
	return { ...f, ui, modules, events, props }
}
type Host = ReturnType<typeof host>
function flat(h: Host, node: ControlNode) {
	return h.flatten(
		typeof node.props.style === 'function'
			? node.props.style({ pressed: false })
			: node.props.style,
	)
}
function text(value: unknown): string {
	return Array.isArray(value)
		? value.map(text).join('')
		: value && typeof value === 'object' && 'children' in value
			? text((value as ControlNode).children)
			: typeof value === 'string' || typeof value === 'number'
				? String(value)
				: ''
}
function controls(tree: unknown) {
	return controlNodes(tree).filter((node) => node.type === 'Pressable')
}
function visibleControls(tree: unknown): ControlNode[] {
	if (Array.isArray(tree)) return tree.flatMap(visibleControls)
	if (!tree || typeof tree !== 'object' || !('type' in tree)) return []
	const node = tree as ControlNode
	if (node.type === 'Modal' && node.props.visible === false) return []
	return [
		...(node.type === 'Pressable' ? [node] : []),
		...visibleControls(node.children),
	]
}
function label(tree: unknown, name: string) {
	const node = controls(tree).find(
		(candidate) =>
			(candidate.props.accessibilityLabel ?? text(candidate.children)) === name,
	)
	assert.ok(node, name)
	return node
}
function press(tree: unknown, name: string) {
	;(label(tree, name).props.onPress as () => void)()
}
function normalize(h: Host, value: unknown): unknown {
	if (Array.isArray(value))
		// This new functional block is checked separately by actual three-theme TSX tests.
		// Keep comparing every pre-existing row/more/page/empty/error subtree to 21210b37.
		return Array.from(value)
			.filter(
				(child) =>
					!(
						child &&
						typeof child === 'object' &&
						'props' in child &&
						[
							'creator-post-filter-controls',
							'creator-post-filter-status',
						].includes(child.props?.testID)
					),
			)
			.map((child) => normalize(h, child))
	if (typeof value === 'function') return '<callback>'
	if (!value || typeof value !== 'object') return value
	if ('type' in value) {
		const node = value as ControlNode
		const props = Object.fromEntries(
			Object.entries(node.props)
				.filter(
					([key, v]) =>
						v !== undefined &&
						key !== 'children' &&
						!(
							node.type === 'FlatList' &&
							['ListHeaderComponent', 'ListEmptyComponent'].includes(key)
						),
				)
				.map(([key, v]) => [key, key === 'style' ? flat(h, node) : v]),
		)
		return {
			type: node.type,
			props: normalize(h, props),
			children: normalize(h, node.children),
		}
	}
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.map(([key, v]) => [key, normalize(h, v)]),
	)
}
function packageTheme(): AdaptedPackageTheme {
	return {
		theme: structuredClone(builtInThemes.modern),
		mode: 'light',
		retained: {
			buttonMinTouchDp: 96,
			controlRowLayout: {
				minTouchDp: 96,
				compactMinTouchDp: 72,
				narrowFallback: 'host-single-row',
			},
			lyricTokens: { active: '#111111', inactive: '#444444' },
		},
		renderingResponsibilities: [
			'local-image-uris',
			'button-min-touch-dp',
			'lyric-tokens',
			'motion-duration-and-reduced-motion',
			'explicit-color-mode',
		],
	}
}
function root(
	h: Host,
	name: string,
	state: Record<string, unknown>,
	adapted = packageTheme(),
) {
	return h.element(
		component(h.ui.PackageThemeProvider),
		{ adapted, allowedImageUris: [], reducedMotion: true },
		h.element(component(h.modules[name]), h.props(name, state)),
	)
}
function measurements(tree: unknown) {
	return controlNodes(tree).filter(
		(node) =>
			typeof node.props.onLayout === 'function' &&
			String(node.key).includes('['),
	)
}
function measure(node: ControlNode, width: number) {
	;(node.props.onLayout as (event: unknown) => void)({
		nativeEvent: { layout: { width } },
	})
}
function settle(h: Host, value: unknown, width = 400) {
	let tree = h.render(value)
	for (let i = 0; i < 2; i++) {
		for (const node of measurements(tree)) measure(node, width)
		tree = h.render(value)
	}
	return tree
}

function discoveryNode(value: unknown, type: string): ControlNode {
	assert.ok(value && typeof value === 'object' && 'type' in value)
	assert.equal(value.type, type)
	return value as ControlNode
}
function discoveryChildren(value: unknown): unknown[] {
	assert.ok(Array.isArray(value))
	return value
}
function exactDiscoveryText(tree: unknown, value: string) {
	const found = controlNodes(tree).filter(
		(node) => node.type === 'Text' && text(node.children) === value,
	)
	assert.equal(found.length, 1, `one exact text leaf: ${value}`)
	return found[0]
}
// Only CreatorSearchResults owns these new optional following/preview slots.
// Expect their exact empty values in these six historical scenarios instead of
// dropping arbitrary null/false nodes throughout the native tree.
function creatorSearchExpectation(expected: unknown, prompt: boolean) {
	const expectedRoot = discoveryNode(expected, 'View')
	assert.equal(expectedRoot.props.testID, 'creator-search-results')
	const children = discoveryChildren(
		discoveryChildren(expectedRoot.children)[0],
	)
	assert.equal(children.length, 5)
	const results = discoveryChildren(children[2])
	for (const result of results) {
		const row = discoveryNode(result, 'Pressable')
		assert.equal(
			row.props.accessibilityLabel,
			'查看搜索 UP 主 已知 UP，mid 123',
		)
		const rowChildren = discoveryChildren(discoveryChildren(row.children)[0])
		assert.equal(rowChildren.length, 2)
		const info = discoveryNode(rowChildren[1], 'View')
		const fields = discoveryChildren(discoveryChildren(info.children)[0])
		assert.equal(fields.length, 3)
		assert.equal(text(fields[1]), 'Bilibili · mid 123')
		assert.equal(text(fields[2]), '暂无搜索简介')
		fields.splice(2, 0, false)
	}
	children.splice(2, 0, false)
	children.splice(5, 0, undefined)
	if (prompt) {
		const oldPrompt = '输入昵称或相关关键词，再提交搜索。'
		const node = exactDiscoveryText(expected, oldPrompt)
		assert.deepEqual(node.children, [oldPrompt])
		node.children = [
			'输入昵称、mid:123 或 space.bilibili.com 的 UP 主页链接，再提交搜索。',
		]
	}
	return expected
}
function feedRefreshExpectation(expected: unknown) {
	const expectedRoot = discoveryNode(expected, 'FlatList')
	assert.equal(expectedRoot.props.testID, 'following-feed-page')
	const header = discoveryNode(
		discoveryChildren(discoveryChildren(expectedRoot.children)[0])[0],
		'View',
	)
	const children = discoveryChildren(discoveryChildren(header.children)[0])
	assert.equal(children.length, 8)
	assert.equal(
		discoveryNode(children[1], 'View').props.style !== undefined,
		true,
	)
	assert.equal(text(children[2]), '重新读取本地更新')
	const oldCopy =
		'只展示本机已保存的投稿，不代表已同步最新或全部投稿。前往 UP 主页可主动读取。'
	const copy = exactDiscoveryText(expected, oldCopy)
	assert.deepEqual(copy.children, [oldCopy])
	copy.children = [
		'展示本机保存的投稿。主动刷新会读取本地关注 UP 的最新一页，不代表全部投稿。',
	]
	// The new action uses the existing secondary Button contract, not a snapshot
	// read from the current feed. Keep every theme/style/role prop from history.
	const templates = controls(expected).filter(
		(node) => text(node.children) === '寻找 UP 主',
	)
	assert.equal(templates.length, 1)
	const refresh = structuredClone(templates[0])
	const title = exactDiscoveryText(refresh, '寻找 UP 主')
	assert.deepEqual(title.children, ['寻找 UP 主'])
	title.children = ['刷新关注更新']
	children.splice(1, 0, refresh, false)
	return expected
}

function replaceDiscoveryNode(
	tree: unknown,
	target: ControlNode,
	replacement?: unknown,
) {
	let replaced = 0
	function visit(value: unknown): void {
		if (Array.isArray(value)) {
			const index = value.indexOf(target)
			if (index >= 0) {
				value.splice(
					index,
					1,
					...(replacement === undefined ? [] : [replacement]),
				)
				replaced++
			}
			for (const child of value) visit(child)
		} else if (value && typeof value === 'object' && 'children' in value)
			visit((value as ControlNode).children)
	}
	visit(tree)
	assert.equal(replaced, 1, 'replace only one reviewed historical node')
}

/** Reviewed built-in ControlTarget floors; imported packages retain their authored contract. */
function builtinDiscoveryFloors(expected: unknown) {
	const widths: Record<string, number> = {
		'管理本地关注的 UP 主': 148,
		'打开已关注 UP 主 已知 UP，mid 123': 136,
		'关注范围：全部投稿': 83,
		'关注范围：音乐投稿': 83,
		'关注范围：听视频内容': 83,
		'播放本地音乐音源 音乐原题': 48,
		'收听本地视频音源 视频原题': 48,
		'查看搜索 UP 主 已知 UP，mid 123': 108,
		'核对并收听投稿 缓存投稿': 48,
		'核对后以音乐播放 缓存投稿': 48,
		'核对并收听关注投稿 缓存投稿': 164,
		'查看关注来源 UP 主 已知 UP，mid 123': 48,
		'核对关注投稿后以音乐播放 缓存投稿': 48,
		'查看缓存 UP 主 已知 UP，mid 123': 48,
		'关注更新：全部': 72,
		'关注更新：音乐': 72,
		'关注更新：听视频': 72,
		'播放每日推荐音源 音乐原题': 48,
	}
	for (const target of controls(expected)) {
		const width = widths[String(target.props.accessibilityLabel)]
		if (width !== undefined) {
			const style = target.props.style as Record<string, unknown>
			assert.equal(style.minWidth, undefined)
			style.minWidth = width
			if (target.props.disabled && style.opacity === undefined)
				style.opacity = 0.4
		}
	}
}

function reviewedBlock(
	theme: (typeof builtInThemes)['modern'] | null,
	legacy: Awaited<ReturnType<typeof legacyControlPackage>>,
	make: (h: Host) => unknown,
) {
	// Render only the reused public control with audited static props. Expected
	// blocks never read or copy the current page's native tree.
	const reference = host()
	try {
		return normalize(
			reference,
			reference.render(
				reference.element(
					component(
						theme
							? reference.ui.ThemeProvider
							: reference.ui.PackageThemeProvider,
					),
					theme ? { value: theme } : { ...legacy, reducedMotion: true },
					make(reference),
				),
			),
		)
	} finally {
		reference.unmount()
	}
}

function creatorPresentationExpectation(
	expected: unknown,
	state: Record<string, unknown>,
) {
	const modal = controlNodes(expected).find(node => node.type === 'Modal')!
	;((modal.children![0] as ControlNode).children![0] as unknown[]).splice(1, 0, false)
	const form = !!state.scopeForm || !!state.unfollowConfirm
	const following = (state.routes as { kind: string }[])[0].kind === 'following'
	const heading = exactDiscoveryText(
		expected,
		form ? '本地关注设置' : following ? '本地关注' : 'UP 主主页',
	)
	;(heading.props.style as Record<string, unknown>).flex = 1
	;(heading.props.style as Record<string, unknown>).textAlign = 'center'
	if (following) {
		exactDiscoveryText(
			expected,
			'这里管理音绘本地关注，不是投稿更新流。通知保持关闭，不会同步修改 B 站关系。',
		).children = ['音绘关注单独保存在本机，可以按音乐或听视频设置收听范围。']
		exactDiscoveryText(expected, 'mid 123 · 全部投稿').children = ['全部投稿']
	} else if (state.creator && !form) {
		replaceDiscoveryNode(
			expected,
			exactDiscoveryText(expected, 'BILIBILI CREATOR'),
		)
		replaceDiscoveryNode(expected, exactDiscoveryText(expected, '暂无本地头像'))
		exactDiscoveryText(expected, '暂无本地简介').children = ['暂无简介']
		exactDiscoveryText(expected, '本地已知资料').children = ['资料保存于本机']
		exactDiscoveryText(expected, '本地已保存的音源').children = ['已保存的音源']
	}
	return expected
}

function creatorPostsPresentationExpectation(
	expected: unknown,
	theme: (typeof builtInThemes)['modern'] | null,
	legacy: Awaited<ReturnType<typeof legacyControlPackage>>,
) {
	const title = exactDiscoveryText(expected, '平台返回的投稿')
	const newHeader = reviewedBlock(theme, legacy, (h) =>
		h.element(
			'View',
			{ style: { flexDirection: 'row', alignItems: 'center', gap: 12 } },
			h.element(
				component(h.ui.T),
				{ size: 18, weight: '700', style: { flex: 1 } },
				'投稿',
			),
			h.element(
				component(h.ui.ControlTarget),
				{
					minimumWidthDp: 72,
					accessibilityRole: 'button',
					accessibilityLabel: '收起投稿读取范围',
					accessibilityState: { expanded: true },
					onPress: () => {},
					style: { minHeight: 48, justifyContent: 'center' },
				},
				h.element(component(h.ui.T), { muted: true, size: 12 }, '读取范围'),
			),
		),
	)
	replaceDiscoveryNode(expected, title, newHeader)
	for (const caption of controlNodes(expected).filter(
		(node) => node.type === 'Text' && text(node) === '点击后读取原视频与分 P',
	))
		replaceDiscoveryNode(expected, caption)
	return expected
}

function feedPresentationExpectation(
	expected: unknown,
	state: ReturnType<typeof feedState>,
	theme: (typeof builtInThemes)['modern'] | null,
	legacy: Awaited<ReturnType<typeof legacyControlPackage>>,
) {
	feedRefreshExpectation(expected)
	const rootNode = discoveryNode(expected, 'FlatList')
	const header = discoveryNode(
		discoveryChildren(discoveryChildren(rootNode.children)[0])[0],
		'View',
	)
	const children = discoveryChildren(discoveryChildren(header.children)[0])
	assert.equal(children.length, 10)
	const intro = discoveryNode(children[0], 'Fragment')
	const introChildren = discoveryChildren(discoveryChildren(intro.children)[0])
	assert.equal(introChildren.length, 4)
	const headingRow = discoveryNode(introChildren[0], 'View')
	const headingChildren = discoveryChildren(
		discoveryChildren(headingRow.children)[0],
	)
	assert.equal(headingChildren.length, 2)
	assert.deepEqual(
		introChildren
			.slice(2)
			.map((node) => text(discoveryNode(node, 'Pressable'))),
		['管理本地关注的 UP 主', '寻找 UP 主'],
	)
	const menu = reviewedBlock(theme, legacy, (h) =>
		h.element(component(h.load('library-collection-ui').CollectionMenu), {
			label: '关注更新更多操作',
			actions: [
				'管理本地关注的 UP 主',
				'寻找 UP 主',
				'重新读取本地更新',
				state.coverageOpen ? '收起缓存范围' : '查看缓存范围与缺页',
			].map((labelText) => ({ label: labelText, onPress: () => {} })),
		}),
	)
	headingChildren.push(menu)
	introChildren.splice(2, 2)
	exactDiscoveryText(
		expected,
		'展示本机保存的投稿。主动刷新会读取本地关注 UP 的最新一页，不代表全部投稿。',
	).children = ['显示已保存的投稿；刷新会读取每位 UP 主的最新一页。']
	assert.equal(text(children[4]), '重新读取本地更新')
	children.splice(4, 1)
	const summary = discoveryNode(children[8], 'Fragment')
	const summaryChildren = discoveryChildren(
		discoveryChildren(summary.children)[0],
	)
	assert.equal(summaryChildren.length, 4)
	const count = discoveryNode(summaryChildren[0], 'Text')
	assert.equal(text(count), '按发布时间倒序 · 本机缓存 1 条不同投稿（筛选前）')
	count.children = [
		['已保存 ', 1, ' 条投稿', state.filter !== 'all' ? ' · 筛选前' : ''],
	]
	assert.equal(text(summaryChildren[2]), '收起缓存范围')
	const caution = structuredClone(discoveryNode(summaryChildren[1], 'Text'))
	caution.children = ['点击后核对原视频和分 P，尚未核验音轨可用性。']
	summaryChildren[2] = caution
	for (const rowCaution of controlNodes(rootNode).filter(
		(node) =>
			node !== caution && node.type === 'Text' && text(node) === text(caution),
	))
		replaceDiscoveryNode(expected, rowCaution)
	if (state.snapshot.status === 'filtered-empty') {
		exactDiscoveryText(expected, '当前范围没有匹配的缓存投稿').children = [
			'这个范围暂无投稿',
		]
		exactDiscoveryText(
			expected,
			'仅按已确认的内容类型和关注范围筛选，未知内容可在全部范围查看。',
		).children = [
			'还没有符合当前筛选和关注范围的投稿。可从更多菜单管理每位 UP 的关注范围。',
		]
	} else if (state.snapshot.status === 'partial-empty') {
		exactDiscoveryText(
			expected,
			'已读取的缓存为空，仍有关注尚未读取',
		).children = ['部分关注还没有读取']
		exactDiscoveryText(
			expected,
			'部分 UP 主尚无本地投稿缓存，不能判断这些关注是否有投稿。',
		).children = ['已读取部分暂无投稿，刷新可查看其他关注的最新一页。']
	}
	return expected
}

void test('actual four migrated pages retain default and real legacy48 native trees across key local/remote/feed/feedback states', async () => {
	const originals = Object.fromEntries(
		names.map((name) => [
			name,
			readBaselineSource(`${baseline}:android-app/apps/mobile/melo/${name}.tsx`).replaceAll('padding: 22', 'padding: 20').replaceAll('padding: 24', 'padding: 20').replaceAll('gap: 16', 'gap: 12').replaceAll('size={25}', 'size={23}').replaceAll('gap: 14, marginBottom: 14', 'gap: 10, marginBottom: 12'),
		]),
	)
	const legacy = await legacyControlPackage()
	const cases: [string, Record<string, unknown>][] = [
		['CreatorLibraryEntry', {}],
		['CreatorOverlay', creatorState()],
		['CreatorOverlay', creatorState({ routes: [{ kind: 'following' }] })],
		['CreatorOverlay', creatorState({ scopeForm: 'music' })],
		['CreatorOverlay', creatorState({ unfollowConfirm: true })],
		[
			'CreatorOverlay',
			creatorState({
				creator: null,
				error: '本地读取失败',
				playbackBusy: true,
			}),
		],
		['CreatorSearchResults', searchState()],
		['CreatorSearchResults', searchState({ items: [], keyword: '', page: 0 })],
		[
			'CreatorSearchResults',
			searchState({ items: [], page: 0, loading: true }),
		],
		['CreatorSearchResults', searchState({ items: [], page: 0 })],
		['CreatorSearchResults', searchState({ items: [], more: false })],
		[
			'CreatorSearchResults',
			searchState({ error: '下一页失败', failedPage: 2 }),
		],
		['CreatorProfileRead', remoteState()],
		[
			'CreatorProfileRead',
			remoteState({ profileLoading: true, profileError: '读取受限' }),
		],
		['CreatorPostsRead', remoteState()],
		['CreatorPostsRead', remoteState({ posts: [], page: 0, more: false })],
		['CreatorPostsRead', remoteState({ posts: [], more: false })],
		[
			'CreatorPostsRead',
			remoteState({ cacheStatus: 'failed', cacheError: '本地错误' }),
		],
		[
			'CreatorPostsRead',
			remoteState({ postsError: '下一页受限', failedPage: 2 }),
		],
		['FollowingFeedPage', feedState()],
		[
			'FollowingFeedPage',
			feedState({ playingBvid: post.bvid, stale: true, error: '读取失败' }),
		],
		[
			'FollowingFeedPage',
			feedState({
				filter: 'music',
				snapshot: { ...snapshot, items: [], status: 'filtered-empty' },
			}),
		],
		[
			'FollowingFeedPage',
			feedState({
				snapshot: { ...snapshot, items: [], status: 'partial-empty' },
			}),
		],
		['RecommendationPage', recommendationState()],
		[
			'RecommendationPage',
			recommendationState({
				busy: true,
				playingId: music.id,
				error: '读取失败',
			}),
		],
		[
			'RecommendationPage',
			recommendationState({
				snapshot: {
					localDate: '2026-10-19',
					revision: 0,
					items: [],
					canUndo: false,
				},
			}),
		],
		[
			'RecommendationPage',
			recommendationState({ view: 'dismissed', feedbackPage }),
		],
		[
			'RecommendationPage',
			recommendationState({
				view: 'dismissed',
				feedbackPage,
				feedbackStale: true,
				feedbackError: '刷新失败',
				restoredSourceIds: [music.id],
			}),
		],
		[
			'RecommendationPage',
			recommendationState({
				view: 'dismissed',
				feedbackPage: { ...feedbackPage, total: 0, items: [] },
			}),
		],
	]
	let retainedScenarioComparisons = 0,
		migratedComparisons = 0
	for (const theme of [...Object.values(builtInThemes), null]) {
		const old = host(originals),
			current = host()
		for (const [name, state] of cases) {
			const render = (h: Host) => {
				const element = h.element(
					component(theme ? h.ui.ThemeProvider : h.ui.PackageThemeProvider),
					theme ? { value: theme } : { ...legacy, reducedMotion: true },
					h.element(component(h.modules[name]), h.props(name, state)),
				)
				let tree = h.render(element)
				if (
					name === 'CreatorPostsRead' &&
					controls(tree).some(
						(node) => node.props.accessibilityLabel === '展开投稿读取范围',
					)
				) {
					press(tree, '展开投稿读取范围')
					tree = h.render(element)
				}
				return tree
			}
			const eventsBeforeRender = current.events.slice(),
				currentTree = render(current),
				actual = normalize(current, currentTree),
				expected = normalize(old, render(old))
			if (name === 'CreatorOverlay' && state.unfollowConfirm) {
				const confirmation = controlNodes(currentTree).find(node => node.type === 'Modal' && text(node).startsWith('取消本地关注？'))!
				assert.ok(confirmation, 'unfollow is a separate modal above the profile')
				assert.match(text(confirmation), /本机关注，B站关注关系和音乐资料会保留/)
				assert.ok(label(confirmation, '确认取消本地关注'))
				assert.ok(label(confirmation, '保留关注'))
				assert.match(text(currentTree), /UP 主主页/)
				retainedScenarioComparisons++
				continue
			}
			if (name === 'RecommendationPage' && (actual as ControlNode).props.testID === 'recommendation-feedback-page') {
				const currentChildren = (actual as ControlNode).children![0] as unknown[]
				assert.equal(currentChildren[0], null, 'closed confirmation mounts no modal')
				;((expected as ControlNode).children![0] as unknown[]).unshift(null)
			}
			if (theme) builtinDiscoveryFloors(expected)
			if (name === 'CreatorOverlay') {
				creatorPresentationExpectation(expected, state)
				const children = controlNodes(actual).find(node => node.type === 'ScrollView')
				assert.ok(children)
				// A closed unfollow confirmation adds no native surface.
				const actualModal = controlNodes(actual).find(node => node.type === 'Modal')!
				const row = (actualModal.children![0] as ControlNode).children![0] as unknown[]
				assert.equal(row[1], false)
			}
			if (name === 'CreatorProfileRead') {
				const expectedRoot = expected as ControlNode
				assert.deepEqual(expectedRoot.props.style, { marginTop: 14 })
				expectedRoot.props.style = { marginTop: 14, gap: 12 }
			}
			if (name === 'CreatorPostsRead')
				creatorPostsPresentationExpectation(expected, theme, legacy)
			assert.deepEqual(
				current.events,
				eventsBeforeRender,
				'rendering does not request or play',
			)
			if (name === 'CreatorSearchResults') {
				assert.deepEqual(
					actual,
					creatorSearchExpectation(expected, state.keyword === ''),
					`${theme?.id ?? 'legacy48'} ${name}`,
				)
				migratedComparisons++
			} else if (name === 'FollowingFeedPage') {
				assert.deepEqual(
					actual,
					feedPresentationExpectation(
						expected,
						state as ReturnType<typeof feedState>,
						theme,
						legacy,
					),
					`${theme?.id ?? 'legacy48'} ${name}`,
				)
				const refresh = label(currentTree, '刷新关注更新')
				assert.equal(refresh.props.accessibilityRole, 'button')
				assert.ok(
					refresh.props.disabled === undefined ||
						refresh.props.disabled === false,
				)
				assert.ok(Number(flat(current, refresh).minHeight) >= 48)
				press(currentTree, '刷新关注更新')
				assert.deepEqual(current.events, [...eventsBeforeRender, ['refresh']])
				migratedComparisons++
			} else {
				assert.deepEqual(actual, expected, `${theme?.id ?? 'legacy48'} ${name}`)
				retainedScenarioComparisons++
			}
		}
		for (const [name, state, more] of [
			['CreatorOverlay', creatorState(), '本地音源更多 音乐原题'],
			['CreatorOverlay', creatorState(), '本地音源更多 视频原题'],
			['CreatorPostsRead', remoteState(), '投稿更多 缓存投稿'],
		] as const) {
			const render = (h: Host) => {
				const element = h.element(
					component(theme ? h.ui.ThemeProvider : h.ui.PackageThemeProvider),
					theme ? { value: theme } : { ...legacy, reducedMotion: true },
					h.element(component(h.modules[name]), h.props(name, state)),
				)
				let tree = h.render(element)
				if (
					name === 'CreatorPostsRead' &&
					controls(tree).some(
						(node) => node.props.accessibilityLabel === '展开投稿读取范围',
					)
				) {
					press(tree, '展开投稿读取范围')
					tree = h.render(element)
				}
				return tree
			}
			press(render(old), more)
			press(render(current), more)
			const expected = normalize(old, render(old))
			if (theme) builtinDiscoveryFloors(expected)
			if (name === 'CreatorOverlay')
				creatorPresentationExpectation(expected, state)
			else creatorPostsPresentationExpectation(expected, theme, legacy)
			assert.deepEqual(
				normalize(current, render(current)),
				expected,
				`${theme?.id ?? 'legacy48'} expanded ${more}`,
			)
			retainedScenarioComparisons++
		}
		old.unmount()
		current.unmount()
	}
	assert.equal(retainedScenarioComparisons, 88)
	assert.equal(migratedComparisons, 40)
})

void test('actual following refresh is explicit, stop keeps its own action, and outcome copy never hides cached content', async () => {
	const legacy = await legacyControlPackage()
	for (const theme of [...Object.values(builtInThemes), null]) {
		const h = host()
		const render = (state: ReturnType<typeof feedState>) =>
			h.render(
				h.element(
					component(theme ? h.ui.ThemeProvider : h.ui.PackageThemeProvider),
					theme ? { value: theme } : { ...legacy, reducedMotion: true },
					h.element(
						component(h.modules.FollowingFeedPage),
						h.props('FollowingFeedPage', state),
					),
				),
			)
		let tree = render(feedState())
		assert.deepEqual(
			h.events,
			[],
			'opening the cache view is not a refresh or playback intent',
		)
		assert.ok(label(tree, '核对并收听关注投稿 缓存投稿'))
		press(tree, '刷新关注更新')
		assert.deepEqual(h.events, [['refresh']])
		tree = render(
			feedState({
				refresh: {
					...emptyFeedRefresh(),
					running: true,
					attempted: 2,
					total: 3,
					message: '仅刷新本地关注的最新一页，不读取全部历史投稿。',
				},
			}),
		)
		assert.deepEqual(
			h.events,
			[['refresh']],
			'progress rendering cannot start another request',
		)
		assert.equal(
			controls(tree).some((node) => text(node.children) === '刷新关注更新'),
			false,
		)
		assert.match(text(tree), /仅刷新本地关注的最新一页，不读取全部历史投稿。/)
		assert.ok(label(tree, '核对并收听关注投稿 缓存投稿'))
		press(tree, '停止刷新 · 2/3')
		assert.deepEqual(h.events, [['refresh'], ['cancelRefresh']])
		tree = render(
			feedState({
				refresh: {
					...emptyFeedRefresh(),
					failed: 1,
					finishedAt: 1000,
					message: '有 1 位 UP 读取失败，保留之前的缓存。',
				},
			}),
		)
		assert.match(text(tree), /有 1 位 UP 读取失败，保留之前的缓存。/)
		assert.ok(
			text(tree).includes(`上次结束：${new Date(1000).toLocaleString()}`),
		)
		assert.ok(label(tree, '核对并收听关注投稿 缓存投稿'))
		assert.deepEqual(
			h.events,
			[['refresh'], ['cancelRefresh']],
			'an outcome never auto-retries',
		)
		press(tree, '刷新关注更新')
		assert.deepEqual(h.events, [['refresh'], ['cancelRefresh'], ['refresh']])
		h.unmount()
	}
})

void test('actual creator source and candidate rows measure their stretched parent; primary/more/alternate callbacks and busy state stay owned by callers', () => {
	const h = host(),
		page = root(h, 'CreatorOverlay', creatorState())
	let tree = h.render(page)
	assert.equal(controls(tree).length, 0)
	const row = measurements(tree).find((node) =>
		String(node.key).includes('[164,48]'),
	)!
	assert.ok(row)
	measure(row, 250)
	tree = h.render(page)
	assert.equal(flat(h, label(tree, '收听本地视频音源 视频原题')).minWidth, 164)
	assert.equal(flat(h, label(tree, '本地音源更多 视频原题')).width, 72)
	press(tree, '收听本地视频音源 视频原题')
	press(tree, '本地音源更多 视频原题')
	tree = settle(h, page)
	press(tree, '以音乐播放 视频原题')
	assert.deepEqual(h.events, [
		['play', video, 'listening'],
		['play', video, 'music'],
	])
	const candidate = root(h, 'CreatorPostsRead', remoteState())
	tree = settle(h, candidate)
	press(tree, '核对并收听投稿 缓存投稿')
	press(tree, '投稿更多 缓存投稿')
	tree = settle(h, candidate)
	press(tree, '核对后以音乐播放 缓存投稿')
	press(tree, '加载更多投稿')
	assert.deepEqual(h.events.slice(-3), [
		['play', post, 'listening'],
		['play', post, 'music'],
		['loadMore'],
	])
	const busy = h.element(
		component(h.ui.ThemeProvider),
		{ value: builtInThemes.modern },
		h.element(component(h.modules.CreatorPostsRead), {
			...h.props('CreatorPostsRead', remoteState()),
			playbackBusy: true,
		}),
	)
	tree = h.render(busy)
	assert.equal(label(tree, '核对并收听投稿 缓存投稿').props.disabled, true)
})

void test('actual feed tabs share measured minima, retain unknown/origin actions and reject stale layout after font changes', () => {
	const h = host(),
		page = root(h, 'FollowingFeedPage', feedState())
	let tree = h.render(page)
	assert.equal(visibleControls(tree).length, 0)
	const tabs = measurements(tree).find((node) =>
		String(node.key).includes('[72,72,72]'),
	)!
	assert.ok(tabs)
	for (const [width, touch] of [
		[310, 96],
		[240, 72],
		[220, null],
		[310, 96],
	] as const) {
		measure(tabs, width)
		tree = h.render(page)
		if (touch === null)
			assert.equal(
				controls(tree).some((node) => node.props.accessibilityRole === 'tab'),
				false,
			)
		else assert.equal(flat(h, label(tree, '关注更新：听视频')).minWidth, touch)
	}
	tree = settle(h, page)
	press(tree, '关注更新：音乐')
	press(tree, '核对并收听关注投稿 缓存投稿')
	press(tree, '核对关注投稿后以音乐播放 缓存投稿')
	press(tree, '查看关注来源 UP 主 已知 UP，mid 123')
	press(tree, '查看缓存 UP 主 已知 UP，mid 123')
	press(tree, '关注更新更多操作')
	tree = settle(h, page)
	assert.equal(
		controlNodes(tree).find((node) => node.type === 'Modal')!.props.visible,
		true,
	)
	press(tree, '收起缓存范围')
	tree = settle(h, page)
	assert.equal(
		controlNodes(tree).find((node) => node.type === 'Modal')!.props.visible,
		false,
	)
	assert.deepEqual(h.events, [
		['setFilter', 'music'],
		['play', post.bvid, 'listening'],
		['play', post.bvid, 'music'],
		['creator', creator],
		['creator', creator],
		['setCoverageOpen', false],
	])
	const old = measurements(tree)
	h.viewport.fontScale = 2
	tree = h.render(page)
	assert.equal(visibleControls(tree).length, 0)
	for (const callback of old) measure(callback, 400)
	assert.equal(visibleControls(h.render(page)).length, 0)
	tree = settle(h, page)
	assert.ok(label(tree, '关注更新：全部'))
	h.unmount()
	for (const callback of measurements(tree)) measure(callback, 400)
	assert.equal(h.writesAfterUnmount, 0)
})

void test('actual recommendation play/feedback rows measure together, keep callback identity and page/restore disabled guards', () => {
	const h = host(),
		daily = root(h, 'RecommendationPage', recommendationState())
	let tree = h.render(daily)
	const row = measurements(tree).find((node) =>
		String(node.key).includes('[108,48]'),
	)!
	assert.ok(row)
	measure(row, 190)
	tree = h.render(daily)
	assert.equal(flat(h, label(tree, '对此音源不感兴趣 音乐原题')).width, 72)
	assert.equal(flat(h, label(tree, '播放每日推荐音源 音乐原题')).flex, 1)
	press(tree, '播放每日推荐音源 音乐原题')
	press(tree, '对此音源不感兴趣 音乐原题')
	assert.deepEqual(h.events, [
		['play', music.id],
		['dismiss', music.id],
	])
	const feedback = root(
		h,
		'RecommendationPage',
		recommendationState({ view: 'dismissed', feedbackPage }),
	)
	tree = settle(h, feedback)
	const pagination = measurements(tree).find((node) =>
		String(node.key).includes('[88,88]'),
	)!
	assert.ok(pagination)
	const allocations = (pagination.children ?? []).flat(
		Infinity,
	) as ControlNode[]
	assert.equal(allocations.length, 2)
	assert.ok(
		allocations.every(
			(node) => node.type === 'View' && flat(h, node).flex === 1,
		),
		'nonfixed text Buttons are constrained by parent-assigned flex slots',
	)
	press(tree, '恢复此音源 missing')
	press(tree, '上一页反馈')
	press(tree, '下一页反馈')
	assert.deepEqual(h.events.slice(-3), [
		['restoreSource', 'missing', 3],
		['loadDismissed', 1],
		['loadDismissed', 3],
	])
	const stale = root(
		h,
		'RecommendationPage',
		recommendationState({
			view: 'dismissed',
			feedbackPage,
			feedbackStale: true,
		}),
	)
	tree = settle(h, stale)
	assert.equal(label(tree, '恢复此音源 missing').props.disabled, true)
	assert.equal(
		controls(tree).some((node) => text(node.children) === '下一页反馈'),
		false,
	)
})

void test('actual feed tabs at fontScale2 keep a single allocated row without fixed width/height or text truncation', () => {
	const h = host()
	h.viewport.fontScale = 2
	const page = root(h, 'FollowingFeedPage', feedState())
	let tree = h.render(page)
	const row = measurements(tree).find((node) =>
		String(node.key).includes('[72,72,72]'),
	)
	assert.ok(row)
	assert.equal(flat(h, row).flexDirection, 'row')
	assert.equal(flat(h, row).flexWrap, 'nowrap')
	for (const [width, touch] of [
		[310, 96],
		[240, 72],
		[232, 72],
	] as const) {
		measure(row, width)
		tree = h.render(page)
		const tabs = controls(tree).filter(
			(node) => node.props.accessibilityRole === 'tab',
		)
		assert.equal(tabs.length, 3)
		for (const tab of tabs) {
			const style = flat(h, tab)
			assert.equal(
				style.height,
				undefined,
				'text may grow beyond the touch minimum',
			)
			assert.equal(style.maxHeight, undefined)
			assert.equal(
				style.width,
				undefined,
				'parent flex divides the measured row',
			)
			assert.equal(style.flex, 1)
			assert.equal(style.minWidth, Math.max(72, touch))
			assert.equal(style.minHeight, touch)
			assert.equal(style.paddingHorizontal, 12)
			for (const textNode of controlNodes(tab).filter(
				(node) => node.type === 'Text',
			)) {
				assert.equal(textNode.props.numberOfLines, undefined)
				assert.notEqual(textNode.props.allowFontScaling, false)
			}
		}
	}
	press(tree, '关注更新：全部')
	press(tree, '关注更新：音乐')
	press(tree, '关注更新：听视频')
	assert.deepEqual(h.events, [
		['setFilter', 'all'],
		['setFilter', 'music'],
		['setFilter', 'listening'],
	])
	h.unmount()
})

void test('actual creator scope, follow cancellation, source links and search/retry actions retain original callbacks', () => {
	const h = host(),
		form = root(h, 'CreatorOverlay', creatorState({ scopeForm: 'all' }))
	let tree = settle(h, form)
	assert.equal(
		(
			label(tree, '关注范围：全部投稿').props.accessibilityState as {
				checked: boolean
			}
		).checked,
		true,
	)
	press(tree, '关注范围：听视频内容')
	press(tree, '保存关注范围')
	assert.deepEqual(h.events, [['setScope', 'listening'], ['saveScope']])
	tree = settle(
		h,
		root(h, 'CreatorOverlay', creatorState({ unfollowConfirm: true })),
	)
	press(tree, '确认取消本地关注')
	assert.deepEqual(h.events.at(-1), ['unfollow'])
	tree = settle(
		h,
		root(h, 'CreatorOverlay', creatorState({ playbackBusy: true })),
	)
	press(tree, '取消本次播放')
	press(tree, '取消本地关注')
	assert.deepEqual(h.events.slice(-2), [
		['cancelPlayback'],
		['requestUnfollow'],
	])
	tree = settle(
		h,
		root(
			h,
			'CreatorSearchResults',
			searchState({ error: '失败', failedPage: 2 }),
		),
	)
	press(tree, '查看搜索 UP 主 已知 UP，mid 123')
	press(tree, '重试读取')
	assert.deepEqual(h.events.slice(-2), [['open', creator], ['retry']])
})
