export interface ThemeBackgroundAdjustments {
	transparency: number
	zoom: number
	horizontal: number
	vertical: number
}

export const defaultBackgroundAdjustments: Readonly<ThemeBackgroundAdjustments> = {
	transparency: 80,
	zoom: 1,
	horizontal: 50,
	vertical: 50,
}

export function checkBackgroundAdjustments(value: ThemeBackgroundAdjustments): void {
	if (!value || !Number.isFinite(value.zoom) || value.zoom < 1 || value.zoom > 4 ||
		![value.transparency, value.horizontal, value.vertical].every((n) => Number.isFinite(n) && n >= 0 && n <= 100))
		throw new Error('背景调整数值无效：透明度和位置为 0–100%，缩放为 1–4 倍')
}
