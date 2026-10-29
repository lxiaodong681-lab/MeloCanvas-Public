import { useEffect, useMemo, useSyncExternalStore } from 'react'

import type { BilibiliContentScopeReader } from './core/bilibili-content-scope'
import type { CreatorPostCache } from './core/creator-post-cache'
import type { CreatorStore } from './core/creators'
import type { Library } from './core/database'
import { creatorPosts, creatorProfile } from './creator-api'
import { CreatorRemoteSession } from './creator-remote-session'
import { CreatorSession } from './creator-session'

export function useCreators(
	store: CreatorStore,
	library: Library,
	postCache: CreatorPostCache,
	postScopes: BilibiliContentScopeReader,
) {
	const session = useMemo(
		() => new CreatorSession(store, library),
		[store, library],
	)
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	const remote = useMemo(
		() =>
			new CreatorRemoteSession(
				{ profile: creatorProfile, posts: creatorPosts },
				session.acceptProfile,
				postCache,
				postScopes,
				Date.now,
				session.cancelPlayback,
			),
		[session, postCache, postScopes],
	)
	const remoteState = useSyncExternalStore(remote.subscribe, remote.getSnapshot)
	const route = state.routes.at(-1)
	useEffect(() => {
		const syncVisit = () => {
			const current = session.getSnapshot().routes.at(-1)
			remote.select(
				current?.kind === 'profile' ? current.mid : null,
				current?.kind === 'profile' ? current : null,
			)
		}
		const unsubscribe = session.subscribe(syncVisit)
		syncVisit()
		return () => {
			unsubscribe()
			remote.select(null)
		}
	}, [session, remote])
	const remoteReady =
		route?.kind === 'profile' &&
		remoteState.mid === route.mid &&
		remoteState.visit === route
	return { session, state, remote, remoteState, remoteReady }
}
