import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { FlatList, View } from 'react-native'

import { activeSubtitleLines, type SubtitleLine } from './bilibili-subtitles'
import type {
	ListeningSubtitleFailure,
	ListeningSubtitlesSession,
} from './listening-subtitles-session'
import { Button, ControlTarget, Icon, State, T, time, useTheme } from './ui'
import type { PlaybackProgress } from './playback-progress'
import { usePlaybackProgress } from './usePlaybackProgress'

const messages: Record<ListeningSubtitleFailure, string> = {
	'login-required':
		'字幕需要已验证的 B 站账号。请在个人页联网验证或重新登录后重试。',
	offline: '当前处于离线模式，字幕需要联网读取。已下载的音频仍可继续收听。',
	restricted: 'B 站暂时限制了这段内容的字幕访问，请稍后重试。',
	unavailable: '暂时无法连接字幕服务，请检查网络后重试。',
	'invalid-response': '这条字幕暂时无法读取，可以选择其他语言或稍后重试。',
	'identity-mismatch': '字幕与当前分 P 不匹配，请重新读取。',
	'missing-target': '当前分 P 的信息尚未就绪，请等待分 P 列表读取完成后重试。',
	cancelled: '字幕读取已取消，请重试。',
	stale: '收听内容或账号已经变化，请重新读取字幕。',
}

