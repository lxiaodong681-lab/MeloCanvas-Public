import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import type { LibraryPage } from '../library-ui'

import {
	compile,
	nodes,
	react,
	text,
	type ViewNode,
} from './search-page-fixture'

function render(
	overrides: Partial<Parameters<typeof LibraryPage>[0]> = {},
	viewport = { width: 360, fontScale: 1 },
) {
	const calls: string[] = []
	const output: {
		LibraryPage?: (props: Parameters<typeof LibraryPage>[0]) => ViewNode
	} = {}
	const components = Object.fromEntries(
		[
			'Button',
			'Card',
			'ControlRow',
			'ControlTarget',
			'Icon',
			'IconButton',
			'State',
			'MascotArt',
			'T',
		].map((name) => [name, name]),
	)
	runInNewContext(
		compile(
			readFileSync(new URL('../library-ui.tsx', import.meta.url), 'utf8'),
		),
		{
			exports: output,
			require: (name: string) => {
				if (name === 'react')
					return { __esModule: true, default: react, ...react }
				if (name === 'react-native')
					return {
						View: 'View',
						StyleSheet: { create: (value: unknown) => value },
						useWindowDimensions: () => viewport,
					}
				if (name === './ui')
					return {
						...components,
						useTheme: () => ({
							tokens: {
								action: { primary: 'red' },
								text: { secondary: 'gray' },
								border: { subtle: 'gray' },
							},
						}),
					}
				if (name === './library-collection-ui')
					return { CollectionMenu: 'CollectionMenu' }
				if (name === './listening-ui')
					return { ListeningResumeList: 'ListeningResumeList' }
				if (name === './playlist-ui')
					return {
						PlaylistDetailPage: 'PlaylistDetailPage',
						PlaylistLibrarySection: 'PlaylistLibrarySection',
					}
				throw new Error(name)
			},
		},
	)
	assert.ok(output.LibraryPage)
	const props = {
		collection: 'root',
		onCollectionChange: (value: string) => calls.push(value),
		localAudio: 'LOCAL_CONTENT',
		recentMusic: 'RECENT_CONTENT',
		playlistState: { currentId: null, playlists: [], error: '' },
		playlistSession: {
			requestName: (value: string) => calls.push(`name:${value}`),
		},
		likes: [],
		resumeItems: [],
		playbackBusy: false,
		onImport: () => calls.push('import'),
		onFindMusic: () => calls.push('search'),
		onPlayLiked: () => calls.push('play-liked'),
		onListeningOpenChange: () => calls.push('listening'),
		...overrides,
	} as Parameters<typeof LibraryPage>[0]
	return { value: output.LibraryPage(props), calls }
}

void test('library root puts collection navigation and playlists ahead of tools, without expanding local/recent content', () => {
	const { value, calls } = render()
	assert.ok(text(value).includes('音乐库'))
	assert.ok(!text(value).includes('LOCAL_CONTENT'))
	assert.ok(!text(value).includes('RECENT_CONTENT'))
	for (const [label, expected] of [
		['打开喜欢', 'likes'],
		['打开最近', 'recent'],
		['打开本地', 'local'],
		['打开听视频', 'listening'],
	]) {
		const entry = nodes(value).find(
			(node) => node.props.accessibilityLabel === label,
		)
		assert.ok(entry)
		;(entry.props.onPress as () => void)()
		assert.equal(calls.at(-1), expected)
	}
	const menu = nodes(value).find((node) => node.type === 'CollectionMenu')
	assert.ok(menu)
	const actions = menu.props.actions as { label: string; onPress: () => void }[]
	assert.deepEqual(
		Array.from(actions, (action) => action.label),
		['新建歌单', '导入歌单', '本地音乐，导入文件'],
	)
	actions[1].onPress()
	assert.equal(calls.at(-1), 'import')
	assert.ok(nodes(value).some((node) => node.type === 'PlaylistLibrarySection'))
})

void test('collection detail renders only selected content and returns to library without changing playback', () => {
	for (const [collection, expected] of [
		['local', 'LOCAL_CONTENT'],
		['recent', 'RECENT_CONTENT'],
	] as const) {
		const { value, calls } = render({ collection })
		assert.ok(text(value).includes(expected))
		assert.ok(
			!nodes(value).some((node) => node.type === 'PlaylistLibrarySection'),
		)
		const back = nodes(value).find((node) => node.props.label === '返回音乐库')
		assert.ok(back)
		;(back.props.onPress as () => void)()
		assert.deepEqual(calls, ['root'])
	}
})

void test('liked collection keeps playback disabled when empty and its save action in overflow', () => {
	const { value } = render({ collection: 'likes' })
	const play = nodes(value).find((node) => node.props.label === '播放全部喜欢')
	assert.equal(play?.props.disabled, true)
	const menu = nodes(value).find((node) => node.type === 'CollectionMenu')
	assert.ok(menu)
	const action = (menu.props.actions as { disabled: boolean }[])[0]
	assert.ok(action)
	assert.equal(action.disabled, true)
})

void test('library shortcuts use two rows on narrow phones and large fonts while preserving all four collection actions', () => {
	for (const [viewport, widths] of [
		[{ width: 320, fontScale: 1 }, [4]],
		[{ width: 360, fontScale: 1 }, [4]],
		[{ width: 430, fontScale: 1.5 }, [2, 2]],
	] as const) {
		const { value, calls } = render({}, viewport)
		const grid = nodes(value).find(
			(item) => item.props.testID === 'library-shortcuts',
		)!
		const rows = nodes(grid).filter((item) => item.type === 'ControlRow')
		assert.deepEqual(
			rows.map((row) => (row.props.controlMinWidthsDp as number[]).length),
			Array.from(widths),
		)
		for (const [label, expected] of [
			['打开喜欢', 'likes'],
			['打开最近', 'recent'],
			['打开本地', 'local'],
			['打开听视频', 'listening'],
		]) {
			const target = nodes(grid).find(
				(item) => item.props.accessibilityLabel === label,
			)!
			assert.ok(target)
			;(target.props.onPress as () => void)()
			assert.equal(calls.at(-1), expected)
		}
	}
})
