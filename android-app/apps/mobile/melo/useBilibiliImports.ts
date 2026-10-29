import { useEffect, useMemo, useSyncExternalStore } from 'react'

import { mobileAccountFavorites } from './account-favorites-mobile'
import { mobileBilibiliFavoriteFoldersTransport } from './bilibili-favorite-folders-mobile'
import {
	mobileBilibiliFavoriteIndexTransport,
	mobileBilibiliFavoriteTransport,
} from './bilibili-favorite-mobile'
import { BilibiliImportSession } from './bilibili-import-session'
import type { Library } from './core/database'
import type { ImportStore } from './core/imports'
import type { PlaylistStore } from './core/playlists'
import type { VideoCatalog } from './core/video-catalog'
import type { VideoSaves } from './core/video-saves'
import { beginListeningSourceDetails } from './listening-source'

export function useBilibiliImports(
	store: ImportStore,
	library: Library,
	playlists: PlaylistStore,
	catalog: VideoCatalog,
	saves: VideoSaves,
) {
	const session = useMemo(
		() =>
			new BilibiliImportSession(store, library, playlists, catalog, saves, {
				account: mobileAccountFavorites,
				folders: mobileBilibiliFavoriteFoldersTransport,
				page: mobileBilibiliFavoriteTransport,
				index: mobileBilibiliFavoriteIndexTransport,
				video: beginListeningSourceDetails,
			}),
		[store, library, playlists, catalog, saves],
	)
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	useEffect(() => () => session.close(), [session])
	return { session, state }
}
