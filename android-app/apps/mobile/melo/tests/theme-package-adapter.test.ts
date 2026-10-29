import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import JSZip from 'jszip'

import { builtInThemes } from '../core/theme'
import { resolveThemeNavigation } from '../core/theme-layout'
import {
	packageCapabilities,
	validateThemePackage,
} from '../core/theme-package'
import {
	adaptPackageTheme,
	type InstalledThemeBindings,
	type PackageThemeAdapterOptions,
} from '../core/theme-package-adapter'
import {
	ThemePackageError,
	type ThemeImageDecoder,
	type VerifiedThemePackage,
} from '../core/theme-package-types'

const root = resolve(__dirname, '../../../../..')
const archive = readFileSync(
	join(root, 'theme-packages/paper-signal.melotheme'),
)
const host = { appVersion: '0.4.0', capabilities: [...packageCapabilities] }
const adapter = createRequire(join(root, 'scripts/theme-package.cjs'))(
	'./lib/theme-package-node.cjs',
) as { createNodeImageDecoder(): ThemeImageDecoder }
const decoder = adapter.createNodeImageDecoder()
const options: PackageThemeAdapterOptions = {
	host,
	mode: 'light',
	privateThemesRootUri: 'file:///data/user/0/org.melocanvas.app/files/themes/',
}
const verified = validateThemePackage(archive, host, decoder)

function bindings(value: VerifiedThemePackage): InstalledThemeBindings {
	const rootUri = `${options.privateThemesRootUri}${value.manifest.id}/${value.snapshot.package.archiveSha256}/`
	return {
		package: { ...value.snapshot.package },
		rootUri,
		resources: value.snapshot.resources.map((resource) => ({
			path: resource.path,
			sha256: resource.sha256,
			uri: `${rootUri}${resource.path}`,
		})),
	}
}
function fails(run: () => unknown, code?: ThemePackageError['code']) {
	assert.throws(run, (error: unknown) => {
		assert.ok(error instanceof ThemePackageError)
		if (code) assert.equal(error.code, code)
		return true
	})
}
async function packageWith(
	change: (
		manifest: Record<string, unknown>,
		components: Record<string, unknown>,
		tokens: Record<string, unknown>,
	) => void,
) {
	const zip = await JSZip.loadAsync(archive)
	const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
	const components = JSON.parse(
		await zip.file('components.json')!.async('string'),
	)
	const tokens = JSON.parse(await zip.file('tokens.json')!.async('string'))
	change(manifest, components, tokens)
	for (const [name, value] of Object.entries({ manifest, components, tokens }))
		zip.file(`${name}.json`, JSON.stringify(value))
	return validateThemePackage(
		await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
		host,
		decoder,
	)
}

void test('真实Verified包保留第三方身份、本地图片和完整语义，不改变内置主题', async () => {
	const value = await verified,
		before = JSON.stringify(builtInThemes),
		snapshotBefore = JSON.stringify(value.snapshot)
	const result = adaptPackageTheme(value, bindings(value), options)
	assert.equal(result.theme.id, 'example.paper-signal')
	assert.equal(result.theme.name, value.manifest.name)
	assert.equal(result.theme.version, value.manifest.version)
	assert.equal(result.theme.components.playerFrame, 'arch')
	assert.equal(
		result.theme.assets.hero,
		`${bindings(value).rootUri}assets/header.png`,
	)
	assert.deepEqual(result.theme.motion, value.snapshot.motion)
	assert.equal(
		result.retained.buttonMinTouchDp,
		value.snapshot.components.button.minTouchDp,
	)
	assert.deepEqual(
		result.retained.lyricTokens,
		value.snapshot.tokens.light.lyric,
	)
	assert.equal(result.retained.controlRowLayout, undefined)
	assert.ok(result.renderingResponsibilities.includes('local-image-uris'))
	result.theme.tokens.surface.base = '#000000'
	result.retained.lyricTokens.active = '#000000'
	result.theme.motion.durationMs = 0
	assert.equal(JSON.stringify(value.snapshot), snapshotBefore)
	assert.equal(JSON.stringify(builtInThemes), before)
	assert.equal(
		adaptPackageTheme(value, bindings(value), options).theme.tokens.surface
			.base,
		value.snapshot.tokens.light.surface.base,
	)
})

