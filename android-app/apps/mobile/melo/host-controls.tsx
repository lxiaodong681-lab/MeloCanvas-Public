import { usePlaybackProgress } from './usePlaybackProgress'
import type { PlaybackProgress } from './playback-progress'
import React, { type PropsWithChildren } from 'react'
import { StyleSheet, View } from 'react-native'
import Svg, { Path, Text as SvgText } from 'react-native-svg'

import type { ThemeControlRowStatus } from './theme-control-layout'
import {
	Artwork,
	ThemeNavigationBackground,
	Card,
	ControlRow,
	ControlTarget,
	Icon,
	IconButton,
	T,
	useTheme,
	useThemeRendering,
	useBuiltInVisuals,
	type IconName,
} from './ui'

export type HostTab = 'home' | 'search' | 'library' | 'profile'
/** Shared by the real player content and future isolated measurement containers. */
export const hostPlayerHorizontalPaddingDp = 24
export interface HostControlMeasurementProps {
	layoutRevision?: string | number
	onStatusChange?: (status: ThemeControlRowStatus) => void
	announceStatus?: boolean
}
export interface MiniPlayerControlsProps extends HostControlMeasurementProps {
	mode: 'music' | 'listening'
	title?: string
	artist?: string
	artwork?: string
	playing: boolean
	buffering: boolean
	error: string
	progress?: PlaybackProgress
	position: number
	duration: number
	onOpen: () => void
	onToggle: () => void
	onQueue: () => void
}

/** Presentation only: the host owns navigation, playback and cancellation. */
export function HostPlaybackFooter({
	mini,
	tab,
	bottomInset,
	onNavigate,
	layoutRevision,
	onNavigationStatusChange,
	onMiniStatusChange,
	announceStatus,
}: {
	mini: Omit<MiniPlayerControlsProps, keyof HostControlMeasurementProps> | null
	tab: HostTab
	bottomInset: number
	onNavigate: (destination: HostTab) => void
	layoutRevision?: string | number
	onNavigationStatusChange?: HostControlMeasurementProps['onStatusChange']
	onMiniStatusChange?: HostControlMeasurementProps['onStatusChange']
	announceStatus?: boolean
}) {
	return (
		<HostFooterFrame>
			{mini && (
				<MiniPlayerControls
					{...mini}
					layoutRevision={layoutRevision}
					onStatusChange={onMiniStatusChange}
					announceStatus={announceStatus}
				/>
			)}
			<MainNavigation
				tab={tab}
				bottomInset={bottomInset}
				onNavigate={onNavigate}
				layoutRevision={layoutRevision}
				onStatusChange={onNavigationStatusChange}
				announceStatus={announceStatus}
			/>
		</HostFooterFrame>
	)
}

export function HostFooterFrame({ children }: PropsWithChildren) {
	const theme = useTheme()
	return (
		<View
			style={{
				backgroundColor: theme.tokens.surface.base,
				paddingHorizontal: 10,
			}}
		>
			{children}
		</View>
	)
}

export function MiniPlayerControls(props: MiniPlayerControlsProps) {
	const theme = useTheme()
	const visual = useBuiltInVisuals()
	return (
		<Card
			emphasis
			style={{ padding: 6, marginBottom: 7, gap: 0 }}
		>
			<ControlRow
				layoutRevision={props.layoutRevision}
				onStatusChange={props.onStatusChange}
				announceStatus={props.announceStatus}
				controlMinWidthsDp={[props.mode === 'listening' ? 128 : 100, 48, 48]}
				style={styles.row}
			>
				<ControlTarget
					accessibilityRole='button'
					accessibilityLabel='打开当前播放器'
					onPress={props.onOpen}
					style={[styles.row, { flex: 1, minHeight: 48, gap: 10 }]}
				>
					<Artwork
						uri={props.artwork}
						size={40}
						fit={props.mode === 'listening' ? 'contain' : 'cover'}
						style={{
							width: props.mode === 'listening' ? 64 : 40,
							borderRadius: visual
								? 6
								: theme.components.card === 'rounded'
									? 23
									: 6,
						}}
					/>
					<View style={{ flex: 1 }}>
						<T
							size={12}
							weight='600'
							lines={1}
						>
							{props.title}
						</T>
						<T
							muted
							size={11}
							lines={1}
						>
							{props.error
								? '加载失败，打开播放器重试'
								: props.buffering
									? '正在缓冲…'
									: `${props.mode === 'listening' ? '听视频，' : ''}${props.artist?.replace(/\s*·\s*/g, '：') || '音绘'}`}
						</T>
					</View>
				</ControlTarget>
				<IconButton
					name={props.playing ? 'pause' : 'play'}
					label={props.playing ? '迷你播放器暂停' : '迷你播放器继续'}
					onPress={props.onToggle}
				/>
				<IconButton
					name='queue'
					label='打开播放队列'
					onPress={props.onQueue}
				/>
			</ControlRow>
			<MiniPlayerProgress progress={props.progress} position={props.position} duration={props.duration} />
		</Card>
	)
}

