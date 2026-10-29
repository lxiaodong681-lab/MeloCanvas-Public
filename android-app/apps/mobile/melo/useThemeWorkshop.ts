import { Orpheus } from '@bbplayer/orpheus'
import Constants from 'expo-constants'
import * as DocumentPicker from 'expo-document-picker'
import { useEffect, useMemo, useSyncExternalStore } from 'react'

import type { Library } from './core/database'
import {
	createMobileThemeInstallSession,
	readStartupBuiltinTheme,
	readSelectedThemeBytes,
} from './core/theme-install-mobile'
import type { ThemeInstallDependencies } from './core/theme-install-types'
import { themeImageDecoder } from './theme-image-decoder'
import { ThemeWorkshopSession } from './theme-workshop-session'

export function useThemeWorkshop(
	library: Library,
	preparePresentation?: ThemeInstallDependencies['preparePresentation'],
	/** Only the App with candidate and current-layout guards opts in. */
	responsiveLayoutHost = false,
) {
	const session = useMemo(
		() =>
			new ThemeWorkshopSession({
				widgetTheme: (projection) =>
					Orpheus.setWidgetThemeProjection(projection),
				fallback: () => readStartupBuiltinTheme(library),
				create: async () => {
					const appVersion =
						Constants.expoConfig?.version
					if (!appVersion)
						throw new Error('无法读取当前应用版本，主题包尚不能校验')
					return createMobileThemeInstallSession(library, {
						preparePresentation,
						responsiveLayoutHost,
						host: {
							appVersion,
							capabilities: [
								'semantic-colors',
								'dark-tokens',
								'icons',
								'package-icons-v1',
								'custom-progress-v1',
								'surface-art-v1',
								'collection-art-v1',
								'backgrounds',
								'component-variants',
								'player-frame',
								'motion-presets',
								...(responsiveLayoutHost && preparePresentation
									? ['responsive-touch-layout-v1']
									: []),
							],
						},
						decoder: themeImageDecoder,
						mode: 'light',
					})
				},
				pick: async () => {
					const result = await DocumentPicker.getDocumentAsync({
						type: '*/*',
						multiple: false,
						copyToCacheDirectory: false,
					})
					if (result.canceled) return null
					const file = result.assets[0]
					if (!file) throw new Error('没有取得所选主题文件，请重新选择')
					return {
						uri: file.uri,
						name: file.name || '主题包',
						reportedBytes: file.size,
					}
				},
				read: readSelectedThemeBytes,
			}),
		[library, preparePresentation, responsiveLayoutHost],
	)
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	useEffect(() => {
		void session.load()
		return session.stop
	}, [session])
	return { session, state }
}
