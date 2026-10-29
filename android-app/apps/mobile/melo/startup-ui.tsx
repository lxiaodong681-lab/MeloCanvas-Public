import React, { useEffect, useState, type PropsWithChildren } from 'react'
import { Image } from 'expo-image'
import { ActivityIndicator, ScrollView, StatusBar, Text, useWindowDimensions, View } from 'react-native'

import { builtInThemes } from './core/theme'
import { cosmosTheme, type ColorMode } from './core/theme-appearance'

/** Artwork follows real initialization; it never adds a minimum display time. */
export function StartupSurface({
	mode,
	label = '正在启动',
}: { mode: ColorMode; label?: string }) {
	const tokens = (mode === 'dark' ? cosmosTheme : builtInThemes.modern).tokens
	const { width, height, fontScale } = useWindowDimensions()
	const portraitHeight = Math.max(96, Math.min(600, (width - 48) * 1.5, height * (fontScale > 1.3 ? 0.45 : 0.62)))
	return (
		<View
			testID='app-startup'
			accessibilityLabel={label}
			style={{
				flex: 1,
				backgroundColor: tokens.surface.base,
			}}
		>
			<StatusBar
				barStyle={mode === 'dark' ? 'light-content' : 'dark-content'}
				backgroundColor={tokens.surface.base}
			/>
			<ScrollView contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 40, gap: 22 }}>
				<View pointerEvents='none' accessible={false} accessibilityElementsHidden importantForAccessibility='no-hide-descendants' style={{ width: portraitHeight / 1.5, height: portraitHeight }}>
					<Image source={require('./assets/mascot/portrait-cutout.png')} contentFit='contain' transition={0} style={{ width: '100%', height: '100%' }} />
				</View>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
					<Image source={require('./assets/icon.png')} accessible={false} contentFit='contain' transition={0} style={{ width: 44, height: 44 }} />
					<View style={{ gap: 3 }}>
						<Text style={{ fontSize: 26, fontWeight: '700', color: tokens.text.primary }}>音绘</Text>
						<Text style={{ fontSize: 11, letterSpacing: 2, color: tokens.text.secondary }}>MeloCanvas</Text>
					</View>
				</View>
				<View accessibilityLiveRegion='polite' style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
					<ActivityIndicator color={tokens.text.secondary} />
					<Text style={{ fontSize: 13, color: tokens.text.secondary, flexShrink: 1 }}>{label}</Text>
				</View>
			</ScrollView>
		</View>
	)
}

/** Only gate the first presentation. Later previews/resizes must not unmount pages. */
export function StartupContent({
	ready,
	mode,
	children,
}: PropsWithChildren<{ ready: boolean; mode: ColorMode }>) {
	const [opened, setOpened] = useState(false)
	useEffect(() => {
		if (ready) setOpened(true)
	}, [ready])
	return opened || ready ? <>{children}</> : <StartupSurface mode={mode} />
}
