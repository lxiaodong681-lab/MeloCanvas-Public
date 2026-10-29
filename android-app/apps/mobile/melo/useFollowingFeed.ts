import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'

import type { CreatorPostCache } from './core/creator-post-cache'
import { creatorPosts } from './creator-api'
import type { CreatorSession } from './creator-session'
import {
	FollowingFeedSession,
	type FollowingFeedReader,
} from './following-feed-session'

export function useFollowingFeed(
	store: FollowingFeedReader,
	creators: CreatorSession,
	cache?: CreatorPostCache,
) {
	const session = useMemo(
		() => new FollowingFeedSession(store, cache, creatorPosts),
		[store, cache],
	)
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	useEffect(() => {
		const resume = () => {
			if (!creators.getSnapshot().routes.length) session.resumeFromOverlay()
		}
		const unsubscribe = creators.subscribe(resume)
		resume()
		const foreground = AppState.addEventListener('change', (value) => {
			if (value === 'active') session.load()
			else session.cancelRefresh()
		})
		return () => {
			unsubscribe()
			foreground.remove()
			session.close()
		}
	}, [session, creators])
	return { session, state }
}