void test('真实Verified紧凑策略经adapter重新校验和独立保留，不能修改snapshot或冒充mobile支持', async () => {
	const value = await packageWith((manifest, document) => {
		;(manifest.requiredCapabilities as string[]).push(
			'responsive-touch-layout-v1',
		)
		const components = document.components as Record<string, unknown>
		;(components.button as Record<string, unknown>).minTouchDp = 96
		components.layout = {
			compactMinTouchDp: 72,
			narrowFallback: 'host-single-row',
		}
	})
	const before = structuredClone(value.snapshot)
	const adapted = adaptPackageTheme(value, bindings(value), options)
	assert.deepEqual(adapted.retained.controlRowLayout, {
		minTouchDp: 96,
		compactMinTouchDp: 72,
		narrowFallback: 'host-single-row',
	})
	assert.equal(
		resolveThemeNavigation(adapted.retained.controlRowLayout, {
			availableWidthDp: 340,
			controlMinWidthsDp: [48, 48, 48, 48],
		}).kind,
		'compact',
	)
	adapted.retained.controlRowLayout.compactMinTouchDp = 48
	assert.deepEqual(value.snapshot, before)
	assert.equal(
		adaptPackageTheme(value, bindings(value), options).retained
			.controlRowLayout!.compactMinTouchDp,
		72,
	)
	fails(
		() =>
			adaptPackageTheme(value, bindings(value), {
				...options,
				host: {
					...host,
					capabilities: host.capabilities.filter(
						(capability) => capability !== 'responsive-touch-layout-v1',
					),
				},
			}),
		'INCOMPATIBLE',
	)
})

void test('square显式映射stacked，arch/tilted按值适配', async () => {
	for (const frame of ['square', 'arch', 'tilted']) {
		const value = await packageWith((manifest, components) => {
			manifest.version = '0.1.0+author.1'
			;(
				(components.components as Record<string, unknown>).player as Record<
					string,
					unknown
				>
			).frame = frame
			const button = (components.components as Record<string, unknown>)
				.button as Record<string, unknown>
			button.minTouchDp = 72
			const motion = components.motion as Record<string, unknown>
			motion.durationMs = 321
		})
		const result = adaptPackageTheme(value, bindings(value), options)
		assert.equal(result.theme.version, '0.1.0+author.1')
		assert.ok(!bindings(value).rootUri.includes('0.1.0'))
		assert.equal(result.retained.buttonMinTouchDp, 72)
		assert.deepEqual(result.theme.motion, {
			durationMs: 321,
			respectReducedMotion: true,
		})
		assert.equal(
			adaptPackageTheme(value, bindings(value), options).theme.components
				.playerFrame,
			frame === 'square' ? 'stacked' : frame,
		)
	}
})

void test('已验证快照的合法内置hero回退保持包身份且仍校验所有资源绑定', async () => {
	const value = await packageWith((_manifest, components) => {
		components.decorations = {}
	})
	const result = adaptPackageTheme(value, bindings(value), options)
	assert.equal(result.theme.assets.hero, builtInThemes.modern.assets.hero)
	assert.equal(result.theme.id, value.manifest.id)
	const binding = bindings(value)
	binding.resources = binding.resources.slice(1)
	fails(() => adaptPackageTheme(value, binding, options), 'RESOURCE_INVALID')
})

void test('所有实际资源包括预览必须完整绑定，拒绝缺失/重复/多余/错哈希', async () => {
	const value = await verified
	for (const alter of [
		(binding: InstalledThemeBindings) => {
			binding.resources = binding.resources.slice(0, -1)
		},
		(binding: InstalledThemeBindings) => {
			binding.resources = [
				binding.resources[0],
				binding.resources[0],
				binding.resources[2],
			]
		},
		(binding: InstalledThemeBindings) => {
			binding.resources = [
				...binding.resources,
				{
					path: 'assets/extra.png',
					sha256: '0'.repeat(64),
					uri: `${binding.rootUri}assets/extra.png`,
				},
			]
		},
		(binding: InstalledThemeBindings) => {
			binding.resources = binding.resources.map((resource, i) =>
				i ? resource : { ...resource, sha256: '0'.repeat(64) },
			)
		},
	]) {
		const binding = bindings(value)
		alter(binding)
		fails(() => adaptPackageTheme(value, binding, options), 'RESOURCE_INVALID')
	}
})

void test('只接受宿主私有根内对应不可变版本目录，错误身份/根/版本拒绝', async () => {
	const value = await verified
	for (const alter of [
		(binding: InstalledThemeBindings) => {
			binding.package.id = 'other.theme'
		},
		(binding: InstalledThemeBindings) => {
			binding.package.version = '9.0.0'
		},
		(binding: InstalledThemeBindings) => {
			binding.package.archiveSha256 = '0'.repeat(64)
		},
		(binding: InstalledThemeBindings) => {
			binding.rootUri = binding.rootUri.replace('/files/', '/cache/')
		},
		(binding: InstalledThemeBindings) => {
			binding.rootUri = options.privateThemesRootUri
		},
	]) {
		const binding = bindings(value)
		alter(binding)
		fails(() => adaptPackageTheme(value, binding, options), 'RESOURCE_INVALID')
	}
	for (const privateThemesRootUri of [
		'file://host/themes/',
		'file:///data/user/0/../themes/',
		'content://themes/',
		'file:///data/user/0/%74hemes/',
		'file:///data/themes/?x=1/',
		'file:///data/themes/#bad/',
	])
		fails(() =>
			adaptPackageTheme(value, bindings(value), {
				...options,
				privateThemesRootUri,
			}),
		)
})

