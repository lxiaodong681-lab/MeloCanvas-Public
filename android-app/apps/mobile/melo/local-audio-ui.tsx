import React, { useEffect, useMemo, useReducer } from 'react'
import { View } from 'react-native'

import type { LocalAudioStore } from './core/local-audio'
import { CollectionMenu, CollectionSongRow } from './library-collection-ui'
import { LocalAudioImport } from './local-audio-import'
import { localAudioFiles } from './local-audio-mobile'
import { Button, ControlTarget, T, useTheme } from './ui'

export function LocalAudioSection({
	store,
	onPlay,
	playbackBusy,
	likedIds,
	onToggleLiked,
	onAddToPlaylist,
}: {
	store: LocalAudioStore
	onPlay: (id: string) => void
	playbackBusy: boolean
	likedIds: string[]
	onToggleLiked: (id: string) => void
	onAddToPlaylist: (id: string) => void
}) {
	const [, refresh] = useReducer((value: number) => value + 1, 0)
	const session = useMemo(
		() => new LocalAudioImport(store, localAudioFiles, refresh),
		[store],
	)
	useEffect(() => () => session.dispose(), [session])
	const state = session.state
	const theme = useTheme()
	return (
		<View style={{ marginBottom: 14 }}>
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
					{state.items.length} 首本地音乐
				</T>
				<ControlTarget
					accessibilityRole='button'
					accessibilityLabel='导入音频文件'
					fixedWidth
					disabled={state.busy}
					onPress={() => {
						void session.importFile()
					}}
					style={{
						minHeight: 48,
						minWidth: 64,
						alignItems: 'center',
						justifyContent: 'center',
					}}
				>
					<T
						size={14}
						weight='600'
						style={{ color: theme.tokens.action.primary }}
					>
						{state.busy ? '导入中…' : '导入'}
					</T>
				</ControlTarget>
			</View>
			{state.busy && (
				<Button
					secondary
					onPress={() => session.cancel()}
				>
					取消导入
				</Button>
			)}
			{!!state.error && (
				<View style={{ marginVertical: 12, gap: 12 }}>
					<T>{state.error}</T>
					<Button
						secondary
						onPress={() => session.refresh()}
					>
						重新读取列表
					</Button>
				</View>
			)}
			{!!state.notice && (
				<T
					muted
					size={12}
				>
					{state.notice}
				</T>
			)}
			{!state.items.length && (
				<View style={{ paddingVertical: 28, gap: 8 }}>
					<T
						size={18}
						weight='600'
					>
						暂无本地音乐
					</T>
					<T muted>
						点击右上角导入音频，保存副本后可离线播放。
					</T>
				</View>
			)}
			{state.items.map((audio) => (
				<CollectionSongRow
					key={audio.id}
					title={audio.title}
					subtitle={`${audio.artist || '未知艺术家'}，本地音频`}
					disabled={playbackBusy}
					onPlay={() => onPlay(audio.id)}
					trailing={
						<CollectionMenu
							label={`${audio.title} 的更多操作`}
							actions={[
								{
									label: likedIds.includes(audio.id) ? '取消喜欢' : '喜欢',
									onPress: () => onToggleLiked(audio.id),
								},
								{
									label: '添加到歌单',
									onPress: () => onAddToPlaylist(audio.id),
								},
							]}
						/>
					}
				/>
			))}
			{!!state.items.length && (
				<T
					muted
					size={13}
					style={{ marginTop: 16 }}
				>
					已保存独立副本，可离线播放。
				</T>
			)}
		</View>
	)
}
