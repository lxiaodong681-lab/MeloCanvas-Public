import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import type { CreatorStore } from './core/creators'
import { searchCreators } from './creator-api'
import { CreatorSearchSession } from './creator-search-session'
import { readSearchLocalFollowing } from './search-local-following'

export function useCreatorSearch(
	active: boolean,
	store: Pick<CreatorStore, 'listSubscriptions'>,
	localRevision: unknown,
) {
	const [session] = useState(() => new CreatorSearchSession(searchCreators))
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	const [followingRevision, setFollowingRevision] = useState(0)
	const following = useMemo(
		() => ({
			// Keep invalidation keys with the snapshot; neither changes remote search.
			localRevision,
			followingRevision,
			snapshot: active
				? readSearchLocalFollowing(store)
				: { scopes: null, error: '' },
		}),
		[active, store, localRevision, followingRevision],
	)
	useEffect(() => {
		if (!active) session.cancel()
	}, [active, session])
	useEffect(() => () => session.cancel(), [session])
	return {
		session,
		state,
		following: {
			...following.snapshot,
			refresh: () => setFollowingRevision((value) => value + 1),
		},
	}
}
