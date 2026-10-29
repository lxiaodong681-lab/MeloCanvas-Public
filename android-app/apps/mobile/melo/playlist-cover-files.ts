export interface SavedPlaylistCover {
	uri: string
	discard: () => void
}
export interface PlaylistCoverFiles {
	pick: () => Promise<string | null>
	persist: (uri: string) => Promise<SavedPlaylistCover>
}
