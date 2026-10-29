import type { ImportCommitReceipt } from './import-playlist-types'

/** Directory evidence and review state, independent of platform audio rights. */
export type ImportProvider = 'bilibili' | 'netease' | 'qq' | 'kugou' | 'kuwo' | 'qishui'
export type ExternalImportProvider = Exclude<ImportProvider, 'bilibili'>
export const externalImportProviders = ['netease', 'qq', 'kugou', 'kuwo', 'qishui'] as const
export type ImportJson =
	| null
	| boolean
	| number
	| string
	| ImportJson[]
	| ImportMetadata
export interface ImportMetadata {
	[key: string]: ImportJson
}

export interface ImportDirectoryEntry {
	entryId: string
	originalEntryId: string | null
	originalPosition: number
	originalMetadata: ImportMetadata
}
export interface ImportDirectorySnapshot {
	taskId: string
	provider: ImportProvider
	originalPlaylistId: string
	taskVersion: number
	originalMetadata: ImportMetadata
	entries: ImportDirectoryEntry[]
}
export interface ImportCandidate {
	candidateId: string
	bvid: string
	cid: number | null
	metadata: ImportMetadata
	evidence: ImportMetadata
}
export interface ImportConfirmation {
	candidateId: string
	sourceId: string
}
export interface ImportReview {
	state: 'pending' | 'needs-review' | 'not-found' | 'unreadable' | 'confirmed'
	candidates: ImportCandidate[]
	/** Explicit source choice or the Bilibili folder-to-playlist P1 default; never inferred from candidate confidence. */
	confirmation: ImportConfirmation | null
}
export interface ImportRetryInput {
	errorCode: string | null
	message: string
}
export interface ImportRetryRecord extends ImportRetryInput {
	sequence: number
	taskRevision: number
	createdAt: number
}
export interface ImportReviewDecision {
	selected?: boolean
	review?: ImportReview
	/** Append one observed retry result; this does not schedule any request. */
	retry?: ImportRetryInput
}
export interface ImportTask {
	taskId: string
	provider: ImportProvider
	originalPlaylistId: string
	taskVersion: number
	revision: number
	createdAt: number
	updatedAt: number
	entryCount: number
}
export interface ImportTaskEntry extends ImportDirectoryEntry {
	selected: boolean
	review: ImportReview
	reviewedAt: number | null
	retries: ImportRetryRecord[]
}
export interface ImportTaskDetail extends ImportTask {
	originalMetadata: ImportMetadata
	entries: ImportTaskEntry[]
	commits: ImportCommitReceipt[]
}

export const importTaskLimits = {
	entries: 5000,
	directoryBytes: 8 * 1024 * 1024,
	playlistMetadataBytes: 1024 * 1024,
	entryMetadataBytes: 16 * 1024,
	reviewBytes: 64 * 1024,
	taskReviewBytes: 8 * 1024 * 1024,
	metadataDepth: 8,
	candidates: 20,
	retriesPerEntry: 100,
	idLength: 512,
} as const

export class ImportConflictError extends Error {
	constructor(
		readonly code:
			| 'IMPORT_DIRECTORY_CONFLICT'
			| 'IMPORT_REVISION_CONFLICT'
			| 'IMPORT_COMMIT_CONFLICT'
			| 'IMPORT_TARGET_CONFLICT',
		message: string,
	) {
		super(message)
		this.name = 'ImportConflictError'
	}
}
