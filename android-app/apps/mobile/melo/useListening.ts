import { useEffect, useRef, useState } from 'react'
import { Alert } from 'react-native'

import type { PlaybackMode } from './core/listening'
import type { SearchItem, Source } from './core/model'
import {
	ListeningPartsOwner,
	readCurrentListeningParts,
	acceptExplicitListeningParts,
} from './listening-parts-state'
import {
	selectListening,
	loadListeningSelectionVideo,
} from './listening-selection'
import { listeningSourceDetails, type ListeningVideo } from './listening-source'
import type {
	PlaybackIntent,
	PlaybackRequest,
	PlaybackPreparation,
	PlaybackPreparationPort,
} from './playback-intent'

interface ListeningPlayback extends PlaybackPreparationPort {
	mode: PlaybackMode
	playing: boolean
	playListening: (
		source: Source,
		preparation: PlaybackPreparation,
		relatedSources?: Source[],
	) => Promise<boolean>
}

function confirmMusicSwitch(): Promise<boolean> {
	return new Promise((resolve) => {
		Alert.alert(
			'切换到听视频？',
			'当前音乐会暂停，队列和进度会暂存。返回音乐时恢复并继续播放。',
			[
				{ text: '继续听音乐', style: 'cancel', onPress: () => resolve(false) },
				{ text: '开始收听', onPress: () => resolve(true) },
			],
			{ cancelable: true, onDismiss: () => resolve(false) },
		)
	})
}

export function useListening(
	player: ListeningPlayback,
	current: Source | null,
	onStarted: () => void,
	onError: (message: string) => void,
	intent: PlaybackIntent,
) {
	const [video, setVideo] = useState<ListeningVideo | null>(null)
	const [partsLoading, setPartsLoading] = useState(false)
	const [partsError, setPartsError] = useState('')
	const [pendingBvid, setPendingBvid] = useState('')
	const [revision, setRevision] = useState(0)
	const cache = useRef(new Map<string, ListeningVideo>())
	const partsOwner = useRef(new ListeningPartsOwner())
	const selection = useRef<PlaybackRequest | null>(null)
	const latest = useRef(player)
	useEffect(() => {
		latest.current = player
	}, [player])
	const currentBvid = player.mode === 'listening' ? current?.bvid : undefined
	useEffect(() => {
		if (!currentBvid) {
			partsOwner.current.cancel()
			setVideo(null)
			setPartsLoading(false)
			setPartsError('')
			return
		}
		const cached = cache.current.get(currentBvid)
		if (cached) {
			setVideo(cached)
			setPartsError('')
			setPartsLoading(false)
			return
		}
		return readCurrentListeningParts(
			partsOwner.current,
			currentBvid,
			cache.current,
			listeningSourceDetails,
			{ video: setVideo, loading: setPartsLoading, error: setPartsError },
		)
	}, [currentBvid, revision])
	useEffect(
		() => () => {
			selection.current = null
			intent.cancel()
		},
		[intent],
	)

	async function start(
		item: Pick<SearchItem, 'bvid'> | Source,
		callbacks?: {
			onStarted?: () => void
			onError?: (message: string) => void
			onRequest?: (request: PlaybackRequest) => void
			onCancelled?: () => void
			validateVideo?: (video: ListeningVideo) => void
			validateBeforePlay?: () => void
			verifiedVideo?: ListeningVideo
		},
	): Promise<boolean> {
		let owned: PlaybackRequest | null = null
		const aborted = () => {
			if (selection.current === owned) setPendingBvid('')
		}
		try {
			return await intent.run({
				preparation: latest.current,
				onRequest: (request) => {
					owned = request
					selection.current = request
					setPendingBvid(item.bvid)
					request.signal.addEventListener('abort', aborted)
					callbacks?.onRequest?.(request)
				},
				prepare: async (signal, preparation) => {
					if (callbacks?.verifiedVideo && !('cid' in item))
						throw new Error('已核验目录仍需明确选择原 CID，不能默认首 P')
					return selectListening(item, signal, {
						load: async (bvid, requestSignal) => {
							const loaded = await loadListeningSelectionVideo(
								bvid,
								requestSignal,
								listeningSourceDetails,
								callbacks?.verifiedVideo,
							)
							if (
								!requestSignal.aborted &&
								!(await latest.current.isPreparationCurrent(preparation))
							)
								owned?.cancel()
							if (!requestSignal.aborted) callbacks?.validateVideo?.(loaded)
							return loaded
						},
						current: () => latest.current,
						confirm: async () => {
							const confirmed = await confirmMusicSwitch()
							if (!confirmed && owned?.isCurrent()) callbacks?.onCancelled?.()
							return confirmed
						},
						play: async (source, related) => {
							if (callbacks?.validateBeforePlay) {
								if (signal.aborted || !owned?.isCurrent()) return false
								if (!(await latest.current.isPreparationCurrent(preparation))) {
									owned.cancel()
									return false
								}
								if (signal.aborted || !owned.isCurrent()) return false
								callbacks.validateBeforePlay()
							}
							return latest.current.playListening(source, preparation, related)
						},
					})
				},
				activate: async (value) => !!value,
				onSuccess: (value) => {
					if (!value) return
					acceptExplicitListeningParts(
						partsOwner.current,
						cache.current,
						value,
						{
							video: setVideo,
							loading: setPartsLoading,
							error: setPartsError,
						},
					)
					;(callbacks?.onStarted ?? onStarted)()
				},
			})
		} catch (error) {
			;(callbacks?.onError ?? onError)(
				error instanceof Error ? error.message : '读取听视频音源失败，请重试',
			)
			return false
		} finally {
			;(owned as PlaybackRequest | null)?.signal.removeEventListener(
				'abort',
				aborted,
			)
			if (selection.current === owned) {
				selection.current = null
				setPendingBvid('')
			}
		}
	}

	async function cancel() {
		intent.cancel()
		selection.current = null
		setPendingBvid('')
	}

	function retryParts() {
		if (currentBvid) cache.current.delete(currentBvid)
		setRevision((value) => value + 1)
	}

	return {
		start,
		cancel,
		pendingBvid,
		parts: video && video.bvid === currentBvid ? video.parts : [],
		partsLoading,
		partsError,
		retryParts,
	}
}
