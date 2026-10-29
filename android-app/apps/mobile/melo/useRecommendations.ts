import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'

import type { RecommendationStore } from './core/recommendations'
import { RecommendationSession } from './recommendation-session'

export function useRecommendations(store: RecommendationStore) {
	const session = useMemo(() => new RecommendationSession(store), [store])
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	useEffect(() => {
		const foreground = AppState.addEventListener('change', (value) => {
			if (value === 'active' && session.getSnapshot().open) session.load()
		})
		return () => {
			foreground.remove()
			session.close()
		}
	}, [session])
	return { session, state }
}
