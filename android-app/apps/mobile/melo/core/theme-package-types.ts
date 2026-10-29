import type { ThemeCompactLayout } from './theme-layout'

/** Author API 0.x; schemaVersion 1 is the first ZIP structure, not the lab JSON. */
export interface ThemePackageLimits {
	archiveBytes: number
	totalBytes: number
	fileBytes: number
	jsonBytes: number
	licenseBytes: number
	entries: number
	assets: number
	expansionRatio: number
	imagePixels: number
	imageDimension: number
	decodedImageBytes: number
}

// Design ceilings awaiting device calibration, not measured Android guarantees.
export const themePackageLimits: Readonly<ThemePackageLimits> = Object.freeze({
	archiveBytes: 20 * 1024 * 1024,
	totalBytes: 60 * 1024 * 1024,
	fileBytes: 8 * 1024 * 1024,
	jsonBytes: 256 * 1024,
	licenseBytes: 64 * 1024,
	entries: 256,
	assets: 200,
	expansionRatio: 100,
	imagePixels: 8_000_000,
	imageDimension: 8192,
	decodedImageBytes: 32 * 1024 * 1024,
})

export type ThemePackageErrorCode =
	| 'ARCHIVE_INVALID'
	| 'ARCHIVE_UNSUPPORTED'
	| 'PATH_INVALID'
	| 'LIMIT_EXCEEDED'
	| 'MANIFEST_INVALID'
	| 'INCOMPATIBLE'
	| 'RESOURCE_INVALID'
	| 'IMAGE_INVALID'
	| 'DECODER_REQUIRED'
	| 'CANCELLED'

export class ThemePackageError extends Error {
	constructor(
		readonly code: ThemePackageErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = 'ThemePackageError'
	}
}

export interface ThemePackageHost {
	appVersion: string
	/** Actual renderer capabilities supplied by the host, never by the package. */
	capabilities: readonly string[]
	/** Trusted host may distinguish temporary unavailability by throwing. Receives
	 * every missing required capability; returning never grants support. Runs before
	 * remaining documents/resources are verified, so it cannot imply package validity. */
	onMissingCapabilities?: (missing: readonly string[]) => void
}

export interface ThemePackageAsset {
	path: string
	mime: 'image/png'
	bytes: number
	sha256: string
}

export interface ThemePackageManifest {
	format: 'melocanvas-theme'
	schemaVersion: 1
	id: string
	version: string
	name: string
	author: string
	minAppVersion: string
	license: string
	entry: { tokens: 'tokens.json'; components: 'components.json' }
	fallback: 'melocanvas.builtin.modern'
	requiredCapabilities: string[]
	optionalCapabilities: string[]
	assets: ThemePackageAsset[]
	previews: string[]
}

export interface PackageThemeTokens {
	surface: { base: string; card: string; tinted: string }
	text: { primary: string; secondary: string; inverse: string }
	action: { primary: string }
	state: { error: string }
	border: { subtle: string; strong: string }
	lyric: { active: string; inactive: string }
	/** Requires custom-progress-v1. Omitted preserves the original theme colors. */
	progress?: { track: string; fill: string; thumb: string }
	/** Requires surface-art-v1; independent foreground colors for navigation artwork. */
	navigation?: { normal: string; selected: string }
}

/** Fixed host semantics; package artwork cannot add or redefine actions. */
export const packageThemeIconNames = Object.freeze([
	'home',
	'search',
	'library',
	'user',
	'play',
	'pause',
	'next',
	'previous',
	'down',
	'back',
	'close',
	'heart',
	'queue',
	'repeat',
	'flower',
	'star',
	'music',
	'info',
	'check',
	'arrow',
] as const)
export type PackageThemeIconName = (typeof packageThemeIconNames)[number]
export interface PackageThemeIconStates {
	normal: string
	/** Absent means use normal artwork without changing the host selected state. */
	selected?: string
}
export type PackageThemeIcons = Partial<
	Record<
		PackageThemeIconName,
		{
			light: PackageThemeIconStates
			/** Absent means host vector fallback in dark mode, never reuse light blindly. */
			dark?: PackageThemeIconStates
		}
	>
>

export interface PackageThemeComponents {
	card: { variant: 'rounded' | 'leaf' | 'comic' }
	button: { variant: 'rounded' | 'leaf' | 'comic'; minTouchDp: number }
	input: { variant: 'rounded' | 'leaf' | 'comic' }
	navigation: { discoverIcon: 'home' | 'flower' | 'star' }
	player: { frame: 'square' | 'arch' | 'tilted' }
	progress: {
		variant: 'modern' | 'pastoral' | 'anime'
		/** Static PNG, at most 256px per side; displayed without tint or rotation. */
		thumb?: { light: string; dark?: string; sizeDp: number; dragLeft?: string; dragRight?: string }
	}
	/** Requires responsive-touch-layout-v1; absent means no narrow-row permission. */
	layout?: ThemeCompactLayout
	/** Requires package-icons-v1; absent preserves the host vector icon set. */
	icons?: PackageThemeIcons
}

/** Configuration only. This type intentionally has no verified/installable flag. */
export interface ParsedThemeDocuments {
	manifest: ThemePackageManifest
	tokens: { light: PackageThemeTokens; dark?: PackageThemeTokens }
	components: PackageThemeComponents
	decorations: { hero?: string; backdrop?: string; banner?: string; navigation?: string; pageHeader?: string; profileBackground?: string; avatarFrame?: string }
	motion: { durationMs: number; respectReducedMotion: true }
	warnings: string[]
}

export interface DecodedThemeImage {
	mime: 'image/png'
	width: number
	height: number
	frames: 1
	decodedBytes: number
}

export interface ThemeImageDecoder {
	/** Must fully decode pixels under these input/output budgets, not just read a header. */
	decodeImage(
		bytes: Uint8Array,
		limits: Readonly<ThemePackageLimits>,
		signal?: AbortSignal,
	): Promise<DecodedThemeImage>
}

export interface ThemePackageFile {
	path: string
	bytes: Uint8Array
	sha256: string
	image?: DecodedThemeImage
}

export interface PackageResourceReference {
	kind: 'package'
	path: string
	sha256: string
	mime: 'image/png'
}

/** Serializable intermediate model. URI binding/activation belongs to the installer. */
export interface PackageThemeSnapshot {
	schemaVersion: 1
	package: { id: string; version: string; archiveSha256: string }
	tokens: ParsedThemeDocuments['tokens']
	components: PackageThemeComponents
	motion: ParsedThemeDocuments['motion']
	assets: {
		hero:
			| PackageResourceReference
			| { kind: 'builtin'; theme: 'modern'; role: 'hero' }
		backdrop: PackageResourceReference | null
		banner?: PackageResourceReference
		pageHeader?: PackageResourceReference
		profileBackground?: PackageResourceReference
		avatarFrame?: PackageResourceReference
		navigation?: PackageResourceReference
	}
	resources: PackageResourceReference[]
	warnings: string[]
}

declare const verifiedPackageBrand: unique symbol
/** Only complete ZIP + schema + integrity + actual pixel decoding creates this. */
export interface VerifiedThemePackage {
	readonly [verifiedPackageBrand]: true
	manifest: ThemePackageManifest
	snapshot: PackageThemeSnapshot
	files: ThemePackageFile[]
}
