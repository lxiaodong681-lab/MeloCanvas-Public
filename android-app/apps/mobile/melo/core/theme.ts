import anime from '../themes/anime.json'
import modern from '../themes/modern.json'
import pastoral from '../themes/pastoral.json'

export type ThemeKey = 'modern' | 'pastoral' | 'anime'
type Variant = 'rounded' | 'leaf' | 'comic'
export interface ResolvedTheme {
	schemaVersion: 1
	id: string
	name: string
	version: string
	tokens: {
		surface: { base: string; card: string; tinted: string }
		text: { primary: string; secondary: string; inverse: string }
		action: { primary: string }
		state: { error: string }
		border: { subtle: string; strong: string }
	}
	components: {
		card: Variant
		button: Variant
		input: Variant
		discoverIcon: 'home' | 'flower' | 'star'
		playerFrame: 'stacked' | 'arch' | 'tilted'
		progress: 'modern' | 'pastoral' | 'anime'
	}
	assets: { hero: string; backdrop: string | null }
	motion: { durationMs: number; respectReducedMotion: true }
	warnings: string[]
}

const resourcePaths = new Set([
	'assets/coast.png',
	'assets/meadow.svg',
	'assets/orbit.svg',
	'assets/botanical.svg',
	'assets/starfield.svg',
])
const hostCapabilities = new Set([
	'semantic-colors',
	'icons',
	'backgrounds',
	'component-variants',
	'player-frame',
	'motion-presets',
])
const configs = {
	modern: {
		...modern,
		assets: [{ path: 'assets/coast.png', role: 'hero' }],
		decorations: { hero: 'assets/coast.png' },
		palette: { tinted: '#f9e9e3', line: '#e9e5dd', strong: '#d6cec4' },
	},
	pastoral: {
		...pastoral,
		assets: [
			{ path: 'assets/meadow.svg', role: 'hero' },
			{ path: 'assets/botanical.svg', role: 'headerBackdrop' },
		],
		decorations: {
			hero: 'assets/meadow.svg',
			backdrop: 'assets/botanical.svg',
		},
		palette: { tinted: '#e5ebd6', line: '#dce3cc', strong: '#a5b99b' },
	},
	anime: {
		...anime,
		assets: [
			{ path: 'assets/orbit.svg', role: 'hero' },
			{ path: 'assets/starfield.svg', role: 'headerBackdrop' },
		],
		decorations: { hero: 'assets/orbit.svg', backdrop: 'assets/starfield.svg' },
		palette: { tinted: '#e6dff6', line: '#d9d1ed', strong: '#afa0d4' },
	},
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('主题字段应为对象')
	return value as Record<string, unknown>
}
function color(value: unknown): string {
	if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))
		throw new Error('主题颜色无效')
	return value
}
function choose<T extends string>(value: unknown, allowed: readonly T[]): T {
	if (!allowed.includes(value as T)) throw new Error('主题组件变体不受支持')
	return value as T
}
function resource(
	value: unknown,
	fallback: string | null,
	warnings: string[],
): string | null {
	if (value === undefined || value === null) return fallback
	if (
		typeof value !== 'string' ||
		value.startsWith('/') ||
		value.includes('\\') ||
		value.split('/').includes('..') ||
		/[:?#]/.test(value)
	)
		throw new Error('主题资源必须使用安全的包内相对路径')
	if (!resourcePaths.has(value)) {
		warnings.push(`资源缺失，已回退：${value}`)
		return fallback
	}
	return value
}

// Versioned data contract. Only host-owned component variants reach native views.
export function resolveTheme(input: unknown): ResolvedTheme {
	const raw = object(input)
	if (raw.schemaVersion !== 1) throw new Error('主题 schemaVersion 不兼容')
	if (typeof raw.id !== 'string' || !/^[a-z][a-z0-9.-]+$/.test(raw.id))
		throw new Error('主题 ID 无效')
	if (typeof raw.name !== 'string' || typeof raw.version !== 'string')
		throw new Error('主题缺少名称或版本')
	if (
		raw.requiredCapabilities !== undefined &&
		(!Array.isArray(raw.requiredCapabilities) ||
			raw.requiredCapabilities.some((item) => !hostCapabilities.has(item)))
	)
		throw new Error('主题要求未支持的宿主能力')
	const tokens = object(raw.tokens)
	const surface = object(tokens.surface),
		text = object(tokens.text),
		action = object(tokens.action)
	const components = object(raw.components)
	const palette = object(raw.palette ?? configs.modern.palette)
	const decorations = object(raw.decorations ?? {})
	if (!Array.isArray(raw.assets)) throw new Error('主题缺少资源索引')
	const warnings: string[] = []
	for (const asset of raw.assets) resource(object(asset).path, null, warnings)
	const motion = object(raw.motion)
	if (
		motion.respectReducedMotion !== true ||
		typeof motion.durationMs !== 'number' ||
		motion.durationMs < 0 ||
		motion.durationMs > 500
	)
		throw new Error('主题动效配置超出范围')
	return {
		schemaVersion: 1,
		id: raw.id,
		name: raw.name,
		version: raw.version,
		tokens: {
			surface: {
				base: color(surface.base),
				card: color(surface.card),
				tinted: color(palette.tinted),
			},
			text: {
				primary: color(text.primary),
				secondary: color(text.secondary),
				inverse: '#ffffff',
			},
			action: { primary: color(action.primary) },
			state: { error: '#a33232' },
			border: { subtle: color(palette.line), strong: color(palette.strong) },
		},
		components: {
			card: choose(object(components.card).variant, [
				'rounded',
				'leaf',
				'comic',
			]),
			button: choose(object(components.button).variant, [
				'rounded',
				'leaf',
				'comic',
			]),
			input: choose(object(components.input).variant, [
				'rounded',
				'leaf',
				'comic',
			]),
			discoverIcon: choose(object(components.navigation).discoverIcon, [
				'home',
				'flower',
				'star',
			]),
			playerFrame:
				choose(object(components.player).frame, [
					'square',
					'arch',
					'tilted',
				]) === 'square'
					? 'stacked'
					: (object(components.player).frame as 'arch' | 'tilted'),
			progress: choose(object(components.progress).variant, [
				'modern',
				'pastoral',
				'anime',
			]),
		},
		assets: {
			hero: resource(decorations.hero, 'assets/coast.png', warnings)!,
			backdrop: resource(decorations.backdrop, null, warnings),
		},
		motion: { durationMs: motion.durationMs, respectReducedMotion: true },
		warnings,
	}
}

export const themeConfigs = configs
export const builtInThemes = Object.fromEntries(
	Object.entries(configs).map(([key, raw]) => [key, resolveTheme(raw)]),
) as Record<ThemeKey, ResolvedTheme>
export const validThemeKey = (value: unknown): ThemeKey =>
	value === 'pastoral' || value === 'anime' ? value : 'modern'

export function themeOrFallback(input: unknown): ResolvedTheme {
	try {
		return resolveTheme(input)
	} catch {
		return builtInThemes.modern
	}
}
