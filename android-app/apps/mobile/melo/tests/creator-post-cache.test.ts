import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import {
	CreatorPostCache,
	CreatorPostCacheConflictError,
	type CreatorPostCacheResponse,
} from '../core/creator-post-cache'
import { CreatorStore } from '../core/creators'
import { Library, migrate, migrations, type Database } from '../core/database'
import { ImportStore } from '../core/imports'
import { sourceId } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import { SessionStore } from '../core/sessions'
import type { CreatorPostCandidate } from '../creator-api'

function open(file = ':memory:', version: number = migrations.length) {
	const raw = new DatabaseSync(file)
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
	migrate(db, migrations.slice(0, version))
	return {
		raw,
		db,
		cache: new CreatorPostCache(db),
		library: new Library(db),
		creators: new CreatorStore(db),
	}
}
type Fixture = ReturnType<typeof open>
const item = (index: number, mid = '88'): CreatorPostCandidate => ({
	bvid: `BV${index.toString(36).padStart(10, '0')}`,
	title: `真实投稿${index}`,
	artwork: 'https://i0.hdslb.com/test.jpg',
	duration: 123,
	publishedAt: 1700000000000,
	queryCreatorMid: mid,
})
function page(index = 1, total = 31, mid = '88'): CreatorPostCacheResponse {
	return {
		page: index,
		total,
		more: index < Math.ceil(total / 30),
		items: Array.from(
			{ length: Math.max(0, Math.min(30, total - (index - 1) * 30)) },
			(_, offset) => item((index - 1) * 30 + offset, mid),
		),
	}
}
const storage = (f: Fixture) => ({
	heads: f.raw
		.prepare('SELECT * FROM creator_post_cache_heads ORDER BY cacheKey,mid')
		.all(),
	pages: f.raw
		.prepare(
			'SELECT * FROM creator_post_cache_pages ORDER BY cacheKey,mid,page',
		)
		.all(),
})
function oldRows(f: Fixture) {
	return f.db
		.getAllSync<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'creator_post_cache_%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			[],
		)
		.map(({ name }) => [
			name,
			f.raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
		])
}
function seedLegacy(f: Fixture) {
	const value = {
		id: sourceId('BV1vT411i7ET', 11),
		bvid: 'BV1vT411i7ET',
		cid: 11,
		originalTitle: '保留原标题',
		uploader: 'UP',
		uploaderId: 88,
		performer: null,
		artwork: '',
		duration: 100,
		domain: 'unclassified' as const,
		audioAvailability: 'unknown' as const,
	}
	f.library.setLiked(value, true)
	f.library.setSetting('theme', 'anime')
	const playlists = new PlaylistStore(f.db)
	playlists.create('p', 'A/A')
	playlists.append(
		'p',
		[
			{ itemId: 'a', source: value },
			{ itemId: 'a2', source: value },
		],
		'keep-all',
	)
	new SessionStore(f.db).saveSession({
		mode: 'music',
		entries: [{ entryId: value.id, sourceId: value.id }],
		currentEntryId: value.id,
		currentSourceId: value.id,
		positionSeconds: 42,
		speed: 1,
		updatedAt: 100,
	})
	f.creators.saveCreator({
		source: 'bilibili',
		mid: '88',
		name: '本地UP',
		fetchedAt: 100,
	})
	f.creators.follow({
		profileId: 'local',
		creatorMid: '88',
		scope: 'all',
		origin: 'manual',
	})
	new ImportStore(f.db).createDirectory({
		taskId: 't',
		provider: 'qq',
		originalPlaylistId: 'remote',
		taskVersion: 1,
		originalMetadata: {},
		entries: [
			{
				entryId: 'e',
				originalEntryId: 'song',
				originalPosition: 0,
				originalMetadata: { title: '待核对' },
			},
		],
	})
}

