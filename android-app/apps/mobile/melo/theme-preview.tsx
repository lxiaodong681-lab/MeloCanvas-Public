import React, { useState } from 'react'
import { ScrollView, View } from 'react-native'

import { Progress } from './progress'
import { HostFooterFrame, MainNavigation } from './host-controls'

import type { AdaptedPackageTheme } from './core/theme-package-adapter'
import { builtInThemes, type ResolvedTheme } from './core/theme'
import {
	Artwork,
	ThemeBanner,
	ThemePageArtwork,
	Backdrop,
	ControlTarget,
	Card,
	Icon,
	IconButton,
	LyricLine,
	ThemeRendererProvider,
	State,
	T,
	shape,
	useTheme,
} from './ui'

const pages = [
	['home', '首页'],
	['player', '播放器'],
	['search', '搜索'],
	['error', '错误'],
	['library', '音乐库'],
	['profile', '我的'],
] as const
type PreviewPage = (typeof pages)[number][0]

/** Fixed reference content with local-only controls; never receives player/library. */
export function ThemeReferencePreview({
	adapted,
	fallbackTheme = builtInThemes.modern,
	allowedImageUris,
	reducedMotion,
}: {
	adapted: AdaptedPackageTheme | null
	fallbackTheme?: ResolvedTheme
	allowedImageUris: readonly string[]
	reducedMotion: boolean
}) {
	const [page, setPage] = useState<PreviewPage>('home')
	return (
		<ThemeRendererProvider
			theme={adapted?.theme ?? fallbackTheme}
			adapted={adapted}
			allowedImageUris={allowedImageUris}
			reducedMotion={reducedMotion}
		>
			<View style={{ gap: 12 }}>
				<PreviewTabs page={page} onSelect={setPage} />
				<ReferencePage page={page} />
			</View>
		</ThemeRendererProvider>
	)
}

function PreviewTabs({ page, onSelect }: { page: PreviewPage; onSelect: (page: PreviewPage) => void }) {
	const c = useTheme().tokens
	return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 16 }}>
		{pages.map(([key, label]) => <ControlTarget key={key} fixedWidth accessibilityRole='tab' accessibilityLabel={'预览' + label} accessibilityState={{ selected: page === key }} onPress={() => onSelect(key)} style={{ minHeight: 48, paddingHorizontal: 8, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: page === key ? c.action.primary : 'transparent' }}>
			<T size={13} weight={page === key ? '700' : '400'} style={{ color: page === key ? c.action.primary : c.text.secondary }}>{label}</T>
		</ControlTarget>)}
	</ScrollView>
}

function ReferencePage({ page }: { page: PreviewPage }) {
	const theme = useTheme()
	const colors = theme.tokens
	return (
		<View
			testID={`theme-preview-${page}`}
			style={{
				...shape(theme.components.card),
				backgroundColor: colors.surface.base,
				minHeight: 300,
				padding: 16,
				gap: 16,
				overflow: 'hidden',
			}}
		>
			<Backdrop />
			{page !== 'home' && <ThemePageArtwork compact={page === 'player'} profile={page === 'profile'} />}
			{page === 'home' ? (
				<>
					<ThemeBanner />
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
						<T
							size={22}
							weight='700'
						>
							发现音乐
						</T>
					</View>
					<Artwork
						resource='assets/coast.png'
						size={160}
						style={shape(theme.components.card)}
					/>
					<Card>
						<T
							size={18}
							weight='600'
						>
							海岸线的回声
						</T>
						<T muted>示例 UP 主，固定参考内容</T>
					</Card>
				</>
			) : page === 'player' ? (
				<ReferencePlayer />
			) : page === 'search' ? (
				<>
					<View
						style={{
							...shape(theme.components.input),
							padding: 14,
							backgroundColor: colors.surface.card,
							flexDirection: 'row',
							gap: 8,
						}}
					>
						<Icon name='search' themed={false} />
						<T>海岸</T>
					</View>
					<T muted>固定搜索结果，2 项</T>
					{['海岸线的回声', '夜色中的散步'].map((title) => (
						<Card key={title}>
							<T weight='600'>{title}</T>
							<T
								muted
								size={12}
							>
								示例 UP 主，03:10
							</T>
						</Card>
					))}
				</>
			) : page === 'library' || page === 'profile' ? (
				<>
					<T size={24} weight='700'>{page === 'library' ? '音乐库' : '我的音绘'}</T>
					{(page === 'library' ? ['我喜欢的', '本地音乐', '最近播放'] : ['关注的 UP 主', '下载与离线', '设置']).map((label) => <Card key={label}><T>{label}</T></Card>)}
				</>
			) : (
				<Card>
					<State
						title='暂时无法读取'
						message='这是固定错误示意，真实内容与播放不受影响。'
					/>
					<T style={{ color: colors.state.error }}>读取失败，请稍后再试</T>
				</Card>
			)}
			<HostFooterFrame><MainNavigation tab={page === 'search' || page === 'library' || page === 'profile' ? page : 'home'} bottomInset={0} onNavigate={() => {}} /></HostFooterFrame>
		</View>
	)
}

function ReferencePlayer() {
	const theme = useTheme()
	const [playing, setPlaying] = useState(false)
	const [position, setPosition] = useState(78)
	const frame = theme.components.playerFrame
	return (
		<>
			<T
				muted
				size={12}
			>
				播放器参考，仅演示按钮状态
			</T>
			<Artwork
				resource='assets/coast.png'
				size={180}
				style={{
					alignSelf: 'center',
					borderRadius: frame === 'arch' ? 90 : frame === 'stacked' ? 8 : 3,
					borderBottomLeftRadius: 8,
					borderBottomRightRadius: 8,
					transform: frame === 'tilted' ? [{ rotate: '-5deg' }] : [],
				}}
			/>
			<T
				size={21}
				weight='700'
			>
				海岸线的回声
			</T>
			<T muted>示例 UP 主，固定参考内容</T>
			<Progress position={position} duration={190} onSeek={setPosition} />
			<View style={{ alignItems: 'center' }}>
				<IconButton
					name={playing ? 'pause' : 'play'}
					label='切换预览播放按钮，不播放音频'
					primary
					large
					onPress={() => setPlaying((value) => !value)}
				/>
			</View>
			<LyricLine active>向晚风，借一段安静</LyricLine>
			<LyricLine>固定文字，仅预览歌词颜色</LyricLine>
		</>
	)
}
