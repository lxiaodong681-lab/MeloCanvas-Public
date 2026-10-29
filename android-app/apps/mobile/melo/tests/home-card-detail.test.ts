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
const light = (color: string) => {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const s = parseInt(color.slice(i, i + 2), 16) / 255
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
	})
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => {
	const x = light(a),
		y = light(b)
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
void test('compact home cards use each theme palette and readable text', () => {
	for (const theme of Object.values(builtInThemes)) {
		const f = controlFixture(),
			ui = f.load('ui')
		const tree = f.render(
			f.element(
				component(ui.ThemeProvider),
				{ value: theme },
				f.element(component(f.load('app-controls').HomeLocalFeatures), {
					onRecommendations() {},
					onFm() {},
				}),
			),
		)
		const nodes = controlNodes(tree),
			styles = nodes.map((n) => f.flatten(typeof n.props.style === 'function' ? n.props.style({ pressed: false }) : n.props.style))
		assert.equal(styles.filter(s => s.backgroundColor === theme.tokens.surface.tinted && s.minHeight === 76).length, 2)
		assert.ok(ratio(theme.tokens.text.primary, theme.tokens.surface.tinted) >= 4.5)
		for (const node of nodes.filter(n => n.type === 'Text')) assert.ok(ratio(f.flatten(node.props.style).color as string, theme.tokens.surface.tinted) >= 4.5)
		assert.equal(nodes.filter((n) => n.type === 'Pressable').length, 2)
		assert.match(JSON.stringify(tree), /来自本机收藏/)
	}
})
void test('imported theme retains semantic card surfaces even when its fallback has a built-in id', async () => {
	const legacy = await legacyControlPackage(),
		f = controlFixture(),
		ui = f.load('ui')
	const root = f.element(
		component(ui.PackageThemeProvider),
		legacy,
		f.element(component(f.load('app-controls').HomeLocalFeatures), {
			onRecommendations() {},
			onFm() {},
		}),
	)
	const tree = f.render(root)
	const styles = controlNodes(tree).map((n) => f.flatten(typeof n.props.style === 'function' ? n.props.style({ pressed: false }) : n.props.style)),
		c = legacy.adapted.theme.tokens
	assert.equal(
		styles.filter(
			(s) => s.minHeight === 76 && s.backgroundColor === c.surface.card,
		).length,
		2,
	)
	assert.equal(
		styles.filter(
			(s) => s.minHeight === 76 && s.backgroundColor === c.text.primary,
		).length,
		0,
	)
})
