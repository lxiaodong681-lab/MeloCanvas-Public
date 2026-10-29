import { builtInThemes, type ThemeKey } from './core/theme'
import type { ThemeInstallSession } from './core/theme-install-session'
import type {
	ThemeInstallSnapshot,
	ThemePresentation,
} from './core/theme-install-types'
import {
	ThemeFileSelection,
	type ThemeFileChoice,
} from './theme-file-selection'
import {
	WidgetThemeSync,
	widgetThemeIdle,
	type WidgetThemeSyncState,
	type WidgetThemeWriter,
} from './widget-theme'

export type ThemeInstallPort = Pick<
	ThemeInstallSession,
	| 'getSnapshot'
	| 'subscribe'
	| 'load'
	| 'cancel'
	| 'importBytes'
	| 'applyPreview'
	| 'activateInstalled'
	| 'activateBuiltin'
	| 'undo'
> & Partial<Pick<ThemeInstallSession, 'removeInstalled'>>

export interface ThemeWorkshopSnapshot {
	current: ThemePresentation
	installer: ThemeInstallSnapshot | null
	file: ReturnType<ThemeFileSelection['getSnapshot']>
	loading: boolean
	error: Error | null
	widgetTheme: WidgetThemeSyncState
}

export function themeWorkshopBusy(state: ThemeWorkshopSnapshot): boolean {
	return (
		state.loading ||
		state.file.busy ||
		['loading', 'validating', 'preparing-preview', 'applying'].includes(
			state.installer?.phase ?? '',
		)
	)
}

