import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import type { RecommendationStore } from './core/recommendations'
import {
	FmSession,
	type FmPlaybackPort,
	type FmPlayerState,
} from './fm-session'
import type { PlaybackIntent } from './playback-intent'
import type { HeartDiscoveryPort } from './heart-discovery'

type Player = FmPlayerState & Omit<FmPlaybackPort, 'read'>

export function useFm(
	store: RecommendationStore,
	intent: PlaybackIntent,
	player: Player,
	heart?: HeartDiscoveryPort,
) {
	const [latest] = useState(() => {
		let current = player
		return {
			read: () => current,
			update: (next: Player) => {
				current = next
			},
		}
	})
	const port = useMemo<FmPlaybackPort>(
		() => ({
			read: latest.read,
			reservePlayback: () => latest.read().reservePlayback(),
			isPreparationCurrent: (preparation) =>
				latest.read().isPreparationCurrent(preparation),
			cancelPreparation: (preparation) =>
				latest.read().cancelPreparation(preparation),
			finishPreparation: (preparation) =>
				latest.read().finishPreparation?.(preparation) ?? Promise.resolve(),
			startFm: (sources, preparation) =>
				latest.read().startFm(sources, preparation),
			exitFm: (fmId, preparation) => latest.read().exitFm(fmId, preparation),
			appendFm: (sources, fmId, tail) =>
				latest.read().appendFm(sources, fmId, tail),
		}),
		[latest],
	)
	const session = useMemo(
		() => new FmSession(store, intent, port, heart),
		[store, intent, port, heart],
	)
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	useEffect(() => {
		latest.update(player)
		void session.observe()
	}, [session, latest, player])
	useEffect(() => () => session.close(), [session])
	return { session, state }
}
