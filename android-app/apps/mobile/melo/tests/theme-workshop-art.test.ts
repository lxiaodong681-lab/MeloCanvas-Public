import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { builtInThemes } from '../core/theme'
import { controlFixture, controlNodes, type ControlNode } from './theme-control-fixture'

void test('workshop patterned illustrations use bounded pre-rendered assets instead of live SVG pictures', () => {
	const f = controlFixture(), module = f.load('theme-workshop')
	const nodes = controlNodes(f.render(f.element(module.ThemeWorkshop as ControlNode['type'], {
		themeKey: 'modern', mode: 'music', onSelect: () => {},
	})))
	const sources = new Set(nodes.filter((n) => n.type === 'Image').map((n) => n.props.source))
	for (const name of ['meadow', 'orbit']) {
		assert.ok(sources.has(`./assets/${name}.png`))
		assert.ok(!sources.has(`./assets/${name}.svg`))
		const png = readFileSync(new URL(`../assets/${name}.png`, import.meta.url))
		assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
		assert.equal(png.readUInt32BE(16), 600)
		assert.equal(png.readUInt32BE(20), 600)
		assert.ok(png.length < 256 * 1024)
	}
	f.unmount()
})

for (const theme of Object.values(builtInThemes)) {
	void test(`${theme.id} home shortcut also uses static artwork and remains actionable`, () => {
		const f = controlFixture()
		const { ThemeRendererProvider } = f.load('ui')
		const { HomeMusicHero } = f.load('app-controls')
		let searches = 0
		const nodes = controlNodes(f.render(f.element(ThemeRendererProvider as ControlNode['type'], {
			theme, adapted: null, allowedImageUris: [], reducedMotion: false,
		}, f.element(HomeMusicHero as ControlNode['type'], { onPress: () => { searches++ } }))))
		const images = nodes.filter((node) => node.type === 'Image')
		assert.equal(images.length, 1)
		assert.equal(images[0].props.source, `./${theme.assets.hero.replace(/\.svg$/, '.png')}`)
		const shortcut = nodes.find((node) => node.type === 'Pressable' && node.props.accessibilityLabel === '搜索更多音乐')
		assert.ok(shortcut)
		;(shortcut.props.onPress as () => void)()
		assert.equal(searches, 1)
		f.unmount()
	})
}
