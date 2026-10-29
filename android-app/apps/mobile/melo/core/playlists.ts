import { Library, type Database } from './database'
import type { PlaylistImportOrigin } from './import-playlist-types'
import type { ImportProvider, ImportReview } from './import-types'
import type { Source as BiliSource } from './model'
import { type MusicLibrarySource as Source } from './music-library-source'
import {
	playlistImportJson,
	playlistItemFromRow,
	type PlaylistItemRow,
} from './playlist-import'

export interface Playlist {
	id: string
	name: string
	description: string
	coverUri: string | null
	createdAt: number
	updatedAt: number
}

export interface PlaylistItem {
	itemId: string
	playlistId: string
	sourceId: string | null
	position: number
	addedAt: number
	importOrigin: PlaylistImportOrigin | null
	review: ImportReview | null
}

export interface PlaylistDetail extends Playlist {
	items: PlaylistItem[]
}

export interface PlaylistEntry {
	itemId: string
	source: Source
}

/** Library-card data only; opening a playlist still validates its full detail. */
export interface PlaylistSummary {
	playlist: Playlist
	count: number
	pendingCount: number
	firstSourceId: string | null
	importProviders: ImportProvider[]
}

/** Required on every append; the future UI/import task chooses its policy explicitly. */
export type PlaylistDuplicatePolicy = 'keep-all' | 'skip-existing-source'

export interface PlaylistAppendResult {
	added: PlaylistItem[]
	skippedItemIds: string[]
}

declare const removalReceiptBrand: unique symbol
/** Transient identity token. Only the PlaylistStore instance that issued it can undo it. */
export type PlaylistRemovalReceipt = { readonly [removalReceiptBrand]: true }

export class PlaylistUndoExpiredError extends Error {
	readonly code = 'PLAYLIST_UNDO_EXPIRED'
	constructor(message = '本次移除已失效，不能撤销') {
		super(message)
		this.name = 'PlaylistUndoExpiredError'
	}
}

interface LastRemoval {
	receipt: PlaylistRemovalReceipt
	before: PlaylistDetail
	after: PlaylistDetail
}

function samePlaylist(left: PlaylistDetail, right: PlaylistDetail): boolean {
	return (
		left.id === right.id &&
		left.name === right.name &&
		left.description === right.description &&
		left.coverUri === right.coverUri &&
		left.createdAt === right.createdAt &&
		left.updatedAt === right.updatedAt &&
		left.items.length === right.items.length &&
		left.items.every((item, index) => {
			const other = right.items[index]
			return (
				item.itemId === other.itemId &&
				item.playlistId === other.playlistId &&
				item.sourceId === other.sourceId &&
				item.position === other.position &&
				item.addedAt === other.addedAt &&
				JSON.stringify(item.importOrigin) ===
					JSON.stringify(other.importOrigin) &&
				JSON.stringify(item.review) === JSON.stringify(other.review)
			)
		})
	)
}

function validateId(id: string): void {
	if (typeof id !== 'string' || !id || id.trim() !== id)
		throw new Error('歌单或条目身份无效')
}

function nameFor(name: string): string {
	if (typeof name !== 'string' || !name.trim())
		throw new Error('歌单名称不能为空')
	return name.trim()
}

function validateIds(ids: string[]): void {
	for (const id of ids) validateId(id)
	if (new Set(ids).size !== ids.length) throw new Error('条目身份不能重复')
}

/** Local rows only. Public mutations own their transaction; callers must not wrap them in BEGIN. */
export class PlaylistStore {
	private library: Library
	private lastRemoval: LastRemoval | null = null

	constructor(private db: Database) {
		this.library = new Library(db)
	}

	private atomic<T>(action: () => T): T {
		this.db.execSync('BEGIN IMMEDIATE')
		try {
			const result = action()
			this.db.execSync('COMMIT')
			return result
		} catch (error) {
			try {
				this.db.execSync('ROLLBACK')
			} catch {
				// SQLite may already have rolled back (for example SQLITE_FULL).
				// Preserve the original write error for diagnosis.
			}
			throw error
		}
	}

