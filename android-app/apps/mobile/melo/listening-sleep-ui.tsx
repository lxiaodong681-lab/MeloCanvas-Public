import type { PlaybackSnapshot } from '@bbplayer/orpheus'
import React, { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'

import { Button, MascotArt, T } from './ui'

export type ListeningSleepMode = 'duration' | 'part' | 'off'
export type ListeningSleepTimer = PlaybackSnapshot['sleepTimer']
export type SetListeningSleepTimer = (
	sourceId: string,
	mode: ListeningSleepMode,
	durationMs?: number,
) => Promise<void>

export function sleepTimerLabel(timer: ListeningSleepTimer): string {
	if (!timer) return '定时暂停'
	if (timer.mode === 'part') return '播完当前 P 暂停'
	return `约 ${Math.max(1, Math.ceil((timer.remainingMs ?? 0) / 60000))} 分钟后暂停`
}

export function ListeningSleepTimerPanel({
	sourceId,
	timer,
	switching,
	onSet,
	onRefresh,
}: {
	sourceId: string
	timer: ListeningSleepTimer
	switching: boolean
	onSet: SetListeningSleepTimer
	onRefresh: () => Promise<unknown>
}) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	const alive = useRef(false)
	const pending = useRef(false)
	useEffect(() => {
		alive.current = true
		return () => {
			alive.current = false
		}
	}, [])
	// Refresh display only while this sheet is mounted. Native owns the deadline.
	useEffect(() => {
		void onRefresh()
		if (timer?.mode !== 'duration') return
		const interval = setInterval(() => {
			void onRefresh()
		}, 30000)
		return () => clearInterval(interval)
	}, [onRefresh, timer?.mode])
	async function set(mode: ListeningSleepMode, durationMs?: number) {
		if (!alive.current || pending.current || switching) return
		pending.current = true
		setBusy(true)
		setError('')
		try {
			await onSet(sourceId, mode, durationMs)
		} catch (cause) {
			if (alive.current)
				setError(
					cause instanceof Error ? cause.message : '定时设置失败，请重试',
				)
		} finally {
			pending.current = false
			if (alive.current) setBusy(false)
		}
	}
	return (
		<View style={{ gap: 12 }}>
			<MascotArt state='sleep' size={112} />
			<T weight='700'>{timer ? sleepTimerLabel(timer) : '当前未开启定时'}</T>
			<T
				muted
				size={12}
			>
				按实际经过时间计时，倍速不会缩短定时。到点只暂停播放。
			</T>
			{[15, 30, 60].map((minutes) => (
				<Button
					key={minutes}
					secondary
					disabled={busy || switching}
					onPress={() => {
						void set('duration', minutes * 60000)
					}}
				>
					{minutes} 分钟后暂停
				</Button>
			))}
			<Button
				secondary
				disabled={busy || switching}
				onPress={() => {
					void set('part')
				}}
			>
				播完当前 P 暂停
			</Button>
			<Button
				secondary
				disabled={busy || switching || !timer}
				onPress={() => {
					void set('off')
				}}
			>
				关闭定时
			</Button>
			{busy && (
				<T
					muted
					size={12}
				>
					正在设置定时…
				</T>
			)}
			{!!error && <T size={12}>{error}</T>}
			<T
				muted
				size={11}
			>
				同一视频换 P 会保留定时；“播完当前 P”跟随新 P。更换视频或切回音乐、FM
				会清除定时，应用进程重建后不恢复。
			</T>
		</View>
	)
}
