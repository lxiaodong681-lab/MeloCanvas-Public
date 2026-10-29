import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'

import JSZip from 'jszip'
import ts from 'typescript'

import { builtInThemes } from '../core/theme'
import { crc32 } from '../core/theme-archive'
import {
	inspectThemePng,
	packageCapabilities,
	validateThemePackage,
} from '../core/theme-package'
import {
	adaptPackageTheme,
	type InstalledThemeBindings,
} from '../core/theme-package-adapter'
import {
	packageThemeIconNames,
	ThemePackageError,
	themePackageLimits,
	type ThemeImageDecoder,
	type ThemePackageHost,
	type ThemePackageManifest,
	type VerifiedThemePackage,
} from '../core/theme-package-types'

const root = resolve(__dirname, '../../../../..')
const base = readFileSync(
	resolve(root, 'theme-packages/paper-signal.melotheme'),
)
const host: ThemePackageHost = {
	appVersion: '0.4.0',
	capabilities: [...packageCapabilities],
}
const oldHost: ThemePackageHost = {
	...host,
	capabilities: host.capabilities.filter((name) => name !== 'package-icons-v1'),
}
const decoder = (
	createRequire(resolve(root, 'scripts/theme-package.cjs'))(
		'./lib/theme-package-node.cjs',
	) as { createNodeImageDecoder(): ThemeImageDecoder }
).createNodeImageDecoder()
const names = ['normal', 'selected', 'dark-normal', 'dark-selected'] as const
const path = (name: string) => `assets/icon-${name}.png`
const options = {
	host,
	mode: 'light' as const,
	privateThemesRootUri: 'file:///private/themes/',
}
type Document = {
	components: Record<string, unknown>
	decorations: Record<string, unknown>
	motion: Record<string, unknown>
}
const mapping = () => ({
	play: {
		light: { normal: path('normal'), selected: path('selected') },
		dark: { normal: path('dark-normal'), selected: path('dark-selected') },
	},
	pause: { light: { normal: path('normal') } },
})
const digest = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex')
async function pack(
	change?: (
		manifest: ThemePackageManifest,
		document: Document,
		zip: JSZip,
	) => Promise<void> | void,
) {
	const zip = await JSZip.loadAsync(base)
	const manifest: ThemePackageManifest = JSON.parse(
		await zip.file('manifest.json')!.async('string'),
	)
	const document: Document = JSON.parse(
		await zip.file('components.json')!.async('string'),
	)
	const tokens = JSON.parse(await zip.file('tokens.json')!.async('string'))
	manifest.requiredCapabilities.push('package-icons-v1', 'dark-tokens')
	tokens.dark = structuredClone(tokens.light)
	document.components.icons = mapping()
	const png = await zip.file('assets/header.png')!.async('uint8array')
	for (const name of names) {
		zip.file(path(name), png, { createFolders: false })
		manifest.assets.push({
			path: path(name),
			mime: 'image/png',
			bytes: png.length,
			sha256: digest(png),
		})
	}
	await change?.(manifest, document, zip)
	zip.file('manifest.json', JSON.stringify(manifest))
	zip.file('components.json', JSON.stringify(document))
	zip.file('tokens.json', JSON.stringify(tokens))
	return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
function bindings(value: VerifiedThemePackage): InstalledThemeBindings {
	const rootUri = `${options.privateThemesRootUri}${value.manifest.id}/${value.snapshot.package.archiveSha256}/`
	return {
		package: { ...value.snapshot.package },
		rootUri,
		resources: value.snapshot.resources.map((resource) => ({
			path: resource.path,
			sha256: resource.sha256,
			uri: rootUri + resource.path,
		})),
	}
}
const code = (expected?: ThemePackageError['code']) => (error: unknown) => {
	assert.ok(error instanceof ThemePackageError)
	if (expected) assert.equal(error.code, expected)
	return true
}
async function rejected(
	bytes: Uint8Array,
	expected?: ThemePackageError['code'],
	actualHost = host,
) {
	let output: unknown
	await assert.rejects(
		validateThemePackage(bytes, actualHost, decoder).then((value) => {
			output = value
		}),
		code(expected),
	)
	assert.equal(
		output,
		undefined,
		'invalid icons cannot produce a Verified package',
	)
}

void test('icon contract exposes exactly the existing 20 host semantic keys; explicit legacy host lacks the new capability', () => {
	const file = ts.createSourceFile(
		'ui.tsx',
		readFileSync(new URL('../ui.tsx', import.meta.url), 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	let keys: string[] = []
	function visit(node: ts.Node) {
		if (
			ts.isVariableDeclaration(node) &&
			node.name.getText(file) === 'shapes' &&
			node.initializer &&
			ts.isObjectLiteralExpression(node.initializer)
		)
			keys = node.initializer.properties.map((prop) => prop.name!.getText(file))
		ts.forEachChild(node, visit)
	}
	visit(file)
	assert.equal(keys.length, 20)
	assert.deepEqual([...packageThemeIconNames].sort(), keys.sort())
	assert.equal(Object.isFrozen(packageThemeIconNames), true)
	const reference = JSON.parse(
		readFileSync(resolve(root, 'theme-packages/reference-host.json'), 'utf8'),
	)
	assert.ok(reference.capabilities.includes('package-icons-v1'))
	assert.equal(oldHost.capabilities.includes('package-icons-v1'), false)
	assert.equal(host.capabilities.includes('package-icons-v1'), true)
})

void test('real ZIP/hash/full PNG decoder carries all light/dark states and bound identity without changing selected or dark fallback semantics', async () => {
	let decoded = 0
	const actual: ThemeImageDecoder = {
		decodeImage: (...args) => {
			decoded++
			return decoder.decodeImage(...args)
		},
	}
	const value = await validateThemePackage(await pack(), host, actual)
	assert.equal(decoded, new Set(value.manifest.assets.map((asset) => asset.sha256)).size)
	assert.ok(value.files.filter((file) => file.path.endsWith('.png')).every((file) => file.image))
	assert.deepEqual(value.snapshot.components.icons, mapping())
	const result = adaptPackageTheme(value, bindings(value), options)
	const icons = result.retained.iconResources!
	for (const [state, name] of [
		[icons.play!.light.normal, 'normal'],
		[icons.play!.light.selected!, 'selected'],
		[icons.play!.dark!.normal, 'dark-normal'],
		[icons.play!.dark!.selected!, 'dark-selected'],
	] as const) {
		assert.equal(state.kind, 'package')
		assert.equal(state.path, path(name))
		assert.equal(state.uri, bindings(value).rootUri + path(name))
		assert.equal(
			state.sha256,
			value.manifest.assets.find((asset) => asset.path === path(name))!.sha256,
		)
		assert.equal(state.mime, 'image/png')
	}
	assert.equal(
		icons.pause!.light.selected,
		undefined,
		'absent selected preserves normal fallback for future renderer',
	)
	assert.equal(
		icons.pause!.dark,
		undefined,
		'missing dark is not silently filled with light artwork',
	)
	assert.ok(
		result.theme.warnings.some(
			(warning) => warning.includes('pause') && warning.includes('矢量'),
		),
	)
	const dark = adaptPackageTheme(value, bindings(value), {
		...options,
		mode: 'dark',
	})
	assert.deepEqual(dark.retained.iconResources, icons)
})

void test('icons including an empty object require required package-icons-v1; optional-only or old host cannot bypass', async () => {
	for (const icons of [{}, mapping()]) {
		for (const optional of [false, true]) {
			await rejected(
				await pack((manifest, document) => {
					document.components.icons = icons
					manifest.requiredCapabilities = manifest.requiredCapabilities.filter(
						(name) => name !== 'package-icons-v1',
					)
					if (optional) manifest.optionalCapabilities.push('package-icons-v1')
				}),
				'MANIFEST_INVALID',
			)
		}
		const bytes = await pack((_manifest, document) => {
			document.components.icons = icons
		})
		await rejected(bytes, 'INCOMPATIBLE', oldHost)
		assert.deepEqual(
			(await validateThemePackage(bytes, host, decoder)).snapshot.components
				.icons,
			icons,
		)
	}
})

void test('unknown icon semantics and every malformed nested icon/state field fail closed instead of becoming resource or action extensions', async () => {
	for (const icons of [
		null,
		[],
		'assets/icon-normal.png',
		{ unknown: { light: { normal: path('normal') } } },
		{ play: null },
		{ play: [] },
		{ play: {} },
		{ play: { normal: path('normal') } },
		{ play: { light: null } },
		{ play: { light: [] } },
		{ play: { light: {} } },
		{ play: { light: { selected: path('selected') } } },
		{
			play: { light: { normal: path('normal'), uri: 'file:///private/x.png' } },
		},
		{ play: { light: { normal: path('normal'), selected: null } } },
		{ play: { light: { normal: path('normal') }, dark: {} } },
		{
			play: {
				light: { normal: path('normal') },
				dark: { normal: path('normal'), hover: path('selected') },
			},
		},
		{ play: { light: { normal: path('normal') }, onPress: 'play' } },
	])
		await rejected(
			await pack((_manifest, document) => {
				document.components.icons = icons
			}),
			'MANIFEST_INVALID',
		)
})

void test('icon states accept only exact indexed assets PNG paths; URI/traversal/alias/previews/unsupported format cannot enter bindings', async () => {
	for (const invalid of [
		'https://example.invalid/icon.png',
		'file:///private/icon.png',
		'content://provider/icon.png',
		'../icon.png',
		'/assets/icon.png',
		'C:/assets/icon.png',
		'assets\\icon.png',
		'assets/../icon.png',
		'assets/./icon.png',
		'assets/%69con.png',
		' assets/icon-normal.png',
		'assets/icon-normal.png\n',
		'assets/missing.png',
		'assets/ICON-normal.png',
		'previews/default.png',
		'assets/icon.svg',
		'assets/icon.jpg',
	]) {
		for (const state of ['normal', 'selected'] as const)
			await rejected(
				await pack((_manifest, document) => {
					document.components.icons = {
						play: { light: { normal: path('normal'), [state]: invalid } },
					}
				}),
			)
	}
})

function chunk(type: string, data: Uint8Array) {
	const result = new Uint8Array(data.length + 12),
		view = new DataView(result.buffer)
	view.setUint32(0, data.length)
	result.set(new TextEncoder().encode(type), 4)
	result.set(data, 8)
	view.setUint32(
		result.length - 4,
		crc32(result.subarray(4, result.length - 4)),
	)
	return result
}
void test('mapped icons retain exact bytes/hash and actual full pixel decode checks, not just a valid PNG header or CRC', async () => {
	for (const field of ['sha256', 'bytes'] as const)
		await rejected(
			await pack((manifest) => {
				const icon = manifest.assets.find(
					(asset) => asset.path === path('normal'),
				)!
				if (field === 'sha256') icon.sha256 = '0'.repeat(64)
				else icon.bytes++
			}),
			'RESOURCE_INVALID',
		)
	const zip = await JSZip.loadAsync(base),
		png = await zip.file('assets/header.png')!.async('uint8array')
	const idat = chunk('IDAT', new Uint8Array([0, 0, 0, 0])),
		end = chunk('IEND', new Uint8Array())
	const broken = new Uint8Array(33 + idat.length + end.length)
	broken.set(png.subarray(0, 33))
	broken.set(idat, 33)
	broken.set(end, 33 + idat.length)
	assert.doesNotThrow(() => inspectThemePng(broken, { ...themePackageLimits }))
	const bytes = await pack((manifest, _document, iconZip) => {
		iconZip.file(path('normal'), broken, { createFolders: false })
		Object.assign(
			manifest.assets.find((asset) => asset.path === path('normal'))!,
			{ bytes: broken.length, sha256: digest(broken) },
		)
	})
	let reachedPixels = false
	const actual: ThemeImageDecoder = {
		decodeImage: (...args) => {
			if (digest(args[0]) === digest(broken)) reachedPixels = true
			return decoder.decodeImage(...args)
		},
	}
	await assert.rejects(
		validateThemePackage(bytes, host, actual),
		code('IMAGE_INVALID'),
	)
	assert.equal(
		reachedPixels,
		true,
		'broken indexed icon passes chunk preflight but fails real PNG decode',
	)
})

void test('adapter revalidates icon capability, nested document paths and every immutable binding before returning any URI', async () => {
	const value = await validateThemePackage(await pack(), host, decoder)
	assert.throws(
		() =>
			adaptPackageTheme(value, bindings(value), { ...options, host: oldHost }),
		code('INCOMPATIBLE'),
	)
	for (const mutate of [
		(v: VerifiedThemePackage) => {
			v.snapshot.components.icons!.play!.light.normal = 'assets/unindexed.png'
		},
		(v: VerifiedThemePackage) => {
			v.snapshot.components.icons!.play!.light.normal =
				'https://example.invalid/icon.png'
		},
		(v: VerifiedThemePackage) => {
			v.snapshot.resources.find(
				(resource) => resource.path === path('normal'),
			)!.sha256 = '0'.repeat(64)
		},
	]) {
		const changed = structuredClone(value)
		mutate(changed)
		assert.throws(
			() => adaptPackageTheme(changed, bindings(changed), options),
			code(),
		)
	}
	for (const mutate of [
		(b: InstalledThemeBindings) => {
			b.resources.find((resource) => resource.path === path('normal'))!.uri =
				bindings(value).rootUri + path('selected')
		},
		(b: InstalledThemeBindings) => {
			b.resources.find((resource) => resource.path === path('normal'))!.sha256 =
				'0'.repeat(64)
		},
		(b: InstalledThemeBindings) => {
			b.rootUri = 'file:///private/other/'
		},
		(b: InstalledThemeBindings) => {
			b.resources = b.resources.filter(
				(resource) => resource.path !== path('normal'),
			)
		},
	]) {
		const changed = structuredClone(bindings(value))
		mutate(changed)
		assert.throws(
			() => adaptPackageTheme(value, changed, options),
			code('RESOURCE_INVALID'),
		)
	}
})

void test('bound states are independent deep copies; old package absence and three builtin themes remain unchanged', async () => {
	const builtinBefore = JSON.stringify(builtInThemes)
	const value = await validateThemePackage(await pack(), host, decoder),
		binding = bindings(value)
	const before = JSON.stringify({ value, binding })
	const first = adaptPackageTheme(value, binding, options)
	first.retained.iconResources!.play!.light.normal.uri = 'file:///changed.png'
	first.retained.iconResources!.play!.dark!.selected!.sha256 = '0'.repeat(64)
	first.retained.iconResources!.pause!.light.normal.path = 'assets/changed.png'
	assert.equal(JSON.stringify({ value, binding }), before)
	const second = adaptPackageTheme(value, binding, options)
	assert.equal(
		second.retained.iconResources!.play!.light.normal.uri,
		binding.rootUri + path('normal'),
	)
	assert.equal(
		second.retained.iconResources!.pause!.light.normal.path,
		path('normal'),
	)
	assert.notEqual(
		second.retained.iconResources!.play!.light.normal,
		second.retained.iconResources!.pause!.light.normal,
	)
	const old = await validateThemePackage(base, oldHost, decoder)
	assert.equal(Object.hasOwn(old.snapshot.components, 'icons'), false)
	assert.equal(
		Object.hasOwn(
			adaptPackageTheme(old, bindings(old), { ...options, host: oldHost })
				.retained,
			'iconResources',
		),
		false,
	)
	assert.equal(JSON.stringify(builtInThemes), builtinBefore)
})
