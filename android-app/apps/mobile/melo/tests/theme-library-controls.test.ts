import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'

import type { Source } from '../core/model'
import { playlistEntryId } from '../core/queue'
import { readBaselineSource } from './baseline-source'

import { builtInThemes } from '../core/theme'
import type { AdaptedPackageTheme } from '../core/theme-package-adapter'
import * as importDisplay from '../import-display'
import * as playlistSelection from '../playlist-selection'
import type { PlaylistSession, PlaylistState } from '../playlist-session'

import { approvedRedesignCopy } from './redesign-copy'
import { migrateInputAppearance } from './input-appearance-contract'
import {
	controlFixture,
	controlNodes,
	legacyControlPackage,
	type ControlNode,
} from './theme-control-fixture'

// The author baseline is unavailable on GitHub; this published integration has the same pre-migration UI blobs.
const baseline = 'c59bb4a793460ba88b490f676cea2e27b6c953b4'
const component = (value: unknown) => value as ControlNode['type']
const noop = () => {}
const source: Source = {
	id: 'bilibili:BV1234567890:10',
	bvid: 'BV1234567890',
	cid: 10,
	originalTitle: '原标题 A',
	uploader: '真实 UP',
	uploaderId: 123,
	performer: null,
	artwork: '',
	duration: 120,
	domain: 'music',
	audioAvailability: 'unknown',
}
const second = {
	...source,
	id: 'bilibili:BV1234567890:20',
	cid: 20,
	originalTitle: '原标题 B',
}
function state(overrides: Partial<PlaylistState> = {}): PlaylistState {
	const playlist = {
		id: 'p',
		name: '我的长标题歌单',
		description: '',
		coverUri: null,
		createdAt: 1,
		updatedAt: 2,
	}
	return {
		playlists: [
			{ playlist, count: 3, pendingCount: 0, artwork: null, importSummary: '' },
		],
		currentId: 'p',
		detail: {
			...playlist,
			items: [source, second, source].map((s, index) => ({
				itemId: `i${index + 1}`,
				playlistId: 'p',
				sourceId: s.id,
				position: index,
				addedAt: 1,
				importOrigin: null,
				review: null,
			})),
		},
		sources: new Map([
			[source.id, source],
			[second.id, second],
		]),
		detailQuery: '',
		detailViewToken: 0,
		detailFilter: 'all',
		editing: false,
		selectedItemIds: [],
		nameForm: null,
		coverForm: null,
		picker: null,
		targetSources: null,
		deleting: false,
		undoAvailable: false,
		error: '',
		notice: '',
		...overrides,
	}
}
function pendingState() {
	const value = state()
	const review = {
		state: 'pending' as const,
		candidates: [],
		confirmation: null,
	}
	value.detail!.items[1] = {
		...value.detail!.items[1],
		sourceId: null,
		review,
		importOrigin: {
			taskId: 'task',
			provider: 'bilibili',
			originalPlaylistId: 'folder',
			taskVersion: 1,
			entryId: 'occ2',
			originalEntryId: '123',
			originalPosition: 1,
			originalMetadata: { media: { bvid: source.bvid, title: '待补全原条目' } },
			reviewAtCommit: review,
		},
	}
	return value
}
function host(sources: Record<string, string> = {}) {
	const calls: unknown[][] = []
	const dependencies: Record<string, unknown> = {
		'./core/queue': { playlistEntryId },
		'./playlist-selection': playlistSelection,
		'./import-display': importDisplay,
	}
	const f = controlFixture(sources, dependencies)
	dependencies['./theme-input'] = f.load('theme-input')
	for (const [path, name] of [
		['./creator-ui', 'CreatorLibraryEntry'],
		['./import-ui', 'ImportEntry'],
		['./page-title', 'PageTitle'],
	])
		dependencies[path] = {
			[name]: (props: Record<string, unknown>) => f.element(name, props),
		}
	const playlist = f.load('playlist-ui')
	dependencies['./playlist-ui'] = playlist
	const library = f.load('library-ui'),
		ui = f.load('ui')
	const session = Object.fromEntries(
		[
			'requestName',
			'open',
			'refresh',
			'setEditing',
			'setDetailQuery',
			'setDetailFilter',
			'clearDetailFilters',
			'toggleItem',
			'selectAll',
			'clearSelection',
			'removeSelected',
			'move',
			'openAdd',
			'undoRemove',
			'requestDelete',
			'closeSheet',
			'setName',
			'saveName',
			'confirmDelete',
			'selectTarget',
			'setPickerQuery',
			'toggleSource',
			'setDuplicatePolicy',
			'appendSelected',
		].map((name) => [
			name,
			(...args: unknown[]) => calls.push([name, ...args]),
		]),
	) as unknown as PlaylistSession
	session.getDetailScroll = () => ({ itemId: null, index: 0, offset: 0 })
	session.getSnapshot = () => state()
	session.recordDetailScroll = noop
	const props = (value: PlaylistState) => ({
		state: value,
		session,
		onBack: () => calls.push(['back']),
		onSearch: () => calls.push(['search']),
		onPlay: async (...args: unknown[]) => {
			calls.push(['play', ...args])
			return true
		},
		onReviewBilibiliPending: (...args: unknown[]) =>
			calls.push(['review', ...args]),
		playbackBusy: false,
		currentEntryId: playlistEntryId('i3'),
		bottomInset: 12,
		reducedMotion: true,
	})
	const libraryProps = (value: PlaylistState) => ({
		playlistState: value,
		playlistSession: session,
		onPlaylistBack: noop,
		onPlaylistSearch: noop,
		onPlayPlaylist: props(value).onPlay,
		onPlayLiked: () => calls.push(['playLiked']),
		playbackBusy: false,
		currentEntryId: null,
		bottomInset: 12,
		reducedMotion: true,
		listeningOpen: false,
		onListeningOpenChange: (open: boolean) => calls.push(['listening', open]),
		resumeItems: [],
		onPlayListening: noop,
		localDataError: '',
		onFindListening: noop,
		onFindMusic: noop,
		onOpenFollowing: noop,
		onOpenFollowingFeed: noop,
		onImport: noop,
		onOpenVideoSaves: noop,
		onReviewBilibiliPending: noop,
		likes: [source],
		renderLikedSource: (liked: Source, index: number) =>
			f.element('LikedRow', { sourceId: liked.id, index }),
	})
	return { ...f, playlist, library, ui, calls, session, props, libraryProps }
}
type Host = ReturnType<typeof host>
const policy = {
	minTouchDp: 96,
	compactMinTouchDp: 72,
	narrowFallback: 'host-single-row' as const,
}
function adapted(): AdaptedPackageTheme {
	return {
		theme: structuredClone(builtInThemes.modern),
		mode: 'light',
		retained: {
			buttonMinTouchDp: 96,
			controlRowLayout: policy,
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
function packageRoot(h: Host, child: unknown, value = adapted()) {
	return h.element(
		component(h.ui.PackageThemeProvider),
		{ adapted: value, allowedImageUris: [], reducedMotion: true },
		child,
	)
}
function controls(tree: unknown) {
	return controlNodes(tree).filter((node) => node.type === 'Pressable')
}
/** Hidden native Modals have no hittable descendants; retain raw trees for goldens. */
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

function text(value: unknown): string {
	if (Array.isArray(value)) return value.map(text).join('')
	if (value && typeof value === 'object' && 'children' in value)
		return text((value as ControlNode).children)
	return typeof value === 'string' || typeof value === 'number'
		? String(value)
		: ''
}
function controlName(node: ControlNode) {
	return typeof node.props.accessibilityLabel === 'string' ? node.props.accessibilityLabel : text(node.children)
}
function label(tree: unknown, name: string) {
	const found = controls(tree).find((node) => controlName(node).replaceAll(' · ','，') === name.replaceAll(' · ','，'))
	assert.ok(found, `missing control: ${name}`)
	return found
}
function press(tree: unknown, name: string) {
	;(label(tree, name).props.onPress as () => void)()
}
function flat(h: Host, node: ControlNode) {
	return h.flatten(
		typeof node.props.style === 'function'
			? node.props.style({ pressed: false })
			: node.props.style,
	)
}
function normalize(h: Host, value: unknown): unknown {
	if (Array.isArray(value))
		return Array.from(value)
			.filter(
				(v) =>
					v !== undefined &&
					v !== false &&
					!(
						v &&
						typeof v === 'object' &&
						'props' in v &&
						['playlist-detail-filters', 'library-play-liked'].includes(
							String((v as ControlNode).props.testID),
						)
					),
			)
			.map((v) => normalize(h, v))
	if (typeof value === 'function') return '<callback>'
	if (!value || typeof value !== 'object') return value
	if ('type' in value) {
		const node = value as ControlNode
		return {
			type: node.type,
			props: normalize(
				h,
				Object.fromEntries(
					Object.entries(node.props)
						.filter(([key, v]) => key !== 'children' && v !== undefined)
						.map(([key, v]) => [key, key === 'style' ? flat(h, node) : v]),
				),
			),
			children: normalize(h, node.children),
		}
	}
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.map(([key, v]) => [key, normalize(h, v)]),
	)
}
function measured(tree: unknown) {
	return controlNodes(tree).filter(
		(node) => typeof node.props.onLayout === 'function',
	)
}
function measure(node: ControlNode, width: number) {
	;(node.props.onLayout as (event: unknown) => void)({
		nativeEvent: { layout: { width } },
	})
}
function settle(h: Host, root: unknown, width = 350) {
	let tree = h.render(root)
	for (let pass = 0; pass < 3; pass++) {
		for (const row of measured(tree)) measure(row, width)
		tree = h.render(root)
	}
	return tree
}

/** Audited c59 deltas only: verify both exact leaves before adapting the historical expectation.
 * This is not a normalizer: callers name the scenario, exact old/new child arrays and count.
 */
function expectLibraryTextDelta(
	actual: unknown,
	expected: unknown,
	before: unknown[],
	after: unknown[],
	count: number,
) {
	const oldNodes = controlNodes(expected).filter(
		(node) => node.type === 'Text' && text(node.children) === text(before),
	)
	const newNodes = controlNodes(actual).filter(
		(node) => node.type === 'Text' && text(node.children) === text(after),
	)
	assert.equal(oldNodes.length, count, 'exact historical text leaf count')
	assert.equal(newNodes.length, count, 'exact current text leaf count')
	for (const node of oldNodes) {
		assert.deepEqual(node.children, before)
		node.children = structuredClone(after)
	}
	for (const node of newNodes) assert.deepEqual(node.children, after)
}
function uniqueLibraryNameInput(tree: unknown) {
	const found = controlNodes(tree).filter(
		(node) =>
			node.type === 'TextInput' && node.props.accessibilityLabel === '歌单名称',
	)
	assert.equal(found.length, 1)
	return found[0]
}
function expectLibraryNameDefault(actual: unknown, expected: unknown) {
	const before = uniqueLibraryNameInput(expected),
		after = uniqueLibraryNameInput(actual)
	assert.equal(Object.hasOwn(before.props, 'multiline'), false)
	assert.equal(after.props.multiline, false)
	before.props.multiline = false
}

/** Approved pending-row migration only: the same live review control is moved
 * below the disabled song shell. Compare its entire old subtree before moving
 * the historical expectation; all row content and unrelated styles remain exact.
 */
function expectPendingReviewPlacement(actual: unknown, expected: unknown) {
	for (const row of controlNodes(actual).filter((node) =>
		String(node.props.testID).startsWith('playlist-item-'),
	)) {
		const footer = controlNodes(row).find(
			(node) => node.props.testID === 'playlist-pending-review',
		)
		if (!footer) continue
		assert.deepEqual(footer.props, {
			testID: 'playlist-pending-review',
			style: { marginTop: 10 },
		})
		const previous = controlNodes(expected).find(
			(node) => node.props.testID === row.props.testID,
		)!
		assert.ok(previous)
		const shell = controls(row).find((node) => node.props.disabled === true)!
		const oldShell = controls(previous).find(
			(node) => node.props.disabled === true,
		)!
		assert.ok(shell)
		assert.ok(oldShell)
		assert.equal(
			controlNodes(shell).includes(footer),
			false,
			'review lives below the disabled song shell',
		)
		const currentChildren = (footer.children ?? [])
			.flat(Infinity)
			.filter((node) => node && typeof node === 'object') as ControlNode[]
		assert.equal(currentChildren.length, 1)
		const oldReview = structuredClone(currentChildren[0])
		for (const node of controlNodes(oldReview)) {
			if (node.type === 'Text' && text(node.children) === '匹配此条目')
				node.children = ['核对B站原BV并补全此待匹配项']
			const style = node.props.style as Record<string, unknown> | undefined
			if (style?.width === '100%') {
				assert.equal(style.flex, undefined)
				delete style.width
				style.flex = 1
			}
		}
		const candidates = controlNodes(oldShell).filter((node) =>
			isDeepStrictEqual(node, oldReview),
		)
		assert.equal(
			candidates.length,
			1,
			'entire relocated review subtree matches the historical control',
		)
		const removed = candidates[0]
		const remove = (value: unknown): unknown =>
			Array.isArray(value)
				? value.filter((entry) => entry !== removed).map(remove)
				: value && typeof value === 'object' && 'children' in value
					? Object.assign(value, {
							children: remove((value as ControlNode).children),
						})
					: value
		oldShell.children = remove(oldShell.children) as unknown[]
		assert.ok(Array.isArray(previous.children?.[0]))
		previous.children[0].push(structuredClone(footer))
	}
}
function expectLibraryScenarioDelta(
	name: string,
	value: PlaylistState,
	actual: unknown,
	expected: unknown,
) {
	if (name === 'PlaylistDetailPage')
		expectPendingReviewPlacement(actual, expected)
	if (name === 'PlaylistLibrarySection' && value.playlists.length) {
		expectLibraryTextDelta(
			actual,
			expected,
			[[3, ' 个', '音源', ' · 我 · 本地歌单', '']],
			[[3, ' ', '首', '']],
			1,
		)
	} else if (
		name === 'PlaylistLibrarySection' &&
		!value.playlists.length &&
		!value.error
	) {
		assert.ok(text(actual).includes('暂无歌单'))
		assert.ok(label(actual, '新建歌单'))
	} else if (name === 'PlaylistDetailPage' && value.detail?.items.length) {
		expectLibraryTextDelta(
			actual,
			expected,
			[['02:00', ' · Bilibili']],
			[['02:00', ' ·', ' ', 'Bilibili']],
			value.detail.items.filter((item) => item.sourceId !== null).length,
		)
	} else if (name === 'PlaylistDialogs' && value.nameForm) {
		expectLibraryNameDefault(actual, expected)
	} else if (name === 'PlaylistDialogs' && value.picker?.sources.length) {
		expectLibraryTextDelta(
			actual,
			expected,
			[['UP · ', '真实 UP', ' · ', '02:00']],
			[['UP', '，', ' ', '真实 UP', '，', '02:00']],
			2,
		)
	} else return false
	return true
}
function expectBuiltinLibraryTarget(
	after: ControlNode,
	before: ControlNode,
	width: number,
	height: number,
	oldHeight: number | undefined,
) {
	assert.equal(after.type, 'Pressable')
	assert.equal(before.type, 'Pressable')
	const style = before.props.style as Record<string, unknown>
	assert.equal(style.minWidth, undefined, 'exact historical target width')
	assert.equal(style.minHeight, oldHeight, 'exact historical target height')
	const next = { ...style, minWidth: width, minHeight: height }
	assert.deepEqual(after.props.style, next, 'exact builtin target bounds')
	before.props.style = next
}
function expectBuiltinLibraryTouchDelta(
	name: string,
	value: PlaylistState,
	actual: unknown,
	expected: unknown,
) {
	if (name === 'PlaylistLibrarySection') {
		for (const { playlist } of value.playlists) {
			const id = `playlist-${playlist.id}`
			expectBuiltinLibraryTarget(
				uniqueLibraryNode(actual, id),
				uniqueLibraryNode(expected, id),
				152,
				86,
				undefined,
			)
		}
	} else if (name === 'PlaylistDetailPage') {
		for (const item of value.detail?.items ?? []) {
			if (
				!value.editing &&
				(!item.sourceId || !value.sources.get(item.sourceId))
			)
				continue
			const id = `playlist-item-${item.itemId}`,
				before = controls(uniqueLibraryNode(expected, id))[0],
				after = controls(uniqueLibraryNode(actual, id))[0]
			assert.equal(
				before.props.accessibilityRole,
				value.editing ? 'checkbox' : 'button',
			)
			expectBuiltinLibraryTarget(
				after,
				before,
				(value.editing ? 140 : 134) + (item.itemId === 'i3' ? 28 : 0),
				62,
				62,
			)
		}
	} else if (name === 'PlaylistDialogs' && value.targetSources) {
		for (const actionName of [
			...value.playlists.map(
				({ playlist, count }) => `${playlist.name} · ${count} 项`,
			),
			'新建歌单并继续添加',
		])
			expectBuiltinLibraryTarget(
				label(actual, actionName),
				label(expected, actionName),
				48,
				54,
				54,
			)
	} else if (name === 'PlaylistDialogs' && value.picker) {
		for (const pickedSource of playlistSelection.selectPlaylistPickerSources(
			value.picker.sources,
			value.picker.query,
		))
			expectBuiltinLibraryTarget(
				label(actual, `选择音源 ${pickedSource.originalTitle}`),
				label(expected, `选择音源 ${pickedSource.originalTitle}`),
				138,
				76,
				76,
			)
	}
}
function uniqueLibraryNode(tree: unknown, testID: string) {
	const found = controlNodes(tree).filter(
		(node) => node.props.testID === testID,
	)
	assert.equal(found.length, 1, testID)
	return found[0]
}
function uniqueLibraryModal(tree: unknown) {
	const found = controlNodes(tree).filter((node) => node.type === 'Modal')
	assert.equal(found.length, 1)
	return found[0]
}
function pressVisibleLibrary(tree: unknown, name: string) {
	const found = visibleControls(tree).filter(
		(node) => controlName(node) === name,
	)
	assert.equal(found.length, 1, name)
	assert.notEqual(found[0].props.disabled, true)
	;(found[0].props.onPress as () => void)()
}
function assertGallery(
	actual: unknown,
	value: PlaylistState,
	builtin: boolean,
) {
	const cards = controlNodes(actual).filter(
		(n) =>
			n.type === 'Pressable' &&
			typeof n.props.testID === 'string' &&
			n.props.testID.startsWith('playlist-'),
	)
	assert.equal(cards.length, value.playlists.length)
	for (const {
		playlist,
		count,
		pendingCount,
		importSummary,
	} of value.playlists) {
		const card = cards.find(
			(n) => n.props.testID === 'playlist-' + playlist.id,
		)!
		assert.equal(card.props.accessibilityRole, 'button')
		assert.equal(
			card.props.accessibilityLabel,
			`打开歌单 ${playlist.name}，${count}个${pendingCount ? '条目' : '音源'}`,
		)
		assert.ok(text(card).includes(playlist.name))
		assert.ok(text(card).includes(count + (pendingCount ? ' 项' : ' 首')))
		if (importSummary) assert.ok(text(card).includes(importSummary))
		const style = card.props.style as Record<string, unknown>
		assert.equal(style.minHeight, builtin ? 48 : undefined)
		assert.equal(style.minWidth, builtin ? 48 : 0)
		assert.ok(Number(style.width) >= 48)
		assert.equal(card.props.onPress, '<callback>')
	}
	if (value.error) assert.ok(text(actual).includes(value.error))
	if (value.notice) assert.ok(text(actual).includes(value.notice))
	if (!value.playlists.length && !value.error)
		assert.ok(text(actual).includes('暂无歌单'))
}
type LibraryDraw = (overrides?: Record<string, unknown>) => unknown
function assertContentFirstLibrary(
	current: Host,
	old: Host,
	currentTree: unknown,
	oldTree: unknown,
	draw: LibraryDraw,
	builtin: boolean,
) {
	const actualSection = normalize(
		current,
		uniqueLibraryNode(currentTree, 'playlist-library-section'),
	)
	const oldSection = normalize(
		old,
		uniqueLibraryNode(oldTree, 'playlist-library-section'),
	)
	expectLibraryScenarioDelta(
		'PlaylistLibrarySection',
		state(),
		actualSection,
		oldSection,
	)
	assertGallery(actualSection, state(), builtin)
	assert.equal(
		controlNodes(oldTree).filter((node) => node.type === 'PageTitle').length,
		1,
	)
	assert.equal(
		controlNodes(currentTree).filter((node) => node.type === 'PageTitle')
			.length,
		0,
	)
	assert.deepEqual(visibleControls(currentTree).map(controlName), [
		'新建与导入',
		'打开喜欢',
		'打开最近',
		'打开本地',
		'打开听视频',
		'歌单',
		'听视频',
		'UP 主',
		'我喜欢的，1 首',
		'导入歌单',
		'新建本地歌单',
		'打开歌单 我的长标题歌单，3个音源',
		'关注的 UP 主',
		'关注更新',
		'听视频收藏',
		'待分类内容',
	])
	assert.equal(uniqueLibraryModal(currentTree).props.visible, false)
	assert.equal(
		controlNodes(currentTree).filter((node) => node.type === 'LikedRow').length,
		0,
	)
	for (const name of ['打开喜欢', '打开最近', '打开本地', '打开听视频']) {
		const node = label(currentTree, name)
		assert.equal(node.props.accessibilityRole, 'button')
		assert.equal(flat(current, node).minHeight, 68)
		assert.equal(flat(current, node).flex, 1)
	}
	for (const name of ['关注的 UP 主', '关注更新', '听视频收藏', '待分类内容']) {
		assert.equal(label(currentTree, name).props.accessibilityRole, 'button')
		assert.equal(flat(current, label(currentTree, name)).minHeight, 52)
	}
	assert.equal(flat(current, label(currentTree, '新建与导入')).minHeight, 48)
	const start = current.calls.length
	for (const name of [
		'打开喜欢',
		'打开最近',
		'打开本地',
		'打开听视频',
		'关注的 UP 主',
		'关注更新',
		'听视频收藏',
		'待分类内容',
	]) {
		pressVisibleLibrary(draw(), name)
	}
	assert.deepEqual(current.calls.slice(start), [
		['collection', 'likes'],
		['collection', 'recent'],
		['collection', 'local'],
		['listening', true],
		['following'],
		['feed'],
		['saves', 'listening'],
		['saves', 'unclassified'],
	])
	for (const name of ['关闭操作菜单', '取消操作', 'android-back']) {
		const before = current.calls.length
		pressVisibleLibrary(draw(), '新建与导入')
		let tree = draw()
		assert.equal(uniqueLibraryModal(tree).props.visible, true)
		assert.deepEqual(
			visibleControls(uniqueLibraryModal(tree)).map(controlName),
			[
				'关闭操作菜单',
				'新建歌单',
				'导入歌单',
				'本地音乐，导入文件',
				'取消操作',
			],
		)
		for (const action of ['新建歌单', '导入歌单', '本地音乐，导入文件'])
			assert.equal(flat(current, label(tree, action)).minHeight, 52)
		if (name === 'android-back')
			(uniqueLibraryModal(tree).props.onRequestClose as () => void)()
		else pressVisibleLibrary(tree, name)
		tree = draw()
		assert.equal(uniqueLibraryModal(tree).props.visible, false)
		assert.equal(current.calls.length, before)
	}
	for (const [name, expected] of [
		['新建歌单', ['requestName', 'create']],
		['导入歌单', ['import']],
		['本地音乐，导入文件', ['collection', 'local']],
	] as const) {
		const before = current.calls.length
		pressVisibleLibrary(draw(), '新建与导入')
		pressVisibleLibrary(uniqueLibraryModal(draw()), name)
		assert.equal(uniqueLibraryModal(draw()).props.visible, false)
		assert.deepEqual(current.calls.slice(before), [expected])
	}
	const liked = draw({ collection: 'likes' })
	assert.deepEqual(
		normalize(
			current,
			controlNodes(liked).filter((node) => node.type === 'LikedRow'),
		),
		normalize(
			old,
			controlNodes(oldTree).filter((node) => node.type === 'LikedRow'),
		),
		'liked content moves intact into its explicit collection route',
	)
	assert.equal(label(liked, '播放全部喜欢').props.disabled, false)
	const beforePlay = current.calls.length
	pressVisibleLibrary(liked, '播放全部喜欢')
	assert.deepEqual(current.calls.slice(beforePlay), [['playLiked']])
	assert.equal(
		label(draw({ collection: 'likes', playbackBusy: true }), '播放全部喜欢')
			.props.disabled,
		true,
	)
	const empty = draw({ collection: 'likes', likes: [] })
	assert.equal(label(empty, '播放全部喜欢').props.disabled, true)
	assert.match(text(empty), /还没有喜欢的音乐/)
	assert.ok(label(empty, '去搜索音乐'))
	for (const [collection, sentinel] of [
		['local', 'LocalAudioContent'],
		['recent', 'RecentMusicContent'],
	] as const) {
		const tree = draw({
			collection,
			localAudio: current.element('LocalAudioContent', { identity: 'local' }),
			recentMusic: current.element('RecentMusicContent', {
				identity: 'recent',
			}),
		})
		assert.deepEqual(
			controlNodes(tree)
				.filter(
					(node) =>
						node.type === 'LocalAudioContent' ||
						node.type === 'RecentMusicContent',
				)
				.map((node) => node.type),
			[sentinel],
		)
		const before = current.calls.length
		pressVisibleLibrary(tree, '返回音乐库')
		assert.deepEqual(current.calls.slice(before), [['collection', 'root']])
	}
	const emptyRoot = draw({
		playlistState: state({ currentId: null, playlists: [] }),
		likes: [],
	})
	assert.ok(label(emptyRoot, '搜索音乐'))
	assert.ok(
		visibleControls(emptyRoot).find((node) => controlName(node) === '导入歌单'),
	)
	assert.equal(
		current.calls
			.slice(start)
			.filter((call) =>
				['play', 'playLiked', 'playListening'].includes(String(call[0])),
			).length,
		1,
		'only the single explicit liked-play press plays; render/navigation/menu cannot autoplay',
	)
}

void test('redesigned playlist/library routes retain input and row action contracts across built-in and legacy themes', async () => {
	const sources = Object.fromEntries(
		['playlist-ui', 'library-ui'].map((name) => [
			name,
			approvedRedesignCopy(
				readBaselineSource(`${baseline}:android-app/apps/mobile/melo/${name}.tsx`),
			),
		]),
	)
	const legacy = await legacyControlPackage()
	const pending = pendingState()
	const scenarios = [
		['PlaylistLibrarySection', state({ currentId: null })],
		['PlaylistLibrarySection', state({ playlists: [], error: '读取失败' })],
		['PlaylistLibrarySection', state({ playlists: [], notice: '已保存' })],
		['PlaylistDetailPage', state()],
		['PlaylistDetailPage', pending],
		[
			'PlaylistDetailPage',
			state({ editing: true, selectedItemIds: ['i3'], undoAvailable: true }),
		],
		['PlaylistDetailPage', state({ detail: null, error: '读取失败' })],
		[
			'PlaylistDetailPage',
			state({ detail: { ...state().detail!, items: [] } }),
		],
		...(['create', 'rename', 'copy'] as const).map(
			(kind) =>
				[
					'PlaylistDialogs',
					state({ nameForm: { kind, value: '名称' } }),
				] as const,
		),
		[
			'PlaylistDialogs',
			state({ nameForm: { kind: 'create', value: '' }, error: '保存失败' }),
		],
		['PlaylistDialogs', state({ deleting: true })],
		['PlaylistDialogs', state({ targetSources: [source] })],
		[
			'PlaylistDialogs',
			state({
				picker: {
					sources: [source, second],
					selectedSourceIds: [second.id],
					query: '',
					duplicatePolicy: 'keep-all',
				},
			}),
		],
		[
			'PlaylistDialogs',
			state({
				picker: {
					sources: [],
					selectedSourceIds: [],
					query: '',
					duplicatePolicy: null,
				},
			}),
		],
	] as const
	let unchangedComparisons = 0,
		migratedComparisons = 0
	for (const theme of [...Object.values(builtInThemes), null]) {
		const old = host(sources),
			current = host()
		const wrap = (h: Host, child: unknown) =>
			theme
				? h.element(component(h.ui.ThemeProvider), { value: theme }, child)
				: h.element(
						component(h.ui.PackageThemeProvider),
						{ ...legacy, reducedMotion: true },
						child,
					)
		for (const [name, value] of scenarios) {
			const currentTree = current.render(
				wrap(
					current,
					current.element(
						component(current.playlist[name]),
						current.props(value),
					),
				),
			)
			const oldTree = old.render(
				wrap(old, old.element(component(old.playlist[name]), old.props(value))),
			)
			// Only the intentionally windowed detail/picker scroll containers changed here.
			// Every occurrence/picker row is still compared, and unrelated branches retain
			// the original whole-tree assertion (including known historical copy drift).
			const comparable =
				name === 'PlaylistDetailPage'
					? nativeDetailRows
					: name === 'PlaylistDialogs' && value.picker
						? nativePickerRows
						: (tree: unknown) => tree
			const actual = normalize(current, comparable(currentTree))
			const expected = normalize(old, comparable(oldTree))
			if (name === 'PlaylistDetailPage') {
    assert.deepEqual(rowActionContract(actual), rowActionContract(expected), 'occurrence action identity, order and disabled state')
    migratedComparisons++
    continue
   }
   if (name === 'PlaylistDialogs') migrateDialogSpacing(expected)
			if (expectLibraryScenarioDelta(name, value, actual, expected))
				migratedComparisons++
			else unchangedComparisons++
			if (name === 'PlaylistLibrarySection') {
				assertGallery(actual, value, !!theme)
				continue
			}
			if (theme) expectBuiltinLibraryTouchDelta(name, value, actual, expected)
			migrateInputAppearance(actual, expected, theme ?? legacy.adapted.theme)
			assert.deepEqual(actual, migrateLibraryPunctuation(expected), `${theme?.id ?? 'legacy48'} ${name}`)
		}
		for (const listeningOpen of [false, true]) {
			const value = state({ currentId: null })
			const draw = (overrides: Record<string, unknown> = {}) =>
				current.render(
					wrap(
						current,
						current.element(component(current.library.LibraryPage), {
							...current.libraryProps(value),
							listeningOpen,
							playlistSession: {
								// Root/collection cases use only these playlist actions.
								open: current.session.open,
								refresh: current.session.refresh,
								requestName: (kind: string) => {
									assert.equal(
										uniqueLibraryModal(draw()).props.visible,
										false,
										'menu closes before create action',
									)
									current.calls.push(['requestName', kind])
								},
							},
							onCollectionChange: (collection: string) => {
								assert.equal(
									uniqueLibraryModal(draw()).props.visible,
									false,
									'menu closes before collection action',
								)
								current.calls.push(['collection', collection])
							},
							onPlayListening: (item: Source) =>
								current.calls.push(['playListening', item.id]),
							onFindMusic: () => current.calls.push(['findMusic']),
							onFindListening: () => current.calls.push(['findListening']),
							onOpenFollowing: () => current.calls.push(['following']),
							onOpenFollowingFeed: () => current.calls.push(['feed']),
							onImport: () => {
								assert.equal(
									uniqueLibraryModal(draw()).props.visible,
									false,
									'menu closes before import action',
								)
								current.calls.push(['import'])
							},
							onOpenVideoSaves: (bucket: string) =>
								current.calls.push(['saves', bucket]),
							...overrides,
						}),
					),
				)
			const callsBeforeDraw = current.calls.slice()
			const currentTree = draw()
			assert.deepEqual(
				current.calls,
				callsBeforeDraw,
				'initial library render cannot navigate, request or play',
			)
			const oldTree = old.render(
				wrap(
					old,
					old.element(component(old.library.LibraryPage), {
						...old.libraryProps(value),
						listeningOpen,
					}),
				),
			)
			if (listeningOpen) {
				unchangedComparisons++
				assert.deepEqual(
					normalize(current, currentTree),
					normalize(old, oldTree),
					`${theme?.id ?? 'legacy48'} library ${listeningOpen}`,
				)
			} else {
				migratedComparisons++
				assertContentFirstLibrary(
					current,
					old,
					currentTree,
					oldTree,
					draw,
					!!theme,
				)
			}
		}
		const actions = (h: Host) =>
			h.element(component(h.playlist.PlaylistSourceActions), {
				item: source,
				onClose: noop,
				onAdd: noop,
				onListen: noop,
				onCreator: noop,
				bottomInset: 12,
				reducedMotion: true,
			})
		const actualActions = normalize(
				current,
				current.render(wrap(current, actions(current))),
			),
			expectedActions = normalize(old, old.render(wrap(old, actions(old))))
		if (theme)
			for (const name of ['加入本地歌单', '以听视频开启', '查看 UP 主主页'])
				expectBuiltinLibraryTarget(
					label(actualActions, name),
					label(expectedActions, name),
					48,
					54,
					54,
				)
		const actionSubtitle = controlNodes(expectedActions).find(n=>n.type==='Text' && text(n)==='UP · 真实 UP')
  assert.ok(actionSubtitle)
  actionSubtitle.children=[['UP，','真实 UP']]
  assert.deepEqual(actualActions, expectedActions)
		unchangedComparisons++
		old.unmount()
		current.unmount()
	}
		assert.equal(unchangedComparisons + migratedComparisons, 76)
})

const libraryGuardLeaf = (children: unknown[]): ControlNode => ({
	type: 'Text',
	key: undefined,
	props: { style: { fontSize: 11 } },
	children,
})
const libraryGuardInput = (props: Record<string, unknown>): ControlNode => ({
	type: 'TextInput',
	key: undefined,
	props: { accessibilityLabel: '歌单名称', ...props },
	children: [],
})
void test('library historical delta guards reject duplicate, restyled or unexpected text and multiline changes', () => {
	const before = [[3, ' 个', '音源', ' · 我 · 本地歌单', '']]
	const after = [[3, ' ', '首', '']]
	const original = libraryGuardLeaf(structuredClone(before))
	const current = libraryGuardLeaf(structuredClone(after))
	expectLibraryTextDelta(current, original, before, after, 1)
	assert.deepEqual(current, original)
	for (const changed of [
		libraryGuardLeaf(['4 首']),
		libraryGuardLeaf(['3 首']),
		libraryGuardLeaf([libraryGuardLeaf(['3 首'])]),
	]) {
		assert.throws(() =>
			expectLibraryTextDelta(
				changed,
				libraryGuardLeaf(before),
				before,
				after,
				1,
			),
		)
	}
	assert.throws(() =>
		expectLibraryTextDelta(
			current,
			[libraryGuardLeaf(before), libraryGuardLeaf(before)],
			before,
			after,
			1,
		),
	)
	const restyled = libraryGuardLeaf(after)
	restyled.props.style = { fontSize: 99 }
	const historical = libraryGuardLeaf(before)
	expectLibraryTextDelta(restyled, historical, before, after, 1)
	assert.throws(
		() => assert.deepEqual(restyled, historical),
		'leaf migration never masks style drift',
	)

	assert.throws(() =>
		expectLibraryNameDefault(
			libraryGuardInput({ multiline: true }),
			libraryGuardInput({}),
		),
	)
	assert.throws(() =>
		expectLibraryNameDefault(
			libraryGuardInput({ multiline: false }),
			libraryGuardInput({ multiline: true }),
		),
	)
})

// Exact pre-windowing integration source, retained instead of depending on a local Git checkout.
// The c59 checks above retain the audited historical subtrees and precise current deltas. These checks independently compare the unaffected row and dialog trees,
// excluding only their changed scroll containers and the new selection-scope controls.
const preWindowingSource = () => {
	const sourceText = readFileSync(
		new URL('./fixtures/playlist-ui-973ce45.tsx.txt', import.meta.url),
		'utf8',
	)
	assert.equal(
		createHash('sha256')
			.update(sourceText.replaceAll('\r\n', '\n'))
			.digest('hex'),
		'4743002f5355c4aff693625dd874132ca4b7baebde6d1e107184a7c799080df9',
	)
	return sourceText
		.replaceAll('给这段心情起个名字', '输入歌单名称')
		.replaceAll('写下这张歌单的故事，也可以留空', '输入歌单简介（选填）')
}
function nativeDetailRows(tree: unknown) {
	return controlNodes(tree).filter(
		(node) =>
			typeof node.props.testID === 'string' &&
			node.props.testID.startsWith('playlist-item-'),
	)
}
function nativePickerRows(tree: unknown) {
	return controls(tree).filter(
		(node) => node.props.accessibilityRole === 'checkbox',
	)
}
/** React may split adjacent literal text differently; native Text renders the same run.
 * Join only adjacent primitive children, never remove/change a character or a styled Text node.
 * Used solely for c59 row comparison; the 973 pre-windowing comparison remains byte-structure strict.
 */
function nativeTextRuns(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(nativeTextRuns)
	if (!value || typeof value !== 'object') return value
	const record = value as Record<string, unknown>
	const result = Object.fromEntries(
		Object.entries(record).map(([key, child]) => [key, nativeTextRuns(child)]),
	)
	if (record.type === 'Text' && Array.isArray(record.children)) {
		const children: unknown[] = []
		for (const child of record.children.flat(Infinity)) {
			if (typeof child === 'string' || typeof child === 'number') {
				const last = children.at(-1)
				if (typeof last === 'string')
					children[children.length - 1] = last + String(child)
				else children.push(String(child))
			} else children.push(nativeTextRuns(child))
		}
		result.children = children
	}
	return result
}
// Compare durable row actions instead of freezing the superseded card layout.
function rowActionContract(tree: unknown) {
 return controls(tree).filter(n=>String(n.props.accessibilityLabel).startsWith('歌单第')).map(n=>({
  label:n.props.accessibilityLabel, role:n.props.accessibilityRole,
  disabled:n.props.disabled, state:n.props.accessibilityState, onPress:n.props.onPress,
 }))
}
function migrateLibraryPunctuation(tree: unknown): unknown {
 if(typeof tree==='string') return tree.replace(/^UP · /,'UP， ').replaceAll(' · ','，').replaceAll(' ·','，')
 if(Array.isArray(tree)) return tree.map(migrateLibraryPunctuation)
 if(tree && typeof tree==='object') return Object.fromEntries(Object.entries(tree).map(([key,value])=>[key,migrateLibraryPunctuation(value)]))
 return tree
}
function migrateDialogSpacing(tree: unknown) {
 for(const node of controlNodes(tree)) {
  const style=node.props.style as Record<string,unknown>|undefined
  if(node.type==='View' && style?.marginTop===14 && Object.keys(style).length===1) node.props.style={...style,gap:12}
 }
}
async function compareRetainedPlaylistRows(
	sources: Record<string, string>,
	origin: string,
) {
	const legacy = await legacyControlPackage()
	const rowTree = (h: Host, tree: unknown) =>
		origin === 'c59' ? nativeTextRuns(normalize(h, tree)) : normalize(h, tree)
	for (const theme of [...Object.values(builtInThemes), null]) {
		const previous = host(sources),
			current = host()
		const wrap = (h: Host, child: unknown) =>
			theme
				? h.element(component(h.ui.ThemeProvider), { value: theme }, child)
				: h.element(
						component(h.ui.PackageThemeProvider),
						{ ...legacy, reducedMotion: true },
						child,
					)
		const draw = (h: Host, name: string, value: PlaylistState) =>
			h.render(wrap(h, h.element(component(h.playlist[name]), h.props(value))))
		try {
			for (const [scenario, value, expectedCount] of [
				['ordered duplicate occurrences', state(), 3],
				['pending occurrence with live review button', pendingState(), 3],
				[
					'missing source',
					state({ sources: new Map([[source.id, source]]) }),
					3,
				],
				[
					'selected occurrence and move controls',
					state({
						editing: true,
						selectedItemIds: ['i3'],
						undoAvailable: true,
					}),
					3,
				],
			] as const) {
				const before = nativeDetailRows(
					draw(previous, 'PlaylistDetailPage', value),
				)
				const after = nativeDetailRows(
					draw(current, 'PlaylistDetailPage', value),
				)
				assert.equal(
					before.length,
					expectedCount,
					`${origin} baseline row inventory: ${scenario}`,
				)
				assert.equal(
					after.length,
					expectedCount,
					`${origin} current row inventory: ${scenario}`,
				)
				const actual = rowTree(current, after),
					expected = rowTree(previous, before)
				if (theme && origin === 'c59')
					expectBuiltinLibraryTouchDelta(
						'PlaylistDetailPage',
						value,
						actual,
						expected,
					)
				assert.deepEqual(
					rowActionContract(actual),
					rowActionContract(expected),
					`${origin} ${theme?.id ?? 'legacy48'} ${scenario}`,
				)
			}
			for (const query of ['', '原标题 B', '无匹配']) {
				const value = state({
					picker: {
						sources: [source, second],
						selectedSourceIds: [second.id],
						query,
						duplicatePolicy: 'keep-all',
					},
				})
				const before = nativePickerRows(
					draw(previous, 'PlaylistDialogs', value),
				)
				const after = nativePickerRows(draw(current, 'PlaylistDialogs', value))
				assert.equal(
					before.length,
					query === '' ? 2 : query === '原标题 B' ? 1 : 0,
				)
				assert.equal(after.length, before.length)
				const actual = rowTree(current, after),
					expected = rowTree(previous, before)
				if (theme && origin === 'c59')
					expectBuiltinLibraryTouchDelta(
						'PlaylistDialogs',
						value,
						actual,
						expected,
					)
				assert.deepEqual(
					actual,
					migrateLibraryPunctuation(expected),
					`${origin} ${theme?.id ?? 'legacy48'} picker ${query}`,
				)
			}
			// Since 973, name/delete dialogs have no windowing or selection change: compare the entire tree.
			// c59 predates their metadata-editor props; its original whole-tree assertions remain above.
			if (origin === 'c59') continue
			for (const value of [
				...(['create', 'rename', 'copy'] as const).map((kind) =>
					state({ nameForm: { kind, value: '原名称' } }),
				),
				state({ deleting: true }),
			])
			{
    const expected=normalize(previous,draw(previous,'PlaylistDialogs',value))
    migrateDialogSpacing(expected)
    assert.deepEqual(
					normalize(current, draw(current, 'PlaylistDialogs', value)),
					expected,
					`${origin} ${theme?.id ?? 'legacy48'} unchanged dialog`,
				)
   }
		} finally {
			previous.unmount()
			current.unmount()
		}
	}
}

void test('redesigned occurrences retain c59 action identity while picker native rows remain unchanged', async () => {
	await compareRetainedPlaylistRows(
		{
			'playlist-ui': readBaselineSource(`${baseline}:android-app/apps/mobile/melo/playlist-ui.tsx`),
		},
		'c59',
	)
})

void test('windowing preserves occurrence action order and picker controls across three themes and verified legacy48 package', async () => {
	await compareRetainedPlaylistRows(
		{ 'playlist-ui': preWindowingSource() },
		'973ce45',
	)
})

void test('actual detail pure-button rows consume measured regular/compact/fallback/reject widths without changing occurrence or move callbacks', () => {
	const h = host(),
		value = state({ editing: true, selectedItemIds: ['i3'] })
	const root = packageRoot(
		h,
		h.element(component(h.playlist.PlaylistDetailPage), h.props(value)),
	)
	let tree = h.render(root)
	assert.equal(controls(tree).length, 0)
	const playRow = measured(tree).find(
		(node) =>
			String(node.key).includes('[48,48]') && String(node.key).includes(',10,'),
	)!
	assert.ok(playRow)
	for (const [width, touch] of [
		[220, 96],
		[170, 72],
		[110, 48],
		[100, null],
		[220, 96],
	] as const) {
		measure(playRow, width)
		tree = h.render(root)
		const play = controls(tree).find((node) => controlName(node) === '播放全部')
		if (touch === null) {
			assert.equal(play, undefined)
			continue
		}
		assert.ok(play)
		assert.equal(flat(h, play).minHeight, touch)
	}
	tree = settle(h, root)
	press(tree, '上移歌单第3项')
	press(tree, '下移歌单第1项')
	press(tree, '移除所选1项')
	assert.ok(!h.calls.some(call => call[0] === 'removeSelected'))
	press(settle(h, root), '移除')
	assert.deepEqual(h.calls, [
		['move', 'i3', -1],
		['move', 'i1', 1],
		['removeSelected'],
	])
	const nonediting = state()
	const playRoot = packageRoot(
		h,
		h.element(component(h.playlist.PlaylistDetailPage), h.props(nonediting)),
	)
	tree = settle(h, playRoot)
	const third = label(tree, '播放歌单第3项 原标题 A')
	const item = controlNodes(tree).find(
		(node) => node.props.testID === 'playlist-item-i3',
	)!
	const row = controlNodes(item).find(
		(node) => node.type === 'View' && flat(h, node).gap === 9,
	)!
	assert.ok(
		((row.children ?? []).flat(Infinity) as ControlNode[]).some(
			(child) => typeof child?.props?.onLayout === 'function',
		),
		'the original stretched row owns measurement, not a shrink-to-content wrapper inside it',
	)
	assert.equal(flat(h, third).flex, 1)
	assert.equal(
		flat(h, third).minWidth,
		162,
		'active icon and gap remain included in the host floor',
	)
	assert.equal(
		(third.props.accessibilityState as { selected: boolean }).selected,
		true,
	)
	;(third.props.onPress as () => void)()
	assert.deepEqual(h.calls.at(-1), ['play', 'p', 'i3'])
})

void test('actual standalone library/picker rows preserve content floors and become noninteractive on font invalidation or rejected width', () => {
	const h = host(),
		value = state({ currentId: null })
	const root = packageRoot(
		h,
		h.element(component(h.library.LibraryPage), h.libraryProps(value)),
	)
	let tree = h.render(root)
	const closedMenu = controlNodes(tree).find(
		(node) => node.type === 'Modal' && node.props.visible === false,
	)!
	assert.ok(closedMenu)
	assert.deepEqual(controls(closedMenu).map(controlName), ['关闭操作菜单'])
	assert.equal(visibleControls(tree).length, 0)
	const old = measured(tree).map(
		(node) => node.props.onLayout as (event: unknown) => void,
	)
	// The listening entry now shares a four-shortcut row, rather than a standalone link.
	tree = settle(h, root, 180)
	assert.equal(
		visibleControls(tree).some((node) => controlName(node) === '打开听视频'),
		false,
	)
	tree = settle(h, root, 360)
	press(tree, '打开听视频')
	press(tree, '打开歌单 我的长标题歌单，3个音源')
	assert.deepEqual(h.calls, [
		['listening', true],
		['open', 'p'],
	])
	assert.equal(
		flat(h, label(tree, '打开歌单 我的长标题歌单，3个音源')).minHeight,
		96,
	)
	h.viewport.fontScale = 2
	tree = h.render(root)
	assert.equal(visibleControls(tree).length, 0)
	for (const callback of old)
		callback({ nativeEvent: { layout: { width: 350 } } })
	assert.equal(visibleControls(h.render(root)).length, 0)
	tree = settle(h, root, 100)
	assert.equal(
		visibleControls(tree).some(
			(node) => node.props.accessibilityLabel === '打开听视频',
		),
		false,
	)
	tree = settle(h, root, 180)
	// Large fonts use the compact two-column grid, so both targets now fit.
	const compactListening = label(tree, '打开听视频')
	assert.equal(flat(h, compactListening).minWidth, 72)
	assert.equal(flat(h, compactListening).minHeight, 72)
	tree = settle(h, root, 360)
	assert.ok(label(tree, '打开听视频'))
	const late = measured(tree).map(
		(node) => node.props.onLayout as (event: unknown) => void,
	)
	h.unmount()
	for (const callback of late)
		callback({ nativeEvent: { layout: { width: 350 } } })
	assert.equal(h.writesAfterUnmount, 0)
})

void test('actual picker/name/menu controls retain selection, duplicate policy, disabled state, backdrop and editing contracts', () => {
	const h = host(),
		picker = state({
			picker: {
				sources: [source, second],
				selectedSourceIds: [second.id],
				query: '',
				duplicatePolicy: null,
			},
		})
	const root = packageRoot(
		h,
		h.element(component(h.playlist.PlaylistDialogs), h.props(picker)),
	)
	let tree = h.render(root)
	assert.equal(
		controls(tree).length,
		1,
		'only the unmeasured full-screen dismiss layer remains',
	)
	press(tree, '关闭歌单面板')
	tree = settle(h, root, 150)
	const checked = label(tree, '选择音源 原标题 B')
	assert.equal(
		(checked.props.accessibilityState as { checked: boolean }).checked,
		true,
	)
	assert.equal(flat(h, checked).minHeight, 96)
	assert.equal(label(tree, '添加所选 1 项').props.disabled, true)
	press(tree, '选择音源 原标题 A')
	press(tree, '保留重复条目')
	press(tree, '跳过歌单已有音源')
	const search = controlNodes(tree).find((node) => node.type === 'TextInput')!
	;(search.props.onChangeText as (text: string) => void)('最新关键词')
	assert.deepEqual(h.calls, [
		['closeSheet'],
		['toggleSource', source.id],
		['setDuplicatePolicy', 'keep-all'],
		['setDuplicatePolicy', 'skip-existing-source'],
		['setPickerQuery', '最新关键词'],
	])
	picker.picker!.duplicatePolicy = 'keep-all'
	tree = h.render(root)
	assert.equal(label(tree, '添加所选 1 项').props.disabled, false)
	press(tree, '添加所选 1 项')
	assert.deepEqual(h.calls.at(-1), ['appendSelected'])
	const named = state({ nameForm: { kind: 'create', value: '' } })
	const namedRoot = packageRoot(
		h,
		h.element(component(h.playlist.PlaylistDialogs), h.props(named)),
	)
	tree = settle(h, namedRoot)
	assert.equal(label(tree, '创建歌单').props.disabled, true)
	const input = controlNodes(tree).find(
		(node) => node.props.testID === 'playlist-name-input',
	)!
	assert.equal(input.props.maxLength, 40)
	assert.equal(input.props.returnKeyType, 'done')
	;(input.props.onChangeText as (text: string) => void)('新名称')
	const submitEvent = { nativeEvent: { text: '新名称' } }
	;(input.props.onSubmitEditing as (event: unknown) => void)(submitEvent)
	;(
		controlNodes(tree).find((node) => node.type === 'Modal')!.props
			.onRequestClose as () => void
	)()
	assert.deepEqual(h.calls.slice(-3), [
		['setName', '新名称'],
		['saveName', submitEvent],
		['closeSheet'],
	])
	const actionsRoot = packageRoot(
		h,
		h.element(component(h.playlist.PlaylistSourceActions), {
			item: source,
			onClose: () => h.calls.push(['dismiss']),
			onAdd: (s: Source) => h.calls.push(['add', s.id]),
			onListen: (s: Source) => h.calls.push(['listen', s.id]),
			onCreator: (s: Source) => h.calls.push(['creator', s.id]),
			bottomInset: 12,
			reducedMotion: true,
		}),
	)
	tree = settle(h, actionsRoot, 80)
	press(tree, '加入本地歌单')
	press(tree, '以听视频开启')
	press(tree, '查看 UP 主主页')
	assert.deepEqual(h.calls.slice(-3), [
		['add', source.id],
		['listen', source.id],
		['creator', source.id],
	])
	assert.equal(flat(h, label(tree, '加入本地歌单')).minHeight, 72)
})

void test('actual pending/missing rows remain disabled and manage/undo/more operations keep their original targets', () => {
	const h = host(),
		value = state({ undoAvailable: true })
	value.detail!.items[1].sourceId = null
	value.sources.set(source.id, null)
	const root = packageRoot(
		h,
		h.element(component(h.playlist.PlaylistDetailPage), h.props(value)),
	)
	let tree = settle(h, root)
	const rows = controls(tree).filter((node) =>
		String(node.props.accessibilityLabel).includes('歌单第'),
	)
	assert.equal(rows.length, 3)
	assert.ok(
		rows.every((row) => row.props.disabled === true),
		'pending and real missing Source cannot start playback',
	)
	press(tree, '歌单更多操作')
	tree = settle(h, root)
	press(tree, '复制为新歌单')
	assert.deepEqual(h.calls.at(-1), ['requestName', 'copy'])
	tree = settle(h, root)
	press(tree, '歌单更多操作')
	tree = settle(h, root)
	press(tree, '删除歌单')
	assert.deepEqual(h.calls.at(-1), ['requestDelete'])
	tree = settle(h, root)
	const management = controls(tree).find((row) =>
		String(row.props.accessibilityLabel).includes('管理歌单'),
	)
	assert.ok(management)
	;(management.props.onPress as () => void)()
	assert.deepEqual(h.calls.at(-1), ['setEditing', true])
	press(tree, '撤销本次移除')
	assert.deepEqual(h.calls.at(-1), ['undoRemove'])
})

void test('Bili pending review sits below the disabled song shell and waits for its own full-width measured bounds', () => {
	const h = host(),
		value = pendingState()
	const root = packageRoot(
		h,
		h.element(component(h.playlist.PlaylistDetailPage), h.props(value)),
	)
	let tree = h.render(root)
	const shell = controls(tree).find((node) =>
		String(node.props.accessibilityLabel).startsWith('歌单第2项'),
	)!
	assert.ok(shell)
	assert.equal(shell.props.disabled, true)
	const footer = controlNodes(tree).find(
		(node) => node.props.testID === 'playlist-pending-review',
	)!
	assert.ok(footer)
	assert.equal(controlNodes(shell).includes(footer), false)
	assert.equal(
		measured(shell).length,
		0,
		'disabled song metadata does not own the live review slot',
	)
	const ownBounds = measured(footer)
	assert.equal(
		ownBounds.length,
		1,
		'only the separate review button has a measurement boundary',
	)
	const fullWidth = controlNodes(footer).filter(
		(node) => flat(h, node).width === '100%',
	)
	assert.equal(fullWidth.length, 1, 'review has one full-width boundary')
	assert.ok(
		controlNodes(fullWidth[0]).includes(ownBounds[0]),
		'measured slot belongs to the full-width footer',
	)
	assert.doesNotMatch(
		text(tree),
		/MY PLAYLIST|保留原标题与 UP 信息，只修改本机歌单/,
	)
	assert.match(text(tree), /3 首，1 首未匹配/)
	assert.equal(
		controls(shell).length,
		1,
		'only the disabled shell is exposed in the song row',
	)
	measure(ownBounds[0], 100)
	tree = h.render(root)
	const button = label(tree, '匹配此条目')
	assert.equal(
		flat(h, button).minWidth,
		96,
		'button does not inherit the disabled row metadata/cover width',
	)
	press(tree, '匹配此条目')
	assert.deepEqual(h.calls, [['review', 'p', 'i2']])
	measure(ownBounds[0], 40)
	tree = h.render(root)
	assert.equal(
		controls(tree).some((node) => controlName(node) === '匹配此条目'),
		false,
	)
})

void test('actual liked collection button invokes explicit playback and disables for empty or busy library', () => {
	const h = host(),
		value = state({ currentId: null })
	const draw = (likes: Source[], busy = false) =>
		h.render(
			h.element(
				component(h.ui.ThemeProvider),
				{ value: builtInThemes.modern },
				h.element(component(h.library.LibraryPage), {
					...h.libraryProps(value),
					collection: 'likes',
					likes,
					playbackBusy: busy,
				}),
			),
		)
	try {
		let tree = draw([source])
		press(tree, '播放全部喜欢')
		assert.deepEqual(h.calls, [['playLiked']])
		press(tree, '喜欢的音乐管理')
		tree = draw([source])
		assert.ok(
			controlNodes(tree).some(
				(node) => node.type === 'Modal' && node.props.visible === true,
			),
		)
		press(tree, '另存为歌单')
		assert.deepEqual(h.calls.at(-1), ['requestName', 'from-likes'])
		tree = draw([])
		assert.equal(label(tree, '播放全部喜欢').props.disabled, true)
		press(tree, '喜欢的音乐管理')
		tree = draw([])
		assert.equal(label(tree, '另存为歌单').props.disabled, true)
		tree = draw([source], true)
		assert.equal(label(tree, '播放全部喜欢').props.disabled, true)
	} finally {
		h.unmount()
	}
})
