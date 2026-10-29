import * as SecureStore from 'expo-secure-store'
import { useEffect, useSyncExternalStore } from 'react'
import { useColorScheme } from 'react-native'

import { AppearanceStore } from './appearance-preference'
import { effectiveColorMode } from './core/theme-appearance'

const key = 'melocanvas.appearance.v1'
const options = {
	keychainService: 'melocanvas.appearance',
	keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}
export const appearanceStore = new AppearanceStore({
	read: () => SecureStore.getItemAsync(key, options),
	write: (value) => SecureStore.setItemAsync(key, value, options),
})

export function useAppearance() {
	const state = useSyncExternalStore(
		appearanceStore.subscribe,
		appearanceStore.getSnapshot,
	)
	const system = useColorScheme()
	useEffect(() => {
		void appearanceStore.restore()
	}, [])
	return {
		...state,
		mode: effectiveColorMode(state.preference, system),
		set: appearanceStore.set,
	}
}
