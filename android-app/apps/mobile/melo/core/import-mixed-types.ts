import type { ImportOrganizationReceipt } from './import-organization-types'
import type {
	ImportCommitReceipt,
	ImportPlaylistTarget,
	PlaylistImportOrigin,
} from './import-playlist-types'
import type { ImportTaskDetail } from './import-types'
import type { PlaylistDetail, PlaylistDuplicatePolicy } from './playlists'

export const contentKinds = [
	'song',
	'musicCollection',
	'audioDrama',
	'audiobook',
	'knowledge',
	'commentary',
	'other',
	'unknown',
] as const
export type ContentKind = (typeof contentKinds)[number]
export type VideoSaveBucket = 'listening' | 'unclassified'
export type MixedTargetKind = 'playlist' | VideoSaveBucket
export interface FavoritePlaylistDefault {
	entryId: string
	sourceId: string | null
	/** Non-video entries remain in the source task, outside the music playlist. */
	skip?: boolean
	unavailable?: string
}
export interface ImportContentReview {
	entryId: string
	kind: ContentKind
	/** Null means the default unknown, not an automatic classification. */
	reviewedAt: number | null
}
export interface MixedCommitRequest {
	commitId: string
	expectedRevision: number
	musicTarget: ImportPlaylistTarget | null
	songDuplicatePolicy: PlaylistDuplicatePolicy
	videoDuplicatePolicy: 'keep-all' | 'skip-existing-video'
	itemIds: { entryId: string; itemId: string }[]
}
export interface MixedVerification {
	sourceConfirmed: boolean
	catalogVerified: boolean
	/** Confirmed CID / cached view metadata do not prove an independent audio track. */
	audioCapability: 'unchecked'
}
export interface MixedOccurrenceResult {
	entryId: string
	originalEntryId: string | null
	originalPosition: number
	requestedItemId: string
	itemId: string | null
	outcome: 'added' | 'skipped'
	targetKind: MixedTargetKind
	/** Playlist identity or the local video bucket identity. */
	targetId: string
	contentKind: ContentKind
	reviewedAt: number | null
	bvid: string | null
	sourceId: string | null
	skipKey: string | null
	verification: MixedVerification
}
export interface MixedCommitReceipt {
	kind: 'mixed'
	version: 1
	commitId: string
	taskId: string
	request: MixedCommitRequest
	taskRevision: number
	playlistId: string | null
	playlistUpdatedAt: number | null
	committedAt: number
	results: MixedOccurrenceResult[]
	counts: {
		playlist: { added: number; skipped: number; withoutConfirmedCid: number }
		listening: { added: number; skipped: number }
		unclassified: { added: number; skipped: number }
		unselected: number
		unprocessed: number
	}
}
export type ImportCommitHistory =
	| { kind: 'playlist'; receipt: ImportCommitReceipt }
	| { kind: 'mixed'; receipt: MixedCommitReceipt }
export interface MixedImportTaskDetail extends ImportTaskDetail {
	contentReviews: ImportContentReview[]
	/** Complete processing history. The inherited commits field remains legacy playlist-only. */
	history: ImportCommitHistory[]
	/** Separate organization history; never count these as another initial commit. */
	organizations: ImportOrganizationReceipt[]
}
export interface MixedCommitResult {
	receipt: MixedCommitReceipt
	/** Null for zero-song commits or a replay whose target was deleted. */
	playlist: PlaylistDetail | null
}
export interface SavedVideoItem {
	itemId: string
	bucket: VideoSaveBucket
	position: number
	addedAt: number
	bvid: string | null
	contentKind: ContentKind
	reviewedAt: number | null
	verification: MixedVerification
	importOrigin: PlaylistImportOrigin
}