void test('v11 file upgrade/reopen preserves every old table and cache success never writes Source/profile/follow', () => {
	const folder = mkdtempSync(join(tmpdir(), 'melo-post-cache-')),
		file = join(folder, 'data.sqlite')
	let f = open(file, 11)
	try {
		seedLegacy(f)
		const before = oldRows(f)
		// This cache migration contract is v11 -> v12, not every later additive schema.
		migrate(f.db, migrations.slice(0, 12))
		assert.equal(f.raw.prepare('PRAGMA user_version').get()!.user_version, 12)
		assert.deepEqual(oldRows(f), before)
		const first = f.cache.savePage('88', page(), 1000, null)
		const last = f.cache.savePage('88', page(2), 2000, first.revision)
		assert.deepEqual(oldRows(f), before)
		f.raw.close()
		f = open(file, 12)
		assert.deepEqual(f.cache.load('88'), last)
		assert.deepEqual(oldRows(f), before)
	} finally {
		f.raw.close()
		rmSync(folder, { recursive: true, force: true })
	}
})

void test('v11 file upgrade to the current schema preserves every legacy column and cache writes leave every current non-cache table unchanged', () => {
	const folder = mkdtempSync(join(tmpdir(), 'melo-post-cache-current-')),
		file = join(folder, 'data.sqlite')
	let f = open(file, 11)
	try {
		seedLegacy(f)
		const legacy = f.db
			.getAllSync<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				[],
			)
			.map(({ name }) => {
				const names = f.raw
					.prepare(`PRAGMA table_info("${name}")`)
					.all()
					.map((column) => String(column.name))
				const query = `SELECT ${names.map((column) => `"${column}"`).join(', ')} FROM "${name}" ORDER BY rowid`
				return { query, rows: f.raw.prepare(query).all() }
			})
		migrate(f.db)
		assert.equal(
			f.raw.prepare('PRAGMA user_version').get()!.user_version,
			migrations.length,
		)
		for (const old of legacy)
			assert.deepEqual(f.raw.prepare(old.query).all(), old.rows)
		assert.deepEqual(
			{
				...f.raw
					.prepare('SELECT description, coverUri FROM playlists WHERE id = ?')
					.get('p'),
			},
			{ description: '', coverUri: null },
		)
		const current = oldRows(f)
		const first = f.cache.savePage('88', page(), 1000, null)
		const last = f.cache.savePage('88', page(2), 2000, first.revision)
		assert.deepEqual(oldRows(f), current)
		f.raw.close()
		f = open(file)
		assert.deepEqual(f.cache.load('88'), last)
		assert.deepEqual(oldRows(f), current)
		for (const old of legacy)
			assert.deepEqual(f.raw.prepare(old.query).all(), old.rows)
	} finally {
		f.raw.close()
		rmSync(folder, { recursive: true, force: true })
	}
})

void test('migration SQL failure atomically removes new schema and preserves old rows/version', () => {
	const f = open(':memory:', 11)
	try {
		seedLegacy(f)
		const before = oldRows(f)
		assert.throws(
			() =>
				migrate(f.db, [
					...migrations.slice(0, 11),
					migrations[11] + '; SELECT missing_column FROM sources;',
				]),
			/missing_column/,
		)
		assert.equal(f.raw.prepare('PRAGMA user_version').get()!.user_version, 11)
		assert.equal(
			f.raw
				.prepare(
					"SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'creator_post_cache_%'",
				)
				.get()!.n,
			0,
		)
		assert.deepEqual(oldRows(f), before)
		migrate(f.db)
		assert.equal(f.cache.load('88'), null)
	} finally {
		f.raw.close()
	}
})

void test('unread cache differs from successful empty first page and load is read-only', () => {
	const f = open()
	try {
		assert.equal(f.cache.load('88'), null)
		const empty = f.cache.savePage('88', page(1, 0), 1000, null)
		assert.deepEqual(empty, {
			mid: '88',
			revision: 1,
			pages: [{ page: 1, items: [], fetchedAt: 1000 }],
			lastPage: 1,
			more: false,
			total: 0,
			complete: true,
		})
		const before = storage(f)
		const readonly = new CreatorPostCache({
			...f.db,
			runSync: () => {
				throw new Error('unexpected write')
			},
		})
		assert.deepEqual(readonly.load('88'), empty)
		assert.deepEqual(storage(f), before)
	} finally {
		f.raw.close()
	}
})

