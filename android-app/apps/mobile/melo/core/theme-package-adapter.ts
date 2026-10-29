import { type ResolvedTheme, builtInThemes } from './theme'
import { safePackagePath } from './theme-archive'
import type { ThemeControlRowPolicy } from './theme-layout'
import { parseThemeDocuments } from './theme-package'
import {
	ThemePackageError,
	type PackageResourceReference,
	type PackageThemeIconName,
	type PackageThemeTokens,
	type ThemePackageHost,
	type VerifiedThemePackage,
} from './theme-package-types'

/** Trusted installer output. Never populate this object from package metadata. */
export interface InstalledThemeBindings {
	package: { id: string; version: string; archiveSha256: string }
	/** Immutable version root, below the independently supplied host private root. */
	rootUri: string
	resources: readonly { path: string; sha256: string; uri: string }[]
}

export interface PackageThemeAdapterOptions {
	mode: 'light' | 'dark'
	host: ThemePackageHost
	/** Host-owned app-private themes directory, including a trailing slash. */
	privateThemesRootUri: string
}

export interface BoundPackageIconResource extends PackageResourceReference {
	uri: string
}
export interface BoundPackageIconStates {
	normal: BoundPackageIconResource
	selected?: BoundPackageIconResource
}
export type PackageThemeIconResources = Partial<
	Record<
		PackageThemeIconName,
		{
			light: BoundPackageIconStates
			dark?: BoundPackageIconStates
		}
	>
>

export interface AdaptedPackageTheme {
	theme: ResolvedTheme
	mode: 'light' | 'dark'
	/** ResolvedTheme cannot carry these semantics; the renderer must consume them. */
	retained: {
		buttonMinTouchDp: number
		controlRowLayout?: ThemeControlRowPolicy
		lyricTokens: PackageThemeTokens['lyric']
		progress?: { colors?: PackageThemeTokens['progress']; thumb?: BoundPackageIconResource; sizeDp?: number; dragLeft?: BoundPackageIconResource; dragRight?: BoundPackageIconResource }
		surfaceArt?: { banner?: string; navigation?: string; pageHeader?: string; profileBackground?: string; avatarFrame?: string; navigationColors?: PackageThemeTokens['navigation'] }
		/** Data only; a future renderer must preserve selected semantics and dark fallback. */
		iconResources?: PackageThemeIconResources
	}
	/** Data adaptation does not establish that a renderer implements these. */
	renderingResponsibilities: readonly [
		'local-image-uris',
		'button-min-touch-dp',
		'lyric-tokens',
		'motion-duration-and-reduced-motion',
		'explicit-color-mode',
	]
}

function invalid(message: string): never {
	throw new ThemePackageError('RESOURCE_INVALID', message)
}

function fileRoot(uri: string): void {
	if (
		typeof uri !== 'string' ||
		!uri.startsWith('file:///') ||
		!uri.endsWith('/') ||
		uri !== uri.normalize('NFC')
	)
		invalid('安装根必须为宿主提供的规范私有 file URI')
	// Reject encoded aliases rather than decode them into a second path spelling.
	const parts = uri.slice('file:///'.length, -1).split('/')
	if (
		parts.some(
			(part) =>
				!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(part) || /[. ]$/.test(part),
		)
	)
		invalid('安装根含非规范路径段或 URI 别名')
}

