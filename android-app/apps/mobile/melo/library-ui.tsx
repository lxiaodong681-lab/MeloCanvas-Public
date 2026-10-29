import React, { type ReactNode } from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'

import type { Source } from './core/model'
import type { MusicLibrarySource } from './core/music-library-source'
import { CollectionMenu } from './library-collection-ui'
import { ListeningResumeList, type ListeningResume } from './listening-ui'
import type { PlaylistSession, PlaylistState } from './playlist-session'
import { PlaylistDetailPage, PlaylistLibrarySection } from './playlist-ui'
import {
	Button,
	ControlRow,
	ControlTarget,
	Icon,
	IconButton,
	MascotArt,
	State,
	T,
	useTheme,
	type IconName,
} from './ui'

const ignoreCollectionChange = () => {}

export type LibraryCollection = 'root' | 'likes' | 'local' | 'recent'

interface LibraryPageProps {
	collection?: LibraryCollection
	collectionBackLabel?: string
	onCollectionChange?: (collection: LibraryCollection) => void
	onOffline?: () => void
	localAudio?: ReactNode
	recentMusic?: ReactNode
	playlistState: PlaylistState
	playlistSession: PlaylistSession
	onPlaylistBack: () => void
	onPlaylistSearch: () => void
	onPlayPlaylist: (playlistId: string, startItemId: string) => Promise<boolean>
	onPlayLiked: () => void
	playbackBusy: boolean
	currentEntryId: string | null
	bottomInset: number
	reducedMotion: boolean
	listeningOpen: boolean
	onListeningOpenChange: (open: boolean) => void
	resumeItems: ListeningResume[]
	onPlayListening: (source: Source) => void
	localDataError: string
	onFindListening: () => void
	onFindMusic: () => void
	onOpenFollowing: () => void
	onOpenFollowingFeed: () => void
	onImport: () => void
	onOpenVideoSaves: (bucket: 'listening' | 'unclassified') => void
	onReviewBilibiliPending: (playlistId: string, itemId: string) => void
	onChangeSource?: (playlistId: string, itemId: string) => void
	likes: MusicLibrarySource[]
	renderLikedSource: (source: MusicLibrarySource, index: number) => ReactNode
}

