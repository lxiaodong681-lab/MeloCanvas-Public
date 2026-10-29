import type { Database } from './database'
import type { RecentMusicHistoryEntry } from '@bbplayer/orpheus'
import { readHeartProfile } from './heart-profile'
import { originalVideoBvid } from './import-mixed-validation'
import {
	importTaskLimits,
	type ImportDirectorySnapshot,
	type ImportDirectoryEntry,
} from './import-types'
import { json } from './import-validation'
import { sourceId, type Source } from './model'
import { playlistItemFromRow, type PlaylistItemRow } from './playlist-import'

export const recommendationSettingKey = 'recommendations.local.v1'
const snapshotSize = 20
const maxDismissals = 5000
const maxSettingBytes = 1024 * 1024

export type RecommendationReason =
	| 'liked'
	| 'playlist'
	| 'saved-music'
	| 'imported-song'
export interface LocalRecommendation {
	source: Source
	/** Current local relationships, rechecked on every read; never a claim about Artist. */
	reasons: RecommendationReason[]
}
export interface RecommendationSnapshot {
	localDate: string
	/** Explicit rotations within this date, not an interaction/learning score. */
	revision: number
	items: LocalRecommendation[]
	canUndo: boolean
}
export interface DismissedRecommendation {
	sourceId: string
	dismissedAt: number
	source: Source | null
}
export interface DismissedRecommendationPage {
	items: DismissedRecommendation[]
	page: number
	pageSize: number
	total: number
	totalPages: number
}
interface RecordV1 {
	version: 1
	localDate: string
	revision: number
	sourceIds: string[]
	dismissed: { sourceId: string; dismissedAt: number }[]
	undoSourceId: string | null
}
interface Candidate extends Source {
	liked: number
	inPlaylist: number
	reviewedSong: number
}

