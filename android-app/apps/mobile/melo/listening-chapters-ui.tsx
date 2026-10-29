import React, { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'

import { chapterIndexAt } from '../src/features/player/utils/chapters'

import type { Source } from './core/model'
import { listeningChapters, type Chapter } from './listening-chapters'
import { ControlTarget, State, T, time, useTheme } from './ui'
import type { PlaybackProgress } from './playback-progress'
import { usePlaybackProgress } from './usePlaybackProgress'

/** Mounted only while the user is viewing chapters; closing or changing P aborts the read. */
export function ListeningChaptersPanel({
	source,
	duration: fallbackDuration,
	position: fallbackPosition,
	progress,
	switching,
	onSeek,
}: {
	source: Source
	duration: number
	position: number
	progress?: PlaybackProgress
	switching: boolean
	onSeek: (seconds: number) => void
}) {
	const live = usePlaybackProgress(progress, fallbackPosition, fallbackDuration)
	const position = live.position
	const duration = live.duration || fallbackDuration
	const theme = useTheme()
	const [state, setState] = useState<{
		sourceId: string
		chapters: Chapter[]
		loading: boolean
		error: string
	}>({ sourceId: '', chapters: [], loading: true, error: '' })
	const [revision, setRevision] = useState(0)
	const owner = useRef<AbortController | null>(null)
	const seconds = duration > 0 ? duration : source.duration
	useEffect(() => {
		const request = new AbortController()
		owner.current = request
		setState({ sourceId: source.id, chapters: [], loading: true, error: '' })
		void listeningChapters(
			{ id: source.id, bvid: source.bvid, cid: source.cid },
			seconds,
			request.signal,
		)
			.then((chapters) => {
				if (!request.signal.aborted)
					setState({ sourceId: source.id, chapters, loading: false, error: '' })
			})
			.catch((cause: unknown) => {
				if (!request.signal.aborted)
					setState({
						sourceId: source.id,
						chapters: [],
						loading: false,
						error:
							cause instanceof Error
								? cause.message
								: '章节暂时无法读取，请重试',
					})
			})
		return () => {
			request.abort()
			if (owner.current === request) owner.current = null
		}
	}, [source.id, source.bvid, source.cid, seconds, revision])
	if (state.sourceId !== source.id || state.loading)
		return (
			<State
				busy
				title='正在读取当前分 P 的章节'
			/>
		)
	if (state.error)
		return (
			<State
				title='章节暂时无法读取'
				message={state.error}
				retry={() => setRevision((value) => value + 1)}
			/>
		)
	if (!state.chapters.length)
		return (
			<State
				title='当前分 P 暂无章节'
				message='此视频没有提供可用章节，可使用进度条定位；分 P 列表仍可切换内容。'
			/>
		)
	const active = chapterIndexAt(state.chapters, position)
	return (
		<>
			<T
				muted
				size={11}
				style={{ marginBottom: 12 }}
			>
				仅定位当前分 P，不更换队列；暂停时跳转仍保持暂停。
			</T>
			{state.chapters.map((chapter, index) => (
				<ControlTarget
					key={chapter.id}
					minimumWidthDp={120}
					minimumHeightDp={64}
					accessibilityRole='button'
					accessibilityLabel={`跳转章节 ${chapter.title}，${time(chapter.startSeconds)}`}
					accessibilityState={{
						selected: index === active,
						disabled: switching,
					}}
					disabled={switching}
					onPress={() => {
						if (
							switching ||
							!owner.current ||
							owner.current.signal.aborted ||
							state.sourceId !== source.id
						)
							return
						onSeek(Math.max(0, Math.min(chapter.startSeconds, seconds)))
					}}
					style={{
						minHeight: 64,
						paddingVertical: 12,
						borderBottomWidth: 1,
						borderBottomColor: theme.tokens.border.subtle,
					}}
				>
					<View style={{ gap: 5 }}>
						<T weight={index === active ? '700' : '400'}>{chapter.title}</T>
						<T
							muted
							size={11}
						>
							{time(chapter.startSeconds)} – {time(chapter.endSeconds)}
							{index === active ? ' · 当前章节' : ''}
						</T>
					</View>
				</ControlTarget>
			))}
		</>
	)
}
