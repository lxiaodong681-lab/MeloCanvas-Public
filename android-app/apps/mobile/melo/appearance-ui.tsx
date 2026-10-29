import { setBackgroundColorAsync } from 'expo-system-ui'
import React, { useEffect, type PropsWithChildren } from 'react'
import { StatusBar, View } from 'react-native'

import type { AppearanceState } from './appearance-preference'
import { builtInThemes } from './core/theme'
import {
	cosmosTheme,
	type AppearancePreference,
	type ColorMode,
} from './core/theme-appearance'
import { ControlTarget, Icon, T, ThemeProvider, useTheme } from './ui'

/** Covers the native root and database/account recovery before the theme package is available. */
export function AppearanceSurface({
	mode,
	children,
}: PropsWithChildren<{ mode: ColorMode }>) {
	const theme = mode === 'dark' ? cosmosTheme : builtInThemes.modern
	const color = theme.tokens.surface.base
	useEffect(() => {
		void setBackgroundColorAsync(color).catch(() => {})
	}, [color])
	return (
		<ThemeProvider value={theme}>
			<View style={{ flex: 1, backgroundColor: color }}>
				<StatusBar
					barStyle={mode === 'dark' ? 'light-content' : 'dark-content'}
					backgroundColor={color}
				/>
				{children}
			</View>
		</ThemeProvider>
	)
}

export function AppearanceSetting({
	appearance,
}: {
	appearance: AppearanceState & {
		mode: ColorMode
		set(value: AppearancePreference): Promise<void>
	}
}) {
	const c = useTheme().tokens
	return (
		<View style={{ paddingVertical: 12, gap: 4 }}>
			<T weight='600'>明暗模式</T>
			{(
				[
					['light', '浅色'],
					['dark', '深色'],
					['system', '跟随系统'],
				] as const
			).map(([value, label]) => (
				<ControlTarget
					key={value}
					accessibilityRole='radio'
					accessibilityLabel={label}
					accessibilityState={{
						checked: appearance.preference === value,
						disabled: appearance.saving,
					}}
					disabled={appearance.saving}
					onPress={() => {
						void appearance.set(value)
					}}
					style={{
						minHeight: 48,
						flexDirection: 'row',
						alignItems: 'center',
						justifyContent: 'space-between',
					}}
				>
					<T>{label}</T>
					{appearance.preference === value && (
						<Icon
							name='check'
							color={c.action.primary}
							size={20}
						/>
					)}
				</ControlTarget>
			))}
			<T
				muted
				size={12}
			>
				深色默认使用黑色宇宙外观。主题提供深色配色时优先使用，浅色主题选择会保留。
			</T>
			{!!appearance.error && (
				<View accessibilityLiveRegion='polite'>
					<T
						size={12}
						style={{ color: c.state.error }}
					>
						{appearance.error}
					</T>
				</View>
			)}
		</View>
	)
}