	private insertPlaylist(
		id: string,
		name: string,
		now: number,
		description = '',
		coverUri: string | null = null,
	): Playlist {
		const playlist = {
			id,
			name,
			description,
			coverUri,
			createdAt: now,
			updatedAt: now,
		}
		this.db.runSync(
			'INSERT INTO playlists(id,name,createdAt,updatedAt) VALUES (?, ?, ?, ?)',
			[id, name, now, now],
		)
		if (description)
			this.db.runSync('UPDATE playlists SET description = ? WHERE id = ?', [
				description,
				id,
			])
		if (coverUri)
			this.db.runSync('UPDATE playlists SET coverUri = ? WHERE id = ?', [
				coverUri,
				id,
			])
		return playlist
	}

	create(id: string, name: string): Playlist {
		validateId(id)
		const normalized = nameFor(name)
		const created = this.atomic(() =>
			this.insertPlaylist(id, normalized, Date.now()),
		)
		this.invalidateRemoval(id)
		return created
	}

	/** Snapshot the current likes inside the same transaction as the new playlist. */
	createFromLikes(
		id: string,
		name: string,
		createItemId: () => string,
	): PlaylistDetail {
		validateId(id)
		const normalized = nameFor(name)
		const created = this.atomic(() => {
			const sources = this.library.musicLikes()
			if (!sources.length) throw new Error('还没有喜欢的音源，请先添加喜欢')
			const ids = sources.map(() => createItemId())
			validateIds(ids)
			if (this.importedItemIds(ids).size)
				throw new Error('条目身份已用于导入，不能重新创建')
			const now = Date.now(),
				playlist = this.insertPlaylist(id, normalized, now)
			const items = sources.map((source, position) => ({
				itemId: ids[position],
				playlistId: id,
				sourceId: source.id,
				position,
				addedAt: now,
				importOrigin: null,
				review: null,
			}))
			for (const item of items) this.insertItem(item)
			return { ...playlist, items }
		})
		this.invalidateRemoval(id)
		return created
	}

	get(id: string): PlaylistDetail | null {
		validateId(id)
		const playlist = this.readPlaylist(id)
		if (playlist?.items.some((item, position) => item.position !== position))
			throw new Error('歌单条目顺序无效')
		return playlist
	}

	private readPlaylist(id: string): PlaylistDetail | null {
		const row = this.db.getFirstSync<Playlist>(
			'SELECT * FROM playlists WHERE id = ?',
			[id],
		)
		if (!row) return null
		const items = this.db.getAllSync<PlaylistItemRow>(
			'SELECT * FROM playlist_items WHERE playlistId = ? ORDER BY position',
			[id],
		)
		return { ...row, items: items.map(playlistItemFromRow) }
	}

	list(): Playlist[] {
		return this.db
			.getAllSync<Playlist>(
				'SELECT * FROM playlists ORDER BY updatedAt DESC, id',
				[],
			)
			.map((row) => ({ ...row }))
	}

