import type { PlaylistImportOrigin } from './import-playlist-types'
import { importTaskLimits, type ImportReview } from './import-types'
import {
	directory,
	id,
	invalid,
	json,
	keys,
	object,
	reviewValue,
} from './import-validation'
import type { PlaylistItem } from './playlists'

export interface PlaylistItemRow {
	itemId: string
	playlistId: string
	sourceId: string | null
	position: number
	addedAt: number
	importTaskId?: string | null
	originJson?: string | null
	reviewJson?: string | null
}

/** Pure codec shared by the two transactional stores, never a write entry point. */
export function playlistItemFromRow(row: PlaylistItemRow): PlaylistItem {
	const base = {
		itemId: row.itemId,
		playlistId: row.playlistId,
		sourceId: row.sourceId,
		position: row.position,
		addedAt: row.addedAt,
	}
	if (
		row.importTaskId == null &&
		row.originJson == null &&
		row.reviewJson == null
	) {
		if (row.sourceId === null) invalid('待匹配歌单条目缺少导入证据')
		return { ...base, importOrigin: null, review: null }
	}
	if (!row.importTaskId || !row.originJson || !row.reviewJson)
		invalid('歌单导入证据不完整')
	const origin = JSON.parse(row.originJson) as PlaylistImportOrigin
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
	const checked = directory({
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
	}).snapshot
	if (checked.taskId !== row.importTaskId) invalid('歌单导入任务引用不一致')
	const reviewAtCommit = reviewValue(origin.reviewAtCommit)
	const review = reviewValue(JSON.parse(row.reviewJson) as ImportReview)
	if (
		row.sourceId === null
			? review.state === 'confirmed'
			: review.state !== 'confirmed' ||
				review.confirmation?.sourceId !== row.sourceId
	)
		invalid('歌单首选音源与审核状态不一致')
	return {
		...base,
		importOrigin: {
			taskId: checked.taskId,
			provider: checked.provider,
			originalPlaylistId: checked.originalPlaylistId,
			taskVersion: checked.taskVersion,
			...checked.entries[0],
			reviewAtCommit,
		},
		review,
	}
}

export function playlistImportJson(
	item: PlaylistItem,
): { origin: string; review: string; taskId: string } | null {
	if (!item.importOrigin && !item.review) {
		if (item.sourceId === null) invalid('待匹配条目必须保留导入证据')
		return null
	}
	if (!item.importOrigin || !item.review) invalid('歌单导入证据不完整')
	id(item.importOrigin.taskId)
	const origin = json(
		item.importOrigin,
		importTaskLimits.reviewBytes + importTaskLimits.entryMetadataBytes + 4096,
		importTaskLimits.metadataDepth + 4,
	)
	const review = json(
		item.review,
		importTaskLimits.reviewBytes,
		importTaskLimits.metadataDepth + 3,
	)
	playlistItemFromRow({
		...item,
		importTaskId: item.importOrigin.taskId,
		originJson: origin,
		reviewJson: review,
	})
	return { origin, review, taskId: item.importOrigin.taskId }
}
