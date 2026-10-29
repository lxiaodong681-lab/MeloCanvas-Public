import React from 'react'
import {
	StyleSheet,
	Switch,
	View,
	useWindowDimensions,
	type SwitchProps,
} from 'react-native'

import {
	Artwork,
	ThemeBanner,
	ControlRow,
	ControlTarget,
	Icon,
	T,
	shape,
	useTheme,
	useThemeRendering,
	useBuiltInVisuals,
} from './ui'

export function HomeHeader({ onThemes }: { onThemes: () => void }) {
	const theme = useTheme(),
		c = theme.tokens
	const { fontScale } = useWindowDimensions()
	const flexibleText = !!useThemeRendering()?.controlRowLayout || fontScale > 1
	const banner = useThemeRendering()?.surfaceArt?.banner
	const header = (
		<View
			style={[
				styles.row,
				{ justifyContent: 'space-between', marginBottom: 14 },
			]}
		>
			<View style={flexibleText ? { flex: 1, minWidth: 0 } : undefined}>
				<T
					size={24}
					weight='700'
					style={{ marginTop: 5 }}
				>
					发现音乐
				</T>
			</View>
			<ControlTarget
				minimumWidthDp={48}
				fixed
				accessibilityRole='button'
				accessibilityLabel='打开主题工坊'
				onPress={onThemes}
				style={{
					width: 48,
					height: 48,
					borderRadius: 24,
					alignItems: 'center',
					justifyContent: 'center',
					backgroundColor: c.surface.tinted,
				}}
			>
				<T
					size={27}
					style={{
						color: c.action.primary,
						fontStyle: 'italic',
						fontFamily: 'serif',
					}}
				>
					m
				</T>
			</ControlTarget>
		</View>
	)
	return banner ? <View><ThemeBanner />{header}</View> : header
}
export function HomeSearchEntry({
	channel,
	onPress,
}: {
	channel: 'music' | 'listening'
	onPress: () => void
}) {
	const theme = useTheme(),
		c = theme.tokens
	const { fontScale } = useWindowDimensions()
	const flexibleText = !!useThemeRendering()?.controlRowLayout || fontScale > 1
	return (
		<ControlTarget
			minimumWidthDp={152}
			accessibilityRole='button'
			accessibilityLabel={
				channel === 'listening' ? '搜索听视频或 BV 号' : '搜索歌曲或 BV 号'
			}
			onPress={onPress}
			style={[
				styles.row,
				shape(theme.components.input),
				{
					minHeight: 48,
					gap: 10,
					paddingHorizontal: 14,
					borderWidth: 1,
					borderColor: c.border.subtle,
					backgroundColor: c.surface.card,
				},
			]}
		>
			<Icon
				name='search' themed={false}
				color={c.text.secondary}
				size={19}
			/>
			<T
				muted
				size={12}
				style={flexibleText ? { flex: 1, minWidth: 0 } : undefined}
			>
				{channel === 'listening'
					? '搜索视频、UP 主或 BV 号'
					: '搜索歌曲、关键词或 BV 号'}
			</T>
		</ControlTarget>
	)
}
export function HomeDiscoveryTabs({
	channel,
	onMusic,
	onListening,
}: {
	channel: 'music' | 'listening'
	onMusic: () => void
	onListening: () => void
}) {
	const { fontScale } = useWindowDimensions()
	const flexibleText = !!useThemeRendering()?.controlRowLayout || fontScale > 1
	return (
		<ControlRow
			controlMinWidthsDp={[72, 60]}
			gapDp={24}
			style={[styles.row, { marginTop: 8, marginBottom: 1, gap: 24 }]}
		>
			<ControlTarget
				accessibilityRole='tab'
				accessibilityLabel='发现音乐'
				accessibilityState={{ selected: channel === 'music' }}
				onPress={onMusic}
				style={{
					minHeight: 48,
					justifyContent: 'center',
					...(flexibleText ? { flex: 1 } : {}),
				}}
			>
				<T
					size={13}
					weight={channel === 'music' ? '700' : '400'}
					muted={channel !== 'music'}
				>
					音乐
				</T>
			</ControlTarget>
			<ControlTarget
				accessibilityRole='tab'
				accessibilityLabel='发现听视频'
				accessibilityState={{
					selected: channel === 'listening',
				}}
				onPress={onListening}
				style={{
					minHeight: 48,
					justifyContent: 'center',
					...(flexibleText ? { flex: 1 } : {}),
				}}
			>
				<T
					size={13}
					weight={channel === 'listening' ? '700' : '400'}
					muted={channel !== 'listening'}
				>
					听视频
				</T>
			</ControlTarget>
		</ControlRow>
	)
}
/** A search shortcut, not a playable collection or recommendation. */
export function HomeMusicHero({ onPress }: { onPress: () => void }) {
	const theme = useTheme(),
		c = theme.tokens
	return (
		<ControlTarget
			minimumWidthDp={180}
			minimumHeightDp={72}
			accessibilityRole='button'
			accessibilityLabel='搜索更多音乐'
			onPress={onPress}
			style={[
				shape(theme.components.card),
				{
					flexDirection: 'row',
					alignItems: 'center',
					gap: 12,
					padding: 12,
					minHeight: 72,
					backgroundColor: c.surface.card,
				},
			]}
		>
			<Artwork
				resource={theme.assets.hero}
				size={48}
			/>
			<View style={{ flex: 1, minWidth: 0 }}>
				<T
					size={14}
					weight='600'
				>
					搜索音乐
				</T>
				<T
					size={11}
					muted
					style={{ marginTop: 4 }}
				>
					搜索歌曲、歌手或 BV 号
				</T>
			</View>
			<Icon
				name='search' themed={false}
				color={c.text.secondary}
				size={20}
			/>
		</ControlTarget>
	)
}
export function HomeLocalFeatures({
	onRecommendations,
	onFm,
}: {
	onRecommendations: () => void
	onFm: () => void
}) {
	const c = useTheme().tokens
	const imported = !useBuiltInVisuals()
	return (
		<ControlRow
			controlMinWidthsDp={[124, 124]}
			gapDp={12}
			style={{ flexDirection: 'row', gap: 12, marginVertical: 16 }}
		>
			{[
				{
					title: '每日推荐',
					label: '打开每日推荐',
					detail: '来自本机收藏',
					icon: 'star' as const,
					onPress: onRecommendations,
				},
				{
					title: '私人 FM',
					label: '打开私人 FM',
					detail: '连续播放',
					icon: 'music' as const,
					onPress: onFm,
				},
			].map((item) => (
				<ControlTarget
					key={item.label}
					minimumWidthDp={124}
					accessibilityRole='button'
					accessibilityLabel={item.label}
					onPress={item.onPress}
					style={{
						flex: 1,
						minHeight: 76,
						borderRadius: 12,
						backgroundColor: imported ? c.surface.card : c.surface.tinted,
						padding: 12,
						flexDirection: 'row',
						alignItems: 'center',
						gap: 10,
					}}
				>
					<Icon
						name={item.icon}
						color={c.action.primary}
						size={21}
					/>
					<View style={{ flex: 1, minWidth: 0 }}>
						<T
							size={13}
							weight='600'
						>
							{item.title}
						</T>
						<T
							muted
							size={11}
							style={{ marginTop: 4, color: c.text.primary }}
						>
							{item.detail}
						</T>
					</View>
				</ControlTarget>
			))}
		</ControlRow>
	)
}
export function HomeShortcuts({
	onLikes,
	onRecent,
	onLocal,
	onOffline,
}: {
	onLikes: () => void
	onRecent: () => void
	onLocal: () => void
	onOffline: () => void
}) {
	const c = useTheme().tokens
	return (
		<ControlRow
			controlMinWidthsDp={[54, 54, 54, 54]}
			gapDp={8}
			style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}
		>
			{[
				{ name: 'heart' as const, label: '喜欢', onPress: onLikes },
				{ name: 'repeat' as const, label: '最近', onPress: onRecent },
				{ name: 'library' as const, label: '本地', onPress: onLocal },
				{ name: 'down' as const, label: '下载', onPress: onOffline },
			].map((item) => (
				<ControlTarget
					key={item.label}
					accessibilityRole='button'
					accessibilityLabel={'打开' + item.label}
					onPress={item.onPress}
					minimumWidthDp={54}
					style={{
						flex: 1,
						minHeight: 68,
						alignItems: 'center',
						justifyContent: 'center',
						gap: 8,
					}}
				>
					<Icon
						name={item.name}
						color={c.action.primary}
						size={22}
					/>
					<T size={12}>{item.label}</T>
				</ControlTarget>
			))}
		</ControlRow>
	)
}
export function ReducedMotionSetting({
	value,
	onValueChange,
	disabled,
}: {
	value: boolean
	onValueChange: (value: boolean) => void
	disabled?: boolean
}) {
	const c = useTheme().tokens
	const responsive = !!useThemeRendering()?.controlRowLayout
	return (
		<View style={{ paddingVertical: 12 }}>
			<View style={[styles.row, { justifyContent: 'space-between' }]}>
				<T style={responsive ? { flex: 1, minWidth: 0 } : undefined}>
					减少动态效果
				</T>
				<AppMotionSwitch
					accessibilityLabel='减少动态效果'
					value={value}
					trackColor={{ true: c.action.primary, false: c.border.strong }}
					onValueChange={onValueChange}
					disabled={disabled}
				/>
			</View>
			<T
				muted
				size={11}
			>
				同时遵循系统无障碍设置
			</T>
		</View>
	)
}
export function AppQueueItem({
	index,
	selected,
	label,
	title,
	artist,
	artwork,
	mode,
	onPress,
	onLongPress,
	disabled,
}: {
	index: number
	selected: boolean
	label: string
	title?: string
	artist?: string
	artwork?: string
	mode: 'music' | 'listening'
	onPress: () => void
	onLongPress?: () => void
	disabled?: boolean
}) {
	const c = useTheme().tokens
	return (
		<ControlTarget
			minimumWidthDp={180}
			accessibilityRole='button'
			accessibilityState={{
				selected: selected,
			}}
			accessibilityLabel={label}
			accessibilityHint={onLongPress ? '长按设为下一首播放' : undefined}
			disabled={disabled}
			onPress={onPress}
			onLongPress={onLongPress}
			style={[
				styles.row,
				{
					gap: 12,
					paddingVertical: 12,
					borderBottomWidth: 1,
					borderBottomColor: c.border.subtle,
				},
			]}
		>
			<T
				muted
				size={12}
			>
				{String(index + 1).padStart(2, '0')}
			</T>
			<Artwork
				uri={artwork}
				size={44}
				fit={mode === 'listening' ? 'contain' : 'cover'}
				style={{ borderRadius: 6 }}
			/>
			<View style={{ flex: 1 }}>
				<T
					size={13}
					weight={selected ? '700' : '400'}
					lines={2}
				>
					{title}
				</T>
				<T
					muted
					size={10}
					lines={1}
				>
					{artist}
				</T>
			</View>
			{selected && (
				<Icon
					name='music'
					color={c.action.primary}
				/>
			)}
		</ControlTarget>
	)
}
export function AppMotionSwitch(props: SwitchProps) {
	const rendering = useThemeRendering()
	if (!rendering?.controlRowLayout) return <Switch {...props} />
	return (
		<ControlRow
			controlMinWidthsDp={[48]}
			single
			style={{
				width: Math.max(48, rendering.buttonMinTouchDp),
				maxWidth: '100%',
				flexShrink: 0,
			}}
		>
			<ControlTarget
				fixed
				accessibilityRole='switch'
				accessibilityLabel={props.accessibilityLabel}
				accessibilityState={{
					checked: !!props.value,
					disabled: !!props.disabled,
				}}
				disabled={props.disabled}
				onPress={() => {
					if (!props.disabled) void props.onValueChange?.(!props.value)
				}}
				style={{ alignItems: 'center', justifyContent: 'center' }}
			>
				<Switch
					{...props}
					pointerEvents='none'
					accessible={false}
					accessibilityElementsHidden
					importantForAccessibility='no-hide-descendants'
					onValueChange={undefined}
				/>
			</ControlTarget>
		</ControlRow>
	)
}
const styles = StyleSheet.create({
	row: { flexDirection: 'row', alignItems: 'center' },
})
