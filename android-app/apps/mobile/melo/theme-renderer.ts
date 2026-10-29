import type { ThemeControlRowPolicy } from './core/theme-layout'
import type {
	AdaptedPackageTheme,
	BoundPackageIconStates,
} from './core/theme-package-adapter'
import {
	packageThemeIconNames,
	type PackageThemeIconName,
	type PackageThemeTokens,
} from './core/theme-package-types'

export interface ThemeRendering {
	/** Only exact image URIs supplied by the trusted installation session resolve. */
	resolveResource: (resource: string) => string | undefined
	/** Missing mappings/modes resolve to the host vector, not another mode's PNG. */
	resolveIcon: (
		name: PackageThemeIconName,
		selected?: boolean,
	) => string | undefined
	buttonMinTouchDp: number
	controlRowLayout: ThemeControlRowPolicy | null
	lyricTokens: Readonly<PackageThemeTokens['lyric']>
	transitionMs: number
	mode: 'light' | 'dark'
	surfaceArt?: { banner?: string; navigation?: string; pageHeader?: string; profileBackground?: string; avatarFrame?: string; navigationColors?: { normal: string; selected: string } }
	progress?: { colors?: PackageThemeTokens['progress']; thumbUri?: string; sizeDp?: number; dragLeftUri?: string; dragRightUri?: string }
}

function canonicalFileUri(uri: string): boolean {
	return (
		uri.startsWith('file:///') &&
		uri === uri.normalize('NFC') &&
		uri
			.slice('file:///'.length)
			.split('/')
			.every(
				(part) =>
					/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(part) && !/[. ]$/.test(part),
			)
	)
}

/** Inputs belong to the host session, never to unverified package JSON. */
export function createPackageRendering(
	adapted: AdaptedPackageTheme,
	allowedImageUris: readonly string[],
	reducedMotion: boolean,
): ThemeRendering {
	const allowed = new Set(allowedImageUris)
	const resolveResource = (resource: string) =>
		allowed.has(resource) && canonicalFileUri(resource) ? resource : undefined
	type IconUris = { normal: string; selected?: string }
	const iconState = (
		states: BoundPackageIconStates | undefined,
	): IconUris | undefined => {
		if (!states) return undefined
		const normal = resolveResource(states.normal.uri)
		const selected = states.selected
			? resolveResource(states.selected.uri)
			: undefined
		// An invalid declared state must not be mistaken for an absent optional state.
		return !normal || (states.selected && !selected)
			? undefined
			: { normal, ...(selected ? { selected } : {}) }
	}
	const icons = new Map<
		PackageThemeIconName,
		{ light?: IconUris; dark?: IconUris }
	>()
	for (const name of packageThemeIconNames) {
		const icon = adapted.retained.iconResources?.[name]
		if (icon)
			icons.set(name, {
				light: iconState(icon.light),
				dark: iconState(icon.dark),
			})
	}
	const mode = adapted.mode
	return {
		resolveResource,
		resolveIcon: (name, selected = false) => {
			const icon = icons.get(name)?.[mode]
			return selected ? (icon?.selected ?? icon?.normal) : icon?.normal
		},
		buttonMinTouchDp: adapted.retained.buttonMinTouchDp,
		controlRowLayout: adapted.retained.controlRowLayout
			? { ...adapted.retained.controlRowLayout }
			: adapted.retained.buttonMinTouchDp > 48
				? {
						minTouchDp: adapted.retained.buttonMinTouchDp,
						narrowFallback: 'reject',
					}
				: null,
		lyricTokens: { ...adapted.retained.lyricTokens },
		transitionMs: reducedMotion ? 0 : adapted.theme.motion.durationMs,
		mode: adapted.mode,
		...(adapted.retained.surfaceArt ? { surfaceArt: {
			banner: adapted.retained.surfaceArt.banner ? resolveResource(adapted.retained.surfaceArt.banner) : undefined,
			pageHeader: adapted.retained.surfaceArt.pageHeader ? resolveResource(adapted.retained.surfaceArt.pageHeader) : undefined,
			profileBackground: adapted.retained.surfaceArt.profileBackground ? resolveResource(adapted.retained.surfaceArt.profileBackground) : undefined,
			avatarFrame: adapted.retained.surfaceArt.avatarFrame ? resolveResource(adapted.retained.surfaceArt.avatarFrame) : undefined,
			navigation: adapted.retained.surfaceArt.navigation ? resolveResource(adapted.retained.surfaceArt.navigation) : undefined,
			...(adapted.retained.surfaceArt.navigationColors ? { navigationColors: { ...adapted.retained.surfaceArt.navigationColors } } : {}),
		} } : {}),
		...(adapted.retained.progress ? { progress: {
			colors: adapted.retained.progress.colors ? { ...adapted.retained.progress.colors } : undefined,
			thumbUri: adapted.retained.progress.thumb ? resolveResource(adapted.retained.progress.thumb.uri) : undefined,
			dragLeftUri: adapted.retained.progress.dragLeft ? resolveResource(adapted.retained.progress.dragLeft.uri) : undefined,
			dragRightUri: adapted.retained.progress.dragRight ? resolveResource(adapted.retained.progress.dragRight.uri) : undefined,
			sizeDp: adapted.retained.progress.sizeDp,
		} } : {}),
	}
}
