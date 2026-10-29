import type { Library } from './core/database'
import type { PlaylistEntry } from './core/playlists'
import type {
	PlaybackIntent,
	PlaybackPreparation,
	PlaybackPreparationPort,
} from './playback-intent'

/** A transient collection queue. Does not create or modify a saved playlist. */
export function playLikedCollection(
	library: Pick<Library, 'musicLikes'>,
	intent: PlaybackIntent,
	player: PlaybackPreparationPort & {
		playPlaylist: (
			entries: PlaylistEntry[],
			startItemId: string,
			preparation: PlaybackPreparation,
		) => Promise<boolean>
	},
	onSuccess: () => void,
): Promise<boolean> {
	return intent.run({
		preparation: player,
		prepare: async () => {
			const sources = library.musicLikes()
			if (!sources.length) throw new Error('还没有喜欢的音源，请先添加喜欢')
			return sources.map((source) => ({ itemId: `liked:${source.id}`, source }))
		},
		activate: (entries, preparation) =>
			player.playPlaylist(entries, entries[0].itemId, preparation),
		onSuccess,
	})
}
