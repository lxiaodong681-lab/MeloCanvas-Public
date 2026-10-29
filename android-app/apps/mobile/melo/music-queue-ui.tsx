import type { Track, PlaybackSnapshot } from '@bbplayer/orpheus'
import React, { useEffect, useRef, useState } from 'react'
import { FlatList, View } from 'react-native'

import { AppQueueItem } from './app-controls'
import { Button, IconButton, T } from './ui'

type RefreshQueue = (
	receiveFailure?: (cause: unknown) => void,
	owns?: () => boolean,
) => Promise<unknown>

async function readQueue(refresh: RefreshQueue, owns: () => boolean) {
	const status = await refresh(() => {}, owns)
	if (!owns()) return
	if (status === 'failed')
		throw new Error('队列状态暂时无法读取，请重新读取队列后再操作。')
	if (status === 'superseded')
		throw new Error('播放状态已变化，请重新读取队列确认。')
}

/** Mounted only for the ordinary music queue; FM and listening retain their own UI. */
export function MusicQueue({
	tracks,
	currentEntryId,
	switching,
	onSelect,
	onMoveNext,
	onRemove,
	undo,
	onUndo,
	onRefresh,
	canMoveNext = true,
}: {
	tracks: Track[]
	currentEntryId: string | null
	switching: boolean
	onSelect: (index: number, entryId: string) => void
	onMoveNext: (entryId: string) => Promise<void>
	onRemove: (entryId: string) => Promise<void>
	undo: PlaybackSnapshot['musicQueueUndo']
	onUndo: (token: string) => Promise<void>
	onRefresh: RefreshQueue
	canMoveNext?: boolean
}) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	const pending = useRef(false)
	const needsRefresh = useRef(false)
	const operation = useRef(0)
	const latestSwitching = useRef(switching)
	useEffect(() => {
		latestSwitching.current = switching
		if (switching) operation.current++
	}, [switching])
	const alive = useRef(false)
	useEffect(() => {
		alive.current = true
		return () => {
			alive.current = false
		}
	}, [])
	useEffect(() => {
		if (pending.current || latestSwitching.current) return
		let cancelled = false
		const version = operation.current
		const owns = () =>
			!cancelled &&
			alive.current &&
			!latestSwitching.current &&
			version === operation.current
		void readQueue(onRefresh, owns).catch(() => {
			if (owns()) {
				needsRefresh.current = true
				setError('队列状态暂时无法读取，请重新读取队列后再操作。')
			}
		})
		return () => {
			cancelled = true
		}
	}, [onRefresh])
	const currentIndex = tracks.findIndex((item) => item.id === currentEntryId)
	async function mutate(
		action: (owns: () => boolean) => Promise<void>,
		recovery = false,
	) {
		if (
			!alive.current ||
			pending.current ||
			latestSwitching.current ||
			(needsRefresh.current && !recovery)
		)
			return
		pending.current = true
		setBusy(true)
		const version = ++operation.current
		const owns = () =>
			alive.current && !latestSwitching.current && version === operation.current
		try {
			await action(owns)
			if (owns()) {
				needsRefresh.current = false
				setError('')
			}
		} catch (cause) {
			if (owns()) {
				needsRefresh.current = true
				setError(
					cause instanceof Error ? cause.message : '队列调整失败，请重试',
				)
			}
		} finally {
			pending.current = false
			if (alive.current) setBusy(false)
		}
	}
	return (
		<FlatList
			data={tracks}
			keyExtractor={(item) => item.id}
			initialNumToRender={12}
			maxToRenderPerBatch={8}
			windowSize={5}
			keyboardShouldPersistTaps='handled'
			ListHeaderComponent={<>
			{!!error && (
				<View style={{ marginVertical: 12, gap: 12 }}>
					<T size={12}>{error}</T>
					<Button
						secondary
						disabled={busy || switching}
						onPress={() => {
							void mutate((owns) => readQueue(onRefresh, owns), true)
						}}
					>
						{busy ? '正在读取队列…' : '重新读取队列'}
					</Button>
					<T
						muted
						size={11}
					>
						只读取播放状态，不会再次移除、重排或开始播放。
					</T>
				</View>
			)}
			{undo && (
				<View style={{ marginVertical: 12, gap: 12 }}>
					<Button
						secondary
						disabled={busy || switching || !!error}
						onPress={() => {
							void mutate(() => onUndo(undo.token))
						}}
					>
						撤销移除：{undo.title}
					</Button>
					<T
						muted
						size={11}
					>
						仅在当前队列未变化时可撤销最近一次移除。
					</T>
				</View>
			)}
			</>}
			renderItem={({ item, index }) => (
				<View key={item.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
					<View style={{ flex: 1, minWidth: 0 }}>
					<AppQueueItem
						index={index}
						selected={item.id === currentEntryId}
						mode='music'
						label={`队列第${index + 1}项 ${item.title}`}
						title={item.title}
						artist={item.artist}
						artwork={item.artwork}
						disabled={busy || switching || !!error}
						onLongPress={canMoveNext && currentIndex >= 0 && index !== currentIndex && index !== currentIndex + 1
							? () => { void mutate(() => onMoveNext(item.id)) }
							: undefined}
						onPress={() => {
							if (
								alive.current &&
								!pending.current &&
								!latestSwitching.current &&
								!needsRefresh.current
							)
								onSelect(index, item.id)
						}}
					/>
					</View>
					{currentIndex >= 0 && index !== currentIndex && (
							<IconButton
								name='close'
								label={`移出队列 · ${item.title}`}
								disabled={busy || switching || !!error}
								onPress={() => {
									void mutate(() => onRemove(item.id))
								}}
							/>
					)}
				</View>
			)}
		/>
	)
}
