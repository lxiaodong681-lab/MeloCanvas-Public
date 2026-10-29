import type { CreatorPostCandidate } from '../creator-api'

import type { Database } from './database'
import { json } from './import-validation'

const cacheNamespace = 'bilibili/public/emptykeyword/defaultorder/ps30/'
const cacheKey = `${cacheNamespace}format1`
const pageSize = 30

export interface CreatorPostCacheResponse {
	items: CreatorPostCandidate[]
	page: number
	more: boolean
	total: number
}
export interface CachedCreatorPostPage {
	page: number
	items: CreatorPostCandidate[]
	fetchedAt: number
}
export interface CachedCreatorPosts {
	mid: string
	revision: number
	pages: CachedCreatorPostPage[]
	lastPage: number
	more: boolean
	total: number
	/** Only the end reported for this contiguous page sequence, not a stable complete platform snapshot. */
	complete: boolean
}
export class CreatorPostCacheConflictError extends Error {
	readonly code = 'CREATOR_POST_CACHE_CONFLICT'
	constructor(message = 'UP 投稿缓存已变化，请重新读取或刷新第一页') {
		super(message)
		this.name = 'CreatorPostCacheConflictError'
	}
}
interface Header {
	revision: number
	lastPage: number
	more: number
	total: number
}
interface PageRow {
	page: number
	fetchedAt: number
	itemsJson: string
}
function invalid(): never {
	throw new Error('UP 投稿缓存数据无效；原数据已保留。')
}
function integer(value: number, minimum = 0): void {
	if (!Number.isSafeInteger(value) || value < minimum) invalid()
}
function mid(value: string): void {
	if (
		typeof value !== 'string' ||
		value.trim() !== value ||
		!/^[1-9][0-9]*$/.test(value)
	)
		invalid()
}
function timestamp(value: number): void {
	integer(value)
	if (value > 8640000000000000) invalid()
}
function items(
	value: unknown,
	creatorMid: string,
): { text: string; items: CreatorPostCandidate[] } {
	if (!Array.isArray(value) || value.length > pageSize) invalid()
	// Validate the parsed flat candidate shape without an arbitrary per-UP cache size cap.
	const text = json(value, Number.MAX_SAFE_INTEGER, 4)
	const parsed = JSON.parse(text) as CreatorPostCandidate[]
	const seen = new Set<string>()
	for (const candidate of parsed) {
		if (
			!candidate ||
			typeof candidate !== 'object' ||
			Array.isArray(candidate) ||
			Object.keys(candidate).some(
				(key) =>
					![
						'bvid',
						'title',
						'artwork',
						'duration',
						'publishedAt',
						'queryCreatorMid',
						'ownerMid',
					].includes(key),
			)
		)
			invalid()
		if (
			typeof candidate.bvid !== 'string' ||
			candidate.bvid.length !== 12 ||
			!/^BV[A-Za-z0-9]{10}$/.test(candidate.bvid) ||
			seen.has(candidate.bvid)
		)
			invalid()
		seen.add(candidate.bvid)
		if (
			typeof candidate.title !== 'string' ||
			!candidate.title ||
			candidate.title.trim() !== candidate.title ||
			candidate.queryCreatorMid !== creatorMid
		)
			invalid()
		if (candidate.ownerMid !== undefined) mid(candidate.ownerMid)
		integer(candidate.duration)
		timestamp(candidate.publishedAt)
		if (typeof candidate.artwork !== 'string') invalid()
		try {
			const url = new URL(candidate.artwork)
			if (
				url.protocol !== 'https:' ||
				!url.hostname ||
				url.username ||
				url.password
			)
				invalid()
		} catch {
			invalid()
		}
	}
	return { text, items: parsed }
}
function paging(
	page: number,
	total: number,
	more: boolean,
	length: number,
): void {
	integer(page, 1)
	integer(total)
	const pages = Math.ceil(total / pageSize)
	const expected =
		page > pages ? 0 : Math.min(pageSize, total - (page - 1) * pageSize)
	if (typeof more !== 'boolean' || more !== page < pages || length !== expected)
		invalid()
}

