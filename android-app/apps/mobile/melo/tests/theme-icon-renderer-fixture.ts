import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import JSZip from 'jszip'

import {
	packageCapabilities,
	validateThemePackage,
} from '../core/theme-package'
import {
	adaptPackageTheme,
	type AdaptedPackageTheme,
} from '../core/theme-package-adapter'
import type { ThemeImageDecoder } from '../core/theme-package-types'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const root = resolve(__dirname, '../../../../..')
const host = { appVersion: '0.4.0', capabilities: [...packageCapabilities] }
const decoder = (
	createRequire(resolve(root, 'scripts/theme-package.cjs'))(
		'./lib/theme-package-node.cjs',
	) as {
		createNodeImageDecoder(): ThemeImageDecoder
	}
).createNodeImageDecoder()

/** Real ZIP/index/hash/pixel validation; source PNG is the original example art, not a UI screenshot. */
export async function iconPackage() {
	const zip = await JSZip.loadAsync(
		readFileSync(resolve(root, 'theme-packages/paper-signal.melotheme')),
	)
	const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
	const document = JSON.parse(
		await zip.file('components.json')!.async('string'),
	)
	const tokens = JSON.parse(await zip.file('tokens.json')!.async('string'))
	manifest.requiredCapabilities.push('package-icons-v1', 'dark-tokens')
	tokens.dark = structuredClone(tokens.light)
	document.components.navigation.discoverIcon = 'home'
	const png = await zip.file('assets/header.png')!.async('uint8array')
	const paths = ['normal', 'selected', 'dark-normal', 'dark-selected'].map(
		(state) => `assets/icon-${state}.png`,
	)
	for (const path of paths) {
		zip.file(path, png, { createFolders: false })
		manifest.assets.push({
			path,
			mime: 'image/png',
			bytes: png.length,
			sha256: createHash('sha256').update(png).digest('hex'),
		})
	}
	document.components.icons = {
		play: {
			light: { normal: paths[0], selected: paths[1] },
			dark: { normal: paths[2], selected: paths[3] },
		},
		heart: { light: { normal: paths[0] } },
		home: { light: { normal: paths[0], selected: paths[1] } },
	}
	zip.file('manifest.json', JSON.stringify(manifest))
	zip.file('components.json', JSON.stringify(document))
	zip.file('tokens.json', JSON.stringify(tokens))
	const verified = await validateThemePackage(
		await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
		host,
		decoder,
	)
	const privateThemesRootUri = 'file:///private/themes/'
	const rootUri = `${privateThemesRootUri}${verified.manifest.id}/${verified.snapshot.package.archiveSha256}/`
	const resources = verified.snapshot.resources.map((resource) => ({
		path: resource.path,
		sha256: resource.sha256,
		uri: rootUri + resource.path,
	}))
	const binding = { package: verified.snapshot.package, rootUri, resources }
	return {
		light: adaptPackageTheme(verified, binding, {
			host,
			privateThemesRootUri,
			mode: 'light',
		}),
		dark: adaptPackageTheme(verified, binding, {
			host,
			privateThemesRootUri,
			mode: 'dark',
		}),
		allowed: resources.map((resource) => resource.uri),
	}
}
const component = (value: unknown) => value as ControlNode['type']
/** Actual ui/host TSX, with the existing deterministic React/native ports. */
export function iconHost(originals: Record<string, string> = {}) {
	const f = controlFixture(originals),
		ui = f.load('ui'),
		controls = f.load('host-controls')
	return {
		...f,
		icon: (props: Record<string, unknown>) =>
			f.element(component(ui.Icon), props),
		button: (props: Record<string, unknown>) =>
			f.element(component(ui.IconButton), props),
		navigation: (props: Record<string, unknown>) =>
			f.element(component(controls.MainNavigation), props),
		builtin: (child: unknown, theme: unknown) =>
			f.element(component(ui.ThemeProvider), { value: theme }, child),
		pack: (
			child: unknown,
			adapted: AdaptedPackageTheme,
			allowedImageUris: readonly string[],
		) =>
			f.element(
				component(ui.PackageThemeProvider),
				{ adapted, allowedImageUris, reducedMotion: true },
				child,
			),
	}
}
export function only(tree: unknown, type: string) {
	const found = controlNodes(tree).filter((node) => node.type === type)
	if (found.length !== 1)
		throw new Error(`Expected one ${type}, got ${found.length}`)
	return found[0]
}
export function normalized(
	f: ReturnType<typeof iconHost>,
	value: unknown,
): unknown {
	if (Array.isArray(value))
		return Array.from(value, (child) => normalized(f, child))
	if (typeof value === 'function') return '<callback>'
	if (!value || typeof value !== 'object') return value
	if ('type' in value) {
		const node = value as ControlNode
		return {
			type: node.type,
			props: normalized(
				f,
				Object.fromEntries(
					Object.entries(node.props)
						.filter(([key, v]) => key !== 'children' && v !== undefined)
						.map(([key, v]) => [
							key,
							key === 'style'
								? f.flatten(typeof v === 'function' ? v({ pressed: false }) : v)
								: v,
						]),
				),
			),
			children: normalized(f, node.children),
		}
	}
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.map(([key, v]) => [key, normalized(f, v)]),
	)
}
