import { useSyncExternalStore } from 'react'
import type { PlaybackProgress } from './playback-progress'

const idle = { position: 0, duration: 0 }
const idleSnapshot = () => idle
const idleSubscribe = () => () => {}
export function usePlaybackProgress(progress: PlaybackProgress | undefined, position: number, duration: number) {
	const live = useSyncExternalStore(progress?.subscribe ?? idleSubscribe, progress?.getSnapshot ?? idleSnapshot)
	return progress ? live : { position, duration }
}
