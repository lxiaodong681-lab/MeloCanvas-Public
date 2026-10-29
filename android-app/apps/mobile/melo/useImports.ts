import { fetch } from 'expo/fetch'

import { getAccountAccess } from './account-access'
import { accountSession } from './account-runtime'
import { createAccountDirectoryFetch } from './account-directory-fetch'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'

import { search } from './bilibili'
import type { Library } from './core/database'
import type { ImportStore } from './core/imports'
import type { PlaylistStore } from './core/playlists'
import { createExternalDirectoryTransport } from './external-directory-transport'
import { createImportDirectoryReader } from './import-directory-reader'
import { ImportSession } from './import-session'
import { listeningSourceDetails } from './listening-source'

export function useImports(
	store: ImportStore,
	library: Library,
	playlists: PlaylistStore,
) {
	const session = useMemo(
		() =>
			new ImportSession(store, library, playlists, {
				readDirectory: createImportDirectoryReader(
					createExternalDirectoryTransport(
						createAccountDirectoryFetch(fetch, getAccountAccess, accountSession.subscribe),
					),
				),
				search: (keyword, page, signal, rereadIncomplete = true) =>
					search(keyword, page, signal, 'relevance', rereadIncomplete),
				video: listeningSourceDetails,
			}),
		[store, library, playlists],
	)
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	useEffect(() => {
		const subscription = AppState.addEventListener('change', (appState) => {
			if (appState !== 'active') session.pauseBatch()
		})
		return () => {
			subscription.remove()
			session.close()
		}
	}, [session])
	return { session, state }
}
