import { builtInThemes, type ResolvedTheme } from './theme'
import { cosmosTheme } from './theme-appearance'

const layout = {
	pageInset: 20,
	sectionGap: 22,
	contentGap: 14,
	rowGap: 12,
} as const

/** Identity, not the theme id: imported packages own their colors and decoration. */
export function builtInVisuals(theme: ResolvedTheme) {
	if (theme === cosmosTheme)
		return { topTint: '#17171f', modern: true, fadeEnd: 0.85, softCover: true,
			layout, progress: { railHeightDp: 3, thumbSizeDp: 14, thumbRadiusDp: 7 } }
	if (theme === builtInThemes.modern)
		return {
			topTint: '#e6cbbb',
			modern: true,
			fadeEnd: 0.85,
			softCover: true,
			layout,
			progress: { railHeightDp: 3, thumbSizeDp: 14, thumbRadiusDp: 7 },
		}
	if (theme === builtInThemes.pastoral)
		return {
			topTint: '#d8e5ba',
			modern: false,
			fadeEnd: 0.85,
			softCover: true,
			layout,
			progress: { railHeightDp: 5, thumbSizeDp: 16, thumbRadiusDp: 8 },
		}
	if (theme === builtInThemes.anime)
		return {
			topTint: '#e5d8fb',
			modern: false,
			fadeEnd: 1,
			softCover: false,
			layout,
			progress: { railHeightDp: 5, thumbSizeDp: 16, thumbRadiusDp: 3 },
		}
	return null
}
