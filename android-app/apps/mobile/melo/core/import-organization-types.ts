import type {
	ContentKind,
	MixedVerification,
	SavedVideoItem,
} from './import-mixed-types'
import type { ImportPlaylistTarget } from './import-playlist-types'
import type { PlaylistDetail } from './playlists'

export interface ImportOrganizationRequest {
	operationId: string
	expectedRevision: number
	expectedItem: Pick<SavedVideoItem, 'itemId' | 'bvid' | 'position' | 'addedAt'>
	musicTarget: ImportPlaylistTarget | null
}
export interface ImportOrganizationReceipt {
	kind: 'organization'
	version: 1
	operationId: string
	taskId: string
	entryId: string
	request: ImportOrganizationRequest
	taskRevision: number
	organizedAt: number
	itemId: string
	bvid: string | null
	addedAt: number
	/** The initial receipt/ledger remains unclassified; this is a separate explicit move. */
	fromPosition: number
	contentKind: Exclude<ContentKind, 'unknown'>
	reviewedAt: number
	targetKind: 'playlist' | 'listening'
	/** Local playlist identity or 'local' for the existing global listening bucket. */
	targetId: string
	position: number
	sourceId: string | null
	verification: MixedVerification
	playlistUpdatedAt: number | null
}
export interface ImportOrganizationResult {
	receipt: ImportOrganizationReceipt
	/** Current target, possibly null on historical replay after removal/deletion. */
	playlist: PlaylistDetail | null
	video: SavedVideoItem | null
}
