import React from 'react'
import { ScrollView } from 'react-native'

import type { usePlayer } from './player'
import { Button, Card, T } from './ui'
import { usePlaybackProgress } from './usePlaybackProgress'

interface Props {
	player: Pick<
		ReturnType<typeof usePlayer>,
		| 'track'
		| 'position'
		| 'duration'
		| 'progress'
		| 'playing'
		| 'error'
		| 'seek'
		| 'toggle'
	>
	bottomInset: number
	returnToImport: boolean
	onClose: () => void | Promise<void>
}

export function CandidateAuditionPanel({
	player,
	bottomInset,
	returnToImport,
	onClose,
}: Props) {
	const liveProgress = usePlaybackProgress(
		player.progress,
		player.position,
		player.duration,
	)
	return (
		<ScrollView
			testID='candidate-audition-panel'
			style={{ flex: 1 }}
			contentContainerStyle={{
				padding: 22,
				paddingBottom: bottomInset + 24,
			}}
		>
			<Card style={{ gap: 12 }}>
				<T
					size={22}
					weight='700'
				>
					试听
				</T>
				<T
					weight='600'
					lines={2}
				>
					{player.track?.title || '候选音源'}
				</T>
				<T
					muted
					size={13}
				>
					{player.track?.artist?.replace(/\s*·\s*/g, '：') || ''}
				</T>
				<T>退出试听后恢复原队列，并保持暂停。</T>
				<T>
					{Math.floor(liveProgress.position)} /{' '}
					{Math.floor(liveProgress.duration)} 秒
				</T>
				{player.error ? <T>{player.error}</T> : null}
				<Button
					secondary
					onPress={() => {
						void player.seek(liveProgress.position - 15)
					}}
				>
					后退 15 秒
				</Button>
				<Button
					onPress={() => {
						void player.toggle()
					}}
				>
					{player.playing ? '暂停试听' : '播放试听'}
				</Button>
				<Button
					secondary
					onPress={() => {
						void player.seek(liveProgress.position + 15)
					}}
				>
					前进 15 秒
				</Button>
				<Button
					secondary
					onPress={() => {
						void onClose()
					}}
				>
					{returnToImport ? '返回选择音源' : '结束试听，恢复原播放'}
				</Button>
			</Card>
		</ScrollView>
	)
}
