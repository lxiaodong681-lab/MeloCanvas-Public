import { Image } from 'expo-image'
import React, {
	createContext,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type PropsWithChildren,
} from 'react'
import {
	ActivityIndicator,
	Pressable,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
	type TextStyle,
	type ViewStyle,
	type StyleProp,
	type PressableProps,
} from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { MascotArt, type MascotState } from './mascot-art'
export { MascotArt } from './mascot-art'

import { builtInVisuals } from './core/builtin-visuals'
import { builtInThemes, type ResolvedTheme } from './core/theme'
import { cosmosTheme } from './core/theme-appearance'
import type { AdaptedPackageTheme } from './core/theme-package-adapter'
import {
	MeasuredThemeControlRow,
	useThemeControlTarget,
	type MeasuredThemeControlRowProps,
} from './theme-control-layout'
import { createPackageRendering, type ThemeRendering } from './theme-renderer'

const Context = createContext<ResolvedTheme>(builtInThemes.modern)
export const ThemeProvider = Context.Provider
export const useTheme = () => useContext(Context)
const RenderingContext = createContext<ThemeRendering | null>(null)
export const useThemeRendering = () => useContext(RenderingContext)
// Installer snapshots clone built-ins. The provider, not an imported theme id,
// owns whether a presentation is built-in (adapted === null) or a package.
const BuiltInVisualContext = createContext<
	ReturnType<typeof builtInVisuals> | undefined
>(undefined)
export function useBuiltInVisuals() {
	const trusted = useContext(BuiltInVisualContext)
	const theme = useTheme()
	return trusted === undefined ? builtInVisuals(theme) : trusted
}

export function ControlRow(
	props: Omit<MeasuredThemeControlRowProps, 'policy' | 'errorColor'>,
) {
	const rendering = useThemeRendering()
	const theme = useTheme()
	return (
		<MeasuredThemeControlRow
			{...props}
			policy={rendering?.controlRowLayout ?? null}
			errorColor={theme.tokens.state.error}
		/>
	)
}

/** Responsive package controls wait until their actual row has a fit decision. */
export function ControlTarget({
	minimumWidthDp = 48,
	minimumHeightDp = 48,
	fixed = false,
	fixedWidth = false,
	...props
}: PressableProps & {
	minimumWidthDp?: number
	minimumHeightDp?: number
	fixed?: boolean
	/** Keep the resolved row width while allowing text to increase the height. */
	fixedWidth?: boolean
}) {
	const rendering = useThemeRendering()
	const target = useThemeControlTarget()
	const visual = useBuiltInVisuals()
	if (!rendering?.controlRowLayout)
		return visual ? (
			<Pressable
				{...props}
				style={(state) => {
					const supplied =
						typeof props.style === 'function' ? props.style(state) : props.style
					const flat = StyleSheet.flatten(supplied)
					return [
						supplied,
						{
							minWidth: Math.max(
								48,
								minimumWidthDp,
								typeof flat?.minWidth === 'number' ? flat.minWidth : 0,
							),
							minHeight: Math.max(
								48,
								minimumHeightDp,
								typeof flat?.minHeight === 'number' ? flat.minHeight : 0,
							),
							opacity: props.disabled
								? (flat?.opacity ?? 0.4)
								: state.pressed
									? typeof flat?.opacity === 'number'
										? Math.min(flat.opacity, 0.86)
										: (flat?.opacity ?? 0.86)
									: flat?.opacity,
						},
					]
				}}
			/>
		) : (
			<Pressable {...props} />
		)
	if (!target) {
		return (
			<ControlRow
				controlMinWidthsDp={[minimumWidthDp]}
				single={!fixed && !fixedWidth}
				style={
					fixed || fixedWidth
						? {
								width: Math.max(minimumWidthDp, rendering.buttonMinTouchDp),
								maxWidth: '100%',
							}
						: { alignSelf: 'stretch' }
				}
			>
				<ControlTarget
					{...props}
					minimumWidthDp={minimumWidthDp}
					minimumHeightDp={minimumHeightDp}
					fixed={fixed}
					fixedWidth={fixedWidth}
				/>
			</ControlRow>
		)
	}
	return (
		<Pressable
			{...props}
			style={(state) => [
				typeof props.style === 'function' ? props.style(state) : props.style,
				fixed
					? {
							width: Math.max(minimumWidthDp, target.minimumWidthDp),
							height: Math.max(minimumHeightDp, target.touchDp),
						}
					: fixedWidth
						? {
								width: Math.max(minimumWidthDp, target.minimumWidthDp),
								minHeight: Math.max(minimumHeightDp, target.touchDp),
							}
						: {
								minWidth: Math.max(minimumWidthDp, target.minimumWidthDp),
								minHeight: Math.max(minimumHeightDp, target.touchDp),
								flexGrow: target.fill ? 1 : undefined,
							},
			]}
		/>
	)
}

