import {
	ThemePackageError,
	themePackageLimits,
} from './core/theme-package-types'

export interface ThemeFileChoice {
	uri: string
	name: string
	reportedBytes?: number
}
interface SelectionState {
	busy: boolean
	file: { name: string; bytes: number | null } | null
	error: Error | null
}

/** Owns only the picker/read intent; the installer owns validation and commit. */
export class ThemeFileSelection {
	private version = 0
	private state: SelectionState = { busy: false, file: null, error: null }
	private listeners = new Set<() => void>()
	constructor(
		private readonly actions: {
			pick: () => Promise<ThemeFileChoice | null>
			read: (uri: string) => Promise<Uint8Array>
			importBytes: (bytes: Uint8Array) => Promise<boolean>
			cancelValidation: () => void | Promise<void>
		},
	) {}
	getSnapshot = (): SelectionState => this.state
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	private update(change: Partial<SelectionState>) {
		this.state = { ...this.state, ...change }
		for (const listener of this.listeners) listener()
	}
	/** Supersede picker/read UI without discarding an installer's valid preview. */
	invalidate = (): void => {
		this.version++
		this.update({ busy: false, file: null, error: null })
	}
	cancel = (): void => {
		this.invalidate()
		const version = this.version
		const failed = (error: unknown) => {
			if (version === this.version)
				this.update({
					error: error instanceof Error ? error : new Error('主题操作取消失败'),
				})
		}
		try {
			void Promise.resolve(this.actions.cancelValidation()).catch(failed)
		} catch (error) {
			failed(error)
		}
	}
	choose = async (): Promise<boolean> => {
		const version = ++this.version
		this.update({ busy: true, file: null, error: null })
		try {
			// Native validation/cleanup retains its single admission slot until it
			// settles. Do not let a fast new picker/read race that final release.
			await this.actions.cancelValidation()
			if (version !== this.version) return false
			const file = await this.actions.pick()
			if (version !== this.version || !file) return false
			const reported = file.reportedBytes
			const knownSize =
				typeof reported === 'number' &&
				Number.isSafeInteger(reported) &&
				reported >= 0
			this.update({
				file: { name: file.name, bytes: knownSize ? reported : null },
			})
			if (knownSize && reported > themePackageLimits.archiveBytes)
				throw new ThemePackageError('LIMIT_EXCEEDED', '主题包超过 20 MiB 上限')
			const bytes = await this.actions.read(file.uri)
			if (version !== this.version) return false
			if (bytes.length > themePackageLimits.archiveBytes)
				throw new ThemePackageError('LIMIT_EXCEEDED', '主题包超过 20 MiB 上限')
			this.update({ file: { name: file.name, bytes: bytes.length } })
			const success = await this.actions.importBytes(bytes)
			return version === this.version && success
		} catch (error) {
			if (version !== this.version) return false
			this.update({
				error: error instanceof Error ? error : new Error('主题文件读取失败'),
			})
			return false
		} finally {
			if (version === this.version) this.update({ busy: false })
		}
	}
}
