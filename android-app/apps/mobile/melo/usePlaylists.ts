import { useMemo, useSyncExternalStore } from 'react'

import type { Library } from './core/database'
import type { PlaylistStore } from './core/playlists'
import { playlistCoverFiles } from './playlist-cover-mobile'
import { PlaylistSession } from './playlist-session'

export function usePlaylists(store: PlaylistStore, library: Library) {
	const session = useMemo(
		() => new PlaylistSession(store, library, undefined, playlistCoverFiles),
		[store, library],
	)
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	return { session, state }
}
