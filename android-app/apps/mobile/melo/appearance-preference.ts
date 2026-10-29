import type { AppearancePreference } from './core/theme-appearance'

export interface AppearanceState {
	preference: AppearancePreference
	ready: boolean
	saving: boolean
	error: string | null
}

/** Kept outside the account/library so login and recovery use the same appearance. */
export class AppearanceStore {
	private state: AppearanceState = {
		preference: 'system',
		ready: false,
		saving: false,
		error: null,
	}
	private readonly listeners = new Set<() => void>()
	private reading: Promise<void> | null = null
	private generation = 0
	constructor(
		private readonly storage: {
			read(): Promise<string | null>
			write(value: AppearancePreference): Promise<void>
		},
	) {}
	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private publish(change: Partial<AppearanceState>) {
		this.state = { ...this.state, ...change }
		for (const listener of this.listeners) listener()
	}
	restore = (): Promise<void> => {
		if (this.reading) return this.reading
		if (this.state.ready) return Promise.resolve()
		const generation = this.generation
		this.reading = (async () => {
			try {
				const value = await this.storage.read()
				if (generation !== this.generation) return
				this.publish({
					preference: value === 'light' || value === 'dark' ? value : 'system',
					ready: true,
				})
			} catch {
				if (generation === this.generation)
					this.publish({
						ready: true,
						error: '外观设置读取失败，暂时跟随系统；可重新选择。',
					})
			}
		})().finally(() => {
			this.reading = null
		})
		return this.reading
	}
	set = async (preference: AppearancePreference): Promise<void> => {
		if (this.state.saving || !['light', 'dark', 'system'].includes(preference))
			return
		if (
			this.state.ready &&
			preference === this.state.preference &&
			!this.state.error
		)
			return
		const previous = this.state.preference
		this.generation++
		this.publish({ preference, ready: true, saving: true, error: null })
		try {
			await this.storage.write(preference)
			this.publish({ saving: false })
		} catch {
			this.publish({
				preference: previous,
				saving: false,
				error: '外观设置未能保存，已恢复上次选择，请重试。',
			})
		}
	}
}