/** Progress ticks must not rerender the cover, buttons or themed control rows. */
function MiniPlayerProgress({ progress, position, duration }: Pick<MiniPlayerControlsProps, 'progress' | 'position' | 'duration'>) {
	const theme = useTheme()
	const progressColors = useThemeRendering()?.progress?.colors
	const live = usePlaybackProgress(progress, position, duration)
	return <View testID='mini-player-progress' style={{
		height: 2,
		width: `${Math.max(0, Math.min(100, live.duration ? (live.position / live.duration) * 100 : 0))}%`,
		backgroundColor: progressColors?.fill ?? theme.tokens.action.primary,
	}} />
}

export function MainNavigation({
	tab,
	bottomInset,
	onNavigate,
	layoutRevision,
	onStatusChange,
	announceStatus,
}: {
	tab: HostTab
	bottomInset: number
	onNavigate: (destination: HostTab) => void
} & HostControlMeasurementProps) {
	const theme = useTheme(),
		c = theme.tokens
	const visual = useBuiltInVisuals()
	const surfaceArt = useThemeRendering()?.surfaceArt
	const navigationArt = surfaceArt?.navigation
	const navigationColors = surfaceArt?.navigationColors
	const navigation = (
		<ControlRow
			layoutRevision={layoutRevision}
			onStatusChange={onStatusChange}
			announceStatus={announceStatus}
			navigation
			controlMinWidthsDp={[48, 48, 48, 48]}
			style={[
				styles.row,
				{ paddingBottom: Math.max(bottomInset, 6), paddingTop: 3 },
			]}
		>
			{(
				[
					{ id: 'home', label: '发现', icon: theme.components.discoverIcon },
					{ id: 'search', label: '搜索', icon: 'search' },
					{ id: 'library', label: '音乐库', icon: 'library' },
					{ id: 'profile', label: '我的', icon: 'user' },
				] as { id: HostTab; label: string; icon: IconName }[]
			).map((item) => (
				<ControlTarget
					minimumHeightDp={54}
					key={item.id}
					accessibilityRole='tab'
					accessibilityLabel={`导航${item.label}`}
					accessibilityState={{ selected: tab === item.id }}
					onPress={() => onNavigate(item.id)}
					style={{
						flex: 1,
						minHeight: 54,
						alignItems: 'center',
						justifyContent: 'center',
						gap: 3,
						...(visual
							? {
									borderRadius: theme.components.button === 'comic' ? 8 : 18,
									backgroundColor: 'transparent',
								}
							: {}),
					}}
				>
					<Icon
						name={item.icon}
						navigation
						selected={tab === item.id}
						size={navigationArt ? 28 : 21}
						color={tab === item.id ? (navigationColors?.selected ?? c.action.primary) : (navigationColors?.normal ?? c.text.secondary)}
					/>
					<T
						size={11}
						style={{
							color: tab === item.id ? (navigationColors?.selected ?? c.action.primary) : (navigationColors?.normal ?? c.text.secondary),
						}}
					>
						{item.label}
					</T>
				</ControlTarget>
			))}
		</ControlRow>
	)
	return navigationArt ? <View><ThemeNavigationBackground />{navigation}</View> : navigation
}

