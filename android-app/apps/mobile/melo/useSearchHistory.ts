import { useState, useSyncExternalStore } from 'react'

import { SearchHistory } from './search-history'

export function useSearchHistory(
	storage: ConstructorParameters<typeof SearchHistory>[0],
) {
	const [session] = useState(() => new SearchHistory(storage))
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	return { state, session }
}