void test('pagination preserves response order, per-page timestamps and cross-page repeated BV without inventing ownership', () => {
	const f = open()
	try {
		const firstPage = page()
		firstPage.items[0].ownerMid = '99'
		const first = f.cache.savePage('88', firstPage, 1000, null)
		const second = page(2)
		second.items[0] = { ...firstPage.items[0] }
		const result = f.cache.savePage('88', second, 2000, first.revision)
		assert.equal(result.revision, 2)
		assert.equal(result.complete, true)
		assert.equal(result.pages.flatMap((part) => part.items).length, 31)
		assert.deepEqual(
			result.pages.map((part) => part.fetchedAt),
			[1000, 2000],
		)
		assert.equal(result.pages[0].items[0].queryCreatorMid, '88')
		assert.equal(result.pages[0].items[0].ownerMid, '99')
		assert.ok(!('ownerMid' in result.pages[0].items[1]))
		assert.deepEqual(f.cache.load('88'), result)
	} finally {
		f.raw.close()
	}
})

void test('canonical large mids and fixed public query namespace stay separate; unfollow keeps cached posts', () => {
	const f = open()
	try {
		const large = '9007199254740993123456789'
		f.cache.savePage(large, page(1, 1, large), 1000, null)
		f.cache.savePage('88', page(1, 1), 2000, null)
		assert.equal(f.cache.load(large)!.pages[0].items[0].queryCreatorMid, large)
		seedLegacy(f)
		const cached = f.cache.load('88')
		f.creators.updateScope('local', '88', 'music')
		f.creators.unfollow('local', '88')
		assert.deepEqual(f.cache.load('88'), cached)
		assert.ok(f.creators.getCreator('88'))
		assert.ok(f.library.get(sourceId('BV1vT411i7ET', 11)))
		for (const mid of ['0', '088', '-1', '88\n', ' 88', '8.8', ''])
			assert.throws(() => f.cache.load(mid))
	} finally {
		f.raw.close()
	}
})

void test('two-connection CAS rejects stale writes and page-one success replaces tails in a new revision', () => {
	const folder = mkdtempSync(join(tmpdir(), 'melo-post-cache-cas-')),
		file = join(folder, 'data.sqlite')
	const a = open(file),
		b = open(file)
	try {
		a.cache.savePage('88', page(), 1000, null)
		const old = b.cache.load('88')!
		a.cache.savePage('88', page(2), 2000, old.revision)
		const before = storage(a)
		assert.throws(
			() => b.cache.savePage('88', page(1, 1), 3000, old.revision),
			CreatorPostCacheConflictError,
		)
		assert.deepEqual(storage(a), before)
		const replaced = b.cache.savePage('88', page(1, 1), 3000, 2)
		assert.equal(replaced.revision, 3)
		assert.equal(replaced.pages.length, 1)
		assert.equal(a.cache.load('88')!.pages.length, 1)
		assert.equal(a.cache.load('88')!.total, 1)
	} finally {
		a.raw.close()
		b.raw.close()
		rmSync(folder, { recursive: true, force: true })
	}
})

