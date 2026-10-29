import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'
import { cosmosTheme } from '../core/theme-appearance'

import {
	controlFixture,
	controlNodes,
	legacyControlPackage,
	type ControlNode,
} from './theme-control-fixture'

const component = (value: unknown) => value as ControlNode['type']

void test('player menu retains real themed targets and 48dp minimums in built-in and legacy package themes', async () => {
	const legacy = await legacyControlPackage()
	for (const theme of [...Object.values(builtInThemes), cosmosTheme, null]) {
		const f = controlFixture()
		const ui = f.load('ui'),
			collection = f.load('music-player-menu')
		let selected = 0
		const content = f.element(component(collection.MusicPlayerMenu), {
			local: false,
			bvid: 'BVpreview',
			fm: true,
			notifications: false,
			bottomInset: 20,
			onSource: () => {
				selected++
			},
			onTheme: () => {},
			onFm: () => {},
			onNotificationSettings: () => {},
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
		for (const label of [
			'更多播放选项',
			'查看音源信息',
			'切换主题',
			'媒体通知不可用 · 前往设置',
			'管理与退出私人 FM',
			'取消播放选项',
		]) {
			const node = target(label)
			const style = f.flatten(
				typeof node.props.style === 'function'
					? node.props.style({ pressed: false })
					: node.props.style,
			)
			assert.ok(Number(style.minHeight ?? style.height) >= 48, label)
		}
		;(target('更多播放选项').props.onPress as () => void)()
		const sheet = controlNodes(render()).find(node => node.props.accessibilityViewIsModal)!
		assert.equal(f.flatten(sheet.props.style).backgroundColor, (theme ?? legacy.adapted.theme).tokens.surface.card)
		assert.equal(
			controlNodes(render()).find((node) => node.type === 'Modal')?.props
				.visible,
			true,
		)
		;(target('查看音源信息').props.onPress as () => void)()
		assert.equal(selected, 1)
		assert.equal(
			controlNodes(render()).find((node) => node.type === 'Modal')?.props
				.visible,
			false,
		)
		f.unmount()
	}
})
