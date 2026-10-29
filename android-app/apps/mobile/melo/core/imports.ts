import { Library, type Database } from './database'
import type {
	ContentKind,
	FavoritePlaylistDefault,
	ImportCommitHistory,
	ImportContentReview,
	MixedCommitReceipt,
	MixedCommitRequest,
	MixedCommitResult,
	MixedImportTaskDetail,
	MixedOccurrenceResult,
} from './import-mixed-types'
import {
	contentKind,
	mixedTarget,
	originalVideoBvid,
} from './import-mixed-validation'
import {
	organizationPendingBinding,
	organizationRequest,
	organizeUnclassified,
	readOrganizations,
} from './import-organization'
import type {
	ImportOrganizationRequest,
	ImportOrganizationResult,
} from './import-organization-types'
import type {
	ImportCommitReceipt,
	ImportCommitRequest,
	ImportCommitResult,
	ImportOccurrenceResult,
	ImportResolveRequest,
} from './import-playlist-types'
import {
	ImportConflictError,
	importTaskLimits as limits,
	type ImportCandidate,
	type ImportDirectorySnapshot,
	type ImportReview,
	type ImportReviewDecision,
	type ImportRetryRecord,
	type ImportTask,
	type ImportTaskDetail,
} from './import-types'
import {
	id,
	integer,
	object,
	keys,
	json,
	directory,
	reviewValue,
	retryValue,
	invalid,
} from './import-validation'
import { sourceId as stableSourceId } from './model'
import { playlistImportJson } from './playlist-import'
import {
	PlaylistStore,
	type PlaylistDetail,
	type PlaylistItem,
} from './playlists'
import { savedVideoJson } from './video-saves'

type TaskRow = Omit<ImportTask, 'entryCount'> & { snapshotJson: string }
interface EntryRow {
	entryId: string
	originalPosition: number
	selected: number
	state: ImportReview['state']
	candidatesJson: string
	confirmationCandidateId: string | null
	confirmedSourceId: string | null
	reviewedAt: number | null
}
interface CommitRow {
	commitId: string
	taskId: string
	requestJson: string
	playlistId: string | null
	taskRevision: number
	playlistUpdatedAt: number | null
	committedAt: number
	kind?: 'playlist' | 'mixed'
	receiptJson?: string | null
}
interface LedgerRow extends ImportOccurrenceResult {
	playlistId: string
	resolvedSourceId: string | null
	targetKind?: 'playlist' | 'listening' | 'unclassified'
	targetId?: string
	contentKind?: ContentKind | null
}