export function MusicTransportControls(
	props: {
		playing: boolean
		previousDisabled: boolean
		nextDisabled: boolean
		onOrderInfo: () => void
		playbackOrder?: string
		orderDisabled?: boolean
		onPrevious: () => void
		onToggle: () => void
		onNext: () => void
		onQueue: () => void
	} & HostControlMeasurementProps,
) {
	const c = useTheme().tokens
	return (
		<ControlRow
			layoutRevision={props.layoutRevision}
			onStatusChange={props.onStatusChange}
			announceStatus={props.announceStatus}
			controlMinWidthsDp={[48, 48, 68, 48, 48]}
			style={[
				styles.row,
				{ justifyContent: 'space-between', marginVertical: 10 },
			]}
		>
			<ControlTarget
				fixed
				accessibilityRole='button'
				accessibilityLabel={`切换播放模式：${props.playbackOrder === 'shuffle' ? '随机播放' : props.playbackOrder === 'repeat-one' ? '单曲循环' : '顺序播放'}`}
				disabled={props.orderDisabled || undefined}
				onPress={props.onOrderInfo}
				style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
			>
				{props.playbackOrder === 'shuffle' ? (
					<Svg width={22} height={22} viewBox='0 0 24 24' accessibilityElementsHidden>
						<Path d='M3 6h3c5 0 7 12 12 12h3m-3-3 3 3-3 3M3 18h3c2 0 4-3 6-6s4-6 6-6h3m-3-3 3 3-3 3' fill='none' stroke={c.text.primary} strokeWidth={1.7} strokeLinecap='round' strokeLinejoin='round' />
					</Svg>
				) : <Icon name='repeat' />}
				{props.playbackOrder === 'repeat-one' && <T size={10} style={{ position: 'absolute' }}>1</T>}
			</ControlTarget>
			<IconButton
				name='previous'
				label='上一首'
				disabled={props.previousDisabled}
				onPress={props.onPrevious}
			/>
			<IconButton
				large
				primary
				musicPrimary
				name={props.playing ? 'pause' : 'play'}
				label={props.playing ? '暂停播放' : '继续播放'}
				onPress={props.onToggle}
			/>
			<IconButton
				name='next'
				label='下一首'
				disabled={props.nextDisabled}
				onPress={props.onNext}
			/>
			<IconButton
				name='queue'
				label='播放队列'
				onPress={props.onQueue}
			/>
		</ControlRow>
	)
}

export function ListeningTransportControls(
	props: {
		speed: number
		playing: boolean
		switching: boolean
		onSpeed: () => void
		onBackward: () => void
		onToggle: () => void
		onForward: () => void
		onParts: () => void
	} & HostControlMeasurementProps,
) {
	return (
		<ControlRow
			layoutRevision={props.layoutRevision}
			onStatusChange={props.onStatusChange}
			announceStatus={props.announceStatus}
			controlMinWidthsDp={[48, 48, 68, 48, 48]}
			style={[
				styles.row,
				{ justifyContent: 'space-between', marginVertical: 10 },
			]}
		>
			<ControlTarget
				fixedWidth
				accessibilityRole='button'
				accessibilityLabel={`收听倍速 ${props.speed} 倍`}
				onPress={props.onSpeed}
				disabled={props.switching}
				style={styles.smallControl}
			>
				<T
					size={14}
					weight='600'
				>
					{props.speed}×
				</T>
			</ControlTarget>
			<SeekButton
				disabled={props.switching}
				onPress={props.onBackward}
			/>
			<IconButton
				primary
				large
				name={props.playing ? 'pause' : 'play'}
				label={props.playing ? '暂停收听' : '继续收听'}
				disabled={props.switching}
				onPress={props.onToggle}
			/>
			<SeekButton
				forward
				disabled={props.switching}
				onPress={props.onForward}
			/>
			<IconButton
				name='queue'
				label='选择分 P'
				onPress={props.onParts}
			/>
		</ControlRow>
	)
}

function SeekButton({
	forward = false,
	disabled,
	onPress,
}: {
	forward?: boolean
	disabled: boolean
	onPress: () => void
}) {
	const theme = useTheme()
	return (
		<ControlTarget
			accessibilityRole='button'
			accessibilityLabel={forward ? '前进15秒' : '后退15秒'}
			accessibilityState={{ disabled }}
			disabled={disabled}
			onPress={onPress}
			style={[styles.smallControl, { opacity: disabled ? 0.4 : 1 }]}
		>
			<Svg
				width={34}
				height={34}
				viewBox='0 0 36 36'
				accessibilityElementsHidden
				importantForAccessibility='no-hide-descendants'
			>
				<Path
					d='M10 7a13 13 0 1 1-5 13M10 2v8H2'
					transform={forward ? 'translate(36 0) scale(-1 1)' : undefined}
					stroke={theme.tokens.text.primary}
					strokeWidth={1.7}
					strokeLinecap='round'
					strokeLinejoin='round'
					fill='none'
				/>
				<SvgText
					x={18}
					y={23}
					fill={theme.tokens.text.primary}
					fontSize={12}
					fontWeight='600'
					textAnchor='middle'
				>
					15
				</SvgText>
			</Svg>
		</ControlTarget>
	)
}

const styles = StyleSheet.create({
	row: { flexDirection: 'row', alignItems: 'center' },
	smallControl: {
		minWidth: 48,
		minHeight: 48,
		alignItems: 'center',
		justifyContent: 'center',
	},
})