	/**
	 * Return one compact row per playlist instead of hydrating every occurrence
	 * (and every import metadata/review object) just to render library cards.
	 * This does not page, truncate or change the ordered detail used for playback.
	 */
	listSummaries(): PlaylistSummary[] {
		const hasImportEvidence =
			(this.db.getFirstSync<{ user_version: number }>('PRAGMA user_version', [])
				?.user_version ?? 0) >= 8
		const provider = hasImportEvidence
			? "CASE WHEN item.originJson IS NULL THEN NULL ELSE COALESCE(json_extract(item.originJson, '$.provider'), '') END"
			: 'NULL'
		type Row = Playlist & {
			count: number
			pendingCount: number
			firstSourceId: string | null
			importProvidersJson: string
		}
		return this.db
			.getAllSync<Row>(
				`SELECT playlist.*,
					COUNT(item.itemId) AS count,
					COALESCE(SUM(item.itemId IS NOT NULL AND item.sourceId IS NULL), 0) AS pendingCount,
					(SELECT sourceId FROM playlist_items
						WHERE playlistId = playlist.id AND sourceId IS NOT NULL
						ORDER BY position LIMIT 1) AS firstSourceId,
					json_group_array(DISTINCT ${provider}) AS importProvidersJson
				FROM playlists AS playlist
				LEFT JOIN playlist_items AS item ON item.playlistId = playlist.id
				GROUP BY playlist.id
				ORDER BY playlist.updatedAt DESC, playlist.id`,
				[],
			)
			.map(
				({
					count,
					pendingCount,
					firstSourceId,
					importProvidersJson,
					...playlist
				}) => {
					const providers: unknown = JSON.parse(importProvidersJson)
					if (
						!Array.isArray(providers) ||
						providers.some(
							(value: unknown) =>
								value !== null &&
								value !== 'netease' &&
								value !== 'qq' &&
								value !== 'bilibili',
						)
					)
						throw new Error('歌单导入来源无效')
					return {
						playlist,
						count,
						pendingCount,
						firstSourceId,
						importProviders: (['netease', 'qq', 'bilibili', 'kugou', 'kuwo', 'qishui'] as const).filter(
							(value) => providers.includes(value),
						),
					}
				},
			)
	}

	private requirePlaylist(id: string): PlaylistDetail {
		const playlist = this.get(id)
		if (!playlist) throw new Error('歌单不存在')
		return playlist
	}

	private touch(id: string): void {
		this.db.runSync(
			'UPDATE playlists SET updatedAt = MAX(updatedAt + 1, ?) WHERE id = ?',
			[Date.now(), id],
		)
	}

	private invalidateRemoval(id: string): void {
		if (this.lastRemoval?.before.id === id) this.lastRemoval = null
	}
	private importedItemIds(ids: string[]): Set<string> {
		const taken = new Set<string>()
		if (
			(this.db.getFirstSync<{ user_version: number }>('PRAGMA user_version', [])
				?.user_version ?? 0) < 8
		)
			return taken
		for (const id of ids)
			if (
				this.db.getFirstSync(
					'SELECT itemId FROM import_commit_entries WHERE itemId = ?',
					[id],
				)
			)
				taken.add(id)
		return taken
	}

	rename(id: string, name: string): Playlist {
		validateId(id)
		const normalized = nameFor(name)
		const renamed = this.atomic(() => {
			const playlist = this.requirePlaylist(id)
			const updated = {
				id: playlist.id,
				name: normalized,
				description: playlist.description,
				coverUri: playlist.coverUri,
				createdAt: playlist.createdAt,
				updatedAt: Math.max(Date.now(), playlist.updatedAt + 1),
			}
			this.db.runSync(
				'UPDATE playlists SET name = ?, updatedAt = ? WHERE id = ?',
				[updated.name, updated.updatedAt, id],
			)
			return updated
		})
		this.invalidateRemoval(id)
		return renamed
	}

	setDescription(id: string, description: string): Playlist {
		validateId(id)
		const normalized = description.trim()
		const updated = this.atomic(() => {
			const playlist = this.requirePlaylist(id)
			const updatedAt = Math.max(Date.now(), playlist.updatedAt + 1)
			this.db.runSync(
				'UPDATE playlists SET description = ?, updatedAt = ? WHERE id = ?',
				[normalized, updatedAt, id],
			)
			return {
				id: playlist.id,
				name: playlist.name,
				description: normalized,
				coverUri: playlist.coverUri,
				createdAt: playlist.createdAt,
				updatedAt,
			}
		})
		this.invalidateRemoval(id)
		return updated
	}

	setCoverUri(id: string, coverUri: string | null): Playlist {
		validateId(id)
		if (coverUri !== null && !coverUri.startsWith('file://'))
			throw new Error('封面必须为已保存的本地图片')
		const updated = this.atomic(() => {
			const playlist = this.requirePlaylist(id)
			const updatedAt = Math.max(Date.now(), playlist.updatedAt + 1)
			this.db.runSync(
				'UPDATE playlists SET coverUri = ?, updatedAt = ? WHERE id = ?',
				[coverUri, updatedAt, id],
			)
			return {
				id: playlist.id,
				name: playlist.name,
				description: playlist.description,
				coverUri,
				createdAt: playlist.createdAt,
				updatedAt,
			}
		})
		this.invalidateRemoval(id)
		return updated
	}

