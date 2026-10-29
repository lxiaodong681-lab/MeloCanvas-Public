import type { ResolvedTheme, ThemeKey } from './theme'
import type { AdaptedPackageTheme } from './theme-package-adapter'
import type { ThemeImageDecoder, ThemePackageHost } from './theme-package-types'

export type ThemeSelection =
	| { kind: 'builtin'; key: ThemeKey }
	| { kind: 'package'; id: string; archiveSha256: string }
export interface InstalledThemeRecord {
	id: string
	version: string
	name: string
	archiveSha256: string
	storedBytes?: number
}
export interface ThemeRegistryV1 {
	schemaVersion: 1
	revision: number
	installed: InstalledThemeRecord[]
	active: ThemeSelection
	previous: ThemeSelection | null
	/** Unregistered packages awaiting idempotent physical cleanup. */
	pendingRemoval?: { id: string; archiveSha256: string; token: string }[]
}
export interface ThemePresentation {
	selection: ThemeSelection
	theme: ResolvedTheme
	packageMetadata: {
		name: string
		author: string
		license: string
		version: string
		archiveBytes: number
	} | null
	/** Present only for a validated package. Preserve retained semantics in the renderer. */
	adapted: AdaptedPackageTheme | null
	/** Precomputed from the same verified package; no I/O when display mode changes. */
	darkAdapted?: AdaptedPackageTheme
	/** Exact host-bound URI set; never derive from package-provided URLs. */
	allowedImageUris: readonly string[]
}
export interface ThemeInstallSnapshot {
	phase:
		| 'idle'
		| 'loading'
		| 'validating'
		| 'preparing-preview'
		| 'preview'
		| 'applying'
		| 'ready'
		| 'error'
	current: ThemePresentation
	preview: ThemePresentation | null
	installed: readonly InstalledThemeRecord[]
	revision: number
	canUndo: boolean
	readOnly: boolean
	error: Error | null
	cleanupErrors: readonly Error[]
}
export interface ThemeSettingsDriver {
	read(): string | null
	readLegacy(): string | null
	/** Synchronous compare then one SQLite upsert; throws on stale registry/write failure. */
	commit(expected: string | null, value: string): void
}
export interface ThemeStage {
	token: string
	privateRootUri: string
}
export interface ThemeFileEntry {
	path: string
	bytes: number
}
/** All operations enforce private roots/no links/bounds internally, not only in JS. */
export interface ThemeFilesDriver {
	installedRootUri: string
	createStage(): Promise<ThemeStage>
	writeStage(stage: ThemeStage, path: string, bytes: Uint8Array): Promise<void>
	read(
		scope: ThemeStage | 'installed',
		path: string,
		maxBytes: number,
	): Promise<Uint8Array>
	list(scope: ThemeStage | 'installed', path: string): Promise<ThemeFileEntry[]>
	/** Never replaces a final directory, including an already registered/active version. */
	publish(
		stage: ThemeStage,
		id: string,
		hash: string,
	): Promise<'created' | 'exists'>
	removeStage(stage: ThemeStage): Promise<void>
	/** Host-written receipt outside package contents; native checks every file hash off the JS thread. */
	readVerified?(id: string, hash: string, context: string): Promise<string | null>
	writeVerified?(id: string, hash: string, context: string, payload: string,
		entries: { path: string; bytes: number; sha256: string }[]): Promise<void>
	removeInstalled?(id: string, hash: string, token: string): Promise<void>
}
export type ThemePresentationPurpose = 'preview' | 'activate' | 'restore'
/** A complete, stable measurement rejected the candidate, rather than timing out. */
export class ThemeLayoutRejectedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ThemeLayoutRejectedError'
	}
}
/** Never treat an unfinished/expired host measurement as a damaged installed theme. */
export class ThemePresentationTransientError extends Error {
	constructor(
		readonly reason: 'pending' | 'stale' | 'cancelled' | 'unavailable',
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = 'ThemePresentationTransientError'
	}
}
export interface ThemePresentationLease {
	/** Synchronous environment/ownership check; throw a transient error if expired. */
	assertCurrent(): void
}
export interface ThemeInstallDependencies {
	files: ThemeFilesDriver
	settings: ThemeSettingsDriver
	host: ThemePackageHost
	decoder: ThemeImageDecoder
	mode: 'light' | 'dark'
	validatePresentation?: (presentation: ThemePresentation) => void
	/** Optional host preparation after static validation; builtins bypass this hook.
	 * Reject stable incompatibility with ThemeLayoutRejectedError, unfinished work
	 * with ThemePresentationTransientError. Observe signal to release host resources;
	 * the installer stops waiting on abort even if this promise has not settled.
	 */
	preparePresentation?: (
		presentation: ThemePresentation,
		context: { purpose: ThemePresentationPurpose; signal: AbortSignal },
	) => Promise<ThemePresentationLease>
}
