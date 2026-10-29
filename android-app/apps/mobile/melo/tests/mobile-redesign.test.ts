import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'
import { flat, importHost, playlistState } from './theme-import-fixture'

void test('approved themes retain their palettes, readable controls and all four home shortcuts', () => {
	for (const [key, accent] of [
		['modern', '#cb483a'],
		['pastoral', '#52794f'],
		['anime', '#7352ba'],
	] as const) {
		const f = controlFixture(),
			ui = f.load('ui'),
			calls: string[] = []
		const draw = (
			component: ControlNode['type'],
			props: Record<string, unknown>,
		) =>
			f.render(
				f.element(
					ui.ThemeProvider as ControlNode['type'],
					{ value: builtInThemes[key] },
					f.element(component, props),
				),
			)
		assert.equal(builtInThemes[key].tokens.action.primary, accent)
		const shortcuts = draw(
			f.load('app-controls').HomeShortcuts as ControlNode['type'],
			{
				onLikes: () => calls.push('likes'),
				onRecent: () => calls.push('recent'),
				onLocal: () => calls.push('local'),
				onOffline: () => calls.push('offline'),
			},
		)
		for (const label of ['打开喜欢', '打开最近', '打开本地', '打开下载']) {
			const target = controlNodes(shortcuts).find(
				(node) => node.props.accessibilityLabel === label,
			)!
			assert.ok(target, label)
			;(target.props.onPress as () => void)()
		}
		assert.deepEqual(calls, ['likes', 'recent', 'local', 'offline'])
		const card = draw(ui.Card as ControlNode['type'], { children: '内容' })
		const style = f.flatten(
			controlNodes(card).find((node) => node.type === 'View')!.props.style,
		)
		assert.equal(style.backgroundColor, builtInThemes[key].tokens.surface.card)
		assert.equal(style.borderRadius, 12)
		assert.equal(style.boxShadow, undefined)
	}
})

void test('compact settings entries call their real owner and retain unavailable-state semantics', () => {
	const f = controlFixture(),
		layout = f.load('settings-layout'),
		ui = f.load('ui')
	let opened = 0
	const draw = (disabled: boolean) =>
		f.render(
			f.element(
				ui.ThemeProvider as ControlNode['type'],
				{ value: builtInThemes.anime },
				f.element(layout.SettingsRow as ControlNode['type'], {
					label: '备份与恢复',
					detail: '保存在本机',
					onPress: () => opened++,
					disabled,
				}),
			),
		)
	const entry = controlNodes(draw(false)).find(
		(n) => n.props.accessibilityLabel === '备份与恢复',
	)!
	;(entry.props.onPress as () => void)()
	assert.equal(opened, 1)
	const disabled = controlNodes(draw(true)).find(
		(n) => n.props.accessibilityLabel === '备份与恢复',
	)!
	assert.equal(disabled.props.disabled, true)
	assert.equal(
		(disabled.props.accessibilityState as { disabled: boolean }).disabled,
		true,
	)
})

void test('installed builtin snapshots retain two-column galleries; large fonts use one column without changing playlist identity', () => {
	for (const theme of Object.values(builtInThemes)) {
		for (const width of [320, 360, 430]) {
			for (const fontScale of [1, 2]) {
				const h = importHost()
				Object.assign(h.viewport, { width, fontScale })
				const state = playlistState({
					playlists: [0, 1].map((index) => ({
						playlist: {
							id: 'p' + index,
							name: '歌单' + index,
							description: '',
							coverUri: null,
							createdAt: 1,
							updatedAt: 1,
						},
						count: 3,
						pendingCount: 1,
						artwork: null,
						importSummary: '本地副本',
					})),
				})
				const root = h.element(
					h.ui.ThemeRendererProvider as ControlNode['type'],
					{
						theme: structuredClone(theme),
						adapted: null,
						allowedImageUris: [],
						reducedMotion: true,
					},
					h.page('PlaylistLibrarySection', state),
				)
				const tree = h.render(root)
				const cards = controlNodes(tree).filter(
					(n) =>
						n.type === 'Pressable' &&
						/^playlist-p\d$/.test(String(n.props.testID)),
				)
				assert.equal(cards.length, 2)
				assert.deepEqual(
					h.calls,
					[],
					'rendering a gallery cannot open or play a playlist',
				)
				for (const [index, card] of cards.entries()) {
					assert.equal(
						flat(h, card).width,
						fontScale === 1 ? (width - 54) / 2 : width - 40,
					)
					assert.equal(
						card.props.accessibilityLabel,
						`打开歌单 歌单${index}，3个条目`,
					)
					;(card.props.onPress as () => void)()
				}
				assert.deepEqual(h.calls, [
					['open', 'p0'],
					['open', 'p1'],
				])
				h.unmount()
			}
		}
	}
})