/** Actual listening position drives highlighting; seeking never changes play/pause state. */
export function ListeningSubtitlesPanel({
	session,
	position: fallbackPosition,
	progress,
	switching,
	onSeek,
}: {
	session: ListeningSubtitlesSession
	position: number
	progress?: PlaybackProgress
	switching: boolean
	onSeek: (seconds: number) => void
}) {
	const { position } = usePlaybackProgress(progress, fallbackPosition, 0)
	const theme = useTheme()
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	const list = useRef<FlatList<SubtitleLine> | null>(null)
	const [following, setFollowing] = useState(true)
	const document = state.document
	const lines = document?.lines ?? []
	const active = activeSubtitleLines(lines, position * 1000)
	const activeIndex = active.length ? lines.indexOf(active[0]) : -1
	useEffect(() => {
		if (following && state.status === 'ready' && activeIndex >= 0)
			list.current?.scrollToIndex({
				index: activeIndex,
				viewPosition: 0.35,
				animated: false,
			})
	}, [following, state.status, document, activeIndex])
	if (
		state.status === 'idle' ||
		state.status === 'loading-tracks' ||
		state.status === 'loading'
	)
		return (
			<State
				busy
				title={state.status === 'loading' ? '正在读取字幕' : '正在读取字幕语言'}
			/>
		)
	if (state.status === 'error')
		return (
			<View style={{ gap: 12 }}>
				<State
					title='字幕暂时无法读取'
					message={messages[state.error ?? 'unavailable']}
					retry={() => {
						void session.retry()
					}}
				/>
				{!!state.tracks.length && (
					<Button
						secondary
						onPress={() => session.showTracks()}
					>
						选择其他字幕语言
					</Button>
				)}
			</View>
		)
	if (state.status === 'no-tracks')
		return (
			<State
				title='当前分 P 没有字幕'
				message='原视频未提供可读取的字幕。仍可使用章节或进度条定位。'
				retry={() => {
					void session.discover()
				}}
			/>
		)
	if (state.status === 'choice')
		return (
			<FlatList
				testID='listening-subtitle-tracks'
				data={state.tracks}
				keyExtractor={(track) => track.id}
				keyboardShouldPersistTaps='handled'
				ListHeaderComponent={
					<T
						muted
						size={12}
						style={{ marginBottom: 12 }}
					>
						选择原视频提供的字幕语言。
					</T>
				}
				renderItem={({ item: track }) => (
					<ControlTarget
						minimumHeightDp={58}
						accessibilityRole='radio'
						accessibilityLabel={`选择字幕 ${track.label}`}
						accessibilityState={{
							checked: state.selectedTrackId === track.id,
							disabled: switching,
						}}
						disabled={switching}
						onPress={() => {
							if (!switching) void session.selectTrack(track.id)
						}}
						style={{
							flexDirection: 'row',
							gap: 14,
							alignItems: 'center',
							minHeight: 58,
							paddingVertical: 12,
							borderBottomWidth: 1,
							borderBottomColor: theme.tokens.border.subtle,
						}}
					>
						<View style={{ flex: 1, gap: 4 }}>
							<T weight={state.selectedTrackId === track.id ? '700' : '400'}>
								{track.label}
							</T>
							{track.platformAiType !== null && track.platformAiType > 0 && (
								<T
									muted
									size={11}
								>
									B 站标记为自动字幕
								</T>
							)}
						</View>
						{state.selectedTrackId === track.id && (
							<Icon
								name='check'
								color={theme.tokens.action.primary}
							/>
						)}
					</ControlTarget>
				)}
			/>
		)
	return (
		<View style={{ flex: 1, minHeight: 0 }}>
			<View
				style={{
					flexDirection: 'row',
					alignItems: 'center',
					gap: 10,
					marginBottom: 10,
				}}
			>
				<T
					weight='600'
					style={{ flex: 1 }}
				>
					{document?.track.label}
				</T>
				<ControlTarget
					minimumWidthDp={80}
					accessibilityRole='button'
					accessibilityLabel='更换字幕语言'
					onPress={() => session.showTracks()}
					style={{ minHeight: 48, justifyContent: 'center' }}
				>
					<T
						size={12}
						style={{ color: theme.tokens.action.primary }}
					>
						更换语言
					</T>
				</ControlTarget>
			</View>
			{!lines.length ? (
				<State
					title='这条字幕暂无内容'
					message='可以选择其他语言继续收听。'
				/>
			) : (
				<>
					<View
						style={{
							flexDirection: 'row',
							alignItems: 'center',
							gap: 12,
							marginBottom: 8,
						}}
					>
						<T
							muted
							size={11}
							style={{ flex: 1 }}
						>
							{active.length
								? '点击字幕可跳到对应位置'
								: '此刻没有字幕 · 点击任意行定位'}
						</T>
						<ControlTarget
							minimumWidthDp={80}
							accessibilityRole='button'
							accessibilityLabel={following ? '暂停字幕跟随' : '跟随当前字幕'}
							accessibilityState={{ selected: following }}
							onPress={() => setFollowing((value) => !value)}
							style={{ minHeight: 48, justifyContent: 'center' }}
						>
							<T
								size={12}
								style={{ color: theme.tokens.action.primary }}
							>
								{following ? '跟随中' : '跟随播放'}
							</T>
						</ControlTarget>
					</View>
					<FlatList
						ref={list}
						testID='listening-subtitle-lines'
						data={lines}
						extraData={{ position, switching }}
						keyExtractor={(_, index) => String(index)}
						onScrollBeginDrag={() => setFollowing(false)}
						onScrollToIndexFailed={({ averageItemLength, index }) => {
							list.current?.scrollToOffset({
								offset: Math.max(0, averageItemLength * index),
								animated: false,
							})
						}}
						keyboardShouldPersistTaps='handled'
						renderItem={({ item: line, index }) => {
							const selected = active.includes(line)
							return (
								<ControlTarget
									minimumHeightDp={64}
									accessibilityRole='button'
									accessibilityLabel={`跳转字幕 ${time(line.startMs / 1000)} ${line.text}`}
									accessibilityState={{ selected, disabled: switching }}
									disabled={switching}
									testID={`listening-subtitle-line-${index}`}
									onPress={() => {
										if (switching) return
										const seconds = session.seekPosition(line)
										if (seconds !== null) onSeek(seconds)
									}}
									style={{
										minHeight: 64,
										paddingVertical: 14,
										paddingHorizontal: 12,
										borderRadius:
											theme.components.card === 'comic'
												? 8
												: theme.components.card === 'leaf'
													? 20
													: 12,
										backgroundColor: selected
											? theme.tokens.surface.tinted
											: undefined,
										marginBottom: 4,
										gap: 6,
									}}
								>
									<T
										size={16}
										weight={selected ? '700' : '400'}
										style={{
											color: selected
												? theme.tokens.action.primary
												: theme.tokens.text.primary,
										}}
									>
										{line.text}
									</T>
									<T
										muted
										size={10}
									>
										{time(line.startMs / 1000)}
									</T>
								</ControlTarget>
							)
						}}
					/>
				</>
			)}
		</View>
	)
}
