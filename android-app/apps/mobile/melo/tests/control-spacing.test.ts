import assert from 'node:assert/strict'
import test from 'node:test'

import { builtInThemes } from '../core/theme'
import { cosmosTheme } from '../core/theme-appearance'
import { controlFixture, controlNodes, legacyControlPackage, measureControl, type ControlNode } from './theme-control-fixture'

const flat = (value: unknown): Record<string, unknown> => Array.isArray(value)
	? Object.assign({}, ...value.map(flat)) : value && typeof value === 'object' ? value as Record<string, unknown> : {}

void test('form cards separate adjacent controls in built-in, dark and imported themes without shrinking targets', async () => {
	const pkg = await legacyControlPackage()
	for (const theme of [...Object.values(builtInThemes), cosmosTheme, null]) {
		const f = controlFixture()
		const ui = f.load('ui')
		f.viewport.width = 320
		f.viewport.fontScale = 1.5
		const button = (label: string) => f.element(ui.Button as ControlNode['type'], { onPress: () => {} }, label)
		const card = f.element(ui.Card as ControlNode['type'], {}, button('保存并应用外观'), button('开发者模式，制作与发布主题'))
		const tree = f.render(f.element((theme ? ui.ThemeRendererProvider : ui.PackageThemeProvider) as ControlNode['type'], theme ? { theme, adapted: null, allowedImageUris: [], reducedMotion: true } : { ...pkg, reducedMotion: true }, card))
		const nodes = controlNodes(tree)
		const surface = nodes.find(n => flat(n.props.style).backgroundColor && flat(n.props.style).padding !== undefined)!
		assert.ok(Number(flat(surface.props.style).gap) >= 12, 'card must separate controls')
		for (const target of nodes.filter(n => n.type === 'Pressable')) {
			const style = typeof target.props.style === 'function' ? target.props.style({ pressed: false }) : target.props.style
			assert.ok(Number(flat(style).minHeight) >= 48)
			assert.equal(flat(style).height, undefined, 'text may grow beyond minimum target height')
		}
		f.unmount()
	}
})

void test('compact cards can explicitly retain their existing spacing', () => {
	const f = controlFixture(), ui = f.load('ui')
	const tree = f.render(f.element(ui.Card as ControlNode['type'], { style: { gap: 0, padding: 6 } }, 'mini player'))
	assert.equal(flat(controlNodes(tree)[0].props.style).gap, 0)
	f.unmount()
})

void test('imported control rows include the styled gap in both fit checks and rendering', () => {
	const f = controlFixture(), row = f.load('theme-control-layout').MeasuredThemeControlRow
	const props = { policy: { minTouchDp: 48, compactMinTouchDp: 48, narrowFallback: 'host-single-row' }, controlMinWidthsDp: [48, 48], style: [{ gap: 12 }] }
	const render = (extra = {}) => f.render(f.element(row as ControlNode['type'], { ...props, ...extra }, f.element('Pressable', {}), f.element('Pressable', {})))
	let tree = render()
	measureControl(tree, 100)
	assert.equal(controlNodes(render()).filter(n => n.type === 'Pressable').length, 0, '96dp of targets plus 12dp gap cannot fit in 100dp')
	measureControl(render(), 108)
	tree = render()
	assert.equal(controlNodes(tree).filter(n => n.type === 'Pressable').length, 2)
	assert.equal(flat(controlNodes(tree).find(n => n.props.onLayout)!.props.style).gap, 12)
	tree = render({ gapDp: 16 })
	measureControl(tree, 112)
	assert.equal(flat(controlNodes(render({ gapDp: 16 })).find(n => n.props.onLayout)!.props.style).gap, 16)
	f.unmount()
})