void test('外部file/content/http或百分号/错路径/穿越URI不能冒充对应资源', async () => {
	const value = await verified
	for (const uri of [
		'file:///sdcard/header.png',
		'content://app/header.png',
		'https://example.com/header.png',
		`${bindings(value).rootUri}assets/other.png`,
		`${bindings(value).rootUri}assets/%68eader.png`,
		`${bindings(value).rootUri}assets/../header.png`,
		`${bindings(value).rootUri}assets/header.png?x=1`,
		`${bindings(value).rootUri}assets/header.png#x`,
	]) {
		const binding = bindings(value)
		binding.resources = binding.resources.map((resource, i) =>
			i ? resource : { ...resource, uri },
		)
		fails(() => adaptPackageTheme(value, binding, options), 'RESOURCE_INVALID')
	}
})

void test('快照及绑定的坏路径/直接URI/未索引装饰都失败而不返回ResolvedTheme', async () => {
	const original = await verified
	for (const path of [
		'../header.png',
		'/header.png',
		'assets\\header.png',
		'file:///data/header.png',
		'assets/%68eader.png',
	]) {
		const value = structuredClone(original)
		value.snapshot.resources[0].path = path
		fails(() => adaptPackageTheme(value, bindings(original), options))
		const binding = bindings(original)
		binding.resources = binding.resources.map((resource, i) =>
			i ? resource : { ...resource, path },
		)
		fails(() => adaptPackageTheme(original, binding, options))
	}
	const value = structuredClone(original)
	value.snapshot.assets.hero = {
		kind: 'package',
		path: 'assets/missing.png',
		sha256: '0'.repeat(64),
		mime: 'image/png',
	}
	fails(
		() => adaptPackageTheme(value, bindings(original), options),
		'MANIFEST_INVALID',
	)
})

void test('宿主能力需重新核对；只有可选背景按内置fallback降级且保留包身份', async () => {
	const value = await packageWith((manifest) => {
		manifest.requiredCapabilities = (
			manifest.requiredCapabilities as string[]
		).filter((capability) => capability !== 'backgrounds')
		;(manifest.optionalCapabilities as string[]).push('backgrounds')
	})
	fails(
		() =>
			adaptPackageTheme(value, bindings(value), {
				...options,
				host: { ...host, capabilities: [] },
			}),
		'INCOMPATIBLE',
	)
	const result = adaptPackageTheme(value, bindings(value), {
		...options,
		host: {
			...host,
			capabilities: host.capabilities.filter(
				(capability) => capability !== 'backgrounds',
			),
		},
	})
	assert.equal(result.theme.assets.hero, builtInThemes.modern.assets.hero)
	assert.equal(result.theme.id, value.manifest.id)
	assert.ok(result.theme.warnings.some((warning) => warning.includes('hero')))
})

void test('暗色选择必须有真实宿主能力及已验证dark组，不静默改选light', async () => {
	const value = await verified
	fails(
		() =>
			adaptPackageTheme(value, bindings(value), { ...options, mode: 'dark' }),
		'INCOMPATIBLE',
	)
	const darkValue = await packageWith((manifest, _components, tokens) => {
		;(manifest.optionalCapabilities as string[]).push('dark-tokens')
		tokens.dark = structuredClone(tokens.light)
		const dark = tokens.dark as Record<string, unknown>
		const surface = dark.surface as Record<string, unknown>
		surface.base = '#111111'
	})
	assert.equal(
		adaptPackageTheme(darkValue, bindings(darkValue), {
			...options,
			mode: 'dark',
		}).theme.tokens.surface.base,
		'#111111',
	)
	assert.notEqual(
		adaptPackageTheme(darkValue, bindings(darkValue), options).theme.tokens
			.surface.base,
		'#111111',
	)
	fails(
		() =>
			adaptPackageTheme(darkValue, bindings(darkValue), {
				...options,
				mode: 'dark',
				host: {
					...host,
					capabilities: host.capabilities.filter(
						(capability) => capability !== 'dark-tokens',
					),
				},
			}),
		'INCOMPATIBLE',
	)
})

void test('合法ZIP也不能使用builtin命名空间冒充三默认主题', async () => {
	const value = await packageWith((manifest) => {
		manifest.id = 'melocanvas.builtin.modern'
	})
	fails(
		() => adaptPackageTheme(value, bindings(value), options),
		'INCOMPATIBLE',
	)
})