export function ThemeRendererProvider({
	theme,
	adapted,
	allowedImageUris,
	reducedMotion,
	children,
}: PropsWithChildren<{
	theme: ResolvedTheme
	adapted: AdaptedPackageTheme | null
	allowedImageUris: readonly string[]
	reducedMotion: boolean
}>) {
	const rendering = useMemo(
		() =>
			adapted
				? createPackageRendering(adapted, allowedImageUris, reducedMotion)
				: null,
		[adapted, allowedImageUris, reducedMotion],
	)
	const builtinVisual = useMemo(() => {
		const builtin = adapted
			? null
			: [...Object.values(builtInThemes), cosmosTheme].find(
					(candidate) => candidate.id === theme.id,
				)
		return builtin ? builtInVisuals(builtin) : null
	}, [adapted, theme.id])
	return (
		<RenderingContext.Provider value={rendering}>
			<BuiltInVisualContext.Provider value={builtinVisual}>
				<ThemeProvider value={theme}>{children}</ThemeProvider>
			</BuiltInVisualContext.Provider>
		</RenderingContext.Provider>
	)
}

export function PackageThemeProvider({
	adapted,
	allowedImageUris,
	reducedMotion,
	children,
}: PropsWithChildren<{
	adapted: AdaptedPackageTheme
	allowedImageUris: readonly string[]
	reducedMotion: boolean
}>) {
	return (
		<ThemeRendererProvider
			theme={adapted.theme}
			adapted={adapted}
			allowedImageUris={allowedImageUris}
			reducedMotion={reducedMotion}
		>
			{children}
		</ThemeRendererProvider>
	)
}