	private insertItem(item: PlaylistItem): void {
		const imported = playlistImportJson(item)
		const values = [
			item.itemId,
			item.playlistId,
			item.sourceId,
			item.position,
			item.addedAt,
		]
		if (imported)
			this.db.runSync(
				'INSERT INTO playlist_items (itemId, playlistId, sourceId, position, addedAt, importTaskId, originJson, reviewJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
				[...values, imported.taskId, imported.origin, imported.review],
			)
		else
			this.db.runSync(
				'INSERT INTO playlist_items (itemId, playlistId, sourceId, position, addedAt) VALUES (?, ?, ?, ?, ?)',
				values,
			)
	}

	append(
		id: string,
		entries: PlaylistEntry[],
		duplicatePolicy: PlaylistDuplicatePolicy,
	): PlaylistAppendResult {
		validateId(id)
		validateIds(entries.map((entry) => entry.itemId))
		if (
			duplicatePolicy !== 'keep-all' &&
			duplicatePolicy !== 'skip-existing-source'
		)
			throw new Error('请明确选择重复音源的处理方式')
		const result = this.atomic(() => {
			const playlist = this.requirePlaylist(id)
			const importedIds = this.importedItemIds(
				entries.map((entry) => entry.itemId),
			)
			const seen = new Set(playlist.items.map((item) => item.sourceId))
			const added: PlaylistItem[] = []
			const skippedItemIds: string[] = []
			const now = Date.now()
			for (const entry of entries) {
				// Library.save does not start a transaction, so metadata and entries commit together.
				this.library.saveMusic(entry.source)
				if (
					duplicatePolicy === 'skip-existing-source' &&
					seen.has(entry.source.id)
				) {
					skippedItemIds.push(entry.itemId)
					continue
				}
				if (importedIds.has(entry.itemId))
					throw new Error('条目身份已用于导入，不能重新创建')
				const item = {
					itemId: entry.itemId,
					playlistId: id,
					sourceId: entry.source.id,
					position: playlist.items.length + added.length,
					addedAt: now,
					importOrigin: null,
					review: null,
				}
				this.insertItem(item)
				added.push(item)
				seen.add(item.sourceId)
			}
			if (added.length) this.touch(id)
			return { added, skippedItemIds }
		})
		if (result.added.length) this.invalidateRemoval(id)
		return result
	}

	private replaceItems(id: string, items: PlaylistItem[]): void {
		this.db.runSync('DELETE FROM playlist_items WHERE playlistId = ?', [id])
		for (const [position, item] of items.entries())
			this.insertItem({ ...item, position })
		this.touch(id)
	}

	/** Change one occurrence, preserving its original song, order and all other copies. */
	changeSource(id: string, itemId: string, source: BiliSource, expectedUpdatedAt: number, method: 'explicit-user-replacement' | 'automatic-title-duration-match' = 'explicit-user-replacement'): PlaylistDetail {
		validateId(id)
		validateId(itemId)
		const result = this.atomic(() => {
			const playlist = this.requirePlaylist(id)
			const item = playlist.items.find(value => value.itemId === itemId)
			if (!item || playlist.updatedAt !== expectedUpdatedAt) throw new Error('歌单已变更，请重新打开歌曲后更换音源')
			this.library.save(source)
			const review: ImportReview | null = item.importOrigin ? {
				state: 'confirmed', candidates: [{ candidateId: source.id, bvid: source.bvid, cid: source.cid,
					metadata: { originalTitle: source.originalTitle, durationSeconds: source.duration }, evidence: { method } }],
				confirmation: { candidateId: source.id, sourceId: source.id },
			} : null
			const encoded = playlistImportJson({ ...item, sourceId: source.id, review })
			this.db.runSync('UPDATE playlist_items SET sourceId = ?, reviewJson = ? WHERE playlistId = ? AND itemId = ?', [source.id, encoded?.review ?? null, id, itemId])
			this.touch(id)
			return this.requirePlaylist(id)
		})
		this.invalidateRemoval(id)
		return result
	}

