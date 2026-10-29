import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { builtInThemes } from '../core/theme'
import type {
	CollectionMenu,
	CollectionSongRow,
} from '../library-collection-ui'

import { compile, nodes, react, type ViewNode } from './search-page-fixture'

function fixture() {
	let open = false
	const output = {} as {
		CollectionMenu: (props: Parameters<typeof CollectionMenu>[0]) => ViewNode
		CollectionSongRow: (
			props: Parameters<typeof CollectionSongRow>[0],
		) => ViewNode
	}
	runInNewContext(
		compile(
			readFileSync(
				new URL('../library-collection-ui.tsx', import.meta.url),
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
						useState: () => [
							open,
							(value: boolean) => {
								open = value
							},
						],
					}
				if (name === 'react-native')
					return {
						View: 'View',
						Modal: 'Modal',
						Pressable: 'Pressable',
						ScrollView: 'ScrollView',
					}
				if (name === './ui')
					return {
						Artwork: 'Artwork',
						ControlRow: 'ControlRow',
						ControlTarget: 'ControlTarget',
						T: 'T',
						shape: () => ({}),
						useTheme: () => builtInThemes.modern,
					}
				throw new Error(`Unexpected dependency ${name}`)
			},
		},
	)
	return output
}

void test('secondary menu dismisses safely and runs a selected action only once', () => {
	const { CollectionMenu: Menu } = fixture()
	let selected = 0
	const render = () =>
		nodes(
			Menu({
				label: '曲目操作',
				actions: [
					{
						label: '添加到歌单',
						onPress: () => {
							selected++
						},
					},
				],
			}),
		)
	const press = (label: string) => {
		const target = render().find(
			(node) => node.props.accessibilityLabel === label,
		)
		assert.ok(target)
		;(target.props.onPress as () => void)()
	}
	const modal = () => {
		const target = render().find((node) => node.type === 'Modal')
		assert.ok(target)
		return target
	}
	assert.equal(modal().props.visible, false)
	press('曲目操作')
	assert.equal(modal().props.visible, true)
	press('关闭操作菜单')
	assert.equal(modal().props.visible, false)
	assert.equal(selected, 0)
	press('曲目操作')
	;(modal().props.onRequestClose as () => void)()
	assert.equal(modal().props.visible, false)
	press('曲目操作')
	press('添加到歌单')
	assert.equal(selected, 1)
	assert.equal(modal().props.visible, false)
})

void test('compact song row keeps a labelled large playback target and busy state', () => {
	const { CollectionSongRow: Row } = fixture()
	let played = 0
	const props = {
		title: '很长的歌名',
		subtitle: '歌手 · 本地音频',
		onPlay: () => {
			played++
		},
	}
	const target = nodes(Row({ ...props, disabled: true })).find(
		(node) => node.props.accessibilityLabel === '播放 很长的歌名',
	)
	assert.ok(target)
	assert.equal(target.props.disabled, true)
	assert.equal(target.props.minimumHeightDp, 64)
	assert.equal(target.props.minimumWidthDp, 116)
	const ready = nodes(Row(props)).find(
		(node) => node.props.accessibilityLabel === '播放 很长的歌名',
	)
	assert.ok(ready)
	;(ready.props.onPress as () => void)()
	assert.equal(played, 1)
})