void test('read transaction observes one cache revision even when another connection refreshes between head/pages reads', () => {
	const folder = mkdtempSync(join(tmpdir(), 'melo-post-cache-read-')),
		file = join(folder, 'data.sqlite')
	const a = open(file),
		b = open(file)
	try {
		const first = a.cache.savePage('88', page(), 1000, null)
		const original = a.cache.savePage('88', page(2), 2000, first.revision)
		let refreshed = false
		const interleaved: Database = {
			...a.db,
			// The Database caller supplies the SQLite row shape.
			// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
			getFirstSync: <T>(sql: string, values: (string | number | null)[]) => {
				const row = a.db.getFirstSync<T>(sql, values)
				if (!refreshed && sql.includes('FROM creator_post_cache_heads')) {
					refreshed = true
					b.cache.savePage('88', page(1, 0), 3000, 2)
				}
				return row
			},
		}
		assert.deepEqual(new CreatorPostCache(interleaved).load('88'), original)
		assert.equal(a.cache.load('88')!.total, 0)
	} finally {
		a.raw.close()
		b.raw.close()
		rmSync(folder, { recursive: true, force: true })
	}
})

void test('wrong sequence/old terminal page/total drift cannot append or mix generations', () => {
	const f = open()
	try {
		assert.throws(
			() => f.cache.savePage('88', page(2), 1000, null),
			CreatorPostCacheConflictError,
		)
		f.cache.savePage('88', page(), 1000, null)
		const before = storage(f)
		for (const value of [page(3, 61), page(2, 32), page(1, 1)]) {
			assert.throws(
				() => f.cache.savePage('88', value, 2000, value.page === 1 ? null : 1),
				CreatorPostCacheConflictError,
			)
			assert.deepEqual(storage(f), before)
		}
		f.cache.savePage('88', page(2), 2000, 1)
		const terminal = storage(f)
		assert.throws(
			() => f.cache.savePage('88', page(3), 3000, 2),
			CreatorPostCacheConflictError,
		)
		assert.deepEqual(storage(f), terminal)
	} finally {
		f.raw.close()
	}
})

void test('invalid parsed candidates, timestamps and page fields preserve all old pages', () => {
	const f = open()
	try {
		f.cache.savePage('88', page(), 1000, null)
		f.cache.savePage('88', page(2), 2000, 1)
		const before = storage(f)
		const bad: CreatorPostCacheResponse[] = [
			{ ...page(1, 1), page: 0 },
			{ ...page(1, 1), total: -1 },
			{ ...page(1, 1), more: true },
			{ ...page(1, 2), items: [item(0)] },
			{ ...page(1, 2), items: [item(0), item(0)] },
			{ ...page(1, 1), items: [{ ...item(0), queryCreatorMid: '99' }] },
			{ ...page(1, 1), items: [{ ...item(0), ownerMid: '0' }] },
			{ ...page(1, 1), items: [{ ...item(0), bvid: 'invalid' }] },
			{ ...page(1, 1), items: [{ ...item(0), title: '' }] },
			{
				...page(1, 1),
				items: [{ ...item(0), artwork: 'http://example.com/pic' }],
			},
			{ ...page(1, 1), items: [{ ...item(0), duration: 1.1 }] },
			{ ...page(1, 1), items: [{ ...item(0), publishedAt: 8640000000000001 }] },
			{
				...page(1, 31),
				items: Array.from({ length: 31 }, (_, index) => item(index)),
			},
		]
		for (const value of bad) {
			assert.throws(() => f.cache.savePage('88', value, 3000, 2))
			assert.deepEqual(storage(f), before)
		}
		for (const time of [-1, 1.2, Infinity, 8640000000000001])
			assert.throws(() => f.cache.savePage('88', page(1, 1), time, 2))
		for (const revision of [0, -1, 1.2, Infinity])
			assert.throws(() => f.cache.savePage('88', page(1, 1), 3000, revision))
		assert.deepEqual(storage(f), before)
	} finally {
		f.raw.close()
	}
})