function invalid(): never {
	throw new Error('本地推荐设置损坏或版本不受支持；原数据已保留。')
}
function identity(value: unknown): value is string {
	if (typeof value !== 'string') return false
	const match = /^bilibili:(BV[A-Za-z0-9]{10}):([1-9][0-9]*)$/.exec(value)
	return !!match && match[0] === value && Number.isSafeInteger(Number(match[2]))
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function localDate(date: Date): string {
	if (
		!Number.isSafeInteger(date.getTime()) ||
		date.getTime() < 0 ||
		date.getFullYear() > 9999
	)
		throw new Error('本地推荐时钟无效')
	return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`
}
function validDate(value: unknown): value is string {
	if (
		typeof value !== 'string' ||
		value.length !== 10 ||
		!/^\d{4}-\d{2}-\d{2}$/.test(value)
	)
		return false
	const [year, month, day] = value.split('-').map(Number)
	// UTC only validates the calendar; snapshots themselves use the injected local clock.
	const date = new Date(0)
	date.setUTCFullYear(year, month - 1, day)
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	)
}
function parseRecord(text: string): RecordV1 {
	if (new TextEncoder().encode(text).length > maxSettingBytes) invalid()
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		invalid()
	}
	if (
		!object(value) ||
		Object.keys(value).sort().join(',') !==
			'dismissed,localDate,revision,sourceIds,undoSourceId,version' ||
		value.version !== 1 ||
		!validDate(value.localDate) ||
		!Number.isSafeInteger(value.revision) ||
		(value.revision as number) < 0 ||
		!Array.isArray(value.sourceIds) ||
		value.sourceIds.length > snapshotSize ||
		!value.sourceIds.every(identity) ||
		new Set(value.sourceIds).size !== value.sourceIds.length ||
		!Array.isArray(value.dismissed) ||
		value.dismissed.length > maxDismissals
	)
		invalid()
	const dismissed = new Set<string>()
	for (const entry of value.dismissed) {
		if (
			!object(entry) ||
			Object.keys(entry).sort().join(',') !== 'dismissedAt,sourceId' ||
			!identity(entry.sourceId) ||
			!Number.isSafeInteger(entry.dismissedAt) ||
			(entry.dismissedAt as number) < 0 ||
			dismissed.has(entry.sourceId)
		)
			invalid()
		dismissed.add(entry.sourceId)
	}
	if (
		value.undoSourceId !== null &&
		(!identity(value.undoSourceId) || !dismissed.has(value.undoSourceId))
	)
		invalid()
	return value as unknown as RecordV1
}

/** Local Source qualification and daily snapshots. No requests, playback events or classification writes. */
export class RecommendationStore {
	constructor(
		private readonly db: Database,
		private readonly now: () => Date,
	) {}

	load(): RecommendationSnapshot {
		return this.update('load')
	}

	refresh(): RecommendationSnapshot {
		return this.update('refresh')
	}

	heartProfile(history: readonly RecentMusicHistoryEntry[]) {
		return this.atomic(() => {
			const profile = readHeartProfile(this.db, history)
			const record = this.setting()
			if (record !== null) profile.knownBvids.push(...parseRecord(record).dismissed.map(item => item.sourceId.split(':')[1]))
			return profile
		}, false)
	}

	/** Read current qualified Sources independently of the daily snapshot; never generates or writes one. */
	fmCandidates(
		excludedSourceIds: readonly string[],
		limit = 20,
	): LocalRecommendation[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
			throw new Error('私人 FM 候选数量无效')
		if (!Array.isArray(excludedSourceIds) || excludedSourceIds.length > 5000)
			throw new Error('私人 FM 排除音源列表无效')
		const excluded = new Set<string>()
		for (const id of excludedSourceIds) {
			if (!identity(id)) throw new Error('私人 FM 排除音源身份无效')
			excluded.add(id)
		}
		return this.atomic(() => {
			const text = this.setting()
			if (text !== null)
				for (const entry of parseRecord(text).dismissed)
					excluded.add(entry.sourceId)
			return this.candidates()
				.filter((item) => !excluded.has(item.source.id))
				.slice(0, limit)
		}, false)
	}

	/** One explicit Source rejection, not rejection of a song, work, version or performer. */
	dismiss(id: string): RecommendationSnapshot {
		if (!identity(id)) throw new Error('推荐音源身份无效')
		return this.update('dismiss', id)
	}

	/** Undo the most recent distinct dismissal, including after reopening the store. */
	undo(): RecommendationSnapshot {
		return this.update('undo')
	}

	/** Read feedback only, including missing Sources; never generates or rewrites a daily snapshot. */
	listDismissed(page = 1, pageSize = 20): DismissedRecommendationPage {
		if (
			!Number.isSafeInteger(page) ||
			page < 1 ||
			!Number.isSafeInteger(pageSize) ||
			pageSize < 1 ||
			pageSize > 50
		)
			throw new Error('推荐反馈页码或每页数量无效')
		return this.atomic(() => {
			const text = this.setting()
			const entries = text === null ? [] : parseRecord(text).dismissed
			entries.sort(
				(left, right) =>
					right.dismissedAt - left.dismissedAt ||
					(left.sourceId < right.sourceId
						? -1
						: left.sourceId > right.sourceId
							? 1
							: 0),
			)
			const total = entries.length,
				totalPages = Math.ceil(total / pageSize)
			// Check first: a valid safe page number multiplied by pageSize may not be safe.
			const selected =
				page > totalPages
					? []
					: entries.slice((page - 1) * pageSize, page * pageSize)
			const items = selected.map((entry) => ({
				...entry,
				source: this.db.getFirstSync<Source>(
					'SELECT * FROM sources WHERE id=?',
					[entry.sourceId],
				),
			}))
			return { items, page, pageSize, total, totalPages }
		}, false)
	}

	restoreSource(id: string): RecommendationSnapshot {
		if (!identity(id)) throw new Error('推荐音源身份无效')
		return this.update('restore', id)
	}

	/** Reset only local recommendation feedback/snapshot; malformed records remain untouched. */
	resetLocalRecommendations(): RecommendationSnapshot {
		return this.update('reset')
	}

	private setting(): string | null {
		return (
			this.db.getFirstSync<{ value: string }>(
				'SELECT value FROM settings WHERE key=?',
				[recommendationSettingKey],
			)?.value ?? null
		)
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
				// SQLite may already have rolled back. Preserve the original error.
			}
			throw error
		}
	}

	private candidates(): LocalRecommendation[] {
		const imported = this.importedSongs()
		// Classification belongs to the current review, not an immutable commit receipt.
		const rejectedBvids = new Set<string>()
		const reviews = this.db.getAllSync<{
			taskId: string
			entryId: string
			confirmedSourceId: string | null
		}>(
			`SELECT r.taskId,r.entryId,e.confirmedSourceId FROM import_content_reviews r
			JOIN import_entries e ON e.taskId=r.taskId AND e.entryId=r.entryId WHERE r.kind!='song'`,
			[],
		)
		const rejectedEntries = new Map<string, Set<string>>()
		for (const review of reviews) {
			let entries = rejectedEntries.get(review.taskId)
			if (!entries) rejectedEntries.set(review.taskId, (entries = new Set()))
			entries.add(review.entryId)
			if (review.confirmedSourceId !== null) {
				if (!identity(review.confirmedSourceId))
					throw new Error('本地推荐审核音源身份损坏；原数据已保留。')
				rejectedBvids.add(review.confirmedSourceId.split(':')[1])
			}
		}
		// Read and parse each relevant task once, not its entire JSON once per review/Source.
		// This also avoids depending on additional Android SQLite JSON functions.
		for (const taskId of rejectedEntries.keys()) {
			const task = this.db.getFirstSync<{ snapshotJson: string }>(
				'SELECT snapshotJson FROM import_tasks WHERE taskId=?',
				[taskId],
			)
			if (!task) throw new Error('本地推荐目录证据缺失；原数据已保留。')
			const snapshot: unknown = JSON.parse(task.snapshotJson)
			if (!object(snapshot) || !Array.isArray(snapshot.entries))
				throw new Error('本地推荐目录证据损坏；原数据已保留。')
			for (const entry of snapshot.entries) {
				if (!object(entry) || typeof entry.entryId !== 'string')
					throw new Error('本地推荐目录条目损坏；原数据已保留。')
				if (!rejectedEntries.get(taskId)?.has(entry.entryId)) continue
				const bvid = originalVideoBvid(entry as unknown as ImportDirectoryEntry)
				if (bvid !== null) rejectedBvids.add(bvid)
			}
		}
		// A BV-level long/unknown review excludes every CID, even if sources.domain is music.
		const rows = this.db.getAllSync<Candidate>(
			`SELECT s.*,
				EXISTS(SELECT 1 FROM likes l WHERE l.sourceId=s.id) AS liked,
				s.id IN (SELECT sourceId FROM playlist_items WHERE sourceId IS NOT NULL) AS inPlaylist,
				s.id IN (
				SELECT e.confirmedSourceId FROM import_content_reviews r
				JOIN import_entries e ON e.taskId=r.taskId AND e.entryId=r.entryId
				WHERE r.kind='song' AND e.confirmedSourceId IS NOT NULL
				) AS reviewedSong
			FROM sources s
			WHERE s.domain='music' OR reviewedSong OR s.id IN (
				SELECT p.sourceId FROM playlist_items p JOIN import_tasks t ON t.taskId=p.importTaskId
				WHERE t.provider IN ('netease','qq','kugou','kuwo','qishui') AND p.sourceId IS NOT NULL)
			ORDER BY liked DESC, inPlaylist DESC, s.id`,
			[],
		)
		return rows
			.filter(
				(row) =>
					!rejectedBvids.has(row.bvid) &&
					(row.domain === 'music' || row.reviewedSong || imported.has(row.id)),
			)
			.map(({ liked, inPlaylist, reviewedSong: _reviewedSong, ...source }) => {
				if (
					!identity(source.id) ||
					source.id !== sourceId(source.bvid, source.cid) ||
					!Number.isSafeInteger(source.cid) ||
					source.cid <= 0
				)
					throw new Error('本地推荐音源身份损坏；原数据已保留。')
				const reasons: RecommendationReason[] = []
				if (liked) reasons.push('liked')
				if (inPlaylist) reasons.push('playlist')
				if (imported.has(source.id)) reasons.push('imported-song')
				if (!reasons.length) reasons.push('saved-music')
				return { source, reasons }
			})
	}

	/** Read-only qualification, never permission to resolve/update the historical original item. */
	private importedSongs(): Set<string> {
		const result = new Set<string>()
		const references = this.db.getAllSync<{
			itemId: string
			importTaskId: string
		}>(
			`SELECT p.itemId,p.importTaskId FROM playlist_items p
			JOIN import_tasks t ON t.taskId=p.importTaskId
			WHERE t.provider IN ('netease','qq','kugou','kuwo','qishui') AND p.sourceId IS NOT NULL`,
			[],
		)
		const groups = new Map<string, string[]>()
		for (const reference of references) {
			let items = groups.get(reference.importTaskId)
			if (!items) groups.set(reference.importTaskId, (items = []))
			items.push(reference.itemId)
		}
		for (const [taskId, itemIds] of groups) {
			const task = this.db.getFirstSync<{
				provider: string
				originalPlaylistId: string
				taskVersion: number
				snapshotJson: string
			}>(
				'SELECT provider,originalPlaylistId,taskVersion,snapshotJson FROM import_tasks WHERE taskId=?',
				[taskId],
			)
			if (!task) throw new Error('已核对导入歌曲的原任务缺失')
			const snapshot = JSON.parse(task.snapshotJson) as ImportDirectorySnapshot
			if (
				snapshot.taskId !== taskId ||
				snapshot.provider !== task.provider ||
				snapshot.originalPlaylistId !== task.originalPlaylistId ||
				snapshot.taskVersion !== task.taskVersion ||
				!Array.isArray(snapshot.entries)
			)
				throw new Error('已核对导入歌曲的原目录不一致')
			const originals = new Map(
				snapshot.entries.map((entry) => [entry.entryId, entry]),
			)
			const originalMetadata = new Map<string, string>()
			const ledger = this.db.getAllSync<{
				entryId: string
				itemId: string | null
				outcome: string
				targetKind: string
				sourceId: string | null
				resolvedSourceId: string | null
				state: string
				confirmedSourceId: string | null
			}>(
				`SELECT l.entryId,l.itemId,l.outcome,l.targetKind,l.sourceId,l.resolvedSourceId,e.state,e.confirmedSourceId
				FROM import_commit_entries l JOIN import_entries e ON e.taskId=l.taskId AND e.entryId=l.entryId
				WHERE l.taskId=?`,
				[taskId],
			)
			const proofs = new Map(ledger.map((proof) => [proof.entryId, proof]))
			for (const itemId of itemIds) {
				const row = this.db.getFirstSync<PlaylistItemRow>(
					'SELECT * FROM playlist_items WHERE itemId=?',
					[itemId],
				)
				if (!row) throw new Error('已核对导入歌曲的当前条目缺失')
				const item = playlistItemFromRow(row),
					origin = item.importOrigin
				const original = origin && originals.get(origin.entryId)
				if (
					!origin ||
					!original ||
					origin.taskId !== taskId ||
					origin.provider !== task.provider ||
					origin.originalPlaylistId !== task.originalPlaylistId ||
					origin.taskVersion !== task.taskVersion ||
					origin.originalEntryId !== original.originalEntryId ||
					origin.originalPosition !== original.originalPosition
				)
					throw new Error('已核对导入歌曲的原条目证据不一致')
				let metadata = originalMetadata.get(origin.entryId)
				if (metadata === undefined) {
					metadata = json(
						original.originalMetadata,
						importTaskLimits.entryMetadataBytes,
					)
					originalMetadata.set(origin.entryId, metadata)
				}
				if (
					json(origin.originalMetadata, importTaskLimits.entryMetadataBytes) !==
					metadata
				)
					throw new Error('已核对导入歌曲的原条目证据不一致')
				const proof = proofs.get(origin.entryId)
				// Copies keep genuine origin evidence; a forged origin alone cannot create a ledger.
				if (
					!proof ||
					proof.outcome !== 'added' ||
					proof.itemId === null ||
					proof.targetKind !== 'playlist'
				)
					throw new Error('已核对导入歌曲缺少真实保存记录')
				if (
					proof.sourceId === null
						? origin.reviewAtCommit.state === 'confirmed'
						: origin.reviewAtCommit.confirmation?.sourceId !== proof.sourceId
				)
					throw new Error('已核对导入歌曲的历史确认不一致')
				if (item.sourceId !== (proof.sourceId ?? proof.resolvedSourceId))
					throw new Error('已核对导入歌曲的保存音源不一致')
				if (
					proof.state === 'confirmed' &&
					proof.confirmedSourceId === item.sourceId
				)
					result.add(item.sourceId!)
			}
		}
		return result
	}

	private generate(record: RecordV1, candidates: LocalRecommendation[]): void {
		const excluded = new Set(record.dismissed.map((entry) => entry.sourceId))
		const pool = candidates.filter((item) => !excluded.has(item.source.id))
		// Rotate one slot so a small pool still visibly changes order. A full cycle repeats.
		const offset = pool.length ? record.revision % pool.length : 0
		record.sourceIds = [...pool.slice(offset), ...pool.slice(0, offset)]
			.slice(0, snapshotSize)
			.map((item) => item.source.id)
	}

	private update(
		action: 'load' | 'refresh' | 'dismiss' | 'undo' | 'restore' | 'reset',
		id?: string,
	): RecommendationSnapshot {
		return this.atomic(() => {
			const now = this.now()
			const today = localDate(now)
			const previous = this.setting()
			const record: RecordV1 =
				previous === null
					? {
							version: 1,
							localDate: today,
							revision: 0,
							sourceIds: [],
							dismissed: [],
							undoSourceId: null,
						}
					: parseRecord(previous)
			const before = JSON.stringify(record)
			const candidates = this.candidates()
			const byId = new Map(candidates.map((item) => [item.source.id, item]))
			let generate = previous === null || record.localDate !== today ||
				(record.sourceIds.length === 0 && candidates.length > 0)
			if (generate) {
				record.localDate = today
				record.revision = 0
			}
			if (action === 'refresh') {
				if (record.revision === Number.MAX_SAFE_INTEGER)
					throw new Error('本地推荐换一批次数已达上限')
				record.revision++
				generate = true
			} else if (action === 'dismiss') {
				if (!record.dismissed.some((entry) => entry.sourceId === id)) {
					if (!id || !record.sourceIds.includes(id) || !byId.has(id))
						throw new Error('这条音源不在当前有效推荐中，请重新读取')
					if (record.dismissed.length >= maxDismissals)
						throw new Error('本地推荐单音源反馈已达上限；原记录已保留。')
					record.dismissed.push({ sourceId: id, dismissedAt: now.getTime() })
					record.undoSourceId = id
				}
			} else if (action === 'undo' && record.undoSourceId !== null) {
				record.dismissed = record.dismissed.filter(
					(entry) => entry.sourceId !== record.undoSourceId,
				)
				record.undoSourceId = null
			} else if (action === 'restore') {
				record.dismissed = record.dismissed.filter(
					(entry) => entry.sourceId !== id,
				)
				if (record.undoSourceId === id) record.undoSourceId = null
			} else if (action === 'reset') {
				record.dismissed = []
				record.undoSourceId = null
				record.revision = 0
				generate = true
			}
			if (generate) this.generate(record, candidates)
			const excluded = new Set(record.dismissed.map((entry) => entry.sourceId))
			const items = record.sourceIds.flatMap((key) => {
				const item = byId.get(key)
				return item && !excluded.has(key) ? [item] : []
			})
			const text = JSON.stringify(record)
			if (new TextEncoder().encode(text).length > maxSettingBytes)
				throw new Error('本地推荐记录过大；原记录已保留。')
			if (previous === null || before !== text)
				this.db.runSync(
					'INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
					[recommendationSettingKey, text],
				)
			return {
				localDate: today,
				revision: record.revision,
				items,
				canUndo: record.undoSourceId !== null,
			}
		})
	}
}
