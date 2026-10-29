import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import JSZip from 'jszip'

import { sha256 } from '../core/theme-archive'
import { packageCapabilities, validateThemePackage } from '../core/theme-package'
import { adaptPackageTheme } from '../core/theme-package-adapter'
import type { PackageThemeComponents, PackageThemeTokens, ThemePackageManifest } from '../core/theme-package-types'
import { createPackageRendering } from '../theme-renderer'
import { PlaybackProgress } from '../playback-progress'
import { controlNodes, type ControlNode } from './theme-control-fixture'
import { iconHost, only } from './theme-icon-renderer-fixture'

const require = createRequire(import.meta.url)
const { createNodeImageDecoder } = require('../../../../../scripts/lib/theme-package-node.cjs')
const example = readFileSync(new URL('../../../../../theme-packages/starter-examples/modern-custom-progress.melotheme', import.meta.url))
const host = { appVersion: '0.18.0', capabilities: packageCapabilities }
async function prepare(bytes: Uint8Array = example, mode: 'light' | 'dark' = 'light') {
	const verified = await validateThemePackage(bytes, host, createNodeImageDecoder())
	const root = 'file:///private/themes/'
	const rootUri = `${root}${verified.manifest.id}/${verified.snapshot.package.archiveSha256}/`
	const resources = verified.snapshot.resources.map((r) => ({ ...r, uri: rootUri + r.path }))
	return { adapted: adaptPackageTheme(verified, { package: verified.snapshot.package, rootUri, resources }, { host, mode, privateThemesRootUri: root }), allowed: resources.map((r) => r.uri) }
}
type Documents = { light: PackageThemeTokens; dark?: PackageThemeTokens }
async function alter(action: (zip: JSZip, manifest: ThemePackageManifest, tokens: Documents, components: { components: PackageThemeComponents }) => void) {
	const zip = await JSZip.loadAsync(example)
	const m = JSON.parse(await zip.file('manifest.json')!.async('string')) as ThemePackageManifest, t = JSON.parse(await zip.file('tokens.json')!.async('string')) as Documents, c = JSON.parse(await zip.file('components.json')!.async('string')) as { components: PackageThemeComponents }
	action(zip, m, t, c)
	zip.file('manifest.json', JSON.stringify(m)); zip.file('tokens.json', JSON.stringify(t)); zip.file('components.json', JSON.stringify(c))
	return zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
}

void test('colors and static thumb survive validation, binding and renderer; legacy packages remain unchanged', async () => {
	const p = await prepare(), rendering = createPackageRendering(p.adapted, p.allowed, false)
	assert.deepEqual(rendering.progress?.colors, { track: '#DDD8D1', fill: '#C3483B', thumb: '#315A86' })
	assert.match(rendering.progress?.thumbUri ?? '', /\/assets\/thumb.png$/)
	assert.equal(rendering.progress?.sizeDp, 28)
	const legacy = await prepare(readFileSync(new URL('../../../../../theme-packages/starter-examples/modern.melotheme', import.meta.url)))
	assert.equal(createPackageRendering(legacy.adapted, legacy.allowed, false).progress, undefined)
	const restricted = createPackageRendering(p.adapted, [], false)
	assert.equal(restricted.progress?.thumbUri, undefined)
})

void test('missing capability, malformed colors, unsafe images, size and unknown fields fail before install', async () => {
	const changes: Parameters<typeof alter>[0][] = [
		(_z, m) => { m.requiredCapabilities = m.requiredCapabilities.filter((c) => c !== 'custom-progress-v1') },
		(_z, _m, t) => { t.light.progress!.fill = 'red' },
		(_z, _m, _t, c) => { c.components.progress.thumb!.sizeDp = 100 },
		(_z, _m, _t, c) => { c.components.progress.thumb!.light = 'https://x.invalid/a.png' },
		(_z, _m, _t, c) => { Object.assign(c.components.progress.thumb!, { animate: true }) },
	]
	for (const change of changes) await assert.rejects(prepare(await alter(change)))
	const tooLarge = await alter((zip, manifest) => {
		const bytes = readFileSync(new URL('../assets/coast.png', import.meta.url))
		zip.file('assets/thumb.png', bytes)
		Object.assign(manifest.assets.find((a) => a.path === 'assets/thumb.png')!, { bytes: bytes.length, sha256: sha256(bytes) })
	})
	await assert.rejects(prepare(tooLarge), /滑块图片/)
	await assert.rejects(validateThemePackage(example, { ...host, capabilities: host.capabilities.filter((c) => c !== 'custom-progress-v1') }, createNodeImageDecoder()), /必需能力/)
})

void test('dark mode uses independent colors and never silently reuses a light thumb', async () => {
	const bytes = await alter((_z, m, t) => { m.requiredCapabilities.push('dark-tokens'); t.dark = structuredClone(t.light); t.dark.progress!.thumb = '#123456' })
	const p = await prepare(bytes, 'dark'), r = createPackageRendering(p.adapted, p.allowed, false)
	assert.equal(r.progress?.thumbUri, undefined)
	assert.equal(r.progress?.colors?.thumb, '#123456')
})

void test('actual player renders independent track/fill, keeps a stable image through ticks, and falls back on error', async () => {
	const p = await prepare(), f = iconHost(), module = f.load('progress')
	const render = (position: number) => f.render(f.pack(f.element(module.Progress as ControlNode['type'], { position, duration: 100, onSeek: () => {} }), p.adapted, p.allowed))
	let tree = render(10)
	const image = only(tree, 'Image'), source = image.props.source
	assert.equal(image.props.contentFit, 'contain')
	assert.equal(image.props.cachePolicy, 'memory-disk')
	assert.equal(image.props.transition, 0)
	const colors = new Set(controlNodes(tree).map((n) => (n.props.style as Record<string, unknown> | undefined)?.backgroundColor))
	assert.ok(colors.has('#DDD8D1')); assert.ok(colors.has('#C3483B'))
	assert.equal(only(render(40), 'Image').props.source, source)
	;(image.props.onError as () => void)()
	tree = render(50)
	assert.equal(controlNodes(tree).filter((n) => n.type === 'Image').length, 0)
	assert.ok(controlNodes(tree).some((n) => (n.props.style as Record<string, unknown> | undefined)?.backgroundColor === '#315A86'))
	assert.ok(controlNodes(tree).some((n) => n.props.accessibilityRole === 'adjustable'))
	f.unmount()
})

void test('leaf progress follows the store and keeps known track duration before the first native duration event', async () => {
	const p = await prepare(), f = iconHost(), module = f.load('progress'), progress = new PlaybackProgress()
	const render = () => f.render(f.pack(f.element(module.Progress as ControlNode['type'], {
		progress, position: 5, duration: 100, onSeek: () => {},
	}), p.adapted, p.allowed))
	try {
		let bar = controlNodes(render()).find((n) => n.props.accessibilityRole === 'adjustable')!
		assert.equal((bar.props.accessibilityState as { disabled: boolean }).disabled, false)
		assert.equal((bar.props.accessibilityValue as { max: number }).max, 100)
		progress.update(60, 120)
		bar = controlNodes(render()).find((n) => n.props.accessibilityRole === 'adjustable')!
		assert.equal((bar.props.accessibilityValue as { now: number }).now, 60)
		assert.equal((bar.props.accessibilityValue as { max: number }).max, 120)
	} finally { f.unmount() }
})
