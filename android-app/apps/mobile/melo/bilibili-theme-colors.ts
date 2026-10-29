/** Bili navigation highlights are often pastel; keep their hue but make actions readable. */
function luminance(hex: string): number {
	const channels = [1, 3, 5].map((start) => {
		const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
	})
	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
export function contrastRatio(a: string, b: string): number {
	const first = luminance(a), second = luminance(b)
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}
/** Import-time palette mixing, never a per-frame image filter. */
export function mixBilibiliColor(base: string, accent: string, amount: number): string {
	return `#${[1, 3, 5].map((start) => Math.round(Number.parseInt(base.slice(start, start + 2), 16) * (1 - amount) + Number.parseInt(accent.slice(start, start + 2), 16) * amount).toString(16).padStart(2, '0')).join('')}`
}
export function readableBilibiliAccent(accent: string, backgrounds: string[]): string {
	for (let step = 0; step <= 100; step++) {
		const candidate = `#${[1, 3, 5].map((start) => Math.round(Number.parseInt(accent.slice(start, start + 2), 16) * (1 - step / 100)).toString(16).padStart(2, '0')).join('')}`
		if (backgrounds.every((background) => contrastRatio(candidate, background) >= 4.5)) return candidate
	}
	return '#000000'
}
