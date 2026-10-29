import React, { type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'

import { builtInThemes, type ThemeKey } from './core/theme'
import { cosmosTheme, type ColorMode } from './core/theme-appearance'
import {
	Artwork,
	Card,
	ControlTarget,
	Icon,
	T,
	ThemeRendererProvider,
} from './ui'

export function ThemeWorkshop({
	themeKey,
	colorMode = 'light',
	mode,
	onSelect,
	disabled = false,
	children,
}: {
	themeKey: ThemeKey | null
	colorMode?: ColorMode
	mode: 'music' | 'listening'
	onSelect: (key: ThemeKey) => void
	disabled?: boolean
	children?: ReactNode
}) {
	return (
		<>
			{colorMode === 'dark' && <T muted size={12}>当前为深色模式。以下选择保留为浅色主题；深色默认显示宇宙外观。</T>}
			<T
				muted
				size={12}
				style={{ marginBottom: 18 }}
			>
				{mode === 'listening'
					? '切换主题保留收听进度。'
					: '切换主题保留当前播放和收藏。'}
			</T>
			{(['modern', 'pastoral', 'anime'] as const).map((key) => (
				<ControlTarget
					key={key}
					minimumWidthDp={themeKey === key ? 197 : 161}
					minimumHeightDp={99}
					accessibilityRole='button'
					accessibilityLabel={`应用${key === 'modern' ? '现代' : key === 'pastoral' ? '田园' : '动漫'}主题`}
					accessibilityState={{ selected: key === themeKey, disabled }}
					disabled={disabled}
					onPress={() => onSelect(key)}
					style={{ marginBottom: 13, opacity: disabled ? 0.5 : 1 }}
				>
					<ThemeRendererProvider
						theme={colorMode === 'dark' ? cosmosTheme : builtInThemes[key]}
						adapted={null}
						allowedImageUris={[]}
						reducedMotion={false}
					>
						<Card>
							<View style={[s.row, { gap: 14 }]}>
								<Artwork
									resource={builtInThemes[key].assets.hero}
									size={64}
									style={{ borderRadius: 8 }}
								/>
								<View style={{ flex: 1 }}>
									<T
										size={16}
										weight='700'
									>
										{builtInThemes[key].name}{' '}
										{key === 'modern'
											? '现代'
											: key === 'pastoral'
												? '田园'
												: '动漫'}
									</T>
									<T
										muted
										size={11}
									>
										{key === 'modern'
											? '暖白与朱红'
											: key === 'pastoral'
												? '米白与草木绿'
												: '浅紫与紫罗兰'}
									</T>
								</View>
								{themeKey === key && (
									<Icon
										name='check'
										color={builtInThemes[key].tokens.action.primary}
									/>
								)}
							</View>
						</Card>
					</ThemeRendererProvider>
				</ControlTarget>
			))}
			{children ?? (
				<T
					muted
					size={11}
				>
					第三方主题 ZIP
					安装将在后续开放。当前使用版本化主题契约，不执行主题脚本。
				</T>
			)}
		</>
	)
}

const s = StyleSheet.create({
	row: { flexDirection: 'row', alignItems: 'center' },
})
