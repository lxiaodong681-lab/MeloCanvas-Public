import assert from 'node:assert/strict'
import test from 'node:test'

import { builtInThemes } from '../core/theme'
import { cosmosTheme } from '../core/theme-appearance'
import type { useThemeDialog } from '../theme-dialog'
import { controlFixture, controlNodes, type ControlNode } from './theme-control-fixture'

function fixture() {
	const f = controlFixture()
	const module = f.load('theme-dialog') as { useThemeDialog: typeof useThemeDialog }
	let api!: ReturnType<typeof useThemeDialog>
	const Component = () => { api = module.useThemeDialog(); return api.dialog }
	const Provider = f.load('ui').ThemeProvider as ControlNode['type']
	const render = (theme = cosmosTheme) => f.render(f.element(Provider, { value: theme }, f.element(Component, {})))
	return { f, render, get api() { return api } }
}

void test('confirmation follows live app colors, stays unmounted while closed and invokes its action once', () => {
	const h = fixture()
	let confirmed = 0
	for (let i = 0; i < 100; i++) assert.equal(h.render(), null)
	h.api.show('确认移除', '原歌单不变', [{ text: '移除', style: 'destructive', onPress: () => confirmed++ }])
	for (const theme of [cosmosTheme, builtInThemes.modern, cosmosTheme]) {
		const tree = h.render(theme)
		const surface = controlNodes(tree).find(node => node.props.accessibilityViewIsModal)!
		assert.equal(h.f.flatten(surface.props.style).backgroundColor, theme.tokens.surface.card)
		const texts = controlNodes(tree).filter(node => node.type === 'Text')
		assert.equal(h.f.flatten(texts[0].props.style).color, theme.tokens.text.primary)
		assert.equal(h.f.flatten(texts[1].props.style).color, theme.tokens.text.secondary)
		assert.equal(h.f.flatten(texts[2].props.style).color, theme.tokens.state.error)
		assert.equal(confirmed, 0)
	}
	const button = controlNodes(h.render()).find(node => node.props.accessibilityLabel === '移除')!
	;(button.props.onPress as () => void)()
	;(button.props.onPress as () => void)()
	assert.equal(confirmed, 1)
	assert.equal(h.render(), null)
	h.f.unmount()
})

void test('cancel, back and unmount release confirmation without invoking destructive actions', () => {
	for (const exit of ['cancel', 'back', 'unmount']) {
		const h = fixture()
		let cancelled = 0, confirmed = 0
		h.render()
		h.api.show('重置？', '保留歌单', [
			{ text: '取消', style: 'cancel', onPress: () => cancelled++ },
			{ text: '确认', style: 'destructive', onPress: () => confirmed++ },
		], { cancelable: true, onDismiss: () => cancelled++ })
		const tree = h.render()
		if (exit === 'unmount') h.f.unmount()
		else {
			const target = controlNodes(tree).find(node => exit === 'back' ? node.type === 'Modal' : node.props.accessibilityLabel === '取消')!
			;(target.props[exit === 'back' ? 'onRequestClose' : 'onPress'] as () => void)()
			assert.equal(h.render(), null)
			h.f.unmount()
		}
		assert.equal(cancelled, 1)
		assert.equal(confirmed, 0)
		assert.equal(h.f.writesAfterUnmount, 0)
	}
})
