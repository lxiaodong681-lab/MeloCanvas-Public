import type { Database } from './database'
import type { ContentKind, ImportContentReview } from './import-mixed-types'
import { contentKind, originalVideoBvid } from './import-mixed-validation'
import type {
	ImportOrganizationReceipt,
	ImportOrganizationRequest,
	ImportOrganizationResult,
} from './import-organization-types'
import {
	ImportConflictError,
	importTaskLimits as limits,
	type ImportReview,
	type ImportTaskDetail,
} from './import-types'
import { id, integer, invalid, json, keys, object } from './import-validation'
import { playlistImportJson } from './playlist-import'
import { PlaylistStore, type PlaylistItem } from './playlists'
import {
	savedVideoFromRow,
	type SavedVideoRow,
	VideoSaves,
} from './video-saves'

export interface OrganizationRow {
	operationId: string
	taskId: string
	entryId: string
	itemId: string
	requestJson: string
	receiptJson: string
	taskRevision: number
	organizedAt: number
	targetKind: 'playlist' | 'listening'
	targetId: string
	contentKind: Exclude<ContentKind, 'unknown'>
	sourceId: string | null
	resolvedSourceId: string | null
	resolvedAt: number | null
}
export interface OrganizationOriginLedger {
	itemId: string | null
	outcome: string
	targetKind?: string
	targetId?: string
	contentKind?: ContentKind | null
	sourceId: string | null
	resolvedSourceId: string | null
}
function targetConflict(
	message = '原待分类条目或目标已变更，请重新读取后确认',
): never {
	throw new ImportConflictError('IMPORT_TARGET_CONFLICT', message)
}
function operationConflict(message: string): never {
	throw new ImportConflictError('IMPORT_COMMIT_CONFLICT', message)
}
export function organizationRequest(value: ImportOrganizationRequest): {
	request: ImportOrganizationRequest
	text: string
} {
	object(value)
	keys(value, [
		'operationId',
		'expectedRevision',
		'expectedItem',
		'musicTarget',
	])
	id(value.operationId)
	integer(value.expectedRevision)
	object(value.expectedItem)
	keys(value.expectedItem, ['itemId', 'bvid', 'position', 'addedAt'])
	id(value.expectedItem.itemId)
	integer(value.expectedItem.position)
	integer(value.expectedItem.addedAt)
	if (
		value.expectedItem.bvid !== null &&
		(typeof value.expectedItem.bvid !== 'string' ||
			!/^BV[A-Za-z0-9]{10}$/.test(value.expectedItem.bvid))
	)
		invalid('原待分类视频 BV 无效')
	let musicTarget: ImportOrganizationRequest['musicTarget']
	if (value.musicTarget === null) musicTarget = null
	else {
		object(value.musicTarget)
		id(value.musicTarget.playlistId)
		if (value.musicTarget.kind === 'create') {
			keys(value.musicTarget, ['kind', 'playlistId', 'name'])
			if (
				typeof value.musicTarget.name !== 'string' ||
				!value.musicTarget.name.trim() ||
				value.musicTarget.name.length > limits.idLength
			)
				invalid('本地副本名称无效')
			musicTarget = {
				...value.musicTarget,
				name: value.musicTarget.name.trim(),
			}
		} else if (value.musicTarget.kind === 'append') {
			keys(value.musicTarget, ['kind', 'playlistId', 'expectedUpdatedAt'])
			integer(value.musicTarget.expectedUpdatedAt)
			musicTarget = { ...value.musicTarget }
		} else invalid('整理音乐目标无效')
	}
	const request = {
		operationId: value.operationId,
		expectedRevision: value.expectedRevision,
		expectedItem: { ...value.expectedItem },
		musicTarget,
	}
	return { request, text: json(request, limits.reviewBytes, 4) }
}
function organizationReceipt(row: OrganizationRow): ImportOrganizationReceipt {
	const receipt = JSON.parse(row.receiptJson) as ImportOrganizationReceipt
	if (
		receipt.kind !== 'organization' ||
		receipt.version !== 1 ||
		receipt.operationId !== row.operationId ||
		receipt.taskId !== row.taskId ||
		receipt.entryId !== row.entryId ||
		receipt.itemId !== row.itemId ||
		receipt.targetKind !== row.targetKind ||
		receipt.targetId !== row.targetId ||
		receipt.contentKind !== row.contentKind ||
		receipt.sourceId !== row.sourceId ||
		receipt.taskRevision !== row.taskRevision ||
		receipt.organizedAt !== row.organizedAt ||
		organizationRequest(receipt.request).text !== row.requestJson
	)
		invalid('待分类整理记录不一致')
	return receipt
}
function organizationSchema(db: Database): boolean {
	return (
		(db.getFirstSync<{ user_version: number }>('PRAGMA user_version', [])
			?.user_version ?? 0) >= 11
	)
}
export function readOrganizations(
	db: Database,
	taskId: string,
): ImportOrganizationReceipt[] {
	if (!organizationSchema(db)) return []
	return db
		.getAllSync<OrganizationRow>(
			'SELECT * FROM import_item_organizations WHERE taskId = ? ORDER BY taskRevision',
			[taskId],
		)
		.map(organizationReceipt)
}
/** Internal binding projection only. The initial ledger remains immutable. Caller owns the transaction. */
export function organizationPendingBinding(
	db: Database,
	taskId: string,
	entryId: string,
	ledger: OrganizationOriginLedger | null,
): OrganizationRow | null {
	if (!organizationSchema(db)) return null
	const row = db.getFirstSync<OrganizationRow>(
		'SELECT * FROM import_item_organizations WHERE taskId = ? AND entryId = ?',
		[taskId, entryId],
	)
	if (!row) return null
	organizationReceipt(row)
	if (
		!ledger ||
		ledger.outcome !== 'added' ||
		ledger.targetKind !== 'unclassified' ||
		ledger.targetId !== 'local' ||
		ledger.contentKind !== 'unknown' ||
		ledger.itemId !== row.itemId ||
		ledger.sourceId !== null ||
		ledger.resolvedSourceId !== null
	)
		targetConflict('整理记录与原待分类导入身份不一致')
	return row
}