/** Pure bridge only: does not inspect disk, install, activate, or render a theme. */
export function adaptPackageTheme(
	verified: VerifiedThemePackage,
	binding: InstalledThemeBindings,
	options: PackageThemeAdapterOptions,
): AdaptedPackageTheme {
	const { manifest, snapshot } = verified
	if (manifest.id.startsWith('melocanvas.builtin.'))
		throw new ThemePackageError(
			'INCOMPATIBLE',
			'第三方主题不能占用内置主题命名空间',
		)
	if (options.mode !== 'light' && options.mode !== 'dark')
		throw new ThemePackageError('INCOMPATIBLE', '主题明暗模式必须显式选择')
	if (
		snapshot.schemaVersion !== 1 ||
		snapshot.package.id !== manifest.id ||
		snapshot.package.version !== manifest.version ||
		!/^[0-9a-f]{64}$/.test(snapshot.package.archiveSha256) ||
		binding.package.id !== manifest.id ||
		binding.package.version !== manifest.version ||
		binding.package.archiveSha256 !== snapshot.package.archiveSha256
	)
		invalid('安装绑定与已验证主题身份不一致')

	// Revalidate semantics against this renderer's actual capabilities, not the
	// author reference profile used when the ZIP was first verified.
	const hero = snapshot.assets.hero
	if (
		hero.kind !== 'package' &&
		(hero.kind !== 'builtin' || hero.theme !== 'modern' || hero.role !== 'hero')
	)
		invalid('主题回退资源不受支持')
	const parsed = parseThemeDocuments(
		{
			manifest,
			tokens: snapshot.tokens,
			components: {
				components: snapshot.components,
				decorations: {
					...(snapshot.assets.banner ? { banner: snapshot.assets.banner.path } : {}),
					...(snapshot.assets.pageHeader ? { pageHeader: snapshot.assets.pageHeader.path } : {}),
					...(snapshot.assets.profileBackground ? { profileBackground: snapshot.assets.profileBackground.path } : {}),
					...(snapshot.assets.avatarFrame ? { avatarFrame: snapshot.assets.avatarFrame.path } : {}),
					...(snapshot.assets.navigation ? { navigation: snapshot.assets.navigation.path } : {}),
					...(hero.kind === 'package' ? { hero: hero.path } : {}),
					...(snapshot.assets.backdrop
						? { backdrop: snapshot.assets.backdrop.path }
						: {}),
				},
				motion: snapshot.motion,
			},
		},
		options.host,
	)
	if (
		options.mode === 'dark' &&
		(!options.host.capabilities.includes('dark-tokens') || !parsed.tokens.dark)
	)
		throw new ThemePackageError(
			'INCOMPATIBLE',
			'宿主与主题必须均提供明确的深色 token 支持',
		)

	fileRoot(options.privateThemesRootUri)
	fileRoot(binding.rootUri)
	// The archive digest binds the manifest version too; this immutable directory
	// avoids encoding SemVer build metadata into platform-dependent path aliases.
	const expectedRoot = `${options.privateThemesRootUri}${manifest.id}/${snapshot.package.archiveSha256}/`
	if (binding.rootUri !== expectedRoot)
		invalid('主题资源不在对应的私有不可变版本目录')
	const declarations = new Map(
		manifest.assets.map((asset) => [asset.path, asset]),
	)
	if (
		snapshot.resources.length !== declarations.size ||
		binding.resources.length !== declarations.size
	)
		invalid('主题资源绑定不完整')
	const references = new Map<string, PackageResourceReference>()
	for (const reference of snapshot.resources) {
		safePackagePath(reference.path)
		const declared = declarations.get(reference.path)
		if (
			reference.kind !== 'package' ||
			!declared ||
			declared.sha256 !== reference.sha256 ||
			reference.mime !== declared.mime ||
			references.has(reference.path)
		)
			invalid('主题快照资源与已验证索引不一致')
		references.set(reference.path, reference)
	}
	const uris = new Map<string, string>()
	for (const resource of binding.resources) {
		safePackagePath(resource.path)
		const reference = references.get(resource.path)
		if (
			!reference ||
			uris.has(resource.path) ||
			resource.sha256 !== reference.sha256 ||
			resource.uri !== `${expectedRoot}${resource.path}`
		)
			invalid('主题资源 URI、路径或哈希绑定不一致')
		uris.set(resource.path, resource.uri)
	}
	const resourceUri = (reference: PackageResourceReference): string => {
		const indexed = references.get(reference.path)
		const uri = uris.get(reference.path)
		if (
			!indexed ||
			!uri ||
			indexed.sha256 !== reference.sha256 ||
			indexed.mime !== reference.mime
		)
			invalid('主题装饰缺少对应的安装资源')
		return uri
	}
	const selected =
		options.mode === 'dark' ? parsed.tokens.dark! : parsed.tokens.light
	const { lyric, progress, navigation, ...colors } = selected
	const bindIcon = (path: string): BoundPackageIconResource => {
		const reference = references.get(path)
		if (!reference) invalid('主题图标缺少对应的安装资源')
		return { ...reference, uri: resourceUri(reference) }
	}
	const bindIconStates = (states: {
		normal: string
		selected?: string
	}): BoundPackageIconStates => ({
		normal: bindIcon(states.normal),
		...(states.selected !== undefined
			? { selected: bindIcon(states.selected) }
			: {}),
	})
	const iconResources: PackageThemeIconResources | undefined = parsed.components
		.icons
		? Object.fromEntries(
				Object.entries(parsed.components.icons).map(([name, icon]) => [
					name,
					{
						light: bindIconStates(icon.light),
						...(icon.dark ? { dark: bindIconStates(icon.dark) } : {}),
					},
				]),
			)
		: undefined
	const thumb = parsed.components.progress.thumb
	const thumbPath = options.mode === 'dark' ? thumb?.dark : thumb?.light
	return {
		theme: {
			schemaVersion: 1,
			id: manifest.id,
			name: manifest.name,
			version: manifest.version,
			tokens: colors,
			components: {
				card: parsed.components.card.variant,
				button: parsed.components.button.variant,
				input: parsed.components.input.variant,
				discoverIcon: parsed.components.navigation.discoverIcon,
				playerFrame:
					parsed.components.player.frame === 'square'
						? 'stacked'
						: parsed.components.player.frame,
				progress: parsed.components.progress.variant,
			},
			assets: {
				hero:
					parsed.decorations.hero && hero.kind === 'package'
						? resourceUri(hero)
						: builtInThemes.modern.assets.hero,
				backdrop: parsed.decorations.backdrop
					? resourceUri(snapshot.assets.backdrop!)
					: null,
			},
			motion: { ...parsed.motion },
			warnings: [...new Set([...snapshot.warnings, ...parsed.warnings])],
		},
		mode: options.mode,
		retained: {
			...(snapshot.assets.banner || snapshot.assets.navigation || snapshot.assets.pageHeader || snapshot.assets.avatarFrame || snapshot.assets.profileBackground || navigation ? { surfaceArt: {
				...(snapshot.assets.banner ? { banner: resourceUri(snapshot.assets.banner) } : {}),
				...(snapshot.assets.pageHeader ? { pageHeader: resourceUri(snapshot.assets.pageHeader) } : {}),
				...(options.mode === 'light' && snapshot.assets.profileBackground ? { profileBackground: resourceUri(snapshot.assets.profileBackground) } : {}),
				...(options.mode === 'light' && snapshot.assets.avatarFrame ? { avatarFrame: resourceUri(snapshot.assets.avatarFrame) } : {}),
				...(snapshot.assets.navigation ? { navigation: resourceUri(snapshot.assets.navigation) } : {}),
				...(navigation ? { navigationColors: { ...navigation } } : {}),
			} } : {}),
			buttonMinTouchDp: parsed.components.button.minTouchDp,
			...(parsed.components.layout
				? {
						controlRowLayout: {
							minTouchDp: parsed.components.button.minTouchDp,
							...parsed.components.layout,
						},
					}
				: {}),
			lyricTokens: { ...lyric },
			...(progress || thumb ? { progress: {
				...(progress ? { colors: { ...progress } } : {}),
				...(thumbPath ? { thumb: bindIcon(thumbPath), sizeDp: thumb!.sizeDp } : {}),
				...(options.mode === 'light' && thumb?.dragLeft ? { dragLeft: bindIcon(thumb.dragLeft) } : {}),
				...(options.mode === 'light' && thumb?.dragRight ? { dragRight: bindIcon(thumb.dragRight) } : {}),
			} } : {}),
			...(iconResources ? { iconResources } : {}),
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
