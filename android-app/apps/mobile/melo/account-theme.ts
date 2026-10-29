import * as SecureStore from 'expo-secure-store'

import type { ThemeKey } from './core/theme'
import type { ThemeSelection } from './core/theme-install-types'

interface AccountThemeStorage {
	read(): Promise<string | null>
	write(key: ThemeKey): Promise<void>
}

function themeKey(value: unknown): ThemeKey {
	return value === 'pastoral' || value === 'anime' ? value : 'modern'
}

/** An appearance-only mirror. Never opens the library or resolves a theme package. */
export class AccountThemePreference {
	private current: ThemeKey = 'modern'
	private ready = false
	private generation = 0
	private writeGeneration = 0
	private reading: Promise<void> | null = null
	private writes = Promise.resolve()
	private requested: ThemeKey | null = null
	private readonly listeners = new Set<() => void>()
	constructor(private readonly storage: AccountThemeStorage) {}
	getSnapshot = (): ThemeKey => this.current
	getReadySnapshot = (): boolean => this.ready
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private publish(key: ThemeKey) {
		if (key === this.current && this.ready) return
		this.ready = true
		this.current = key
		for (const listener of this.listeners) listener()
	}
	restore = (): Promise<void> => {
		if (this.reading) return this.reading
		const generation = this.generation
		const read = async () => {
			// A remount must not read a previous value while the last choice is saving.
			await this.writes
			if (generation !== this.generation) return
			let value: string | null = null
			try {
				value = await this.storage.read()
			} catch {
				// Appearance storage must never prevent the account gate from rendering.
			}
			if (generation !== this.generation) return
			this.requested =
				value === 'modern' || value === 'pastoral' || value === 'anime'
					? value
					: null
			this.publish(themeKey(value))
		}
		this.reading = read().finally(() => {
			this.reading = null
		})
		return this.reading
	}
	/** Call only for the installer's committed selection, after its initial load. */
	remember = (selection: ThemeSelection): Promise<void> => {
		const key =
			selection.kind === 'builtin' ? themeKey(selection.key) : 'modern'
		this.generation++
		this.publish(key)
		if (this.requested === key) return this.writes
		this.requested = key
		const generation = ++this.writeGeneration
		this.writes = this.writes.then(async () => {
			try {
				await this.storage.write(key)
			} catch {
				if (generation !== this.writeGeneration) return
				this.requested = null
				this.publish('modern')
			}
		})
		return this.writes
	}
}

// Separate from the Bilibili credential key/service; the value is only a builtin key.
const key = 'melocanvas.account-theme.v1'
const options = {
	keychainService: 'melocanvas.account-theme',
	keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}
export const accountTheme = new AccountThemePreference({
	read: () => SecureStore.getItemAsync(key, options),
	write: (value) => SecureStore.setItemAsync(key, value, options),
})
