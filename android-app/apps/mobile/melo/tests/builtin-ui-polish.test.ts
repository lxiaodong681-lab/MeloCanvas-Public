import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { builtInVisuals } from '../core/builtin-visuals'
import { builtInThemes } from '../core/theme'

import {
	controlFixture,
	controlNodes,
	legacyControlPackage,
	type ControlNode,
} from './theme-control-fixture'

const component = (value: unknown) => value as ControlNode['type']
const { contrastRatio } = createRequire(import.meta.url)(
	join(
		resolve(__dirname, '../../../../..'),
		'scripts/lib/theme-token-contrast.cjs',
	),
) as {
	contrastRatio(this: void, foreground: string, background: string): number
}

void test('builtin normal text and primary button labels retain 4.5 contrast in all three palettes', () => {
	for (const theme of Object.values(builtInThemes)) {
		const colors = theme.tokens
		for (const background of [colors.surface.base, colors.surface.card]) {
			assert.ok(
				contrastRatio(colors.text.primary, background) >= 4.5,
				`${theme.name} body`,
			)
			assert.ok(
				contrastRatio(colors.text.secondary, background) >= 4.5,
				`${theme.name} caption`,
			)
		}
		assert.ok(
			contrastRatio(colors.text.inverse, colors.action.primary) >= 4.5,
			`${theme.name} primary button`,
		)
	}
})
const styleOf = (
	f: ReturnType<typeof controlFixture>,
	node: ControlNode,
	pressed = false,
) =>
	f.flatten(
		typeof node.props.style === 'function'
			? node.props.style({ pressed })
			: node.props.style,
	)

void test('runtime font changes replace only the native text measurement identity, keeping controls and callbacks', () => {
	const f = controlFixture(), ui = f.load('ui')
	const events: string[] = []
	const root = f.element(component(ui.ControlTarget), {
		accessibilityLabel: '保留当前操作', onPress: () => events.push('press'),
	}, f.element(component(ui.T), {}, '下载与离线'))
	const before = controlNodes(f.render(root))
	const text = before.find(n => n.type === 'Text')!
	const target = before.find(n => n.type === 'Pressable')!
	f.viewport.fontScale = 1.4
	const after = controlNodes(f.render(root))
	const resizedText = after.find(n => n.type === 'Text')!
	const resizedTarget = after.find(n => n.type === 'Pressable')!
	assert.notEqual(resizedText.key, text.key, 'Fabric must measure a fresh native text node')
	assert.deepEqual(resizedText.children, text.children)
	assert.deepEqual(styleOf(f, resizedText), styleOf(f, text), 'Android applies font scaling once')
	assert.equal(resizedTarget.key, target.key)
	assert.equal(resizedTarget.props.onPress, target.props.onPress)
	;(resizedTarget.props.onPress as () => void)()
	assert.deepEqual(events, ['press'])
	f.unmount()
})

void test('real built-in targets enforce default and explicit touch minimums without shrinking caller bounds', () => {
	for (const theme of Object.values(builtInThemes)) {
		const f = controlFixture(),
			ui = f.load('ui')
		const root = f.element(
			component(ui.ThemeProvider),
			{ value: theme },
			f.element(component(ui.ControlTarget), {
				accessibilityLabel: 'default',
				style: { width: 18, height: 18 },
			}),
			f.element(component(ui.ControlTarget), {
				accessibilityLabel: 'explicit',
				minimumWidthDp: 96,
				minimumHeightDp: 72,
				style: { width: 32, height: 32 },
			}),
			f.element(component(ui.ControlTarget), {
				accessibilityLabel: 'larger',
				minimumWidthDp: 72,
				minimumHeightDp: 64,
				style: () => ({ minWidth: 120, minHeight: 88 }),
			}),
		)
		const nodes = controlNodes(f.render(root)).filter(
			(n) => n.type === 'Pressable',
		)
		const bounds = (label: string) =>
			styleOf(
				f,
				nodes.find((n) => n.props.accessibilityLabel === label)!,
			)
		assert.equal(bounds('default').minWidth, 48)
		assert.equal(bounds('default').minHeight, 48)
		assert.equal(bounds('explicit').minWidth, 96)
		assert.equal(bounds('explicit').minHeight, 72)
		assert.equal(bounds('larger').minWidth, 120)
		assert.equal(bounds('larger').minHeight, 88)
		assert.equal(
			bounds('larger').height,
			undefined,
			'text may increase a control height',
		)
		assert.equal(styleOf(f, nodes[0], true).opacity, 0.86)
		f.unmount()
	}
})