/** Only validated public post candidates; no Source/profile/subscription writes or network work. */
export class CreatorPostCache {
	constructor(private readonly db: Database) {}
	load(creatorMid: string): CachedCreatorPosts | null {
		mid(creatorMid)
		return this.atomic(() => this.read(creatorMid), false)
	}
	/** Read-only boundary: caller MUST own the SQLite read transaction/snapshot.
	 * This method never begins/commits one and exposes no cache mutation path. */
	readInSnapshot(creatorMid: string): CachedCreatorPosts | null {
		mid(creatorMid)
		return this.read(creatorMid)
	}
	savePage(
		creatorMid: string,
		response: CreatorPostCacheResponse,
		fetchedAt: number,
		expectedRevision: number | null,
	): CachedCreatorPosts {
		mid(creatorMid)
		timestamp(fetchedAt)
		if (expectedRevision !== null) integer(expectedRevision, 1)
		if (!response || typeof response !== 'object') invalid()
		const checked = items(response.items, creatorMid)
		paging(response.page, response.total, response.more, checked.items.length)
		return this.atomic(() => {
			const previous = this.read(creatorMid)
			if ((previous?.revision ?? null) !== expectedRevision)
				throw new CreatorPostCacheConflictError()
			if (response.page > 1 && previous && response.total !== previous.total)
				throw new CreatorPostCacheConflictError(
					'UP 投稿列表已变更，请刷新第一页',
				)
			if (
				response.page > 1 &&
				(!previous || !previous.more || response.page !== previous.lastPage + 1)
			)
				throw new CreatorPostCacheConflictError(
					'UP 投稿分页不属于当前连续缓存，请刷新第一页',
				)
			const revision = (previous?.revision ?? 0) + 1
			integer(revision, 1)
			if (response.page === 1 && previous)
				this.db.runSync(
					'DELETE FROM creator_post_cache_pages WHERE cacheKey=? AND mid=?',
					[cacheKey, creatorMid],
				)
			this.db.runSync(
				`INSERT INTO creator_post_cache_heads(cacheKey,mid,revision,lastPage,more,total) VALUES(?,?,?,?,?,?)
				ON CONFLICT(cacheKey,mid) DO UPDATE SET revision=excluded.revision,lastPage=excluded.lastPage,more=excluded.more,total=excluded.total`,
				[
					cacheKey,
					creatorMid,
					revision,
					response.page,
					response.more ? 1 : 0,
					response.total,
				],
			)
			this.db.runSync(
				'INSERT INTO creator_post_cache_pages(cacheKey,mid,page,fetchedAt,itemsJson) VALUES(?,?,?,?,?)',
				[cacheKey, creatorMid, response.page, fetchedAt, checked.text],
			)
			return {
				mid: creatorMid,
				revision,
				pages: [
					...(response.page === 1 ? [] : previous!.pages),
					{ page: response.page, items: checked.items, fetchedAt },
				],
				lastPage: response.page,
				more: response.more,
				total: response.total,
				complete: !response.more,
			}
		})
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
				/* Keep the original SQLite error. */
			}
			throw error
		}
	}
	private read(creatorMid: string): CachedCreatorPosts | null {
		const unsupported = this.db.getFirstSync<{ cacheKey: string }>(
			'SELECT cacheKey FROM creator_post_cache_heads WHERE mid=? AND cacheKey!=? AND substr(cacheKey,1,?)=? LIMIT 1',
			[creatorMid, cacheKey, cacheNamespace.length, cacheNamespace],
		)
		if (unsupported)
			throw new Error('UP 投稿缓存格式不受支持，请使用新版音绘；原数据已保留。')
		const header = this.db.getFirstSync<Header>(
			'SELECT revision,lastPage,more,total FROM creator_post_cache_heads WHERE cacheKey=? AND mid=?',
			[cacheKey, creatorMid],
		)
		const rows = this.db.getAllSync<PageRow>(
			'SELECT page,fetchedAt,itemsJson FROM creator_post_cache_pages WHERE cacheKey=? AND mid=? ORDER BY page',
			[cacheKey, creatorMid],
		)
		if (!header) {
			if (rows.length) invalid()
			return null
		}
		integer(header.revision, 1)
		integer(header.lastPage, 1)
		integer(header.total)
		if (
			![0, 1].includes(header.more) ||
			rows.length !== header.lastPage ||
			header.lastPage > Math.max(1, Math.ceil(header.total / pageSize))
		)
			invalid()
		const pages = rows.map((row, index) => {
			if (row.page !== index + 1 || typeof row.itemsJson !== 'string') invalid()
			timestamp(row.fetchedAt)
			const checked = items(JSON.parse(row.itemsJson), creatorMid)
			paging(
				row.page,
				header.total,
				row.page < Math.ceil(header.total / pageSize),
				checked.items.length,
			)
			return { page: row.page, items: checked.items, fetchedAt: row.fetchedAt }
		})
		if (
			Boolean(header.more) !==
			header.lastPage < Math.ceil(header.total / pageSize)
		)
			invalid()
		return {
			mid: creatorMid,
			revision: header.revision,
			pages,
			lastPage: header.lastPage,
			more: Boolean(header.more),
			total: header.total,
			complete: !header.more,
		}
	}
}