const art: Record<string, number> = {
	'assets/cosmos.png': require('./assets/cosmos.png'),
	'assets/coast.png': require('./assets/coast.png'),
	// Pre-render dense SVG patterns once; Android PictureDrawable replays them on scroll.
	'assets/meadow.svg': require('./assets/meadow.png'),
	'assets/orbit.svg': require('./assets/orbit.png'),
	'assets/botanical.svg': require('./assets/botanical.svg'),
	'assets/starfield.svg': require('./assets/starfield.svg'),
}
const shapes = {
	home: 'M3 11 12 3l9 8M5 10v10h5v-6h4v6h5V10',
	search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
	library: 'M4 4v16M9 4v16M14 5l5-1 3 15-5 1z',
	user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2',
	play: 'm8 4 12 8-12 8z',
	pause: 'M8 5v14M16 5v14',
	next: 'm5 5 10 7-10 7zM19 5v14',
	previous: 'm19 5-10 7 10 7zM5 5v14',
	down: 'm6 9 6 6 6-6',
	back: 'm15 5-7 7 7 7',
	close: 'm6 6 12 12M6 18 18 6',
	heart:
		'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z',
	queue: 'M4 5h16M4 11h10M4 17h7m5-3 5 3-5 3z',
	repeat: 'M4 9V6h15l-3-3m3 3-3 3M20 15v3H5l3 3m-3-3 3-3',
	flower:
		'M12 8c-9-12-14 2-5 4-12 5 0 15 5 5 5 10 17 0 5-5 9-2 4-16-5-4M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
	star: 'm12 2 3 6 7 1-5 5 1 8-6-4-6 4 1-8-5-5 7-1z',
	music:
		'M9 18V5l11-2v13M9 8l11-2M9 18c0 4-7 4-7 1s7-4 7-1M20 16c0 4-7 4-7 1s7-4 7-1',
	info: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 11v6M12 7v.1',
	check: 'm4 12 5 5L20 6',
	arrow: 'm9 5 7 7-7 7',
}
export type IconName = keyof typeof shapes
export function Icon({
	name,
	color,
	size = 22,
	filled = false,
	selected = false,
	themed = true,
	navigation = false,
}: {
	name: IconName
	color?: string
	size?: number
	filled?: boolean
	selected?: boolean
	/** Input affordances can retain their literal symbol while navigation uses artwork. */
	themed?: boolean
	navigation?: boolean
}) {
	const theme = useTheme()
	const rendering = useThemeRendering()
	const navigationIcon = ['home', 'search', 'library', 'user'].includes(name)
	const uri = themed && (!navigationIcon || navigation) ? rendering?.resolveIcon(name, selected) : undefined
	const [previous, setImage] = useState(() => ({
		rendering,
		uri,
		generation: 0,
	}))
	let image = previous
	if (previous.rendering !== rendering || previous.uri !== uri) {
		image = { rendering, uri, generation: previous.generation + 1 }
		setImage(image)
	}
	const vector = (
		<Svg
			width={size}
			height={size}
			viewBox='0 0 24 24'
			accessibilityElementsHidden
			importantForAccessibility='no-hide-descendants'
		>
			<Path
				d={shapes[name]}
				fill={filled ? (color ?? theme.tokens.action.primary) : 'none'}
				stroke={color ?? theme.tokens.text.primary}
				strokeWidth={theme.components.card === 'comic' ? 2 : 1.7}
				strokeLinecap='round'
				strokeLinejoin='round'
			/>
		</Svg>
	)
	return uri ? (
		<PackageIconImage
			key={image.generation}
			uri={uri}
			size={size}
			fallback={vector}
		/>
	) : (
		vector
	)
}

