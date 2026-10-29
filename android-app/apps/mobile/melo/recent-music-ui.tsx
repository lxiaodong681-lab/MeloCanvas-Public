import { Orpheus } from '@bbplayer/orpheus'
import React, { useEffect, useMemo, useReducer } from 'react'
import { AppState, View } from 'react-native'

import { CollectionMenu, CollectionSongRow } from './library-collection-ui'
import {
	RecentMusicSession,
	type RecentMusicState,
} from './recent-music-session'
import { Button, Card, T } from './ui'
import { ConfirmationModal } from './theme-dialog'

export function RecentMusicList({
	state,
	onRefresh,
	onRequestClear,
	onCancelClear,
	onConfirmClear,
	onClose,
	onMore,
	onPlay,
	playbackBusy,
	embedded = false,
}: {
	state: RecentMusicState
	onRefresh: () => void
	onRequestClear: () => void
	onCancelClear: () => void
	onConfirmClear: () => void
	onClose: () => void
	onMore: () => void
	onPlay: (id: string) => void
	playbackBusy: boolean
	embedded?: boolean
}) {
	return (
		<View testID='recent-music-list'>
			<View
				style={{
					flexDirection: 'row',
					alignItems: 'center',
					justifyContent: 'space-between',
					marginBottom: 8,
				}}
			>
				<T
					size={14}
					muted
				>
					{state.loading
						? '正在读取…'
						: state.clearing
							? '正在清空…'
							: '最近听过的音乐'}
				</T>
				<CollectionMenu
					label='最近播放管理'
					actions={[
						{
							label: '刷新最近播放',
							disabled: state.loading || state.clearing,
							onPress: onRefresh,
						},
						{
							label: '清空最近播放，音乐',
							disabled: state.clearing,
							onPress: onRequestClear,
						},
						...(!embedded ? [{ label: '收起最近播放', onPress: onClose }] : []),
					]}
				/>
			</View>
			{state.confirmClear && (
				<ConfirmationModal testID='recent-music-clear-confirmation' title='清空最近播放？' onCancel={onCancelClear}>
					<T>
						清空最近播放记录？歌曲、歌单和音频文件会保留。
					</T>
					<Button
						secondary
						onPress={onCancelClear}
					>
						取消清空
					</Button>
					<Button onPress={onConfirmClear}>确认清空音乐记录</Button>
				</ConfirmationModal>
			)}
			{!!state.error && <T>{state.error}</T>}
			{!state.loading && !state.error && !state.items.length && (
				<T muted>还没有音乐播放记录。搜索音乐或播放本地音频后会出现在这里。</T>
			)}
			{state.items.slice(0, state.visibleCount).map((item) => (
				<CollectionSongRow
					key={item.sourceId}
					title={item.title}
					artwork={item.artwork}
					subtitle={`${item.artist || '未知艺术家'}，${item.sourceId.startsWith('local:') ? '本地音频' : 'B站音源'}`}
					disabled={playbackBusy}
					onPlay={() => onPlay(item.sourceId)}
				/>
			))}
			{state.items.length > state.visibleCount && (
				<Button
					secondary
					onPress={onMore}
				>
					显示更多记录
				</Button>
			)}
		</View>
	)
}

export function RecentMusicSection({
	onPlay,
	playbackBusy,
	embedded = false,
}: {
	onPlay: (id: string) => void
	playbackBusy: boolean
	embedded?: boolean
}) {
	const [, refreshView] = useReducer((value: number) => value + 1, 0)
	const session = useMemo(
		() =>
			new RecentMusicSession(
				() => Orpheus.getRecentMusicHistory(),
				refreshView,
				() => Orpheus.clearRecentMusicHistory(),
			),
		[],
	)
	useEffect(() => {
		session.activate()
		if (embedded) session.open()
		const subscriptions = [
			Orpheus.addListener('onRecentMusicHistoryChanged', () => {
				void session.refresh()
			}),
			AppState.addEventListener('change', (state) => {
				if (state === 'active') void session.refresh()
			}),
		]
		return () => {
			session.dispose()
			subscriptions.forEach((subscription) => subscription.remove())
		}
	}, [session, embedded])
	const content =
		session.state.open || embedded ? (
			<RecentMusicList
				state={session.state}
				onRefresh={() => {
					void session.refresh()
				}}
				onRequestClear={() => session.requestClear()}
				onCancelClear={() => session.cancelClear()}
				onConfirmClear={() => {
					void session.confirmClear()
				}}
				onClose={() => session.close()}
				onMore={() => session.showMore()}
				onPlay={onPlay}
				playbackBusy={playbackBusy}
				embedded={embedded}
			/>
		) : (
			<Button
				secondary
				onPress={() => session.open()}
			>
				最近播放，音乐
			</Button>
		)
	return (
		<View style={{ marginBottom: 14 }}>
			{embedded ? content : <Card>{content}</Card>}
		</View>
	)
}
