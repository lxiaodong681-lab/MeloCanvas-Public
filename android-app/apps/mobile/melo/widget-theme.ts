import type {
	ThemePresentation,
	ThemeSelection,
} from './core/theme-install-types'

export interface WidgetThemeProjection {
	schemaVersion: 1
	registryRevision: number
	selection: ThemeSelection
	themeVersion: string
	colors: {
		card: string
		textPrimary: string
		textSecondary: string
		accent: string
		border: string
	}
	variants: {
		card: 'rounded' | 'leaf' | 'comic'
		button: 'rounded' | 'leaf' | 'comic'
		progress: 'modern' | 'pastoral' | 'anime'
	}
	decoration: 'none' | 'botanical' | 'stars'
	fallback: 'modern'
}
export type WidgetThemeResult = 'applied' | 'unchanged' | 'stale'
export type WidgetThemeWriter = (
	projectionJson: string,
) => Promise<WidgetThemeResult>
export interface WidgetThemeSyncState {
	status: 'idle' | 'syncing' | 'synced' | 'error'
	error: Error | null
	canRetry: boolean
	needsReload: boolean
}
export const widgetThemeIdle: WidgetThemeSyncState = {
	status: 'idle',
	error: null,
	canRetry: false,
	needsReload: false,
}

function color(value: string): string {
	if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))
		throw new Error('小组件主题颜色无效')
	return value.toLowerCase()
}
function variant<T extends string>(value: T, allowed: readonly T[]): T {
	if (!allowed.includes(value)) throw new Error('小组件主题样式无效')
	return value
}
/** Only the installer's already verified, committed current presentation may be passed here. */
export function projectWidgetTheme(
	current: ThemePresentation,
	registryRevision: number,
): WidgetThemeProjection {
	if (!Number.isSafeInteger(registryRevision) || registryRevision < 0)
		throw new Error('小组件主题版本无效')
	let selection: ThemeSelection
	if (current.selection.kind === 'builtin')
		selection = {
			kind: 'builtin',
			key: variant(current.selection.key, ['modern', 'pastoral', 'anime']),
		}
	else {
		if (
			!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(current.selection.id) ||
			!/^[0-9a-f]{64}$/.test(current.selection.archiveSha256)
		)
			throw new Error('小组件主题包身份无效')
		selection = {
			kind: 'package',
			id: current.selection.id,
			archiveSha256: current.selection.archiveSha256,
		}
	}
	const theme = current.theme
	if (
		typeof theme.version !== 'string' ||
		!theme.version ||
		theme.version.trim() !== theme.version
	)
		throw new Error('小组件主题版本无效')
	return {
		schemaVersion: 1,
		registryRevision,
		selection,
		themeVersion: theme.version,
		colors: {
			card: color(theme.tokens.surface.card),
			textPrimary: color(theme.tokens.text.primary),
			textSecondary: color(theme.tokens.text.secondary),
			accent: color(theme.tokens.action.primary),
			border: color(theme.tokens.border.subtle),
		},
		variants: {
			card: variant(theme.components.card, ['rounded', 'leaf', 'comic']),
			button: variant(theme.components.button, ['rounded', 'leaf', 'comic']),
			progress: variant(theme.components.progress, [
				'modern',
				'pastoral',
				'anime',
			]),
		},
		// Package-specific Widget resources are not implemented. These are host decorations only.
		decoration:
			selection.kind === 'builtin'
				? selection.key === 'pastoral'
					? 'botanical'
					: selection.key === 'anime'
						? 'stars'
						: 'none'
				: 'none',
		fallback: 'modern',
	}
}

/** Mirrors committed theme state only; native revision checks own durable ordering. */
export class WidgetThemeSync {
	private state = widgetThemeIdle
	private payload: string | null = null
	private generation = 0
	private active = true
	private readonly listeners = new Set<() => void>()
	constructor(private readonly write: WidgetThemeWriter) {}
	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	private update(state: WidgetThemeSyncState) {
		this.state = state
		for (const listener of this.listeners) listener()
	}
	async submit(current: ThemePresentation, revision: number): Promise<void> {
		if (!this.active) return
		let payload: string
		try {
			payload = JSON.stringify(projectWidgetTheme(current, revision))
			let bytes = 0
			for (const character of payload) {
				const point = character.codePointAt(0)!
				bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
				if (bytes > 8192) throw new Error('小组件主题投影超过大小限额')
			}
		} catch (error) {
			this.generation++
			this.payload = null
			this.update({
				status: 'error',
				error: error instanceof Error ? error : new Error('小组件主题投影失败'),
				canRetry: false,
				needsReload: false,
			})
			return
		}
		if (payload === this.payload) return
		this.payload = payload
		await this.send(payload)
	}
	private async send(payload: string) {
		const generation = ++this.generation
		this.update({
			status: 'syncing',
			error: null,
			canRetry: false,
			needsReload: false,
		})
		try {
			const result = await this.write(payload)
			if (!this.active || generation !== this.generation) return
			if (result === 'stale') {
				this.update({
					status: 'error',
					error: new Error('小组件已有较新的主题记录，请重新读取主题后再同步'),
					canRetry: false,
					needsReload: true,
				})
				return
			}
			if (result !== 'applied' && result !== 'unchanged')
				throw new Error('小组件主题同步响应异常')
			this.update({
				status: 'synced',
				error: null,
				canRetry: false,
				needsReload: false,
			})
		} catch (error) {
			if (!this.active || generation !== this.generation) return
			this.update({
				status: 'error',
				error: error instanceof Error ? error : new Error('小组件主题同步失败'),
				canRetry: true,
				needsReload: false,
			})
		}
	}
	retry = async (): Promise<void> => {
		if (this.active && this.payload && this.state.canRetry)
			await this.send(this.payload)
	}
	stop = () => {
		this.active = false
		this.generation++
	}
	resume = () => {
		this.active = true
		this.generation++
		this.payload = null
	}
}