/** UI bootstrap and picker state; durable theme ownership remains in the installer. */
export class ThemeWorkshopSession {
	private readonly fallback: ThemePresentation
	private state: ThemeWorkshopSnapshot
	private core: ThemeInstallPort | null = null
	private authoritative = false
	private generation = 0
	private readonly listeners = new Set<() => void>()
	private readonly files: ThemeFileSelection
	private readonly widgets: WidgetThemeSync | null
	private stopped = false
	constructor(
		private readonly actions: {
			fallback: () => ThemeKey
			create: () => Promise<ThemeInstallPort>
			pick: () => Promise<ThemeFileChoice | null>
			read: (uri: string) => Promise<Uint8Array>
			widgetTheme?: WidgetThemeWriter
		},
	) {
		this.widgets = actions.widgetTheme
			? new WidgetThemeSync(actions.widgetTheme)
			: null
		let fallback: ThemeKey = 'modern'
		let bootstrapError: Error | null = null
		try {
			fallback = actions.fallback()
		} catch (error) {
			bootstrapError =
				error instanceof Error ? error : new Error('主题设置读取失败')
		}
		this.fallback = {
			selection: { kind: 'builtin', key: fallback },
			theme: builtInThemes[fallback],
			adapted: null,
			packageMetadata: null,
			allowedImageUris: [],
		}
		this.files = new ThemeFileSelection({
			pick: actions.pick,
			read: actions.read,
			cancelValidation: async () => {
				// Closing the sheet must not cancel the app's global bootstrap load.
				if (!this.state.loading) await this.core?.cancel()
			},
			importBytes: async (bytes) => {
				const core = this.ready()
				if (!core) return false
				const success = await core.importBytes(bytes)
				if (!success && !core.getSnapshot().error)
					throw new Error('主题校验尚未完成，请重新选择')
				return success
			},
		})
		this.state = {
			current: this.fallback,
			installer: null,
			file: this.files.getSnapshot(),
			loading: true,
			error: bootstrapError,
			widgetTheme: this.widgets?.getSnapshot() ?? widgetThemeIdle,
		}
		this.files.subscribe(() => this.update({ file: this.files.getSnapshot() }))
		this.widgets?.subscribe(() =>
			this.update({ widgetTheme: this.widgets!.getSnapshot() }, false),
		)
	}
	getSnapshot = (): ThemeWorkshopSnapshot => this.state
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	private update(change: Partial<ThemeWorkshopSnapshot> = {}, mirror = true) {
		this.state = {
			...this.state,
			...change,
			current:
				this.authoritative && this.core
					? this.core.getSnapshot().current
					: this.fallback,
		}
		for (const listener of this.listeners) listener()
		if (mirror) this.syncWidgetTheme()
	}
	private syncWidgetTheme() {
		const installed = this.core?.getSnapshot()
		if (
			!this.stopped &&
			this.authoritative &&
			!this.state.loading &&
			installed &&
			!installed.readOnly
		)
			void this.widgets?.submit(installed.current, installed.revision)
	}
	retryWidgetTheme = (): void => {
		if (this.ready()) void this.widgets?.retry()
	}
	private ready(): ThemeInstallPort | null {
		if (
			this.core &&
			this.authoritative &&
			!this.state.loading &&
			!this.core.getSnapshot().readOnly
		)
			return this.core
		if (!this.state.error && !this.core?.getSnapshot().error)
			this.update({ error: new Error('主题记录尚不可写，请先重新读取') })
		return null
	}
	load = async (): Promise<boolean> => {
		this.stopped = false
		this.widgets?.resume()
		const generation = ++this.generation
		this.update({ loading: true, error: null })
		this.files.invalidate()
		try {
			if (!this.core) {
				const core = await this.actions.create()
				if (generation !== this.generation) {
					await core.cancel()
					return false
				}
				this.core = core
				core.subscribe(() => this.update({ installer: core.getSnapshot() }))
				this.update({ installer: core.getSnapshot() })
			}
			const success = await this.core.load()
			if (generation !== this.generation) return false
			if (success) this.authoritative = true
			this.update({ installer: this.core.getSnapshot() })
			return success
		} catch (error) {
			if (generation === this.generation)
				this.update({
					error:
						error instanceof Error ? error : new Error('主题工坊初始化失败'),
				})
			return false
		} finally {
			if (generation === this.generation) this.update({ loading: false })
		}
	}
	choose = async (): Promise<boolean> => {
		if (!this.ready()) return false
		this.generation++
		this.update({ error: null })
		return this.files.choose()
	}
	close = (): void => {
		if (!this.state.loading) this.generation++
		this.files.cancel()
	}
	stop = (): void => {
		this.stopped = true
		this.widgets?.stop()
		this.generation++
		this.files.cancel()
		void this.core?.cancel()
	}
	private async run(
		action: (core: ThemeInstallPort) => Promise<boolean>,
	): Promise<boolean> {
		const core = this.ready()
		if (!core) return false
		const generation = ++this.generation
		this.files.invalidate()
		this.update({ error: null })
		try {
			const success = await action(core)
			if (generation !== this.generation) return false
			if (success) this.authoritative = true
			else if (!core.getSnapshot().error)
				this.update({ error: new Error('主题操作未完成，请重试') })
			this.update({ installer: core.getSnapshot() })
			return success
		} catch (error) {
			if (generation === this.generation)
				this.update({
					error: error instanceof Error ? error : new Error('主题操作失败'),
				})
			return false
		}
	}
	apply = (): Promise<boolean> => this.run((core) => core.applyPreview())
	previewBytes = (bytes: Uint8Array, signal?: AbortSignal): Promise<boolean> => this.run(async (core) => {
		if (signal?.aborted) return false
		const cancel = () => { void core.cancel() }
		signal?.addEventListener('abort', cancel, { once: true })
		try { return await core.importBytes(bytes) && !signal?.aborted }
		finally { signal?.removeEventListener('abort', cancel) }
	})
	applyAuthored = (bytes: Uint8Array): Promise<boolean> => this.run(async (core) => {
		const generation = this.generation
		if (!await core.importBytes(bytes)) return false
		if (this.stopped || generation !== this.generation) return false
		return core.applyPreview()
	})
	activateBuiltin = (key: ThemeKey): Promise<boolean> =>
		this.run((core) => core.activateBuiltin(key))
	activateInstalled = (id: string, hash: string): Promise<boolean> =>
		this.run((core) => core.activateInstalled(id, hash))
	removeInstalled = (id: string, hash: string): Promise<boolean> =>
		this.run((core) => {
			if (!core.removeInstalled) throw new Error('当前版本不支持删除主题，请更新应用')
			return core.removeInstalled(id, hash)
		})
	undo = (): Promise<boolean> => this.run((core) => core.undo())
}