export function LibraryPage({
	collection = 'root',
	collectionBackLabel = '返回音乐库',
	onCollectionChange = ignoreCollectionChange,
	onOffline,
	localAudio,
	recentMusic,
	playlistState,
	playlistSession,
	onPlaylistBack,
	onPlaylistSearch,
	onPlayPlaylist,
	onPlayLiked,
	playbackBusy,
	currentEntryId,
	bottomInset,
	reducedMotion,
	listeningOpen,
	onListeningOpenChange,
	resumeItems,
	onPlayListening,
	localDataError,
	onFindListening,
	onFindMusic,
	onOpenFollowing,
	onOpenFollowingFeed,
	onImport,
	onOpenVideoSaves,
	onReviewBilibiliPending,
	onChangeSource,
	likes,
	renderLikedSource,
}: LibraryPageProps) {
	const viewport = useWindowDimensions()
	const compactShortcuts = viewport.fontScale >= 1.35
	const shortcuts = [
		<LibraryShortcut
			key='likes'
			icon='heart'
			title='喜欢'
			onPress={() => onCollectionChange('likes')}
		/>,
		<LibraryShortcut
			key='recent'
			icon='repeat'
			title='最近'
			onPress={() => onCollectionChange('recent')}
		/>,
		<LibraryShortcut
			key='local'
			icon='music'
			title='本地'
			onPress={() => onCollectionChange('local')}
		/>,
		<LibraryShortcut
			key='downloads'
			icon='down'
			title={onOffline ? '下载' : '听视频'}
			onPress={onOffline ?? (() => onListeningOpenChange(true))}
		/>,
	]
	return (
		<>
			{playlistState.currentId ? (
				<PlaylistDetailPage
					state={playlistState}
					session={playlistSession}
					onBack={onPlaylistBack}
					onSearch={onPlaylistSearch}
					onPlay={onPlayPlaylist}
					onReviewBilibiliPending={onReviewBilibiliPending}
					onChangeSource={onChangeSource}
					playbackBusy={playbackBusy}
					currentEntryId={currentEntryId}
					bottomInset={bottomInset}
					reducedMotion={reducedMotion}
				/>
			) : listeningOpen ? (
				<View testID='listening-library-page'>
					<View style={[s.row, { gap: 8, marginBottom: 12 }]}>
						<IconButton
							name='back'
							label='返回音乐库'
							onPress={() => onListeningOpenChange(false)}
						/>
						<T
							size={24}
							weight='700'
						>
							继续收听
						</T>
					</View>
					<T
						muted
						size={12}
						style={{ marginBottom: 12 }}
					>
						每个分 P 分别记住进度，已听完的内容从头开始。
					</T>
					<ListeningResumeList
						items={resumeItems}
						onPlay={onPlayListening}
						busy={playbackBusy}
						error={localDataError}
					/>
					<View style={{ gap: 10, marginTop: 16 }}>
						<Button
							secondary
							onPress={() => onOpenVideoSaves('listening')}
						>
							打开本地听视频收藏
						</Button>
						<Button
							secondary
							onPress={() => onOpenVideoSaves('unclassified')}
						>
							打开本地待分类原条目
						</Button>
					</View>
					<View style={{ marginTop: 18 }}>
						<Button
							secondary
							onPress={onFindListening}
						>
							寻找更多听视频
						</Button>
					</View>
				</View>
			) : collection !== 'root' ? (
				<View testID={`library-collection-${collection}`}>
					<View style={[s.row, { gap: 8, marginBottom: 16 }]}>
						<IconButton
							name='back'
							label={collectionBackLabel}
							onPress={() => onCollectionChange('root')}
						/>
						<T
							size={24}
							weight='700'
							style={{ flex: 1 }}
						>
							{collection === 'likes'
								? '我喜欢的'
								: collection === 'local'
									? '本地音乐'
									: '最近播放'}
						</T>
						{collection === 'likes' && (
							<CollectionMenu
								label='喜欢的音乐管理'
								actions={[
									{
										label: '另存为歌单',
										disabled: !likes.length,
										onPress: () => playlistSession.requestName('from-likes'),
									},
								]}
							/>
						)}
					</View>
					{collection === 'local' ? (
						localAudio
					) : collection === 'recent' ? (
						recentMusic
					) : (
						<>
							<ControlRow
								controlMinWidthsDp={[128, 48]}
								gapDp={8}
								style={[
									s.row,
									{ justifyContent: 'space-between', marginBottom: 12 },
								]}
							>
								<View style={[s.row, { gap: 8 }]}>
									<MascotArt state='liked' size={44} />
									<T muted size={12}>{likes.length} 首音乐</T>
								</View>
								<IconButton
									name='play'
									label='播放全部喜欢'
									disabled={!likes.length || playbackBusy}
									onPress={onPlayLiked}
								/>
							</ControlRow>
							{likes.length ? (
								likes.map(renderLikedSource)
							) : (
								<State
									mascot='empty'
									title='还没有喜欢的音乐'
									message='听到喜欢的，轻点爱心就能收藏。'
								/>
							)}
							{!likes.length && (
								<Button
									secondary
									onPress={onFindMusic}
								>
									去搜索音乐
								</Button>
							)}
						</>
					)}
				</View>
			) : (
				<>
					<View
						style={[
							s.row,
							{ justifyContent: 'space-between', marginBottom: 8 },
						]}
					>
						<T
							size={25}
							weight='700'
							style={{ flex: 1 }}
						>
							音乐库
						</T>
						<CollectionMenu
							label='新建与导入'
							trigger={<T size={28}>＋</T>}
							actions={[
								{
									label: '新建歌单',
									onPress: () => playlistSession.requestName('create'),
								},
								{ label: '导入歌单', onPress: onImport },
								{
									label: '本地音乐，导入文件',
									onPress: () => onCollectionChange('local'),
								},
							]}
						/>
					</View>
					<View
						testID='library-shortcuts'
						style={{ gap: 8, marginBottom: 8 }}
					>
						{(compactShortcuts
							? [shortcuts.slice(0, 2), shortcuts.slice(2)]
							: [shortcuts]
						).map((row) => (
							<ControlRow
								key={row.map((shortcut) => shortcut.key).join(':')}
								controlMinWidthsDp={row.map(() => 64)}
								gapDp={8}
								style={[s.row, { gap: 8 }]}
							>
								{row}
							</ControlRow>
						))}
					</View>
					<ControlRow
						controlMinWidthsDp={[64, 64, 64]}
						gapDp={20}
						style={{ flexDirection: 'row', gap: 20, marginBottom: 4 }}
					>
						{[
							{ label: '歌单', onPress: () => {}, selected: true },
							{
								label: '听视频',
								onPress: () => onListeningOpenChange(true),
								selected: false,
							},
							{ label: 'UP 主', onPress: onOpenFollowing, selected: false },
						].map((item) => (
							<ControlTarget
								key={item.label}
								accessibilityRole='tab'
								accessibilityLabel={item.label}
								accessibilityState={{ selected: item.selected }}
								onPress={item.onPress}
								minimumWidthDp={64}
								style={{ minHeight: 48, justifyContent: 'center' }}
							>
								<T weight={item.selected ? '700' : '400'}>{item.label}</T>
							</ControlTarget>
						))}
					</ControlRow>
					<LibraryLink
						icon='heart'
						title={`我喜欢的，${likes.length} 首`}
						onPress={() => onCollectionChange('likes')}
					/>
					<View style={{ marginTop: 8 }}>
						<LibraryLink
							icon='library'
							title='导入歌单'
							onPress={onImport}
						/>
					</View>
					<PlaylistLibrarySection
						state={playlistState}
						session={playlistSession}
					/>
					{!playlistState.playlists.length && !likes.length && (
						<ControlRow
							controlMinWidthsDp={[112, 112]}
							gapDp={12}
							style={[s.row, { gap: 12, marginTop: 12 }]}
						>
							<ControlTarget
								minimumHeightDp={48}
								accessibilityRole='button'
								onPress={onFindMusic}
								style={{
									flex: 1,
									minHeight: 48,
									justifyContent: 'center',
									alignItems: 'center',
								}}
							>
								<T size={13}>搜索音乐</T>
							</ControlTarget>
							<ControlTarget
								minimumHeightDp={48}
								accessibilityRole='button'
								onPress={onImport}
								style={{
									flex: 1,
									minHeight: 48,
									justifyContent: 'center',
									alignItems: 'center',
								}}
							>
								<T size={13}>导入歌单</T>
							</ControlTarget>
						</ControlRow>
					)}
					<View style={{ marginTop: 24 }}>
						<T
							size={17}
							weight='700'
							style={{ marginBottom: 8 }}
						>
							关注与收藏
						</T>
						<LibraryLink
							icon='user'
							title='关注的 UP 主'
							onPress={onOpenFollowing}
						/>
						<LibraryLink
							icon='queue'
							title='关注更新'
							onPress={onOpenFollowingFeed}
						/>
						<LibraryLink
							icon='heart'
							title='听视频收藏'
							onPress={() => onOpenVideoSaves('listening')}
						/>
						<LibraryLink
							icon='library'
							title='待分类内容'
							onPress={() => onOpenVideoSaves('unclassified')}
						/>
					</View>
				</>
			)}
		</>
	)
}