/** Internal transaction body used only by ImportStore. No nested transaction or Source/catalog writes. */
export function organizeUnclassified(
	db: Database,
	taskId: string,
	entryId: string,
	command: ReturnType<typeof organizationRequest>,
	reads: {
		task: (expectedRevision: number) => ImportTaskDetail
		confirmedSource: (review: ImportReview) => string
	},
): ImportOrganizationResult {
	const { request, text } = command
	const playlists = new PlaylistStore(db),
		videos = new VideoSaves(db)
	const prior = db.getFirstSync<OrganizationRow>(
		'SELECT * FROM import_item_organizations WHERE operationId = ?',
		[request.operationId],
	)
	if (prior) {
		if (
			prior.taskId !== taskId ||
			prior.entryId !== entryId ||
			prior.requestJson !== text
		)
			operationConflict('本次整理身份已用于不同操作')
		return {
			receipt: organizationReceipt(prior),
			playlist:
				prior.targetKind === 'playlist' ? playlists.get(prior.targetId) : null,
			video: prior.targetKind === 'listening' ? videos.get(prior.itemId) : null,
		}
	}
	const task = reads.task(request.expectedRevision)
	if (task.provider !== 'bilibili') invalid('待分类整理仅适用于 B站任务')
	const entry = task.entries.find((item) => item.entryId === entryId)
	if (!entry) invalid('原待分类出现项不存在')
	if (
		db.getFirstSync(
			'SELECT operationId FROM import_item_organizations WHERE taskId = ? AND entryId = ?',
			[taskId, entryId],
		)
	)
		operationConflict('原待分类出现项已经整理，不能再次搬移')
	const ledger = db.getFirstSync<OrganizationOriginLedger>(
		'SELECT * FROM import_commit_entries WHERE taskId = ? AND entryId = ?',
		[taskId, entryId],
	)
	const raw = db.getFirstSync<SavedVideoRow>(
		'SELECT * FROM saved_video_items WHERE itemId = ?',
		[request.expectedItem.itemId],
	)
	const item = raw ? savedVideoFromRow(raw) : null
	if (
		!ledger ||
		ledger.outcome !== 'added' ||
		ledger.targetKind !== 'unclassified' ||
		ledger.targetId !== 'local' ||
		ledger.contentKind !== 'unknown' ||
		ledger.sourceId !== null ||
		ledger.resolvedSourceId !== null ||
		ledger.itemId !== request.expectedItem.itemId ||
		!item ||
		item.bucket !== 'unclassified' ||
		item.contentKind !== 'unknown' ||
		item.bvid !== request.expectedItem.bvid ||
		item.position !== request.expectedItem.position ||
		item.addedAt !== request.expectedItem.addedAt ||
		item.importOrigin.taskId !== taskId ||
		item.importOrigin.entryId !== entryId
	)
		targetConflict()
	const origin = item.importOrigin
	if (
		origin.provider !== task.provider ||
		origin.originalPlaylistId !== task.originalPlaylistId ||
		origin.taskVersion !== task.taskVersion ||
		origin.originalEntryId !== entry.originalEntryId ||
		origin.originalPosition !== entry.originalPosition ||
		json(origin.originalMetadata, limits.entryMetadataBytes) !==
			json(entry.originalMetadata, limits.entryMetadataBytes) ||
		originalVideoBvid(entry) !== item.bvid
	)
		targetConflict('原待分类条目的导入证据不一致')
	const classification = db.getFirstSync<ImportContentReview>(
		'SELECT entryId,kind,reviewedAt FROM import_content_reviews WHERE taskId = ? AND entryId = ?',
		[taskId, entryId],
	)
	if (
		!classification ||
		contentKind(classification.kind) === 'unknown' ||
		classification.reviewedAt === null
	)
		invalid('请先明确核对内容类型，再整理原待分类条目')
	const kind = classification.kind as Exclude<ContentKind, 'unknown'>,
		targetKind = kind === 'song' ? 'playlist' : 'listening',
		target = request.musicTarget
	if ((targetKind === 'playlist') !== (target !== null))
		invalid('歌曲须明确音乐目标；长内容整理不能指定歌单')
	const existing = target ? playlists.get(target.playlistId) : null
	if (
		target &&
		(target.kind === 'create'
			? existing !== null
			: !existing || existing.updatedAt !== target.expectedUpdatedAt)
	)
		targetConflict('目标歌单已变更，请重新读取后确认')
	const confirmed =
		entry.review.state === 'confirmed'
			? reads.confirmedSource(entry.review)
			: null
	if (
		confirmed !== null &&
		(item.bvid === null || !confirmed.startsWith(`bilibili:${item.bvid}:`))
	)
		invalid('整理确认音源必须属于原目录 BV，不能伪造缺失身份')
	const sourceId = targetKind === 'playlist' ? confirmed : null
	const now = Math.max(Date.now(), task.updatedAt + 1),
		revision = task.revision + 1
	integer(now)
	integer(revision, 1)
	const verification = {
		sourceConfirmed: sourceId !== null,
		catalogVerified:
			item.bvid !== null &&
			db.getFirstSync('SELECT bvid FROM video_catalog WHERE bvid = ?', [
				item.bvid,
			]) !== null,
		audioCapability: 'unchecked' as const,
	}
	let position: number,
		playlist = null as ImportOrganizationResult['playlist']
	if (targetKind === 'playlist') {
		if (
			db.getFirstSync('SELECT itemId FROM playlist_items WHERE itemId = ?', [
				item.itemId,
			])
		)
			targetConflict('原条目身份已被目标使用')
		if (target!.kind === 'create')
			db.runSync(
				'INSERT INTO playlists(id,name,createdAt,updatedAt) VALUES (?,?,?,?)',
				[target!.playlistId, target!.name, now, now],
			)
		position = existing?.items.length ?? 0
		const moved: PlaylistItem = {
			itemId: item.itemId,
			playlistId: target!.playlistId,
			sourceId,
			position,
			addedAt: item.addedAt,
			importOrigin: origin,
			review: entry.review,
		}
		const encoded = playlistImportJson(moved)!
		db.runSync(
			'INSERT INTO playlist_items(itemId,playlistId,sourceId,position,addedAt,importTaskId,originJson,reviewJson) VALUES (?,?,?,?,?,?,?,?)',
			[
				item.itemId,
				moved.playlistId,
				sourceId,
				position,
				item.addedAt,
				taskId,
				raw!.originJson,
				encoded.review,
			],
		)
		db.runSync('DELETE FROM saved_video_items WHERE itemId = ?', [item.itemId])
		if (target!.kind === 'append')
			db.runSync(
				'UPDATE playlists SET updatedAt = MAX(updatedAt + 1, ?) WHERE id = ?',
				[now, target!.playlistId],
			)
		playlist = playlists.get(target!.playlistId)!
	} else {
		position = db.getFirstSync<{ position: number }>(
			"SELECT COALESCE(MAX(position) + 1, 0) position FROM saved_video_items WHERE bucket = 'listening'",
			[],
		)!.position
		integer(position)
		db.runSync(
			"UPDATE saved_video_items SET bucket='listening',position=?,contentKind=?,reviewedAt=?,verificationJson=? WHERE itemId=?",
			[
				position,
				kind,
				classification.reviewedAt,
				json(verification, 1024),
				item.itemId,
			],
		)
	}
	const receipt: ImportOrganizationReceipt = {
		kind: 'organization',
		version: 1,
		operationId: request.operationId,
		taskId,
		entryId,
		request,
		taskRevision: revision,
		organizedAt: now,
		itemId: item.itemId,
		bvid: item.bvid,
		addedAt: item.addedAt,
		fromPosition: item.position,
		contentKind: kind,
		reviewedAt: classification.reviewedAt,
		targetKind,
		targetId: target?.playlistId ?? 'local',
		position,
		sourceId,
		verification,
		playlistUpdatedAt: playlist?.updatedAt ?? null,
	}
	db.runSync(
		'INSERT INTO import_item_organizations(operationId,taskId,entryId,itemId,requestJson,receiptJson,taskRevision,organizedAt,targetKind,targetId,contentKind,sourceId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
		[
			request.operationId,
			taskId,
			entryId,
			item.itemId,
			text,
			json(receipt, limits.reviewBytes, 6),
			revision,
			now,
			targetKind,
			receipt.targetId,
			kind,
			sourceId,
		],
	)
	db.runSync('UPDATE import_tasks SET revision=?,updatedAt=? WHERE taskId=?', [
		revision,
		now,
		taskId,
	])
	return {
		receipt,
		playlist,
		video: targetKind === 'listening' ? videos.get(item.itemId) : null,
	}
}
