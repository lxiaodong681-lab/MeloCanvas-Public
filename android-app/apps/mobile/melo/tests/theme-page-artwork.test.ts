import assert from 'node:assert/strict'
import test from 'node:test'
import { builtInThemes } from '../core/theme'
import { controlNodes, type ControlNode } from './theme-control-fixture'
import { iconHost, iconPackage } from './theme-icon-renderer-fixture'

void test('secondary pages have no header strip; only the profile retains its bounded cover', async () => {
	const p = await iconPackage(), f = iconHost(), ui = f.load('ui'), adapted = structuredClone(p.light)
	adapted.retained.surfaceArt = { pageHeader: p.allowed[0], profileBackground: p.allowed[0] }
	assert.equal(controlNodes(f.render(f.pack(f.element(ui.ThemePageArtwork as ControlNode['type'], {}), adapted, p.allowed))).length, 0)
	for (const [component, height] of [['ThemePageArtwork', 200]] as const) {
		const child = f.element(ui[component] as ControlNode['type'], { profile: true })
		const tree = f.render(f.pack(child, adapted, p.allowed))
		const art = controlNodes(tree).find((node) => node.props.testID === 'theme-page-artwork')!
		assert.equal(art.props.pointerEvents, 'none')
		assert.equal(f.flatten(art.props.style).height, height)
		const images = controlNodes(tree).filter((node) => node.type === 'Image')
		assert.equal(images.length, 1)
		assert.equal(images[0].props.source, p.allowed[0])
		assert.equal(images[0].props.transition, 0)
		assert.equal(images[0].props.accessible, false)
		assert.equal(controlNodes(f.render(f.builtin(child, builtInThemes.modern))).length, 0)
	}
	assert.equal(controlNodes(f.render(f.pack(f.element(ui.PlayerBackdrop as ControlNode['type'], {}), adapted, p.allowed))).length, 0,
		'player and lyric views must not receive decorative page header strips')
	f.unmount()
})
