import React, { useEffect, useRef, useState } from 'react'
import { View, type GestureResponderEvent } from 'react-native'
import type { PlaybackProgress } from './playback-progress'
import { usePlaybackProgress } from './usePlaybackProgress'

import type { ThemeControlRowStatus } from './theme-control-layout'
import {
	ControlRow,
	PackageIconImage,
	T,
	time,
	useBuiltInVisuals,
	useTheme,
	useThemeRendering,
} from './ui'

export function Progress({
	position: fallbackPosition,
	duration: fallbackDuration,
	progress,
	onSeek,
	onDragChange,
	disabled = false,
	layoutRevision,
	onStatusChange,
	announceStatus,
}: {
	position: number
	duration: number
	progress?: PlaybackProgress
	onSeek: (value: number) => void | Promise<void>
	onDragChange?: (dragging: boolean) => void
	disabled?: boolean
	layoutRevision?: string | number
	onStatusChange?: (status: ThemeControlRowStatus) => void
	announceStatus?: boolean
}) {
	const live = usePlaybackProgress(progress, fallbackPosition, fallbackDuration)
	const position = live.position
	const duration = live.duration || fallbackDuration
	const t = useTheme()
	const visual = useBuiltInVisuals()
	const rendering = useThemeRendering()
	const responsive = !!rendering?.controlRowLayout
	const custom = rendering?.progress
	const [length, setLength] = useState(1)
	const [preview, setPreview] = useState<number | null>(null)
	const [direction, setDirection] = useState<'left' | 'right' | null>(null)
	const interaction = useRef<{
		generation: number
		drag: { originX: number; width: number; lastX: number } | null
	}>({ generation: 0, drag: null })
	const enabled = !disabled && duration > 0
	const dragChange = useRef(onDragChange)
	useEffect(() => { dragChange.current = onDragChange }, [onDragChange])
	useEffect(() => {
		const state = interaction.current
		if (state.drag) dragChange.current?.(false)
		state.drag = null
		setPreview(null)
		setDirection(null)
		state.generation++
		return () => {
			state.generation++
			if (state.drag) dragChange.current?.(false)
			state.drag = null
		}
	}, [disabled, duration])
	const shownPosition = preview ?? position
	const percent = Math.max(0, Math.min(1, duration ? shownPosition / duration : 0))
	const thumbSize = custom?.thumbUri ? (custom.sizeDp ?? 28) : (visual?.progress.thumbSizeDp ?? 14)
	const thumbUri = (direction === 'left' ? custom?.dragLeftUri : direction === 'right' ? custom?.dragRightUri : undefined) ?? custom?.thumbUri
	const seek = (value: number) => {
		if (!enabled) return
		const target = Math.max(0, Math.min(value, duration))
		const request = ++interaction.current.generation
		setPreview(target)
		const finish = () => {
			if (request === interaction.current.generation) setPreview(null)
		}
		// The player reports failures and refreshes its position before settling.
		try {
			void Promise.resolve(onSeek(target)).then(finish, finish)
		} catch {
			finish()
		}
	}
	const touchPosition = (event: GestureResponderEvent, width: number) => {
		const x = interaction.current.drag
			? event.nativeEvent.pageX - interaction.current.drag.originX
			: event.nativeEvent.locationX
		return Math.max(0, Math.min(1, x / (interaction.current.drag?.width ?? width))) * duration
	}
	const track = (touchDp: number, measuredWidth?: number) => (
		<View
			accessibilityRole='adjustable'
			accessibilityLabel='播放进度'
			accessibilityState={{ disabled: disabled || duration <= 0 }}
			accessibilityValue={{
				min: 0,
				max: Math.floor(duration),
				now: Math.floor(Math.max(0, Math.min(shownPosition, duration))),
				text: `${time(shownPosition)}，共 ${time(duration)}`,
			}}
			accessibilityActions={[
				{ name: 'increment', label: '前进15秒' },
				{ name: 'decrement', label: '后退15秒' },
			]}
			onAccessibilityAction={({ nativeEvent }) =>
				seek(position + (nativeEvent.actionName === 'increment' ? 15 : -15))
			}
			onLayout={({ nativeEvent }) => setLength(nativeEvent.layout.width || 1)}
			onStartShouldSetResponder={() => enabled}
			onMoveShouldSetResponder={() => enabled}
			onResponderTerminationRequest={() => false}
			onResponderGrant={(event) => {
				if (!enabled) return
				dragChange.current?.(true)
				interaction.current.generation++
				interaction.current.drag = {
					originX: event.nativeEvent.pageX - event.nativeEvent.locationX,
					width: measuredWidth ?? length,
					lastX: event.nativeEvent.pageX,
				}
				setPreview(touchPosition(event, measuredWidth ?? length))
			}}
			onResponderMove={(event) => {
				if (enabled && interaction.current.drag) {
					const delta = event.nativeEvent.pageX - interaction.current.drag.lastX
					if (Math.abs(delta) > 1) setDirection(delta < 0 ? 'left' : 'right')
					interaction.current.drag.lastX = event.nativeEvent.pageX
					setPreview(touchPosition(event, measuredWidth ?? length))
				}
			}}
			onResponderRelease={(event) => {
				if (!interaction.current.drag) return
				const target = touchPosition(event, measuredWidth ?? length)
				interaction.current.drag = null
				dragChange.current?.(false)
				setDirection(null)
				seek(target)
			}}
			onResponderTerminate={() => {
				interaction.current.generation++
				interaction.current.drag = null
				dragChange.current?.(false)
				setDirection(null)
				setPreview(null)
			}}
			style={{
				height: touchDp,
				...(responsive ? ({ width: '100%' } as const) : {}),
				justifyContent: 'center',
				opacity: disabled ? 0.4 : 1,
			}}
		>
			<View
				pointerEvents='none'
				style={{
					height:
						visual?.progress.railHeightDp ??
						(t.components.progress === 'modern' ? 3 : 6),
					borderRadius: 5,
					backgroundColor: custom?.colors?.track ?? (visual
						? t.tokens.border.subtle
						: t.tokens.border.strong),
				}}
			>
				<View
					style={{
						height: '100%',
						width: `${percent * 100}%`,
						backgroundColor: custom?.colors?.fill ?? t.tokens.action.primary,
						borderRadius: 5,
					}}
				/>
			</View>
			<View
				pointerEvents='none'
				style={{
					position: 'absolute',
					left: percent * (measuredWidth ?? length) - thumbSize / 2,
					top: (touchDp - thumbSize) / 2,
					width: thumbSize,
					height: thumbSize,
					borderRadius:
						visual?.progress.thumbRadiusDp ??
						(t.components.progress === 'anime' ? 3 : 10),
					...(visual && t.components.progress === 'pastoral'
						? {
								borderTopLeftRadius: 8,
								borderTopRightRadius: 3,
								borderBottomLeftRadius: 3,
								borderBottomRightRadius: 8,
							}
						: {}),
					transform:
						!custom?.thumbUri && t.components.progress === 'anime' ? [{ rotate: '45deg' }] : [],
					backgroundColor: custom?.thumbUri ? 'transparent' : (custom?.colors?.thumb ?? t.tokens.action.primary),
				}}
			>
				{thumbUri && <PackageIconImage key={thumbUri} uri={thumbUri} size={thumbSize}
					fallback={<View style={{ width: thumbSize, height: thumbSize, borderRadius: thumbSize / 2, backgroundColor: custom?.colors?.thumb ?? t.tokens.action.primary }} />} />}
			</View>
		</View>
	)
	return (
		<View
			style={{ marginTop: visual ? 16 : 22, marginBottom: visual ? 12 : 10 }}
		>
			{responsive ? (
				<ControlRow
					layoutRevision={layoutRevision}
					onStatusChange={onStatusChange}
					announceStatus={announceStatus}
					controlMinWidthsDp={[48]}
					single
				>
					{({ touchDp, availableWidthDp }) => track(touchDp, availableWidthDp)}
				</ControlRow>
			) : (
				track(48)
			)}
			<View
				style={{
					flexDirection: 'row',
					alignItems: 'center',
					justifyContent: 'space-between',
					marginTop: -7,
				}}
			>
				<T
					muted
					size={visual ? 12 : 10}
				>
					{time(shownPosition)}
				</T>
				<T
					muted
					size={visual ? 12 : 10}
				>
					{time(duration)}
				</T>
			</View>
		</View>
	)
}
