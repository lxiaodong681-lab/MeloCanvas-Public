import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { builtInThemes } from '../core/theme'
import { CreatorSession } from '../creator-session'
import { FollowingFeedSession } from '../following-feed-session'
import type { FollowingFeedPage } from '../following-feed-ui'
import type { useFollowingFeed } from '../useFollowingFeed'

import { feedFixture } from './following-feed-fixture'

type Node = {
	type: string
	props: Record<string, unknown>
	children: unknown[]
}
function compile(source: string) {
	return ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
			jsx: ts.JsxEmit.React,
		},
	}).outputText
}
const react = {
	createElement(
		type: string | ((props: Record<string, unknown>) => unknown),
		props: Record<string, unknown>,
		...children: unknown[]
	): unknown {
		return typeof type === 'function'
			? type({ ...props, children })
			: { type, props: props ?? {}, children }
	},
	Fragment: 'Fragment',
}
function nodes(value: unknown): Node[] {
	if (Array.isArray(value)) return value.flatMap(nodes)
	if (
		!value ||
		typeof value !== 'object' ||
		!('type' in value) ||
		!('props' in value)
	)
		return []
	const item = value as Node
	const virtualized =
		item.type === 'FlatList'
			? [
					item.props.ListHeaderComponent,
					item.props.ListEmptyComponent,
					...((item.props.data as unknown[]) ?? []).map((row) =>
						(item.props.renderItem as (props: { item: unknown }) => unknown)({
							item: row,
						}),
					),
				]
			: []
	return [item, ...nodes(item.children), ...nodes(virtualized)]
}
function label(view: unknown, value: string) {
	const result = nodes(view).find(
		(item) =>
			item.props.accessibilityLabel === value || item.props.label === value,
	)
	assert.ok(result, `Missing ${value}`)
	return result
}
function text(value: unknown): string {
	if (Array.isArray(value)) return value.map(text).join('')
	if (value && typeof value === 'object' && 'children' in value)
		return text((value as Node).children)
	return typeof value === 'string' || typeof value === 'number'
		? String(value)
		: ''
}
function render(
	props: Parameters<typeof FollowingFeedPage>[0],
	theme = builtInThemes.modern,
	coverageOpen = props.state.coverageOpen,
) {
	const output: { FollowingFeedPage?: typeof FollowingFeedPage } = {}
	let commitLayout: (() => void) | undefined
	runInNewContext(
		compile(
			readFileSync(
				new URL('../following-feed-ui.tsx', import.meta.url),
				'utf8',
			),
		),
		{
			exports: output,
			require: (name: string) => {
				if (name === 'react')
					return {
						__esModule: true,
						default: react,
						...react,
						useRef: (value: unknown) => ({ current: value }),
						useCallback: (callback: unknown) => callback,
						useMemo: (factory: () => unknown) => factory(),
						useLayoutEffect: (effect: () => void) => {
							commitLayout = effect
						},
					}
				if (name === 'react-native')
					return { FlatList: 'FlatList', Pressable: 'Pressable', View: 'View' }
				if (name === './creator-ui')
					return {
						creatorScopeLabel: {
							all: '全部投稿',
							music: '音乐投稿',
							listening: '听视频内容',
						},
					}
				if (name === './library-collection-ui')
					return { CollectionMenu: 'CollectionMenu' }
				if (name === './ui')
					return {
						useTheme: () => theme,
						useThemeRendering: () => null,
						ControlRow: 'View',
						ControlTarget: 'Pressable',
						shape: () => ({}),
						time: (value: number) => `${value}s`,
						Artwork: 'Artwork',
						Button: 'Button',
						Card: 'Card',
						IconButton: 'IconButton',
						State: 'State',
						T: 'T',
					}
				throw new Error(`Unexpected UI dependency ${name}`)
			},
		},
	)
	assert.ok(output.FollowingFeedPage)
	const view = output.FollowingFeedPage({
		...props,
		state: { ...props.state, coverageOpen },
	})
	commitLayout?.()
	return view
}

