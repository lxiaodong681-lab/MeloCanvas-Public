import { builtInThemes, type ResolvedTheme } from './theme'
import type { ThemePresentation } from './theme-install-types'

export type AppearancePreference = 'light' | 'dark' | 'system'
export type ColorMode = 'light' | 'dark'

/** A display fallback, never a replacement for the user's durable theme selection. */
export const cosmosTheme: ResolvedTheme = {
	...builtInThemes.modern,
	id: 'melocanvas.builtin.cosmos',
	name: '宇宙',
	tokens: {
		surface: { base: '#000000', card: '#141416', tinted: '#202027' },
		text: { primary: '#E8E8ED', secondary: '#A6A6B2', inverse: '#101016' },
		action: { primary: '#B9B5F5' },
		state: { error: '#FF9B9B' },
		border: { subtle: '#303039', strong: '#666674' },
	},
	assets: { hero: 'assets/cosmos.png', backdrop: null },
	motion: { durationMs: 0, respectReducedMotion: true },
	warnings: [],
}

export function effectiveColorMode(
	preference: AppearancePreference,
	system: string | null | undefined,
): ColorMode {
	return preference === 'system'
		? system === 'dark'
			? 'dark'
			: 'light'
		: preference
}

const darkPresentations = new WeakMap<ThemePresentation, ThemePresentation>()
/** Constant-time switching: no archive reads, image decoding, registry writes or player changes. */
export function themeAppearance(
	presentation: ThemePresentation,
	mode: ColorMode,
): ThemePresentation {
	if (mode === 'light') return presentation
	let dark = darkPresentations.get(presentation)
	if (!dark) {
		const adapted =
			presentation.darkAdapted ??
			(presentation.adapted?.mode === 'dark' ? presentation.adapted : null)
		dark = {
			...presentation,
			theme: adapted?.theme ?? cosmosTheme,
			adapted,
			allowedImageUris: adapted ? presentation.allowedImageUris : [],
		}
		darkPresentations.set(presentation, dark)
	}
	return dark
}