/** A keyed image leaf cannot publish an old load error into its replacement. */
export function PackageIconImage({
	uri,
	size,
	fallback,
}: {
	uri: string
	size: number
	fallback: React.ReactNode
}) {
	const [failed, setFailed] = useState(false)
	const active = useRef(false)
	useLayoutEffect(() => {
		active.current = true
		return () => {
			active.current = false
		}
	}, [])
	return failed ? (
		fallback
	) : (
		<Image
			source={uri}
			contentFit='contain'
			cachePolicy='memory-disk'
			transition={0}
			style={{ width: size, height: size }}
			accessible={false}
			accessibilityElementsHidden
			importantForAccessibility='no-hide-descendants'
			pointerEvents='none'
			onError={() => {
				if (active.current) setFailed(true)
			}}
		/>
	)
}
export function T({
	children,
	muted,
	size,
	weight,
	style,
	lines,
	variant,
}: PropsWithChildren<{
	muted?: boolean
	size?: number
	weight?: TextStyle['fontWeight']
	style?: StyleProp<TextStyle>
	lines?: number
	variant?: 'title' | 'section' | 'body' | 'caption'
}>) {
	const theme = useTheme()
	const { fontScale } = useWindowDimensions()
	const presets = {
		title: { size: 25, weight: '700', leading: 1.25 },
		section: { size: 18, weight: '700', leading: 1.4 },
		body: { size: 14, weight: '400', leading: 1.5 },
		caption: { size: 12, weight: '400', leading: 1.5 },
	} as const
	const preset = variant ? presets[variant] : undefined
	const fontSize = size ?? preset?.size ?? 14
	return (
		<Text
			// Fabric can retain the pre-configuration text measure after Android
			// font changes. Refresh only this native text, preserving page state.
			key={fontScale}
			numberOfLines={lines}
			accessibilityRole={
				variant === 'title' || variant === 'section' ? 'header' : undefined
			}
			style={[
				{
					color:
						(muted ?? variant === 'caption')
							? theme.tokens.text.secondary
							: theme.tokens.text.primary,
					fontSize,
					lineHeight: fontSize * (preset?.leading ?? 1.45),
					fontWeight: weight ?? preset?.weight,
				},
				style,
			]}
		>
			{children}
		</Text>
	)
}
export function shape(variant: ResolvedTheme['components']['card']): ViewStyle {
	return variant === 'leaf'
		? {
				borderTopLeftRadius: 26,
				borderTopRightRadius: 8,
				borderBottomLeftRadius: 8,
				borderBottomRightRadius: 26,
			}
		: { borderRadius: variant === 'comic' ? 8 : 17 }
}
export function Card({
	children,
	style,
	emphasis = false,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle>; emphasis?: boolean }>) {
	const t = useTheme()
	const visual = useBuiltInVisuals()
	return (
		<View
			style={[
				shape(t.components.card),
				{
					padding: visual && emphasis ? 20 : 16,
					gap: 12,
					backgroundColor: t.tokens.surface.card,
					borderWidth:
						visual && t.components.card === 'comic'
							? 1.25
							: t.components.card === 'comic'
								? 1.5
								: 1,
					borderColor: visual
						? emphasis
							? t.tokens.border.strong
							: t.tokens.border.subtle
						: t.components.card === 'rounded'
							? t.tokens.surface.card
							: t.tokens.border.strong,
					boxShadow: visual
						? undefined
						: t.components.card === 'comic'
							? `3px 4px 0 ${t.tokens.border.subtle}`
							: `0px 5px 12px ${t.tokens.border.subtle}44`,
				},
				visual
					? {
							borderRadius: 12,
							borderTopLeftRadius: 12,
							borderTopRightRadius: 12,
							borderBottomLeftRadius: 12,
							borderBottomRightRadius: 12,
							padding: 14,
							borderWidth: 1,
							borderColor: t.tokens.border.subtle,
						}
					: undefined,
				style,
			]}
		>
			{children}
		</View>
	)
}
export function IconButton({
	name,
	label,
	onPress,
	active,
	primary,
	disabled,
	large,
	musicPrimary,
	testID,
}: {
	name: IconName
	label: string
	onPress: () => void
	active?: boolean
	primary?: boolean
	disabled?: boolean
	large?: boolean
	/** Only the music player’s central transport receives the original soft glow. */
	musicPrimary?: boolean
	testID?: string
}) {
	const t = useTheme()
	const visual = useBuiltInVisuals()
	return (
		<ControlTarget
			fixed
			minimumWidthDp={large ? 68 : 48}
			minimumHeightDp={large ? 68 : 48}
			accessibilityRole='button'
			accessibilityLabel={label}
			accessibilityState={{ disabled, selected: active }}
			testID={testID}
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => [
				{
					width: large ? 68 : 48,
					height: large ? 68 : 48,
					justifyContent: 'center',
					alignItems: 'center',
					opacity: disabled ? 0.4 : pressed ? (visual ? 0.86 : 0.65) : 1,
					...(visual && !primary
						? {
								backgroundColor:
									active || pressed ? t.tokens.surface.tinted : undefined,
								borderRadius: 24,
							}
						: {}),
				},
				primary
					? {
							...shape(t.components.button),
							borderRadius:
								t.components.button === 'rounded'
									? 40
									: t.components.button === 'comic'
										? 12
										: undefined,
							backgroundColor: t.tokens.action.primary,
							transform:
								t.components.button === 'comic' ? [{ rotate: '-4deg' }] : [],
							boxShadow:
								t.components.button === 'comic'
									? `3px 4px 0 ${t.tokens.border.strong}`
									: musicPrimary && visual?.modern
										? `0px 8px 22px ${t.tokens.action.primary}38`
										: undefined,
						}
					: undefined,
				visual && primary
					? {
							borderRadius: large ? 40 : 24,
							borderTopLeftRadius: large ? 40 : 24,
							borderTopRightRadius: large ? 40 : 24,
							borderBottomLeftRadius: large ? 40 : 24,
							borderBottomRightRadius: large ? 40 : 24,
							transform: [],
							boxShadow: undefined,
						}
					: undefined,
			]}
		>
			<Icon
				name={name}
				selected={active}
				size={large ? 29 : 22}
				color={
					primary
						? t.tokens.text.inverse
						: active
							? t.tokens.action.primary
							: t.tokens.text.primary
				}
				filled={name === 'play' || (name === 'heart' && active)}
			/>
		</ControlTarget>
	)
}
export function Button({
	children,
	onPress,
	secondary,
	disabled,
	testID,
}: PropsWithChildren<{
	onPress: () => void
	secondary?: boolean
	disabled?: boolean
	testID?: string
}>) {
	const t = useTheme()
	const rendering = useThemeRendering()
	const visual = useBuiltInVisuals()
	return (
		<ControlTarget
			testID={testID}
			accessibilityRole='button'
			disabled={disabled}
			accessibilityState={{ disabled }}
			onPress={onPress}
			style={({ pressed }) => [
				shape(t.components.button),
				{
					...(visual
						? {
								...(t.components.button === 'rounded'
									? { borderRadius: 24 }
									: {}),
								borderWidth:
									secondary || t.components.button === 'comic' ? 1 : 0,
								borderColor: secondary
									? t.tokens.border.strong
									: t.tokens.action.primary,
								boxShadow:
									!disabled && !secondary && t.components.button === 'comic'
										? `2px ${pressed ? 1 : 3}px 0 ${t.tokens.border.strong}`
										: undefined,
							}
						: {}),
					paddingVertical: 13,
					paddingHorizontal: 20,
					minHeight: 48,
					minWidth: rendering?.buttonMinTouchDp,
					alignItems: 'center',
					justifyContent: 'center',
					backgroundColor: secondary
						? t.tokens.surface.tinted
						: t.tokens.action.primary,
					opacity: disabled ? 0.4 : pressed ? (visual ? 0.86 : 0.65) : 1,
				},
				visual
					? {
							borderRadius: 10,
							borderTopLeftRadius: 10,
							borderTopRightRadius: 10,
							borderBottomLeftRadius: 10,
							borderBottomRightRadius: 10,
							paddingVertical: 10,
							paddingHorizontal: 16,
							backgroundColor: secondary
								? t.tokens.surface.card
								: t.tokens.action.primary,
							borderColor: t.tokens.border.subtle,
							boxShadow: undefined,
						}
					: undefined,
			]}
		>
			<T
				weight='600'
				style={{
					color: secondary ? t.tokens.action.primary : t.tokens.text.inverse,
					textAlign: 'center',
				}}
			>
				{children}
			</T>
		</ControlTarget>
	)
}
export function Artwork({
	uri,
	resource,
	size,
	style,
	fit = 'cover',
}: {
	uri?: string
	resource?: string
	size?: number
	style?: StyleProp<ViewStyle>
	fit?: 'cover' | 'contain'
}) {
	const t = useTheme()
	const rendering = useThemeRendering()
	const key = resource ?? t.assets.hero
	const localSource = Object.prototype.hasOwnProperty.call(art, key)
		? art[key]
		: rendering?.resolveResource(key)
	const [failed, setFailed] = React.useState(false)
	React.useEffect(() => setFailed(false), [uri, localSource])
	if (failed || (!uri && !localSource))
		return (
			<View
				style={[
					{
						width: size,
						height: size,
						backgroundColor: t.tokens.surface.tinted,
						alignItems: 'center',
						justifyContent: 'center',
					},
					style,
				]}
			>
				<Icon
					name='music'
					color={t.tokens.action.primary}
					size={32}
				/>
			</View>
		)
	return (
		<View
			style={[
				{
					width: size,
					height: size,
					backgroundColor: t.tokens.surface.tinted,
					overflow: 'hidden',
				},
				style,
			]}
		>
			<Image
				source={uri || localSource}
				contentFit={fit}
				transition={rendering?.transitionMs}
				onError={() => setFailed(true)}
				style={StyleSheet.absoluteFill}
				accessible={false}
			/>
		</View>
	)
}
export function ThemeBanner() {
	const source = useThemeRendering()?.surfaceArt?.banner
	return source ? <View testID='theme-banner' pointerEvents='none' style={{ width: '100%', aspectRatio: 1.6, borderRadius: 18, overflow: 'hidden', marginBottom: 16 }}>
		<Image source={source} contentFit='cover' contentPosition={{ top: '25%', left: '50%' }} transition={0} style={StyleSheet.absoluteFill} accessible={false} />
	</View> : null
}