void test('actual page preserves host themes, candidate artwork, truthful provenance and explicit music/listening callbacks without reads on render', () => {
	const f = feedFixture()
	try {
		f.session.open()
		const actions: unknown[] = []
		for (const theme of Object.values(builtInThemes)) {
			const before = f.reads()
			const view = render(
				{
					state: f.session.getSnapshot(),
					session: f.session,
					onCreator: (creator) => actions.push(creator.mid),
					onManage: () => actions.push('manage'),
					onSearch: () => actions.push('search'),
					onPlay: (bvid, mode) => actions.push([bvid, mode]),
				},
				theme,
				true,
			)
			assert.equal(f.reads(), before)
			const list = nodes(view).find((item) => item.type === 'FlatList')!
			assert.equal(typeof list.props.onLayout, 'function')
			assert.equal(typeof list.props.onContentSizeChange, 'function')
			;(list.props.onScrollBeginDrag as (event: unknown) => void)({
				nativeEvent: { contentOffset: { y: 0 } },
			})
			;(
				list.props.onScroll as (event: {
					nativeEvent: { contentOffset: { y: number } }
				}) => void
			)({ nativeEvent: { contentOffset: { y: 230 } } })
			assert.equal(f.session.getScrollOffset(), 230)
			assert.equal(
				label(view, '核对并收听关注投稿 缓存原视频').props.disabled,
				false,
			)
			;(
				label(view, '核对并收听关注投稿 缓存原视频').props.onPress as () => void
			)()
			;(
				label(view, '核对关注投稿后以音乐播放 缓存原视频').props
					.onPress as () => void
			)()
			;(
				label(view, '查看关注来源 UP 主 真实UP，mid 88').props
					.onPress as () => void
			)()
			const artwork = nodes(view).find((item) => item.type === 'Artwork')!
			assert.equal(artwork.props.uri, f.post.artwork)
			const words = nodes(view).map(text).join(' ')
			assert.match(words, /来自关注 · 真实UP/)
			assert.match(words, /内容类型待确认/)
			assert.match(words, /缓存.*读取于/)
			assert.match(words, /尚未核验音轨/)
			const musicTab = label(view, '关注更新：音乐')
			assert.ok((musicTab.props.style as { minHeight: number }).minHeight >= 48)
			assert.equal(
				nodes(view).filter((item) => item.props.accessibilityRole === 'tab')
					.length,
				3,
			)
		}
		assert.deepEqual(
			actions,
			Array.from({ length: 3 }, () => [
				[f.post.bvid, 'listening'],
				[f.post.bvid, 'music'],
				'88',
			]).flat(),
		)
	} finally {
		f.raw.close()
	}
})

void test('failed local reread retains previous rendered rows with a stale notice and an explicit local retry', () => {
	const f = feedFixture()
	try {
		f.session.open()
		f.fail(new Error('local cache cannot be read'))
		f.session.load()
		const props = () => ({
			state: f.session.getSnapshot(),
			session: f.session,
			onCreator: () => {},
			onManage: () => {},
			onSearch: () => {},
			onPlay: () => {},
		})
		const view = render(props())
		assert.ok(
			nodes(view).some((item) => item.props.title === '本地更新读取未完成'),
		)
		assert.ok(nodes(view).map(text).join(' ').includes('上次成功读取'))
		assert.ok(label(view, '核对并收听关注投稿 缓存原视频'))
		const retry = nodes(view).find(
			(item) => item.props.title === '本地更新读取未完成',
		)!
		f.fail(null)
		;(retry.props.retry as () => void)()
		assert.equal(f.session.getSnapshot().stale, false)
		assert.equal(f.session.getSnapshot().error, '')
	} finally {
		f.raw.close()
	}
})

