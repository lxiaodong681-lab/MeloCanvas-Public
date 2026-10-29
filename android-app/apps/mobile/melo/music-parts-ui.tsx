import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'

import { accountSession } from './account-runtime'
import type { BilibiliReadGate } from './bilibili-import-network'
import { BiliPages } from './bilibili-import-ui'
import type { VideoCatalog } from './core/video-catalog'
import {
	beginListeningSourceDetails,
	type ListeningPart,
	type ListeningVideo,
} from './listening-source'
import { readMusicParts, type MusicPartsIdentity } from './music-parts'
import {
	playMusicIntent,
	type PlaybackIntent,
	type PlaybackRequest,
} from './playback-intent'
import type { usePlayer } from './player'
import { Button, ControlTarget, T, time, useTheme } from './ui'

export type { MusicPartsIdentity } from './music-parts'

export function MusicPartsPanel({
	identity,
	player,
	intent,
	catalog,
	gate,
	onClose,
	onNotice,
}: {
	identity: MusicPartsIdentity
	player: ReturnType<typeof usePlayer>
	intent: PlaybackIntent
	catalog: VideoCatalog
	gate: BilibiliReadGate
	onClose: () => void
	onNotice: (message: string) => void
}) {
	const [video, setVideo] = useState<ListeningVideo | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState('')
	const [pending, setPending] = useState('')
	const [revision, setRevision] = useState(0)
	const latest = useRef(player)
	useEffect(() => {
		latest.current = player
	}, [player])
	const selection = useRef<PlaybackRequest | null>(null)
	const [generation] = useState(accountSession.getGeneration)
	const c = useTheme().tokens
	const current = useCallback(
		() =>
			latest.current.mode === 'music' &&
			latest.current.track?.id === identity.entryId &&
			latest.current.track.sourceId === identity.sourceId &&
			accountSession.getGeneration() === generation,
		[identity.entryId, identity.sourceId, generation],
	)
	const matches =
		player.mode === 'music' &&
		player.track?.id === identity.entryId &&
		player.track.sourceId === identity.sourceId &&
		accountSession.getGeneration() === generation
	useEffect(() => {
		const controller = new AbortController()
		setLoading(true)
		setError('')
		const unsubscribe = accountSession.subscribe(() => {
			if (accountSession.getGeneration() !== generation) controller.abort()
		})
		void readMusicParts(
			catalog,
			gate,
			beginListeningSourceDetails,
			identity.bvid,
			controller.signal,
			current,
		)
			.then((value) => {
				if (!controller.signal.aborted && value) setVideo(value)
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted)
					setError(
						cause instanceof Error ? cause.message : '分 P 读取失败，请重试',
					)
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false)
			})
		return () => {
			controller.abort()
			unsubscribe()
		}
	}, [catalog, gate, identity.bvid, generation, revision, current])
	useEffect(
		() => () => {
			selection.current?.cancel()
		},
		[],
	)
	async function select(part: ListeningPart) {
		if (!current()) {
			setError('当前播放项目已变更，请关闭后重新打开分 P')
			return
		}
		try {
			const switched = await playMusicIntent(intent, part.source, {
				resolve: async (source) => source,
				preparation: latest.current,
				activate: (source, preparation) =>
					latest.current.switchMusicPart(source, preparation, identity),
				onPending: setPending,
				onStarted: () => {
					selection.current = null
					onNotice(`已切换到 P${part.page} · ${part.title}`)
					onClose()
				},
				onRequest: (request) => {
					selection.current = request
				},
			})
			if (!switched && current()) setError('分 P 未切换，请稍后重试')
		} catch (cause) {
			if (current())
				setError(cause instanceof Error ? cause.message : '切换分 P 失败')
		}
	}
	return (
		<View style={{ gap: 12 }}>
			<T weight='600'>{video?.title ?? player.track?.title}</T>
			<T
				muted
				size={12}
			>
				只切换当前视频的分 P，保留歌单队列。从新分 P
				开头播放，暂停状态保持不变。
			</T>
			{!matches ? (
				<T>当前播放项目已变更，请关闭后重新打开分 P。</T>
			) : (
				<>
					{loading && <T muted>正在读取分 P…</T>}
					{!!error && <T style={{ color: c.state.error }}>{error}</T>}
					{!loading && !video && (
						<Button
							secondary
							onPress={() => setRevision((value) => value + 1)}
						>
							重新读取分 P
						</Button>
					)}
					{video && (
						<BiliPages
							label='分 P'
							items={video.parts}
							keyFor={(part) => part.source.id}
							render={(part) => (
								<ControlTarget
									accessibilityRole='button'
									accessibilityLabel={`切换到 P${part.page} ${part.title}`}
									accessibilityState={{
										selected: part.source.id === identity.sourceId,
										disabled:
											!!pending ||
											player.switching ||
											part.source.id === identity.sourceId,
									}}
									disabled={
										!!pending ||
										player.switching ||
										part.source.id === identity.sourceId
									}
									onPress={() => {
										void select(part)
									}}
									style={{ minHeight: 56, paddingVertical: 12, gap: 6 }}
								>
									<T
										weight={
											part.source.id === identity.sourceId ? '700' : '400'
										}
									>
										P{part.page} · {part.title}
									</T>
									<T
										size={12}
										muted
									>
										{part.source.id === identity.sourceId ? '当前分 P · ' : ''}
										{time(part.source.duration)}
									</T>
								</ControlTarget>
							)}
						/>
					)}
				</>
			)}
		</View>
	)
}