const s = StyleSheet.create({
	row: { flexDirection: 'row', alignItems: 'center' },
})

function LibraryShortcut({
	icon,
	title,
	detail,
	onPress,
}: {
	icon: IconName
	title: string
	detail?: string
	onPress: () => void
}) {
	const c = useTheme().tokens
	return (
		<ControlTarget
			minimumWidthDp={64}
			minimumHeightDp={68}
			accessibilityRole='button'
			accessibilityLabel={`打开${title}`}
			onPress={onPress}
			style={{
				flex: 1,
				minHeight: 68,
				alignItems: 'center',
				paddingVertical: 10,
				gap: 7,
			}}
		>
			<Icon
				name={icon}
				size={25}
				color={c.action.primary}
			/>
			<T
				size={12}
				weight='600'
				style={{ textAlign: 'center' }}
			>
				{title}
			</T>
			{!!detail && (
				<T
					size={10}
					muted
				>
					{detail}
				</T>
			)}
		</ControlTarget>
	)
}
function LibraryLink({
	icon,
	title,
	onPress,
}: {
	icon: IconName
	title: string
	onPress: () => void
}) {
	const c = useTheme().tokens
	return (
		<ControlRow
			controlMinWidthsDp={[96]}
			single
		>
			<ControlTarget
				minimumHeightDp={52}
				accessibilityRole='button'
				accessibilityLabel={title}
				onPress={onPress}
				style={[
					s.row,
					{
						flex: 1,
						minHeight: 52,
						gap: 12,
						borderBottomWidth: 1,
						borderBottomColor: c.border.subtle,
					},
				]}
			>
				<Icon
					name={icon}
					size={20}
					color={c.text.secondary}
				/>
				<T
					size={14}
					style={{ flex: 1 }}
				>
					{title}
				</T>
				<Icon
					name='arrow'
					size={16}
					color={c.text.secondary}
				/>
			</ControlTarget>
		</ControlRow>
	)
}
