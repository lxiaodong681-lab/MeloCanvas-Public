import type { Database } from './database'
import type { SavedVideoItem, VideoSaveBucket } from './import-mixed-types'
import {
	contentKind,
	mixedTarget,
	originalVideoBvid,
} from './import-mixed-validation'
import { importTaskLimits } from './import-types'
import {
	directory,
	id,
	integer,
	invalid,
	json,
	keys,
	object,
	reviewValue,
} from './import-validation'

export interface SavedVideoRow extends Omit<
	SavedVideoItem,
	'verification' | 'importOrigin'
> {
	verificationJson: string
	originJson: string
	importTaskId: string
}
export function savedVideoFromRow(row: SavedVideoRow): SavedVideoItem {
	id(row.itemId)
	integer(row.position)
	integer(row.addedAt)
	contentKind(row.contentKind)
	if (mixedTarget(row.contentKind) !== row.bucket)
		invalid('视频收藏类别与目标不一致')
	if (row.reviewedAt !== null) integer(row.reviewedAt)
	const origin = JSON.parse(row.originJson) as SavedVideoItem['importOrigin']
	object(origin)
	keys(origin, [
		'taskId',
		'provider',
		'originalPlaylistId',
		'taskVersion',
		'entryId',
		'originalEntryId',
		'originalPosition',
		'originalMetadata',
		'reviewAtCommit',
	])
	const { snapshot } = directory({
		taskId: origin.taskId,
		provider: origin.provider,
		originalPlaylistId: origin.originalPlaylistId,
		taskVersion: origin.taskVersion,
		originalMetadata: {},
		entries: [
			{
				entryId: origin.entryId,
				originalEntryId: origin.originalEntryId,
				originalPosition: origin.originalPosition,
				originalMetadata: origin.originalMetadata,
			},
		],
	})
	if (
		snapshot.provider !== 'bilibili' ||
		snapshot.taskId !== row.importTaskId ||
		originalVideoBvid(snapshot.entries[0]) !== row.bvid
	)
		invalid('视频收藏原目录身份不一致')
	const verification = JSON.parse(
		row.verificationJson,
	) as SavedVideoItem['verification']
	object(verification)
	keys(verification, ['sourceConfirmed', 'catalogVerified', 'audioCapability'])
	if (
		typeof verification.sourceConfirmed !== 'boolean' ||
		verification.sourceConfirmed ||
		typeof verification.catalogVerified !== 'boolean' ||
		verification.audioCapability !== 'unchecked' ||
		(row.bvid === null && verification.catalogVerified)
	)
		invalid('视频收藏核验状态无效')
	return {
		itemId: row.itemId,
		bucket: row.bucket,
		position: row.position,
		addedAt: row.addedAt,
		bvid: row.bvid,
		contentKind: row.contentKind,
		reviewedAt: row.reviewedAt,
		verification,
		importOrigin: {
			...origin,
			reviewAtCommit: reviewValue(origin.reviewAtCommit),
		},
	}
}

/** Two global local buckets, not user-created video folders. Only commitMixed creates entries. */
export class VideoSaves {
	constructor(private db: Database) {}
	get(itemId: string): SavedVideoItem | null {
		id(itemId)
		const row = this.db.getFirstSync<SavedVideoRow>(
			'SELECT * FROM saved_video_items WHERE itemId = ?',
			[itemId],
		)
		return row ? savedVideoFromRow(row) : null
	}
	list(
		bucket: VideoSaveBucket,
		page: { offset: number; limit: number },
	): SavedVideoItem[] {
		if (bucket !== 'listening' && bucket !== 'unclassified')
			invalid('视频收藏目标无效')
		object(page)
		keys(page, ['offset', 'limit'])
		integer(page.offset)
		integer(page.limit, 1)
		if (page.limit > 100) invalid('每次最多读取100个视频收藏条目')
		return this.db
			.getAllSync<SavedVideoRow>(
				'SELECT * FROM saved_video_items WHERE bucket = ? ORDER BY position LIMIT ? OFFSET ?',
				[bucket, page.limit, page.offset],
			)
			.map(savedVideoFromRow)
	}
	remove(itemId: string): boolean {
		id(itemId)
		// A single DELETE is atomic. Keep ordinal gaps and the historical ledger identity.
		const result = this.db.runSync(
			'DELETE FROM saved_video_items WHERE itemId = ?',
			[itemId],
		) as { changes: number }
		return result.changes > 0
	}
}

export function savedVideoJson(item: SavedVideoItem): {
	origin: string
	verification: string
} {
	const origin = json(
		item.importOrigin,
		importTaskLimits.reviewBytes + importTaskLimits.entryMetadataBytes + 4096,
		importTaskLimits.metadataDepth + 4,
	)
	const verification = json(item.verification, 1024)
	savedVideoFromRow({
		...item,
		importTaskId: item.importOrigin.taskId,
		originJson: origin,
		verificationJson: verification,
	})
	return { origin, verification }
}