void test('partial-empty, uncached, true cached empty and no-subscription states stay distinct with an actionable UP search exit', () => {
	const f = feedFixture()
	try {
		f.cache.savePage(
			'88',
			{ items: [], page: 1, more: false, total: 0 },
			200,
			1,
		)
		f.session.open()
		const props = () => ({
			state: f.session.getSnapshot(),
			session: f.session,
			onCreator: () => {},
			onManage: () => {},
			onSearch: () => {},
			onPlay: () => {},
		})
		assert.ok(
			nodes(render(props())).some(
				(item) => item.props.title === '上次读取没有投稿',
			),
		)
		f.creators.saveCreator({
			source: 'bilibili',
			mid: '99',
			name: '尚未读取UP',
			fetchedAt: 0,
		})
		f.creators.follow({
			profileId: 'local',
			creatorMid: '99',
			scope: 'all',
			origin: 'manual',
		})
		f.session.load()
		assert.ok(
			nodes(render(props())).some(
				(item) => item.props.title === '部分关注还没有读取',
			),
		)
		f.creators.unfollow('local', '88')
		f.session.load()
		assert.ok(
			nodes(render(props())).some(
				(item) => item.props.title === '还没有读取关注投稿',
			),
		)
		f.creators.unfollow('local', '99')
		f.session.load()
		const empty = render(props())
		assert.ok(
			nodes(empty).some((item) => item.props.title === '还没有关注的 UP 主'),
		)
		const tools = nodes(empty).find((item) => item.type === 'CollectionMenu')!
		const actions = tools.props.actions as {
			label: string
			onPress: () => void
		}[]
		assert.ok(actions.some((action) => action.label === '寻找 UP 主'))
		assert.ok(actions.some((action) => action.label === '管理本地关注的 UP 主'))
	} finally {
		f.raw.close()
	}
})

void test('actual hook subscription reinstalls once under StrictMode; overlay return re-reads local qualification and closed foreground does not read', () => {
	const f = feedFixture(),
		creators = new CreatorSession(f.creators, { sourcesByUploader: () => [] })
	const effects: (() => () => void)[] = [],
		foreground = new Set<(state: string) => void>()
	let listeners = 0
	const subscribe = creators.subscribe
	creators.subscribe = (listener) => {
		listeners++
		const remove = subscribe(listener)
		return () => {
			listeners--
			remove()
		}
	}
	const output: { useFollowingFeed?: typeof useFollowingFeed } = {}
	runInNewContext(
		compile(
			readFileSync(new URL('../useFollowingFeed.ts', import.meta.url), 'utf8'),
		),
		{
			exports: output,
			require: (name: string) => {
				if (name === 'react')
					return {
						useMemo: (make: () => unknown) => make(),
						useSyncExternalStore: (_sub: unknown, get: () => unknown) => get(),
						useEffect: (effect: () => () => void) => effects.push(effect),
					}
				if (name === 'react-native')
					return {
						AppState: {
							addEventListener: (
								_name: string,
								callback: (state: string) => void,
							) => {
								foreground.add(callback)
								return { remove: () => foreground.delete(callback) }
							},
						},
					}
				if (name === './following-feed-session') return { FollowingFeedSession }
				if (name === './creator-api')
					return {
						creatorPosts: () => assert.fail('No implicit network refresh'),
					}
				throw new Error(name)
			},
		},
	)
	try {
		assert.ok(output.useFollowingFeed)
		const { session } = output.useFollowingFeed(
			{ load: f.store.load.bind(f.store) },
			creators,
		)
		let stop = effects[0]()
		assert.equal(listeners, 1)
		for (const notify of foreground) notify('active')
		assert.equal(session.getSnapshot().snapshot, null)
		stop()
		stop = effects[0]()
		assert.equal(listeners, 1)
		assert.equal(foreground.size, 1)
		session.open()
		session.pauseForOverlay()
		creators.openFollowing()
		f.creators.unfollow('local', '88')
		creators.back()
		assert.equal(session.getSnapshot().overlay, false)
		assert.equal(session.getSnapshot().snapshot!.status, 'no-subscriptions')
		stop()
		assert.equal(listeners, 0)
		assert.equal(foreground.size, 0)
		assert.equal(session.getSnapshot().open, false)
	} finally {
		f.raw.close()
	}
})