/** Local directory tasks and atomic local playlist publishing; no platform requests or Source writes. */
export class ImportStore {
	private readonly library: Library
	constructor(private readonly db: Database) {
		this.library = new Library(db)
	}
	private atomic<T>(action: () => T, write = true): T {
		this.db.execSync(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
		try {
			const result = action()
			this.db.execSync('COMMIT')
			return result
		} catch (error) {
			try {
				this.db.execSync('ROLLBACK')
			} catch {
				/* Preserve the original error after SQLite automatic rollback. */
			}
			throw error
		}
	}
	createDirectory(input: ImportDirectorySnapshot): ImportTaskDetail {
		const { snapshot, text } = directory(input)
		return this.atomic(() => {
			const existing = this.db.getFirstSync<TaskRow>(
				'SELECT * FROM import_tasks WHERE taskId = ? OR (provider = ? AND originalPlaylistId = ? AND taskVersion = ?)',
				[
					snapshot.taskId,
					snapshot.provider,
					snapshot.originalPlaylistId,
					snapshot.taskVersion,
				],
			)
			if (existing) {
				if (existing.snapshotJson !== text)
					throw new ImportConflictError(
						'IMPORT_DIRECTORY_CONFLICT',
						'同一导入目录任务已存在不同快照，请使用新的任务版本',
					)
				return this.readDetail(existing.taskId)!
			}
			const now = Date.now()
			this.db.runSync(
				'INSERT INTO import_tasks VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
				[
					snapshot.taskId,
					snapshot.provider,
					snapshot.originalPlaylistId,
					snapshot.taskVersion,
					text,
					now,
					now,
				],
			)
			for (const entry of snapshot.entries)
				this.db.runSync(
					"INSERT INTO import_entries VALUES (?, ?, ?, 0, 'pending', '[]', NULL, NULL, NULL)",
					[snapshot.taskId, entry.entryId, entry.originalPosition],
				)
			return this.readDetail(snapshot.taskId)!
		})
	}
	get(taskId: string): ImportTaskDetail | null {
		id(taskId)
		return this.atomic(() => this.readDetail(taskId), false)
	}
	list(): ImportTask[] {
		return this.db
			.getAllSync<ImportTask>(
				'SELECT taskId, provider, originalPlaylistId, taskVersion, revision, createdAt, updatedAt, (SELECT COUNT(*) FROM import_entries e WHERE e.taskId = import_tasks.taskId) AS entryCount FROM import_tasks ORDER BY updatedAt DESC, taskId',
				[],
			)
			.map((task) => ({ ...task }))
	}
	private readDetail(taskId: string): ImportTaskDetail | null {
		const row = this.db.getFirstSync<TaskRow>(
			'SELECT * FROM import_tasks WHERE taskId = ?',
			[taskId],
		)
		if (!row) return null
		const { snapshot } = directory(
			JSON.parse(row.snapshotJson) as ImportDirectorySnapshot,
		)
		if (
			snapshot.taskId !== row.taskId ||
			snapshot.provider !== row.provider ||
			snapshot.originalPlaylistId !== row.originalPlaylistId ||
			snapshot.taskVersion !== row.taskVersion
		)
			invalid('导入目录记录不一致')
		const entries = this.db.getAllSync<EntryRow>(
			'SELECT * FROM import_entries WHERE taskId = ? ORDER BY originalPosition',
			[taskId],
		)
		if (entries.length !== snapshot.entries.length)
			invalid('导入目录出现项不完整')
		const retries = this.db.getAllSync<ImportRetryRecord & { entryId: string }>(
			'SELECT * FROM import_retry_records WHERE taskId = ? ORDER BY sequence',
			[taskId],
		)
		const retriesByEntry = new Map<string, ImportRetryRecord[]>()
		for (const retry of retries) {
			const saved = retriesByEntry.get(retry.entryId) ?? []
			saved.push({
				sequence: retry.sequence,
				taskRevision: retry.taskRevision,
				createdAt: retry.createdAt,
				errorCode: retry.errorCode,
				message: retry.message,
			})
			retriesByEntry.set(retry.entryId, saved)
		}
		return {
			taskId,
			provider: row.provider,
			originalPlaylistId: row.originalPlaylistId,
			taskVersion: row.taskVersion,
			revision: row.revision,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			entryCount: entries.length,
			commits: this.readReceipts(taskId),
			originalMetadata: snapshot.originalMetadata,
			entries: entries.map((entry, index) => {
				const original = snapshot.entries[index]
				if (
					entry.entryId !== original.entryId ||
					entry.originalPosition !== original.originalPosition ||
					(entry.selected !== 0 && entry.selected !== 1)
				)
					invalid('导入目录出现项不一致')
				return {
					...original,
					selected: entry.selected === 1,
					review: reviewValue({
						state: entry.state,
						candidates: JSON.parse(entry.candidatesJson) as ImportCandidate[],
						confirmation:
							entry.confirmationCandidateId === null
								? null
								: {
										candidateId: entry.confirmationCandidateId,
										sourceId: entry.confirmedSourceId!,
									},
					}),
					reviewedAt: entry.reviewedAt,
					retries: retriesByEntry.get(entry.entryId) ?? [],
				}
			}),
		}
	}
	private confirmedSource(review: ImportReview): string {
		const confirmation = review.confirmation
		if (review.state !== 'confirmed' || !confirmation)
			invalid('请先明确确认真实音源')
		const candidate = review.candidates.find(
			(item) => item.candidateId === confirmation.candidateId,
		)
		if (!candidate || candidate.cid === null)
			invalid('确认候选缺少明确 BV 与 CID')
		const source = this.library.get(confirmation.sourceId)
		if (
			!source ||
			source.bvid !== candidate.bvid ||
			source.cid !== candidate.cid ||
			source.id !== stableSourceId(candidate.bvid, candidate.cid) ||
			source.id !== confirmation.sourceId
		)
			invalid('确认关系必须核对本机真实音源的 BV、CID 与身份')
		return source.id
	}
	private commitRequest(value: ImportCommitRequest): {
		request: ImportCommitRequest
		text: string
	} {
		object(value)
		keys(value, [
			'commitId',
			'expectedRevision',
			'target',
			'duplicatePolicy',
			'itemIds',
		])
		id(value.commitId)
		integer(value.expectedRevision)
		object(value.target)
		id(value.target.playlistId)
		let target: ImportCommitRequest['target']
		if (value.target.kind === 'create') {
			keys(value.target, ['kind', 'playlistId', 'name'])
			if (
				typeof value.target.name !== 'string' ||
				!value.target.name.trim() ||
				value.target.name.length > limits.idLength
			)
				invalid('本地副本名称无效')
			target = { ...value.target, name: value.target.name.trim() }
		} else if (value.target.kind === 'append') {
			keys(value.target, ['kind', 'playlistId', 'expectedUpdatedAt'])
			integer(value.target.expectedUpdatedAt)
			target = { ...value.target }
		} else invalid('导入目标无效')
		if (
			value.duplicatePolicy !== 'keep-all' &&
			value.duplicatePolicy !== 'skip-existing-source'
		)
			invalid('请明确选择重复音源的处理方式')
		if (
			!Array.isArray(value.itemIds) ||
			!value.itemIds.length ||
			value.itemIds.length > limits.entries
		)
			invalid('请选择尚未处理的导入条目')
		const entries = new Set<string>(),
			items = new Set<string>()
		const itemIds = value.itemIds
			.map((mapping) => {
				object(mapping)
				keys(mapping, ['entryId', 'itemId'])
				id(mapping.entryId)
				id(mapping.itemId)
				if (entries.has(mapping.entryId) || items.has(mapping.itemId))
					invalid('导入条目或目标条目身份重复')
				entries.add(mapping.entryId)
				items.add(mapping.itemId)
				return { ...mapping }
			})
			.sort((left, right) =>
				left.entryId < right.entryId
					? -1
					: left.entryId > right.entryId
						? 1
						: 0,
			)
		const request = {
			commitId: value.commitId,
			expectedRevision: value.expectedRevision,
			target,
			duplicatePolicy: value.duplicatePolicy,
			itemIds,
		}
		return { request, text: json(request, limits.directoryBytes, 5) }
	}
	private readReceipt(row: CommitRow): ImportCommitReceipt {
		if (
			row.kind === 'mixed' ||
			row.playlistId === null ||
			row.playlistUpdatedAt === null
		)
			invalid('混合导入记录不能作为旧歌单提交读取')
		return {
			commitId: row.commitId,
			taskId: row.taskId,
			request: JSON.parse(row.requestJson) as ImportCommitRequest,
			playlistId: row.playlistId,
			taskRevision: row.taskRevision,
			playlistUpdatedAt: row.playlistUpdatedAt,
			committedAt: row.committedAt,
			results: this.db
				.getAllSync<ImportOccurrenceResult>(
					'SELECT r.entryId, r.requestedItemId, r.itemId, r.sourceId, r.outcome FROM import_commit_entries r JOIN import_entries e ON e.taskId = r.taskId AND e.entryId = r.entryId WHERE r.commitId = ? ORDER BY e.originalPosition',
					[row.commitId],
				)
				.map((result) => ({ ...result })),
		}
	}
	private readReceipts(taskId: string): ImportCommitReceipt[] {
		// v7 directory snapshots predate commit records; historical migrations can
		// still be opened without pretending they contained any published items.
		if (
			(this.db.getFirstSync<{ user_version: number }>('PRAGMA user_version', [])
				?.user_version ?? 0) < 8
		)
			return []
		return this.db
			.getAllSync<CommitRow>(
				`SELECT * FROM import_commits WHERE taskId = ? ${this.mixedSchema() ? "AND kind = 'playlist'" : ''} ORDER BY taskRevision`,
				[taskId],
			)
			.map((row) => this.readReceipt(row))
	}
	private nextRevision(task: ImportTaskDetail): {
		revision: number
		now: number
	} {
		const revision = task.revision + 1
		integer(revision, 1)
		const now = Math.max(Date.now(), task.updatedAt + 1)
		integer(now)
		return { revision, now }
	}
	private taskAtRevision(
		taskId: string,
		expectedRevision: number,
	): ImportTaskDetail {
		const task = this.readDetail(taskId)
		if (!task) invalid('导入任务不存在')
		if (task.revision !== expectedRevision)
			throw new ImportConflictError(
				'IMPORT_REVISION_CONFLICT',
				'导入任务已变更，请重新读取后提交',
			)
		return task
	}
	private mixedSchema(): boolean {
		return (
			(this.db.getFirstSync<{ user_version: number }>('PRAGMA user_version', [])
				?.user_version ?? 0) >= 10
		)
	}
	private requireBilibili(task: ImportTaskDetail | null): ImportTaskDetail {
		if (!task || task.provider !== 'bilibili')
			invalid('混合内容审核仅适用于 B站收藏任务')
		return task
	}
	private readContentReviews(task: ImportTaskDetail): ImportContentReview[] {
		const rows = this.db.getAllSync<ImportContentReview>(
			'SELECT entryId, kind, reviewedAt FROM import_content_reviews WHERE taskId = ?',
			[task.taskId],
		)
		const byEntry = new Map(rows.map((row) => [row.entryId, row]))
		return task.entries.map((entry) => {
			const review = byEntry.get(entry.entryId)
			if (!review)
				return { entryId: entry.entryId, kind: 'unknown', reviewedAt: null }
			contentKind(review.kind)
			integer(review.reviewedAt!)
			return { ...review }
		})
	}
	private readMixedReceipt(row: CommitRow): MixedCommitReceipt {
		if (row.kind !== 'mixed' || !row.receiptJson) invalid('缺少混合导入结果')
		const receipt = JSON.parse(row.receiptJson) as MixedCommitReceipt
		if (
			receipt.kind !== 'mixed' ||
			receipt.version !== 1 ||
			receipt.commitId !== row.commitId ||
			receipt.taskId !== row.taskId ||
			receipt.taskRevision !== row.taskRevision ||
			receipt.playlistId !== row.playlistId ||
			receipt.playlistUpdatedAt !== row.playlistUpdatedAt ||
			receipt.committedAt !== row.committedAt ||
			json(receipt.request, limits.directoryBytes, 5) !== row.requestJson
		)
			invalid('混合导入结果身份不一致')
		return receipt
	}
	private readHistory(taskId: string): ImportCommitHistory[] {
		return this.db
			.getAllSync<CommitRow>(
				'SELECT * FROM import_commits WHERE taskId = ? ORDER BY taskRevision',
				[taskId],
			)
			.map((row) =>
				row.kind === 'mixed'
					? { kind: 'mixed', receipt: this.readMixedReceipt(row) }
					: { kind: 'playlist', receipt: this.readReceipt(row) },
			)
	}
	private mixedDetail(task: ImportTaskDetail): MixedImportTaskDetail {
		this.requireBilibili(task)
		return {
			...task,
			contentReviews: this.readContentReviews(task),
			history: this.readHistory(task.taskId),
			organizations: readOrganizations(this.db, task.taskId),
		}
	}
	getMixed(taskId: string): MixedImportTaskDetail | null {
		id(taskId)
		return this.atomic(() => {
			const task = this.readDetail(taskId)
			return task ? this.mixedDetail(task) : null
		}, false)
	}
	organizeUnclassified(
		taskId: string,
		entryId: string,
		input: ImportOrganizationRequest,
	): ImportOrganizationResult {
		id(taskId)
		id(entryId)
		const command = organizationRequest(input)
		return this.atomic(() =>
			organizeUnclassified(this.db, taskId, entryId, command, {
				task: (expectedRevision) =>
					this.taskAtRevision(taskId, expectedRevision),
				confirmedSource: (review) => this.confirmedSource(review),
			}),
		)
	}
	reviewContent(
		taskId: string,
		entryId: string,
		decision: { kind: ContentKind },
		expectedRevision: number,
	): MixedImportTaskDetail {
		id(taskId)
		id(entryId)
		integer(expectedRevision)
		object(decision)
		keys(decision, ['kind'])
		const kind = contentKind(decision.kind)
		return this.atomic(() => {
			const task = this.requireBilibili(
				this.taskAtRevision(taskId, expectedRevision),
			)
			if (!task.entries.some((entry) => entry.entryId === entryId))
				invalid('内容审核条目不属于本任务')
			const { revision, now } = this.nextRevision(task)
			this.db.runSync(
				'INSERT INTO import_content_reviews(taskId,entryId,kind,reviewedAt) VALUES (?,?,?,?) ON CONFLICT(taskId,entryId) DO UPDATE SET kind=excluded.kind, reviewedAt=excluded.reviewedAt',
				[taskId, entryId, kind, now],
			)
			this.db.runSync(
				'UPDATE import_tasks SET revision = ?, updatedAt = ? WHERE taskId = ?',
				[revision, now, taskId],
			)
			return this.mixedDetail(this.readDetail(taskId)!)
		})
	}
	/** One explicit folder-to-playlist action; defaults are not manual edition verification. */
	defaultFavoritePlaylist(
		taskId: string,
		choices: readonly FavoritePlaylistDefault[],
		expectedRevision: number,
	): MixedImportTaskDetail {
		id(taskId)
		integer(expectedRevision)
		if (!Array.isArray(choices) || !choices.length || choices.length > limits.entries)
			invalid('收藏夹条目数量无效')
		json(choices, limits.taskReviewBytes)
		return this.atomic(() => {
			const task = this.requireBilibili(this.taskAtRevision(taskId, expectedRevision))
			const entries = new Map(task.entries.map((entry) => [entry.entryId, entry]))
			const processed = new Set(this.db.getAllSync<{ entryId: string }>(
				'SELECT entryId FROM import_commit_entries WHERE taskId = ?', [taskId],
			).map((row) => row.entryId))
			const seen = new Set<string>()
			const { revision, now } = this.nextRevision(task)
			for (const choice of choices) {
				id(choice.entryId)
				const entry = entries.get(choice.entryId)
				if (!entry || seen.has(choice.entryId) || processed.has(choice.entryId))
					invalid('默认导入包含重复、已处理或不属于本任务的条目')
				seen.add(choice.entryId)
				if (choice.skip) {
					this.db.runSync('UPDATE import_entries SET selected = 0 WHERE taskId = ? AND entryId = ?', [taskId, choice.entryId])
					continue
				}
				let review: ImportReview
				if (choice.sourceId !== null) {
					const source = this.library.get(choice.sourceId)
					if (!source) invalid('默认分 P 音源不存在')
					this.requireOriginalSource(entry, source.id)
					if (entry.review.confirmation) {
						if (entry.review.confirmation.sourceId !== source.id)
							invalid('默认导入不能覆盖此前明确选择的分 P')
						review = entry.review
					} else {
						const first = this.db.getFirstSync<{ sourceId: string }>(
							'SELECT sourceId FROM video_catalog_parts WHERE bvid = ? AND page = 1', [source.bvid],
						)
						if (first?.sourceId !== source.id) invalid('默认分 P 必须是原视频的第一 P')
						review = reviewValue({
							state: 'confirmed',
							candidates: [{ candidateId: source.id, bvid: source.bvid, cid: source.cid,
								metadata: { originalTitle: source.originalTitle },
								evidence: { method: 'favorite-default-first-part' } }],
							confirmation: { candidateId: source.id, sourceId: source.id },
						})
					}
					this.confirmedSource(review)
				} else {
					if (entry.review.confirmation) invalid('暂不可用的默认结果不能覆盖已有分 P')
					review = { state: 'unreadable', candidates: [], confirmation: null }
					const retry = retryValue({ errorCode: 'favorite-default-unavailable', message: choice.unavailable || '原视频暂不可用' })
					if (entry.retries.length < limits.retriesPerEntry)
						this.db.runSync('INSERT INTO import_retry_records VALUES (?, ?, ?, ?, ?, ?, ?)',
							[taskId, entry.entryId, entry.retries.length + 1, revision, now, retry.errorCode, retry.message])
				}
				this.db.runSync(
					'UPDATE import_entries SET selected = 1, state = ?, candidatesJson = ?, confirmationCandidateId = ?, confirmedSourceId = ?, reviewedAt = ? WHERE taskId = ? AND entryId = ?',
					[review.state, json(review.candidates, limits.reviewBytes), review.confirmation?.candidateId ?? null,
						review.confirmation?.sourceId ?? null, now, taskId, entry.entryId],
				)
				this.db.runSync('INSERT INTO import_content_reviews(taskId,entryId,kind,reviewedAt) VALUES (?,?,?,?) ON CONFLICT(taskId,entryId) DO UPDATE SET kind=excluded.kind, reviewedAt=excluded.reviewedAt',
					[taskId, entry.entryId, 'song', now])
			}
			const size = this.db.getFirstSync<{ bytes: number }>(
				'SELECT COALESCE((SELECT SUM(length(CAST(candidatesJson AS BLOB))) FROM import_entries WHERE taskId = ?), 0) + COALESCE((SELECT SUM(length(CAST(message AS BLOB)) + COALESCE(length(CAST(errorCode AS BLOB)), 0) + 64) FROM import_retry_records WHERE taskId = ?), 0) AS bytes', [taskId, taskId],
			)!.bytes
			if (size > limits.taskReviewBytes) invalid('收藏夹默认导入记录超过本机预算')
			this.db.runSync('UPDATE import_tasks SET revision = ?, updatedAt = ? WHERE taskId = ?', [revision, now, taskId])
			return this.mixedDetail(this.readDetail(taskId)!)
		})
	}
	private requireOriginalSource(
		entry: ImportTaskDetail['entries'][number],
		sourceId: string,
	): void {
		const original = originalVideoBvid(entry),
			source = this.library.get(sourceId)
		if (original === null || !source || source.bvid !== original)
			invalid('B站收藏确认音源必须属于原目录 BV，不能替换为其他视频')
	}
	private requiresOriginalSource(taskId: string, entryId: string): boolean {
		if (!this.mixedSchema()) return false
		const ledger = this.db.getFirstSync<{
			targetKind: string
			contentKind: ContentKind | null
		}>(
			'SELECT targetKind,contentKind FROM import_commit_entries WHERE taskId = ? AND entryId = ?',
			[taskId, entryId],
		)
		// Legacy published pending items predate an original-BV contract. Preserve
		// their confirmation/resolve path without exempting new or mixed items.
		return !(ledger?.targetKind === 'playlist' && ledger.contentKind === null)
	}
	private mixedRequest(value: MixedCommitRequest): {
		request: MixedCommitRequest
		text: string
	} {
		object(value)
		keys(value, [
			'commitId',
			'expectedRevision',
			'musicTarget',
			'songDuplicatePolicy',
			'videoDuplicatePolicy',
			'itemIds',
		])
		if (value.musicTarget === undefined) invalid('请明确提供音乐目标或空目标')
		// Reuse the existing command's target, ID and explicit song-policy validation.
		const checked = this.commitRequest({
			commitId: value.commitId,
			expectedRevision: value.expectedRevision,
			target: value.musicTarget ?? {
				kind: 'create',
				playlistId: 'validation-only',
				name: 'validation-only',
			},
			duplicatePolicy: value.songDuplicatePolicy,
			itemIds: value.itemIds,
		}).request
		if (
			value.videoDuplicatePolicy !== 'keep-all' &&
			value.videoDuplicatePolicy !== 'skip-existing-video'
		)
			invalid('请明确选择重复视频的处理方式')
		const request: MixedCommitRequest = {
			commitId: checked.commitId,
			expectedRevision: checked.expectedRevision,
			musicTarget: value.musicTarget === null ? null : checked.target,
			songDuplicatePolicy: checked.duplicatePolicy,
			videoDuplicatePolicy: value.videoDuplicatePolicy,
			itemIds: checked.itemIds,
		}
		return { request, text: json(request, limits.directoryBytes, 5) }
	}
	commitMixed(taskId: string, input: MixedCommitRequest): MixedCommitResult {
		id(taskId)
		const { request, text } = this.mixedRequest(input)
		return this.atomic(() => {
			const task = this.requireBilibili(this.readDetail(taskId))
			const playlists = new PlaylistStore(this.db)
			const prior = this.db.getFirstSync<CommitRow>(
				'SELECT * FROM import_commits WHERE commitId = ?',
				[request.commitId],
			)
			if (prior) {
				if (
					prior.kind !== 'mixed' ||
					prior.taskId !== taskId ||
					prior.requestJson !== text
				)
					throw new ImportConflictError(
						'IMPORT_COMMIT_CONFLICT',
						'本次提交身份已用于不同的导入操作',
					)
				return {
					receipt: this.readMixedReceipt(prior),
					playlist:
						prior.playlistId === null ? null : playlists.get(prior.playlistId),
				}
			}
			if (task.revision !== request.expectedRevision)
				throw new ImportConflictError(
					'IMPORT_REVISION_CONFLICT',
					'导入任务已变更，请重新读取后提交',
				)
			const processed = new Set(
				this.db
					.getAllSync<{ entryId: string }>(
						'SELECT entryId FROM import_commit_entries WHERE taskId = ?',
						[taskId],
					)
					.map((row) => row.entryId),
			)
			const chosen = task.entries.filter(
				(entry) => entry.selected && !processed.has(entry.entryId),
			)
			const mapping = new Map(
				request.itemIds.map((item) => [item.entryId, item.itemId]),
			)
			if (
				!chosen.length ||
				chosen.length !== mapping.size ||
				chosen.some((entry) => !mapping.has(entry.entryId))
			)
				throw new ImportConflictError(
					'IMPORT_COMMIT_CONFLICT',
					'提交必须准确包含当前选中且尚未处理的出现项',
				)
			const reviews = new Map(
				this.readContentReviews(task).map((review) => [review.entryId, review]),
			)
			const songs = chosen.filter(
				(entry) => reviews.get(entry.entryId)!.kind === 'song',
			)
			const target = request.musicTarget
			if (songs.length > 0 !== (target !== null))
				invalid('存在歌曲时须明确音乐目标；零歌曲时不能创建或指定歌单')
			const existing = target ? playlists.get(target.playlistId) : null
			if (
				target &&
				(target.kind === 'create'
					? !!existing
					: !existing || existing.updatedAt !== target.expectedUpdatedAt)
			)
				throw new ImportConflictError(
					'IMPORT_TARGET_CONFLICT',
					'目标歌单已变更，请重新读取后确认',
				)
			const { revision, now } = this.nextRevision(task)
			if (target?.kind === 'create')
				this.db.runSync(
					'INSERT INTO playlists(id,name,createdAt,updatedAt) VALUES (?,?,?,?)',
					[target.playlistId, target.name, now, now],
				)
			const sourceSeen = new Set(
				(existing?.items ?? [])
					.map((item) => item.sourceId)
					.filter((value): value is string => value !== null),
			)
			const videoSeen = new Set(
				this.db
					.getAllSync<{ bucket: string; bvid: string }>(
						'SELECT bucket,bvid FROM saved_video_items WHERE bvid IS NOT NULL',
						[],
					)
					.map((row) => `${row.bucket}:${row.bvid}`),
			)
			const nextPosition = { listening: 0, unclassified: 0 }
			for (const bucket of ['listening', 'unclassified'] as const)
				nextPosition[bucket] = this.db.getFirstSync<{ position: number }>(
					'SELECT COALESCE(MAX(position) + 1, 0) position FROM saved_video_items WHERE bucket = ?',
					[bucket],
				)!.position
			const results: MixedOccurrenceResult[] = []
			const counts: MixedCommitReceipt['counts'] = {
				playlist: { added: 0, skipped: 0, withoutConfirmedCid: 0 },
				listening: { added: 0, skipped: 0 },
				unclassified: { added: 0, skipped: 0 },
				unselected: task.entries.filter(
					(entry) => !entry.selected && !processed.has(entry.entryId),
				).length,
				unprocessed: task.entries.length - processed.size - chosen.length,
			}
			for (const entry of chosen) {
				const classification = reviews.get(entry.entryId)!,
					kind = classification.kind,
					targetKind = mixedTarget(kind),
					itemId = mapping.get(entry.entryId)!,
					bvid = originalVideoBvid(entry)
				const confirmed =
					entry.review.state === 'confirmed'
						? this.confirmedSource(entry.review)
						: null
				if (confirmed !== null) this.requireOriginalSource(entry, confirmed)
				const sourceId = targetKind === 'playlist' ? confirmed : null
				const skipKey =
					targetKind === 'playlist'
						? sourceId !== null &&
							request.songDuplicatePolicy === 'skip-existing-source' &&
							sourceSeen.has(sourceId)
							? sourceId
							: null
						: bvid !== null &&
							  request.videoDuplicatePolicy === 'skip-existing-video' &&
							  videoSeen.has(`${targetKind}:${bvid}`)
							? bvid
							: null
				const verification = {
					sourceConfirmed: sourceId !== null,
					catalogVerified:
						bvid !== null &&
						this.db.getFirstSync(
							'SELECT bvid FROM video_catalog WHERE bvid = ?',
							[bvid],
						) !== null,
					audioCapability: 'unchecked' as const,
				}
				const result: MixedOccurrenceResult = {
					entryId: entry.entryId,
					originalEntryId: entry.originalEntryId,
					originalPosition: entry.originalPosition,
					requestedItemId: itemId,
					itemId: skipKey === null ? itemId : null,
					outcome: skipKey === null ? 'added' : 'skipped',
					targetKind,
					targetId: targetKind === 'playlist' ? target!.playlistId : 'local',
					contentKind: kind,
					reviewedAt: classification.reviewedAt,
					bvid,
					sourceId,
					skipKey,
					verification,
				}
				results.push(result)
				if (skipKey !== null) {
					counts[targetKind].skipped++
					continue
				}
				if (
					this.db.getFirstSync(
						'SELECT itemId FROM import_commit_entries WHERE itemId = ?',
						[itemId],
					) ||
					this.db.getFirstSync(
						'SELECT itemId FROM playlist_items WHERE itemId = ?',
						[itemId],
					) ||
					this.db.getFirstSync(
						'SELECT itemId FROM saved_video_items WHERE itemId = ?',
						[itemId],
					)
				)
					throw new ImportConflictError(
						'IMPORT_COMMIT_CONFLICT',
						'条目身份已使用，不能重新创建',
					)
				const origin = {
					taskId,
					provider: task.provider,
					originalPlaylistId: task.originalPlaylistId,
					taskVersion: task.taskVersion,
					entryId: entry.entryId,
					originalEntryId: entry.originalEntryId,
					originalPosition: entry.originalPosition,
					originalMetadata: entry.originalMetadata,
					reviewAtCommit: entry.review,
				}
				if (targetKind === 'playlist') {
					const item: PlaylistItem = {
						itemId,
						playlistId: target!.playlistId,
						sourceId,
						position: (existing?.items.length ?? 0) + counts.playlist.added,
						addedAt: now,
						importOrigin: origin,
						review: entry.review,
					}
					const encoded = playlistImportJson(item)!
					this.db.runSync(
						'INSERT INTO playlist_items(itemId,playlistId,sourceId,position,addedAt,importTaskId,originJson,reviewJson) VALUES (?,?,?,?,?,?,?,?)',
						[
							itemId,
							item.playlistId,
							sourceId,
							item.position,
							now,
							taskId,
							encoded.origin,
							encoded.review,
						],
					)
					if (sourceId !== null) sourceSeen.add(sourceId)
					else counts.playlist.withoutConfirmedCid++
				} else {
					const position = nextPosition[targetKind]++
					integer(position)
					const encoded = savedVideoJson({
						itemId,
						bucket: targetKind,
						position,
						addedAt: now,
						bvid,
						contentKind: kind,
						reviewedAt: classification.reviewedAt,
						verification,
						importOrigin: origin,
					})
					this.db.runSync(
						'INSERT INTO saved_video_items(itemId,bucket,position,addedAt,bvid,contentKind,reviewedAt,verificationJson,originJson,importTaskId) VALUES (?,?,?,?,?,?,?,?,?,?)',
						[
							itemId,
							targetKind,
							position,
							now,
							bvid,
							kind,
							classification.reviewedAt,
							encoded.verification,
							encoded.origin,
							taskId,
						],
					)
					if (bvid !== null) videoSeen.add(`${targetKind}:${bvid}`)
				}
				counts[targetKind].added++
			}
			if (target?.kind === 'append' && counts.playlist.added)
				this.db.runSync(
					'UPDATE playlists SET updatedAt = MAX(updatedAt + 1, ?) WHERE id = ?',
					[now, target.playlistId],
				)
			const playlist = target ? playlists.get(target.playlistId)! : null
			const receipt: MixedCommitReceipt = {
				kind: 'mixed',
				version: 1,
				commitId: request.commitId,
				taskId,
				request,
				taskRevision: revision,
				playlistId: playlist?.id ?? null,
				playlistUpdatedAt: playlist?.updatedAt ?? null,
				committedAt: now,
				results,
				counts,
			}
			this.db.runSync(
				"INSERT INTO import_commits(commitId,taskId,requestJson,playlistId,taskRevision,playlistUpdatedAt,committedAt,kind,receiptJson) VALUES (?,?,?,?,?,?,?,'mixed',?)",
				[
					request.commitId,
					taskId,
					text,
					receipt.playlistId,
					revision,
					receipt.playlistUpdatedAt,
					now,
					json(receipt, limits.directoryBytes, 8),
				],
			)
			for (const result of results)
				this.db.runSync(
					'INSERT INTO import_commit_entries(taskId,entryId,commitId,requestedItemId,itemId,sourceId,outcome,targetKind,targetId,bvid,contentKind,skipKey) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
					[
						taskId,
						result.entryId,
						request.commitId,
						result.requestedItemId,
						result.itemId,
						result.sourceId,
						result.outcome,
						result.targetKind,
						result.targetId,
						result.bvid,
						result.contentKind,
						result.skipKey,
					],
				)
			this.db.runSync(
				'UPDATE import_tasks SET revision = ?, updatedAt = ? WHERE taskId = ?',
				[revision, now, taskId],
			)
			return { receipt, playlist }
		})
	}
	commitSelected(
		taskId: string,
		input: ImportCommitRequest,
	): ImportCommitResult {
		id(taskId)
		const { request, text } = this.commitRequest(input)
		return this.atomic(() => {
			const playlists = new PlaylistStore(this.db)
			const prior = this.db.getFirstSync<CommitRow>(
				'SELECT * FROM import_commits WHERE commitId = ?',
				[request.commitId],
			)
			if (prior) {
				if (
					prior.kind === 'mixed' ||
					prior.taskId !== taskId ||
					prior.requestJson !== text
				)
					throw new ImportConflictError(
						'IMPORT_COMMIT_CONFLICT',
						'本次提交身份已用于不同的导入操作',
					)
				return {
					receipt: this.readReceipt(prior),
					playlist: playlists.get(prior.playlistId!),
				}
			}
			const task = this.taskAtRevision(taskId, request.expectedRevision)
			if (this.mixedSchema() && task.provider === 'bilibili')
				invalid('B站新提交须使用 commitMixed，按内容类型保存到对应目标')
			const processed = new Set(
				this.db
					.getAllSync<{ entryId: string }>(
						'SELECT entryId FROM import_commit_entries WHERE taskId = ?',
						[taskId],
					)
					.map((row) => row.entryId),
			)
			const chosen = task.entries.filter(
				(entry) => entry.selected && !processed.has(entry.entryId),
			)
			const mapping = new Map(
				request.itemIds.map((item) => [item.entryId, item.itemId]),
			)
			if (
				!chosen.length ||
				chosen.length !== mapping.size ||
				chosen.some((entry) => !mapping.has(entry.entryId))
			)
				throw new ImportConflictError(
					'IMPORT_COMMIT_CONFLICT',
					'提交必须准确包含当前选中且尚未处理的出现项',
				)
			const target = request.target
			const existing = playlists.get(target.playlistId)
			if (
				target.kind === 'create'
					? !!existing
					: !existing || existing.updatedAt !== target.expectedUpdatedAt
			)
				throw new ImportConflictError(
					'IMPORT_TARGET_CONFLICT',
					'目标歌单已变更，请重新读取后确认',
				)
			const { revision, now } = this.nextRevision(task)
			if (target.kind === 'create')
				this.db.runSync(
					'INSERT INTO playlists (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)',
					[target.playlistId, target.name, now, now],
				)
			const seen = new Set(
				(existing?.items ?? [])
					.map((item) => item.sourceId)
					.filter((value): value is string => value !== null),
			)
			const results: ImportOccurrenceResult[] = []
			let added = 0
			for (const entry of chosen) {
				const requestedItemId = mapping.get(entry.entryId)!
				const sourceId =
					entry.review.state === 'confirmed'
						? this.confirmedSource(entry.review)
						: null
				if (
					sourceId !== null &&
					request.duplicatePolicy === 'skip-existing-source' &&
					seen.has(sourceId)
				) {
					results.push({
						entryId: entry.entryId,
						requestedItemId,
						itemId: null,
						sourceId,
						outcome: 'skipped',
					})
					continue
				}
				if (
					this.db.getFirstSync(
						'SELECT itemId FROM import_commit_entries WHERE itemId = ?',
						[requestedItemId],
					)
				)
					throw new ImportConflictError(
						'IMPORT_COMMIT_CONFLICT',
						'条目身份已用于导入，不能重新创建',
					)
				const item: PlaylistItem = {
					itemId: requestedItemId,
					playlistId: target.playlistId,
					sourceId,
					position: (existing?.items.length ?? 0) + added,
					addedAt: now,
					importOrigin: {
						taskId,
						provider: task.provider,
						originalPlaylistId: task.originalPlaylistId,
						taskVersion: task.taskVersion,
						entryId: entry.entryId,
						originalEntryId: entry.originalEntryId,
						originalPosition: entry.originalPosition,
						originalMetadata: entry.originalMetadata,
						reviewAtCommit: entry.review,
					},
					review: entry.review,
				}
				const encoded = playlistImportJson(item)!
				this.db.runSync(
					'INSERT INTO playlist_items (itemId, playlistId, sourceId, position, addedAt, importTaskId, originJson, reviewJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
					[
						item.itemId,
						item.playlistId,
						item.sourceId,
						item.position,
						item.addedAt,
						encoded.taskId,
						encoded.origin,
						encoded.review,
					],
				)
				added++
				if (sourceId !== null) seen.add(sourceId)
				results.push({
					entryId: entry.entryId,
					requestedItemId,
					itemId: requestedItemId,
					sourceId,
					outcome: 'added',
				})
			}
			if (target.kind === 'append' && added)
				this.db.runSync(
					'UPDATE playlists SET updatedAt = MAX(updatedAt + 1, ?) WHERE id = ?',
					[now, target.playlistId],
				)
			const playlist = playlists.get(target.playlistId)!
			this.db.runSync(
				'INSERT INTO import_commits(commitId, taskId, requestJson, playlistId, taskRevision, playlistUpdatedAt, committedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
				[
					request.commitId,
					taskId,
					text,
					playlist.id,
					revision,
					playlist.updatedAt,
					now,
				],
			)
			const extra = this.mixedSchema()
			for (const result of results) {
				this.db.runSync(
					extra
						? "INSERT INTO import_commit_entries(taskId,entryId,commitId,requestedItemId,itemId,sourceId,outcome,resolvedSourceId,resolvedAt,targetKind,targetId,skipKey) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'playlist', ?, ?)"
						: 'INSERT INTO import_commit_entries(taskId,entryId,commitId,requestedItemId,itemId,sourceId,outcome,resolvedSourceId,resolvedAt) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
					[
						taskId,
						result.entryId,
						request.commitId,
						result.requestedItemId,
						result.itemId,
						result.sourceId,
						result.outcome,
						...(extra
							? [
									target.playlistId,
									result.outcome === 'skipped' ? result.sourceId : null,
								]
							: []),
					],
				)
			}
			this.db.runSync(
				'UPDATE import_tasks SET revision = ?, updatedAt = ? WHERE taskId = ?',
				[revision, now, taskId],
			)
			const row = this.db.getFirstSync<CommitRow>(
				'SELECT * FROM import_commits WHERE commitId = ?',
				[request.commitId],
			)!
			return { receipt: this.readReceipt(row), playlist }
		})
	}
	resolvePending(
		taskId: string,
		entryId: string,
		input: ImportResolveRequest,
	): PlaylistDetail {
		id(taskId)
		id(entryId)
		object(input)
		keys(input, [
			'playlistId',
			'itemId',
			'expectedRevision',
			'expectedUpdatedAt',
		])
		id(input.playlistId)
		id(input.itemId)
		integer(input.expectedRevision)
		integer(input.expectedUpdatedAt)
		return this.atomic(() => {
			const task = this.taskAtRevision(taskId, input.expectedRevision)
			const ledger = this.db.getFirstSync<LedgerRow>(
				'SELECT e.*, c.playlistId FROM import_commit_entries e JOIN import_commits c ON c.commitId = e.commitId WHERE e.taskId = ? AND e.entryId = ?',
				[taskId, entryId],
			)
			const organization = organizationPendingBinding(
				this.db,
				taskId,
				entryId,
				ledger,
			)
			const binding = organization
				? {
						...ledger!,
						itemId: organization.itemId,
						sourceId: organization.sourceId,
						resolvedSourceId: organization.resolvedSourceId,
						playlistId: organization.targetId,
						targetKind: organization.targetKind,
						targetId: organization.targetId,
						contentKind: organization.contentKind,
					}
				: ledger
			const playlists = new PlaylistStore(this.db),
				playlist = playlists.get(input.playlistId)
			const item = playlist?.items.find(
				(value) => value.itemId === input.itemId,
			)
			const entry = task.entries.find((value) => value.entryId === entryId)
			if (
				!binding ||
				(binding.targetKind !== undefined &&
					binding.targetKind !== 'playlist') ||
				(binding.contentKind != null && binding.contentKind !== 'song') ||
				(binding.targetId !== undefined &&
					binding.targetId !== input.playlistId) ||
				binding.outcome !== 'added' ||
				binding.sourceId !== null ||
				binding.resolvedSourceId !== null ||
				binding.playlistId !== input.playlistId ||
				binding.itemId !== input.itemId ||
				!playlist ||
				playlist.updatedAt !== input.expectedUpdatedAt ||
				!item ||
				item.sourceId !== null ||
				!item.importOrigin ||
				item.importOrigin.taskId !== taskId ||
				item.importOrigin.entryId !== entryId ||
				!entry
			)
				throw new ImportConflictError(
					'IMPORT_TARGET_CONFLICT',
					'原待匹配条目或歌单已变更，请重新读取后确认',
				)
			const origin = item.importOrigin
			if (
				origin.provider !== task.provider ||
				origin.originalPlaylistId !== task.originalPlaylistId ||
				origin.taskVersion !== task.taskVersion ||
				origin.originalEntryId !== entry.originalEntryId ||
				origin.originalPosition !== entry.originalPosition ||
				json(origin.originalMetadata, limits.entryMetadataBytes) !==
					json(entry.originalMetadata, limits.entryMetadataBytes)
			)
				throw new ImportConflictError(
					'IMPORT_TARGET_CONFLICT',
					'待匹配条目的原导入引用不一致',
				)
			const matchedSourceId = this.confirmedSource(entry.review)
			if (task.provider === 'bilibili' && binding.contentKind === 'song')
				this.requireOriginalSource(entry, matchedSourceId)
			const { revision, now } = this.nextRevision(task)
			this.db.runSync(
				'UPDATE playlist_items SET sourceId = ?, reviewJson = ? WHERE itemId = ? AND playlistId = ? AND sourceId IS NULL',
				[
					matchedSourceId,
					json(entry.review, limits.reviewBytes, limits.metadataDepth + 3),
					input.itemId,
					input.playlistId,
				],
			)
			this.db.runSync(
				'UPDATE playlists SET updatedAt = MAX(updatedAt + 1, ?) WHERE id = ?',
				[now, input.playlistId],
			)
			if (organization)
				this.db.runSync(
					'UPDATE import_item_organizations SET resolvedSourceId=?,resolvedAt=? WHERE operationId=?',
					[matchedSourceId, now, organization.operationId],
				)
			else
				this.db.runSync(
					'UPDATE import_commit_entries SET resolvedSourceId = ?, resolvedAt = ? WHERE taskId = ? AND entryId = ?',
					[matchedSourceId, now, taskId, entryId],
				)
			this.db.runSync(
				'UPDATE import_tasks SET revision = ?, updatedAt = ? WHERE taskId = ?',
				[revision, now, taskId],
			)
			return playlists.get(input.playlistId)!
		})
	}
	setSelected(
		taskId: string,
		entryIds: string[],
		selected: boolean,
		expectedRevision: number,
	): ImportTaskDetail {
		id(taskId)
		integer(expectedRevision)
		if (typeof selected !== 'boolean') invalid('导入选择值无效')
		if (
			!Array.isArray(entryIds) ||
			!entryIds.length ||
			entryIds.length > limits.entries
		)
			invalid('批量选择必须包含1至5000个出现项')
		const unique = new Set<string>()
		for (const entryId of entryIds) {
			id(entryId)
			if (unique.has(entryId)) invalid('批量选择的出现项身份不能重复')
			unique.add(entryId)
		}
		return this.atomic(() => {
			const task = this.taskAtRevision(taskId, expectedRevision)
			const current = new Map(
				task.entries.map((entry) => [entry.entryId, entry.selected]),
			)
			if (entryIds.some((entryId) => !current.has(entryId)))
				invalid('批量选择包含不属于该任务的出现项')
			const changed = entryIds.filter(
				(entryId) => current.get(entryId) !== selected,
			)
			if (!changed.length) return task
			const { revision, now } = this.nextRevision(task)
			// Keep each statement below SQLite's older 999-parameter limit. Read and
			// validate the complete task only before and after the entire batch.
			for (let start = 0; start < changed.length; start += 500) {
				const batch = changed.slice(start, start + 500)
				this.db.runSync(
					`UPDATE import_entries SET selected = ? WHERE taskId = ? AND entryId IN (${batch.map(() => '?').join(',')})`,
					[Number(selected), taskId, ...batch],
				)
			}
			this.db.runSync(
				'UPDATE import_tasks SET revision = ?, updatedAt = ? WHERE taskId = ?',
				[revision, now, taskId],
			)
			return this.readDetail(taskId)!
		})
	}
	review(
		taskId: string,
		entryId: string,
		decision: ImportReviewDecision,
		expectedRevision: number,
	): ImportTaskDetail {
		id(taskId)
		id(entryId)
		integer(expectedRevision)
		object(decision)
		keys(decision, ['selected', 'review', 'retry'])
		if (
			decision.selected === undefined &&
			decision.review === undefined &&
			decision.retry === undefined
		)
			invalid('审核操作不能为空')
		if (
			decision.selected !== undefined &&
			typeof decision.selected !== 'boolean'
		)
			invalid('导入选择值无效')
		const review =
			decision.review === undefined ? undefined : reviewValue(decision.review)
		const retry =
			decision.retry === undefined ? undefined : retryValue(decision.retry)
		json(decision, limits.reviewBytes, limits.metadataDepth + 4)
		return this.atomic(() => {
			const task = this.readDetail(taskId)
			if (!task) invalid('导入任务不存在')
			if (task.revision !== expectedRevision)
				throw new ImportConflictError(
					'IMPORT_REVISION_CONFLICT',
					'导入任务已变更，请重新读取后审核',
				)
			const entry = task.entries.find((item) => item.entryId === entryId)
			if (!entry) invalid('导入出现项不在该任务中')
			if (review?.confirmation) {
				const sourceId = this.confirmedSource(review)
				if (
					task.provider === 'bilibili' &&
					this.requiresOriginalSource(taskId, entryId)
				)
					this.requireOriginalSource(entry, sourceId)
			}
			const revision = task.revision + 1
			integer(revision, 1)
			const now = Math.max(Date.now(), task.updatedAt + 1)
			const next = review ?? entry.review
			this.db.runSync(
				'UPDATE import_entries SET selected = ?, state = ?, candidatesJson = ?, confirmationCandidateId = ?, confirmedSourceId = ?, reviewedAt = ? WHERE taskId = ? AND entryId = ?',
				[
					decision.selected === undefined
						? Number(entry.selected)
						: Number(decision.selected),
					next.state,
					json(next.candidates, limits.reviewBytes, limits.metadataDepth + 2),
					next.confirmation?.candidateId ?? null,
					next.confirmation?.sourceId ?? null,
					review ? now : entry.reviewedAt,
					taskId,
					entryId,
				],
			)
			if (retry) {
				if (entry.retries.length >= limits.retriesPerEntry)
					invalid('该条目重试记录已达上限，原记录已保留')
				this.db.runSync(
					'INSERT INTO import_retry_records VALUES (?, ?, ?, ?, ?, ?, ?)',
					[
						taskId,
						entryId,
						entry.retries.length + 1,
						revision,
						now,
						retry.errorCode,
						retry.message,
					],
				)
			}
			const size = this.db.getFirstSync<{ bytes: number }>(
				'SELECT COALESCE((SELECT SUM(length(CAST(candidatesJson AS BLOB))) FROM import_entries WHERE taskId = ?), 0) + COALESCE((SELECT SUM(length(CAST(message AS BLOB)) + COALESCE(length(CAST(errorCode AS BLOB)), 0) + 64) FROM import_retry_records WHERE taskId = ?), 0) AS bytes',
				[taskId, taskId],
			)!.bytes
			if (size > limits.taskReviewBytes)
				invalid('该任务审核与重试元数据已达大小上限，原记录已保留')
			this.db.runSync(
				'UPDATE import_tasks SET revision = ?, updatedAt = ? WHERE taskId = ?',
				[revision, now, taskId],
			)
			return this.readDetail(taskId)!
		})
	}
}