	remove(id: string, itemIds: string[]): PlaylistRemovalReceipt | null {
		validateId(id)
		validateIds(itemIds)
		const removal = this.atomic(() => {
			const playlist = this.requirePlaylist(id)
			const removed = new Set(itemIds)
			if (
				itemIds.some(
					(itemId) => !playlist.items.some((item) => item.itemId === itemId),
				)
			)
				throw new Error('要移除的条目不在该歌单中')
			if (!removed.size) return null
			this.replaceItems(
				id,
				playlist.items.filter((item) => !removed.has(item.itemId)),
			)
			return { before: playlist, after: this.requirePlaylist(id) }
		})
		if (!removal) return null
		const receipt = Object.freeze({}) as PlaylistRemovalReceipt
		this.lastRemoval = { receipt, ...removal }
		return receipt
	}

	undoRemove(receipt: PlaylistRemovalReceipt): PlaylistDetail {
		const removal = this.lastRemoval
		if (!removal || removal.receipt !== receipt)
			throw new PlaylistUndoExpiredError()
		let invalidated = false
		try {
			const restored = this.atomic(() => {
				const current = this.readPlaylist(removal.after.id)
				if (!current || !samePlaylist(current, removal.after)) {
					invalidated = true
					throw new PlaylistUndoExpiredError('歌单已发生更改，不能撤销本次移除')
				}
				this.replaceItems(current.id, removal.before.items)
				return this.requirePlaylist(current.id)
			})
			this.lastRemoval = null
			return restored
		} catch (error) {
			// A conflict expires the receipt; a database failure leaves a valid receipt retryable.
			if (invalidated) this.lastRemoval = null
			throw error
		}
	}

	reorder(id: string, orderedItemIds: string[]): void {
		validateId(id)
		validateIds(orderedItemIds)
		this.atomic(() => {
			const playlist = this.requirePlaylist(id)
			const items = new Map(playlist.items.map((item) => [item.itemId, item]))
			if (
				orderedItemIds.length !== items.size ||
				orderedItemIds.some((itemId) => !items.has(itemId))
			)
				throw new Error('排序必须包含歌单中的每个条目且各一次')
			this.replaceItems(
				id,
				orderedItemIds.map((itemId) => items.get(itemId)!),
			)
		})
		this.invalidateRemoval(id)
	}

	copy(
		id: string,
		newId: string,
		name: string,
		newItemIds: string[],
	): PlaylistDetail {
		validateId(id)
		validateId(newId)
		validateIds(newItemIds)
		const normalized = nameFor(name)
		const copied = this.atomic(() => {
			const original = this.requirePlaylist(id)
			if (newItemIds.length !== original.items.length)
				throw new Error('复制条目身份的数量不匹配')
			if (this.importedItemIds(newItemIds).size)
				throw new Error('条目身份已用于导入，不能重新创建副本')
			const now = Date.now()
			const playlist = this.insertPlaylist(
				newId,
				normalized,
				now,
				original.description,
				original.coverUri,
			)
			const items = original.items.map((item, position) => ({
				...item,
				itemId: newItemIds[position],
				playlistId: newId,
				addedAt: now,
			}))
			for (const item of items) this.insertItem(item)
			return { ...playlist, items }
		})
		this.invalidateRemoval(newId)
		return copied
	}

	delete(id: string): boolean {
		validateId(id)
		const deleted = this.atomic(() => {
			if (!this.get(id)) return false
			// The FK cascade only removes this playlist's items; sources and likes have no such cascade.
			this.db.runSync('DELETE FROM playlists WHERE id = ?', [id])
			return true
		})
		if (deleted) this.invalidateRemoval(id)
		return deleted
	}
}