export function ThemeNavigationBackground() {
	const source = useThemeRendering()?.surfaceArt?.navigation
	return source ? <View testID='theme-navigation-background' pointerEvents='none' style={StyleSheet.absoluteFill}>
		<Image source={source} contentFit='fill' transition={0} style={StyleSheet.absoluteFill} accessible={false} />
	</View> : null
}

/** Profile cover only; secondary pages use the shared wallpaper without a separate header strip. */
export function ThemePageArtwork({ compact = false, profile = false }: { compact?: boolean; profile?: boolean }) {
	const surfaceArt = useThemeRendering()?.surfaceArt
	const source = profile && !compact ? surfaceArt?.profileBackground : undefined
	return source ? <View testID='theme-page-artwork' pointerEvents='none' style={{ width: '100%', height: profile && surfaceArt?.profileBackground ? 200 : compact ? 28 : 72, borderRadius: 12, overflow: 'hidden', marginBottom: compact ? 8 : 14 }}>
		<Image source={source} contentFit='cover' contentPosition={profile && surfaceArt?.profileBackground ? { top: '15%', left: '50%' } : undefined} transition={0} style={StyleSheet.absoluteFill} accessible={false} />
	</View> : null
}

/** Player wallpaper is provided by the app backdrop; page headers stay on browsing pages. */
export function PlayerBackdrop() {
	return null
}
export function Backdrop() {
	const t = useTheme()
	const rendering = useThemeRendering()
	const visual = useBuiltInVisuals()
	const resource = t.assets.backdrop
	const source = resource
		? Object.prototype.hasOwnProperty.call(art, resource)
			? art[resource]
			: rendering?.resolveResource(resource)
		: undefined
	return source && !visual ? (
		<View
			pointerEvents='none'
			style={
				visual
					? [StyleSheet.absoluteFill, { opacity: 0.72 }]
					: StyleSheet.absoluteFill
			}
		>
			<Image
				source={source}
				contentFit='cover'
				transition={rendering?.transitionMs}
				style={StyleSheet.absoluteFill}
			/>
		</View>
	) : null
}
export function LyricLine({
	active,
	children,
}: PropsWithChildren<{ active?: boolean }>) {
	const theme = useTheme()
	const rendering = useThemeRendering()
	return (
		<T
			size={active ? 19 : 15}
			weight={active ? '700' : '400'}
			style={{
				color: active
					? (rendering?.lyricTokens.active ?? theme.tokens.text.primary)
					: (rendering?.lyricTokens.inactive ?? theme.tokens.text.secondary),
			}}
		>
			{children}
		</T>
	)
}
export function State({
	title,
	message,
	busy,
	retry,
	mascot,
}: {
	title: string
	message?: string
	busy?: boolean
	retry?: () => void
	mascot?: MascotState
}) {
	const t = useTheme()
	return (
		<View
			style={{
				paddingVertical: 38,
				paddingHorizontal: 16,
				gap: 12,
				alignItems: 'center',
			}}
			accessibilityLiveRegion='polite'
		>
			{mascot ? (
				<MascotArt state={mascot} />
			) : busy ? (
				<ActivityIndicator
					size='large'
					color={t.tokens.action.primary}
				/>
			) : (
				<Icon
					name='music'
					size={46}
					color={t.tokens.action.primary}
				/>
			)}
			{mascot && busy && <ActivityIndicator accessibilityLabel='正在加载' color={t.tokens.action.primary} />}
			<T
				size={18}
				weight='600'
			>
				{title}
			</T>
			{message && (
				<T
					muted
					style={{ textAlign: 'center' }}
				>
					{message}
				</T>
			)}
			{retry && <Button onPress={retry}>重试</Button>}
		</View>
	)
}
export const time = (seconds: number) =>
	`${Math.floor(Math.max(0, seconds) / 60)
		.toString()
		.padStart(2, '0')}:${Math.floor(Math.max(0, seconds) % 60)
		.toString()
		.padStart(2, '0')}`
