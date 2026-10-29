import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { controlFixture, controlNodes, type ControlNode } from './theme-control-fixture'

const component = (value: unknown) => value as ControlNode['type']

void test('all eight mascot states bundle local images and remain decorative', () => {
	const h = controlFixture()
	try {
		for (const state of ['playing', 'video', 'loading', 'empty', 'search', 'error', 'liked', 'sleep']) {
			const nodes = controlNodes(h.render(h.element(component(h.load('mascot-art').MascotArt), { state, size: 140 })))
			const frame = nodes.find(n => n.props.testID === `mascot-${state}`)!
			assert.equal(frame.props.pointerEvents, 'none')
			assert.equal(frame.props.importantForAccessibility, 'no-hide-descendants')
			assert.equal(nodes.find(n => n.type === 'Image')?.props.source, `./assets/mascot/${state}.png`)
			const bytes = readFileSync(new URL(`../assets/mascot/${state}.png`, import.meta.url))
			assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
		}
	} finally { h.unmount() }
})

void test('mascot error and loading states retain their text, retry and progress indicator', () => {
	const h = controlFixture()
	let retried = 0
	try {
		const ui = h.load('ui')
		const tree = h.render(h.element(component(ui.State), { title: '音源暂不可用', message: '请检查连接', mascot: 'error', retry: () => retried++ }))
		const nodes = controlNodes(tree)
		assert.ok(JSON.stringify(tree).includes('请检查连接'))
		assert.ok(nodes.some(n => n.props.testID === 'mascot-error'))
		const retry = nodes.find(n => typeof n.props.onPress === 'function')!
		;(retry.props.onPress as () => void)()
		assert.equal(retried, 1)
		const busy = controlNodes(h.render(h.element(component(ui.State), { title: '正在搜索', mascot: 'loading', busy: true })))
		assert.ok(busy.some(n => n.type === 'ActivityIndicator'))
	} finally { h.unmount() }
})

void test('portrait startup fits narrow and large-text screens and opens immediately when ready', () => {
	for (const mode of ['light', 'dark']) for (const fontScale of [1, 2]) {
		const h = controlFixture()
		Object.assign(h.viewport, { width: 320, height: 568, fontScale })
		try {
			const startup = h.load('startup-ui')
			const element = (ready: boolean) => h.element(component(startup.StartupContent), { mode, ready }, 'READY_CONTENT')
			const tree = h.render(element(false))
			const nodes = controlNodes(tree)
			assert.ok(nodes.some(n => n.props.testID === 'app-startup'))
			const portrait = nodes.find(n => n.props.importantForAccessibility === 'no-hide-descendants')!
			const style = h.flatten(portrait.props.style)
			assert.ok(Number(style.width) <= 272 && Number(style.height) < 568)
			assert.equal(style.backgroundColor, undefined, 'transparent portrait must not regain a white panel')
			assert.ok(nodes.some(n => n.type === 'Image' && n.props.source === './assets/mascot/portrait-cutout.png'))
			assert.equal(nodes.filter(n => n.type === 'Image').length, 2)
			assert.equal(JSON.stringify(h.render(element(true))).includes('READY_CONTENT'), true)
			assert.equal(controlNodes(h.render(element(false))).some(n => n.props.testID === 'app-startup'), false)
		} finally { h.unmount() }
	}
})