void test('pressed targets preserve opaque animated opacity instead of coercing it to a number', () => {
	const f = controlFixture(),
		ui = f.load('ui')
	const animatedOpacity = { animated: 'caller-owned-opacity' }
	const root = f.element(
		component(ui.ThemeProvider),
		{ value: builtInThemes.modern },
		f.element(component(ui.ControlTarget), {
			style: { opacity: animatedOpacity },
		}),
	)
	const target = controlNodes(f.render(root)).find(
		(n) => n.type === 'Pressable',
	)!
	assert.equal(styleOf(f, target).opacity, animatedOpacity)
	assert.equal(styleOf(f, target, true).opacity, animatedOpacity)
	assert.equal(styleOf(f, target, true).minHeight, 48)
	f.unmount()
})

void test('text presets add hierarchy while explicit sizes, weights and styles remain authoritative', () => {
	const f = controlFixture(),
		ui = f.load('ui')
	const root = f.element(
		component(ui.ThemeProvider),
		{ value: builtInThemes.modern },
		f.element(component(ui.T), { variant: 'title' }, '标题'),
		f.element(component(ui.T), { variant: 'section' }, '分区'),
		f.element(component(ui.T), { variant: 'caption' }, '说明'),
		f.element(
			component(ui.T),
			{ variant: 'title', size: 20, weight: '600', style: { lineHeight: 32 } },
			'覆盖',
		),
	)
	const texts = controlNodes(f.render(root)).filter((n) => n.type === 'Text')
	assert.equal(styleOf(f, texts[0]).fontSize, 25)
	assert.equal(styleOf(f, texts[0]).lineHeight, 31.25)
	assert.equal(texts[0].props.accessibilityRole, 'header')
	assert.equal(styleOf(f, texts[1]).fontSize, 18)
	assert.equal(styleOf(f, texts[2]).fontSize, 12)
	assert.equal(
		styleOf(f, texts[2]).color,
		builtInThemes.modern.tokens.text.secondary,
	)
	assert.equal(styleOf(f, texts[3]).fontSize, 20)
	assert.equal(styleOf(f, texts[3]).fontWeight, '600')
	assert.equal(styleOf(f, texts[3]).lineHeight, 32)
	f.unmount()
})

void test('three built-in surfaces use the approved quiet surfaces and retain accessible actions', () => {
	for (const theme of Object.values(builtInThemes)) {
		const f = controlFixture(),
			ui = f.load('ui')
		const root = f.element(
			component(ui.ThemeProvider),
			{ value: theme },
			f.element(component(ui.Card), {}, '普通'),
			f.element(component(ui.Card), { emphasis: true }, '重点'),
			f.element(component(ui.Button), { onPress: () => {} }, '开播'),
			f.element(
				component(ui.Button),
				{ disabled: true, onPress: () => {} },
				'不可用',
			),
		)
		const nodes = controlNodes(f.render(root))
		const cards = nodes.filter(
			(n) => n.type === 'View' && styleOf(f, n).padding !== undefined,
		)
		assert.equal(styleOf(f, cards[0]).padding, 14)
		for (const card of cards) {
			assert.equal(styleOf(f, card).borderRadius, 12)
			assert.equal(styleOf(f, card).boxShadow, undefined)
		}
		const buttons = nodes.filter((n) => n.type === 'Pressable')
		assert.equal(styleOf(f, buttons[0]).minHeight, 48)
		assert.equal(styleOf(f, buttons[0], true).opacity, 0.86)
		assert.equal(styleOf(f, buttons[1], true).opacity, 0.4)
		assert.equal(buttons[1].props.disabled, true)
		assert.equal(styleOf(f, buttons[0]).borderRadius, 10)
		f.unmount()
	}
})

