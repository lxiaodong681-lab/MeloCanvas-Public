import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import JSZip from 'jszip'

import { builtInThemes } from '../core/theme'
import { validateThemePackage } from '../core/theme-package'
import { authorHost, authorThemes, buildAuthoredTheme } from '../theme-author'

const require = createRequire(import.meta.url)
const { createNodeImageDecoder } = require('../../../../../scripts/lib/theme-package-node.cjs')
const background = new Uint8Array(readFileSync(new URL('../assets/meadow.png', import.meta.url)))

for (const base of authorThemes) {
	void test(`${base} starter exports an installable package with its own colors and static background`, async () => {
		const { bytes, filename } = await buildAuthoredTheme({ base, name: '我的主题', background }, createNodeImageDecoder())
		assert.match(filename, /\.melotheme$/)
		const verified = await validateThemePackage(bytes, authorHost, createNodeImageDecoder())
		assert.ok(verified)
		const zip = await JSZip.loadAsync(bytes)
		const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
		assert.equal(manifest.name, '我的主题')
		const tokens = JSON.parse(await zip.file('tokens.json')!.async('string'))
		assert.equal(tokens.light.action.primary, builtInThemes[base].tokens.action.primary)
		const components = JSON.parse(await zip.file('components.json')!.async('string'))
		assert.equal(components.decorations.backdrop, 'assets/background.png')
		assert.equal(components.motion.durationMs, 0)
		assert.deepEqual(new Uint8Array(await zip.file('assets/background.png')!.async('uint8array')), background)
		assert.ok(zip.file(manifest.previews[0]))
	})
}

void test('invalid names, oversized data, and fake PNG bytes fail before sharing', async () => {
	const decoder = createNodeImageDecoder()
	await assert.rejects(buildAuthoredTheme({base:'modern',name:' ',background}, decoder), /名称/)
	await assert.rejects(buildAuthoredTheme({base:'modern',name:'a'.repeat(41),background}, decoder), /名称/)
	await assert.rejects(buildAuthoredTheme({base:'modern',name:'x',background:new Uint8Array(4*1024*1024+1)}, decoder), /4 MB/)
	await assert.rejects(buildAuthoredTheme({base:'modern',name:'x',background:new Uint8Array([1,2,3])}, decoder))
})

void test('generated background integrity remains enforced on reimport', async () => {
	const result = await buildAuthoredTheme({base:'modern',name:'x',background},createNodeImageDecoder())
	const zip = await JSZip.loadAsync(result.bytes)
	const altered = new Uint8Array(background); altered[100] ^= 1
	zip.file('assets/background.png',altered)
	await assert.rejects(validateThemePackage(await zip.generateAsync({type:'uint8array'}),authorHost,createNodeImageDecoder()))
})
