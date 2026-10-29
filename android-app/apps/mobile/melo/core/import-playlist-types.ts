import type {
	ImportDirectoryEntry,
	ImportProvider,
	ImportReview,
} from './import-types'
import type { PlaylistDetail, PlaylistDuplicatePolicy } from './playlists'

/** Immutable per-occurrence evidence. Playlist metadata remains in the referenced task snapshot. */
export interface PlaylistImportOrigin extends ImportDirectoryEntry {
	taskId: string
	provider: ImportProvider
	originalPlaylistId: string
	taskVersion: number
	reviewAtCommit: ImportReview
}

export type ImportPlaylistTarget =
	| { kind: 'create'; playlistId: string; name: string }
	| { kind: 'append'; playlistId: string; expectedUpdatedAt: number }

export interface ImportCommitRequest {
	commitId: string
	expectedRevision: number
	target: ImportPlaylistTarget
	duplicatePolicy: PlaylistDuplicatePolicy
	itemIds: { entryId: string; itemId: string }[]
}

export interface ImportOccurrenceResult {
	entryId: string
	requestedItemId: string
	/** Null for a skipped source. This is historical and survives later removal. */
	itemId: string | null
	sourceId: string | null
	outcome: 'added' | 'skipped'
}

export interface ImportCommitReceipt {
	commitId: string
	taskId: string
	request: ImportCommitRequest
	playlistId: string
	taskRevision: number
	playlistUpdatedAt: number
	committedAt: number
	results: ImportOccurrenceResult[]
}

export interface ImportCommitResult {
	receipt: ImportCommitReceipt
	/** Fresh read; null if a replay's target has since been deleted. */
	playlist: PlaylistDetail | null
}

export interface ImportResolveRequest {
	playlistId: string
	itemId: string
	expectedRevision: number
	expectedUpdatedAt: number
}