void test('built-in progress uses theme geometry inside the rail and preserves seeking and accessible actions', () => {
	for (const theme of Object.values(builtInThemes)) {
		const f = controlFixture(),
			ui = f.load('ui'),
			progress = f.load('progress')
		const sought: number[] = []
		const root = (position: number, disabled = false) =>
			f.element(
				component(ui.ThemeProvider),
				{ value: theme },
				f.element(component(progress.Progress), {
					position,
					duration: 100,
					disabled,
					onSeek: (value: number) => sought.push(value),
				}),
			)
		let tree = f.render(root(100))
		let adjustable = controlNodes(tree).find(
			(n) => n.props.accessibilityRole === 'adjustable',
		)!
		;(adjustable.props.onLayout as (event: unknown) => void)({
			nativeEvent: { layout: { width: 240 } },
		})
		tree = f.render(root(100))
		const visual = builtInVisuals(theme)!
		const nodes = controlNodes(tree)
		const thumb = nodes.find(
			(n) => n.type === 'View' && styleOf(f, n).position === 'absolute',
		)!
		assert.equal(styleOf(f, thumb).width, visual.progress.thumbSizeDp)
		assert.equal(
			Number(styleOf(f, thumb).left) + visual.progress.thumbSizeDp / 2,
			240,
		)
		assert.ok(
			nodes.some(
				(n) =>
					n.type === 'View' &&
					styleOf(f, n).height === visual.progress.railHeightDp &&
					styleOf(f, n).backgroundColor === theme.tokens.border.subtle,
			),
		)
		adjustable = nodes.find((n) => n.props.accessibilityRole === 'adjustable')!
		assert.equal(styleOf(f, adjustable).height, 48)
		;(adjustable.props.onResponderGrant as (event: unknown) => void)({
			nativeEvent: { pageX: 160, locationX: 120 },
		})
		;(adjustable.props.onResponderRelease as (event: unknown) => void)({
			nativeEvent: { pageX: 160, locationX: 120 },
		})
		;(adjustable.props.onAccessibilityAction as (event: unknown) => void)({
			nativeEvent: { actionName: 'decrement' },
		})
		assert.deepEqual(sought, [50, 85])
		const disabled = controlNodes(f.render(root(100, true))).find(
			(n) => n.props.accessibilityRole === 'adjustable',
		)!
		;(disabled.props.onResponderRelease as (event: unknown) => void)({
			nativeEvent: { locationX: 200 },
		})
		assert.deepEqual(sought, [50, 85])
		f.unmount()
	}
})

void test('legacy package target, card and progress keep their existing rendering contract', async () => {
	const pack = await legacyControlPackage()
	const f = controlFixture(),
		ui = f.load('ui'),
		progress = f.load('progress')
	const supplied = { minWidth: 64, minHeight: 56, opacity: 1 }
	const root = f.element(
		component(ui.PackageThemeProvider),
		{ ...pack, reducedMotion: true },
		f.element(component(ui.ControlTarget), {
			accessibilityLabel: 'legacy',
			minimumWidthDp: 96,
			style: supplied,
		}),
		f.element(component(ui.Card), { emphasis: true }, '卡片'),
		f.element(component(progress.Progress), {
			position: 100,
			duration: 100,
			onSeek: () => {},
		}),
	)
	const nodes = controlNodes(f.render(root))
	const target = nodes.find(
		(n) => n.type === 'Pressable' && n.props.accessibilityLabel === 'legacy',
	)!
	assert.equal(target.props.style, supplied)
	const card = nodes.find(
		(n) => n.type === 'View' && styleOf(f, n).padding === 16,
	)!
	assert.equal(
		styleOf(f, card).borderWidth,
		pack.adapted.theme.components.card === 'comic' ? 1.5 : 1,
	)
	const adjustable = nodes.find((n) => n.props.accessibilityRole === 'adjustable')!
	;(adjustable.props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { width: 240 } } })
	const thumb = controlNodes(f.render(root)).find(
		(n) => n.type === 'View' && styleOf(f, n).position === 'absolute',
	)!
	assert.equal(styleOf(f, thumb).width, 14)
	assert.equal(Number(styleOf(f, thumb).left) + 7, 240)
	f.unmount()
})
