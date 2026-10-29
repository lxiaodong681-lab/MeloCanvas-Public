import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'
import type { AdaptedPackageTheme } from '../core/theme-package-adapter'
import { createPackageRendering } from '../theme-renderer'

function adapted(): AdaptedPackageTheme {
	return {
		theme: structuredClone(builtInThemes.modern),
		mode: 'light',
		retained: {
			buttonMinTouchDp: 96,
			lyricTokens: { active: '#112233', inactive: '#445566' },
		},
		renderingResponsibilities: [
			'local-image-uris',
			'button-min-touch-dp',
			'lyric-tokens',
			'motion-duration-and-reduced-motion',
			'explicit-color-mode',
		],
	}
}

const allowed =
	'file:///data/user/0/org.melocanvas.app/files/themes/example.theme/abc/assets/header.png'

void test('surface art resolves only immutable allowed resources and is copied once', () => {
	const value = adapted()
	value.retained.surfaceArt = { banner: allowed, pageHeader: allowed, avatarFrame: allowed, profileBackground: 'https://i0.hdslb.com/bg.png', navigation: 'https://i0.hdslb.com/tail.png', navigationColors: { normal: '#ffffff', selected: '#99ffcc' } }
	const rendering = createPackageRendering(value, [allowed], false)
	assert.equal(rendering.surfaceArt?.banner, allowed)
	assert.equal(rendering.surfaceArt?.pageHeader, allowed)
	assert.equal(rendering.surfaceArt?.avatarFrame, allowed)
	assert.equal(rendering.surfaceArt?.profileBackground, undefined)
	assert.equal(rendering.surfaceArt?.navigation, undefined)
	value.retained.surfaceArt.banner = 'file:///sdcard/replaced.png'
	value.retained.surfaceArt.navigationColors!.normal = '#000000'
	assert.equal(rendering.surfaceArt?.navigationColors?.normal, '#ffffff')
	assert.equal(rendering.surfaceArt?.banner, allowed)
})

void test('主题图片仅接受宿主exact allowlist，外部路径与URI别名不能进入renderer', () => {
	const rendering = createPackageRendering(adapted(), [allowed], false)
	assert.equal(rendering.resolveResource(allowed), allowed)
	for (const resource of [
		'file:///sdcard/header.png',
		allowed.replace('header.png', 'other.png'),
		allowed.replace('header.png', '%68eader.png'),
		allowed.replace('header.png', '../header.png'),
		`${allowed}?x=1`,
		`${allowed}#x`,
		'content://app/header.png',
		'https://example.com/header.png',
		'__proto__',
	])
		assert.equal(rendering.resolveResource(resource), undefined)
})

void test('即使意外放入allowlist，网络/content/编码/穿越URI仍被拒绝', () => {
	for (const resource of [
		'https://example.com/header.png',
		'content://app/header.png',
		'file://host/header.png',
		'file:///data/%68eader.png',
		'file:///data/../header.png',
		'file:///data//header.png',
		'file:///data/header.png#x',
	])
		assert.equal(
			createPackageRendering(adapted(), [resource], false).resolveResource(
				resource,
			),
			undefined,
		)
})

void test('触控/歌词/明暗与动效保留，减少动态将实际图片过渡设为0', () => {
	const value = adapted()
	value.theme.motion.durationMs = 320
	value.mode = 'dark'
	const before = structuredClone(value)
	const rendering = createPackageRendering(value, [allowed], false)
	assert.equal(rendering.buttonMinTouchDp, 96)
	assert.deepEqual(rendering.lyricTokens, value.retained.lyricTokens)
	assert.equal(rendering.mode, 'dark')
	assert.equal(rendering.transitionMs, 320)
	assert.equal(createPackageRendering(value, [allowed], true).transitionMs, 0)
	assert.deepEqual(value, before)
})

void test('宿主传入数组与retained对象后续修改不改变已创建renderer', () => {
	const value = adapted(),
		uris = [allowed]
	value.retained.controlRowLayout = {
		minTouchDp: 96,
		compactMinTouchDp: 72,
		narrowFallback: 'host-single-row',
	}
	const rendering = createPackageRendering(value, uris, false)
	const other = allowed.replace('header.png', 'other.png')
	uris.push(other)
	value.retained.lyricTokens.active = '#ffffff'
	value.retained.controlRowLayout.compactMinTouchDp = 48
	assert.equal(rendering.resolveResource(other), undefined)
	assert.equal(rendering.lyricTokens.active, '#112233')
	assert.ok(rendering.controlRowLayout)
	assert.equal(rendering.controlRowLayout.compactMinTouchDp, 72)
})
