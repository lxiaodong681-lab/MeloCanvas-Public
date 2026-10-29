import type { Database } from './database'
import type { FollowingContentScope } from './following-feed-types'
import { contentKinds, type ContentKind } from './import-mixed-types'
import { contentKind, originalVideoBvid } from './import-mixed-validation'
import type { ImportDirectorySnapshot } from './import-types'
import { directory, id, integer, invalid } from './import-validation'

interface ReviewRow {
	entryId: string
	kind: ContentKind
	reviewedAt: number
}
export interface BilibiliContentScope {
	scope: FollowingContentScope
	kinds: ContentKind[]
}
function family(kinds: readonly ContentKind[]): FollowingContentScope {
	if (!kinds.length || kinds.includes('unknown')) return 'unknown'
	const families = new Set(
		kinds.map((kind) =>
			kind === 'song' || kind === 'musicCollection' ? 'music' : 'listening',
		),
	)
	return families.size === 1 ? families.values().next().value! : 'unknown'
}

/** Current explicit BV evidence only. No Source/CID inference or cross-call cache. */
export class BilibiliContentScopeReader {
	constructor(private readonly db: Database) {}
	load(bvids: readonly string[]): Map<string, BilibiliContentScope> {
		this.db.execSync('BEGIN')
		try {
			const result = this.readInSnapshot(bvids)
			this.db.execSync('COMMIT')
			return result
		} catch (error) {
			try {
				this.db.execSync('ROLLBACK')
			} catch {
				/* Preserve the original read error. */
			}
			throw error
		}
	}
	/** Caller owns the existing read transaction; never begins a nested transaction. */
	readInSnapshot(bvids: Iterable<string>): Map<string, BilibiliContentScope> {
		const wanted = new Set(bvids)
		for (const bvid of wanted)
			if (typeof bvid !== 'string' || !/^BV[A-Za-z0-9]{10}$/.test(bvid))
				throw new Error('投稿 BV 身份无效')
		const evidence = wanted.size
			? this.classifications(wanted)
			: new Map<string, Set<ContentKind>>()
		return new Map(
			[...wanted].map((bvid) => {
				const kinds = contentKinds.filter((kind) =>
					evidence.get(bvid)?.has(kind),
				)
				return [bvid, { scope: family(kinds), kinds }]
			}),
		)
	}
	private classifications(
		wanted: ReadonlySet<string>,
	): Map<string, Set<ContentKind>> {
		const result = new Map<string, Set<ContentKind>>()
		// Once per task, not once per review/BV/CID; retain no cross-call proof cache.
		for (const { taskId } of this.db.getAllSync<{ taskId: string }>(
			'SELECT DISTINCT taskId FROM import_content_reviews ORDER BY taskId',
			[],
		)) {
			id(taskId)
			const row = this.db.getFirstSync<{
				provider: string
				originalPlaylistId: string
				taskVersion: number
				snapshotJson: string
			}>(
				'SELECT provider,originalPlaylistId,taskVersion,snapshotJson FROM import_tasks WHERE taskId=?',
				[taskId],
			)
			if (!row) invalid('关注更新的分类原任务缺失')
			const { snapshot } = directory(
				JSON.parse(row.snapshotJson) as ImportDirectorySnapshot,
			)
			if (
				row.provider !== 'bilibili' ||
				snapshot.taskId !== taskId ||
				snapshot.provider !== row.provider ||
				snapshot.originalPlaylistId !== row.originalPlaylistId ||
				snapshot.taskVersion !== row.taskVersion
			)
				invalid('关注更新的分类原目录身份不一致')
			const entries = this.db.getAllSync<{
				entryId: string
				originalPosition: number
			}>(
				'SELECT entryId,originalPosition FROM import_entries WHERE taskId=? ORDER BY originalPosition',
				[taskId],
			)
			if (
				entries.length !== snapshot.entries.length ||
				entries.some(
					(entry, index) =>
						entry.entryId !== snapshot.entries[index].entryId ||
						entry.originalPosition !== snapshot.entries[index].originalPosition,
				)
			)
				invalid('关注更新的分类原条目身份不一致')
			const originals = new Map(
				snapshot.entries.map((entry) => [entry.entryId, entry]),
			)
			for (const review of this.db.getAllSync<ReviewRow>(
				'SELECT entryId,kind,reviewedAt FROM import_content_reviews WHERE taskId=?',
				[taskId],
			)) {
				contentKind(review.kind)
				integer(review.reviewedAt)
				const original = originals.get(review.entryId)
				if (!original) invalid('关注更新的内容审核条目不属于原任务')
				const bvid = originalVideoBvid(original)
				if (!bvid || !wanted.has(bvid)) continue
				let kinds = result.get(bvid)
				if (!kinds) result.set(bvid, (kinds = new Set()))
				kinds.add(review.kind)
			}
		}
		return result
	}
}
