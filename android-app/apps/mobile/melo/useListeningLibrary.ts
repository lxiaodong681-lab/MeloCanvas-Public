import { useEffect, useMemo, useSyncExternalStore } from 'react'

import type { BilibiliReadGate } from './bilibili-import-network'
import type { VideoCatalog } from './core/video-catalog'
import type { VideoSaves } from './core/video-saves'
import { ListeningLibrarySession } from './listening-library-session'
import { beginListeningSourceDetails } from './listening-source'

export function useListeningLibrary(
	saves: VideoSaves,
	catalog: VideoCatalog,
	gate: BilibiliReadGate,
) {
	const session = useMemo(
		() =>
			new ListeningLibrarySession(
				saves,
				catalog,
				beginListeningSourceDetails,
				gate,
			),
		[saves, catalog, gate],
	)
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	useEffect(() => () => session.close(), [session])
	return { session, state }
}