void test('corrupted cached pages/headers fail closed even on explicit page-one replacement', () => {
	for (const corruption of [
		'json',
		'gap',
		'identity',
		'more',
		'impossible-tail',
	] as const) {
		const f = open()
		try {
			f.cache.savePage('88', page(), 1000, null)
			if (corruption === 'json')
				f.raw.exec("UPDATE creator_post_cache_pages SET itemsJson='{' ")
			if (corruption === 'gap')
				f.raw.exec('UPDATE creator_post_cache_pages SET page=2')
			if (corruption === 'identity')
				f.raw
					.prepare('UPDATE creator_post_cache_pages SET itemsJson=?')
					.run(JSON.stringify(page(1, 30, '99').items))
			if (corruption === 'more')
				f.raw.exec('UPDATE creator_post_cache_heads SET more=0')
			if (corruption === 'impossible-tail') {
				f.raw.exec(
					'UPDATE creator_post_cache_heads SET total=0,more=0,lastPage=2',
				)
				f.raw.exec("UPDATE creator_post_cache_pages SET itemsJson='[]'")
				f.raw.exec(
					"INSERT INTO creator_post_cache_pages SELECT cacheKey,mid,2,fetchedAt,'[]' FROM creator_post_cache_pages",
				)
			}
			const before = storage(f)
			assert.throws(() => f.cache.load('88'), corruption)
			assert.throws(
				() => f.cache.savePage('88', page(1, 1), 2000, 1),
				corruption,
			)
			assert.deepEqual(storage(f), before)
		} finally {
			f.raw.close()
		}
	}
})

void test('valid page 201 appends beyond 6000 candidates without updating or rewriting old page JSON', (context) => {
	const f = open()
	try {
		const total = 6030
		f.cache.savePage('88', page(1, total), 1000, null)
		const key = f.raw
			.prepare('SELECT cacheKey FROM creator_post_cache_heads')
			.get()!.cacheKey
		f.raw.exec('BEGIN IMMEDIATE')
		for (let index = 2; index <= 200; index++)
			f.raw
				.prepare('INSERT INTO creator_post_cache_pages VALUES(?,?,?,?,?)')
				.run(
					key,
					'88',
					index,
					1000 + index,
					JSON.stringify(page(index, total).items),
				)
		f.raw.exec('UPDATE creator_post_cache_heads SET revision=200,lastPage=200')
		f.raw.exec('COMMIT')
		const originalJson = f.raw
			.prepare('SELECT itemsJson FROM creator_post_cache_pages WHERE page=1')
			.get()!.itemsJson
		f.raw.exec(
			"CREATE TRIGGER no_rewrite BEFORE UPDATE ON creator_post_cache_pages BEGIN SELECT RAISE(ABORT,'old page rewritten'); END; CREATE TRIGGER no_delete BEFORE DELETE ON creator_post_cache_pages BEGIN SELECT RAISE(ABORT,'old page deleted'); END",
		)
		const started = performance.now()
		const result = f.cache.savePage('88', page(201, total), 5000, 200)
		context.diagnostic(
			`201 pages / 6030 candidates append: ${Math.round(performance.now() - started)}ms; old pages not rewritten`,
		)
		assert.equal(result.lastPage, 201)
		assert.equal(result.revision, 201)
		assert.equal(result.complete, true)
		assert.equal(result.pages.flatMap((part) => part.items).length, total)
		assert.equal(
			f.raw
				.prepare('SELECT itemsJson FROM creator_post_cache_pages WHERE page=1')
				.get()!.itemsJson,
			originalJson,
		)
	} finally {
		f.raw.close()
	}
})

void test('first-page SQL replacement failure restores old tails and original COMMIT failure is retryable', () => {
	const f = open()
	try {
		f.cache.savePage('88', page(), 1000, null)
		f.cache.savePage('88', page(2), 2000, 1)
		const before = storage(f)
		f.raw.exec(
			"CREATE TRIGGER fail_page BEFORE INSERT ON creator_post_cache_pages BEGIN SELECT RAISE(ABORT,'page write failed'); END",
		)
		assert.throws(
			() => f.cache.savePage('88', page(1, 1), 3000, 2),
			/page write failed/,
		)
		assert.deepEqual(storage(f), before)
		f.raw.exec('DROP TRIGGER fail_page')
		f.raw
			.exec(`CREATE TABLE cache_parent(id INTEGER PRIMARY KEY); CREATE TABLE cache_child(id INTEGER REFERENCES cache_parent(id) DEFERRABLE INITIALLY DEFERRED);
			CREATE TRIGGER fail_commit AFTER UPDATE ON creator_post_cache_heads BEGIN INSERT INTO cache_child VALUES(99); END`)
		assert.throws(
			() => f.cache.savePage('88', page(1, 1), 3000, 2),
			/FOREIGN KEY constraint failed/,
		)
		assert.deepEqual(storage(f), before)
		assert.equal(
			f.raw.prepare('SELECT count(*) AS n FROM cache_child').get()!.n,
			0,
		)
		f.raw.exec('DROP TRIGGER fail_commit')
		assert.equal(f.cache.savePage('88', page(1, 1), 3000, 2).revision, 3)
	} finally {
		f.raw.close()
	}
})

