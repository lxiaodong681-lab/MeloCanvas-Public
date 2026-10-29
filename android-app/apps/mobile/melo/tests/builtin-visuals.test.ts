import assert from 'node:assert/strict'
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

void test('only real built-in theme instances own original background colors', () => {
	assert.deepEqual(
		Object.values(builtInThemes).map((t) => builtInVisuals(t)?.topTint),
		['#e6cbbb', '#d8e5ba', '#e5d8fb'],
	)
	for (const theme of Object.values(builtInThemes)) {
		assert.equal(
			builtInVisuals({ ...theme }),
			null,
			'a package claiming a built-in id must not inherit decoration',
		)
	}
})

void test('approved built-ins use quiet backgrounds; imported artwork remains available', () => {
	for (const theme of [
		...Object.values(builtInThemes),
		{ ...builtInThemes.modern },
	]) {
		const f = controlFixture()
		const ui = f.load('ui')
		const root = f.element(
			component(ui.ThemeProvider),
			{ value: theme },
			f.element(component(ui.Backdrop), {}),
			f.element(component(ui.PlayerBackdrop), {}),
			f.element(component(ui.IconButton), {
				name: 'play',
				label: 'music',
				primary: true,
				large: true,
				musicPrimary: true,
				onPress: () => {},
			}),
			f.element(component(ui.IconButton), {
				name: 'play',
				label: 'other',
				primary: true,
				large: true,
				onPress: () => {},
			}),
		)
		const all = controlNodes(f.render(root))
		assert.equal(
			all.filter((n) => n.type === 'LinearGradient').length,
			0,
		)
		assert.equal(
			all.filter((n) => n.type === 'Image').length,
			!builtInVisuals(theme) && theme.assets.backdrop ? 1 : 0,
		)
		for (const label of ['music', 'other']) {
			const button = all.find(
				(n) => n.type === 'Pressable' && n.props.accessibilityLabel === label,
			)!
			const style = f.flatten(
				typeof button.props.style === 'function'
					? button.props.style({ pressed: false })
					: button.props.style,
			)
			assert.equal(Number(style.width), 68)
			if (theme.components.button !== 'comic')
				assert.equal(
					style.boxShadow,
					undefined,
				)
		}
		f.unmount()
	}
})

void test('actual presentation provider preserves built-in visuals after installer snapshot cloning', () => {
	for (const original of Object.values(builtInThemes)) {
		const theme = JSON.parse(JSON.stringify(original)) as typeof original
		const f = controlFixture(),
			ui = f.load('ui')
		const root = f.element(
			component(ui.ThemeRendererProvider),
			{
				theme,
				adapted: null,
				allowedImageUris: [],
				reducedMotion: true,
			},
			f.element(component(ui.PlayerBackdrop), {}),
		)
		const nodes = controlNodes(f.render(root))
		assert.equal(nodes.filter((n) => n.type === 'LinearGradient').length, 0)
		assert.equal(
			nodes.find((n) => n.type === 'Stop')?.props.stopColor,
			undefined,
		)
		f.unmount()
	}
})

void test('validated imported package cannot obtain built-in decoration by claiming a built-in id', async () => {
	const pack = await legacyControlPackage()
	const f = controlFixture(),
		ui = f.load('ui')
	const adapted = {
		...pack.adapted,
		theme: { ...pack.adapted.theme, id: builtInThemes.modern.id },
	}
	const root = f.element(
		component(ui.PackageThemeProvider),
		{
			...pack,
			adapted,
			reducedMotion: true,
		},
		f.element(component(ui.PlayerBackdrop), {}),
	)
	assert.equal(
		controlNodes(f.render(root)).filter((n) => n.type === 'LinearGradient')
			.length,
		0,
	)
	f.unmount()
})
