import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'

import {
	controlFixture,
	controlNodes,
	legacyControlPackage,
	type ControlNode,
} from './theme-control-fixture'

const component = (value: unknown) => value as ControlNode['type']

void test('compact collection controls retain real themed targets and 48dp minimums in built-in and legacy package themes', async () => {
	const legacy = await legacyControlPackage()
	for (const theme of [...Object.values(builtInThemes), null]) {
		const f = controlFixture()
		const ui = f.load('ui'),
			collection = f.load('library-collection-ui')
		let played = 0,
			selected = 0
		const content = f.element(component(collection.CollectionSongRow), {
			title: '真实音乐',
			subtitle: '歌手 · 本地音频',
			onPlay: () => {
				played++
			},
			trailing: f.element(component(collection.CollectionMenu), {
				label: '歌曲操作',
				actions: [
					{
						label: '喜欢歌曲',
						onPress: () => {
							selected++
						},
					},
				],
			}),
		})
		const root = theme
			? f.element(component(ui.ThemeProvider), { value: theme }, content)
			: f.element(
					component(ui.PackageThemeProvider),
					{ ...legacy, reducedMotion: true },
					content,
				)
		const render = () => f.render(root)
		const target = (label: string) => {
			const node = controlNodes(render()).find(
				(candidate) =>
					candidate.type === 'Pressable' &&
					candidate.props.accessibilityLabel === label,
			)
			assert.ok(node, label)
			return node
		}
		for (const label of ['播放 真实音乐', '歌曲操作', '喜欢歌曲', '取消操作']) {
			const node = target(label)
			const style = f.flatten(
				typeof node.props.style === 'function'
					? node.props.style({ pressed: false })
					: node.props.style,
			)
			assert.ok(Number(style.minHeight ?? style.height) >= 48, label)
		}
		;(target('播放 真实音乐').props.onPress as () => void)()
		;(target('歌曲操作').props.onPress as () => void)()
		assert.equal(
			controlNodes(render()).find((node) => node.type === 'Modal')?.props
				.visible,
			true,
		)
		;(target('喜欢歌曲').props.onPress as () => void)()
		assert.equal(played, 1)
		assert.equal(selected, 1)
		assert.equal(
			controlNodes(render()).find((node) => node.type === 'Modal')?.props
				.visible,
			false,
		)
		f.unmount()
	}
})