void test('save returns its committed snapshot without reads after writes and preserves original SQLite error on rollback failure', () => {
	const f = open()
	try {
		f.cache.savePage('88', page(), 1000, null)
		let written = false
		const guarded: Database = {
			...f.db,
			runSync: (sql, values) => {
				written = true
				return f.db.runSync(sql, values)
			},
			// The Database caller supplies the SQLite row shape.
			// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
			getFirstSync: <T>(sql: string, values: (string | number | null)[]) => {
				assert.equal(written, false)
				return f.db.getFirstSync<T>(sql, values)
			},
			getAllSync: <T>(sql: string, values: (string | number | null)[]) => {
				assert.equal(written, false)
				return f.db.getAllSync<T>(sql, values)
			},
		}
		assert.equal(
			new CreatorPostCache(guarded).savePage('88', page(2), 2000, 1).revision,
			2,
		)
		const before = storage(f),
			original = new Error('original SQLite error')
		const failed: Database = {
			...f.db,
			runSync: () => {
				throw original
			},
			execSync: (sql) => {
				f.db.execSync(sql)
				if (sql === 'ROLLBACK') throw new Error('secondary rollback failure')
			},
		}
		assert.throws(
			() => new CreatorPostCache(failed).savePage('88', page(1, 1), 3000, 2),
			(error) => error === original,
		)
		assert.deepEqual(storage(f), before)
	} finally {
		f.raw.close()
	}
})

void test('future format for the same mid/query rejects downgrade while other query namespaces and mids coexist', () => {
	const f = open()
	try {
		const namespace = 'bilibili/public/emptykeyword/defaultorder/ps30/'
		const insert = (key: string, mid: string) => {
			f.raw
				.prepare('INSERT INTO creator_post_cache_heads VALUES(?,?,1,1,0,0)')
				.run(key, mid)
			f.raw
				.prepare("INSERT INTO creator_post_cache_pages VALUES(?,?,1,1000,'[]')")
				.run(key, mid)
		}
		insert(namespace + 'format2', '88')
		const future = storage(f)
		assert.throws(() => f.cache.load('88'), /格式不受支持/)
		assert.throws(
			() => f.cache.savePage('88', page(1, 0), 2000, null),
			/格式不受支持/,
		)
		assert.deepEqual(storage(f), future)
		assert.equal(f.cache.load('99'), null)
		f.cache.savePage('99', page(1, 0, '99'), 2000, null)
		insert('bilibili/public/keyword-other/defaultorder/ps30/format2', '77')
		insert('bilibili/public/emptykeyword/otherorder/ps30/format2', '77')
		insert('bilibili/public/emptykeyword/defaultorder/ps60/format2', '77')
		assert.equal(f.cache.load('77'), null)
		f.cache.savePage('77', page(1, 0, '77'), 2000, null)
		insert(namespace + 'format2', '77')
		const both = storage(f)
		assert.throws(() => f.cache.load('77'), /格式不受支持/)
		assert.throws(
			() => f.cache.savePage('77', page(1, 0, '77'), 3000, 1),
			/格式不受支持/,
		)
		assert.deepEqual(storage(f), both)
	} finally {
		f.raw.close()
	}
})
