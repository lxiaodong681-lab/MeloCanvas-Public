import { useEffect, useState, useSyncExternalStore } from 'react'

import { search } from './bilibili'
import { SearchSession } from './search-session'

export function useSearch() {
	const [session] = useState(() => new SearchSession(search))
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	useEffect(() => () => session.cancel(), [session])
	return {
		...state,
		find: session.find,
		setOrder: session.setOrder,
		retry: session.retry,
		loadMore: session.loadMore,
	}
}
