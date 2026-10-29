import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, migrations, type Database } from '../core/database'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import { playlistEntryId } from '../core/queue'
import { SessionStore } from '../core/sessions'

function isFull(error: unknown): boolean {
	return error instanceof Error && 'errcode' in error && error.errcode === 13
}

function open(file: string) {
	const raw = new DatabaseSync(file)
	const observed: {
		full: unknown
		rollbacks: string[]
		tablesAtFull: string[]
	} = {
		full: undefined,
		rollbacks: [],
		tablesAtFull: [],
	}
	const db: Database = {
		execSync: (sql) => {
			try {
				raw.exec(sql)
				if (sql === 'ROLLBACK') observed.rollbacks.push('completed')
			} catch (error) {
				if (isFull(error)) {
					observed.full = error
					observed.tablesAtFull = raw
						.prepare(
							"SELECT name FROM sqlite_master WHERE name IN ('creators', 'creator_subscriptions') ORDER BY name",
						)
						.all()
						.map((row) => String(row.name))
				}
				if (sql === 'ROLLBACK')
					observed.rollbacks.push(
						error instanceof Error ? error.message : String(error),
					)
				throw error
			}
		},
		runSync: (sql, values) => {
			try {
				return raw.prepare(sql).run(...values)
			} catch (error) {
				if (isFull(error)) observed.full = error
				throw error
			}
		},
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
	}
	return { db, raw, observed }
}

function withFile(run: (file: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), 'melocanvas-database-full-'))
	if (
		!resolve(dir).startsWith(resolve(tmpdir()) + sep) ||
		!basename(dir).startsWith('melocanvas-database-full-')
	)
		throw new Error('Refusing cleanup outside test root')
	try {
		run(join(dir, 'library.db'))
	} finally {
		rmSync(dir, { recursive: true })
	}
}

const source = (cid: number): Source => ({
	id: sourceId('BV1vT411i7ET', cid),
	bvid: 'BV1vT411i7ET',
	cid,
	originalTitle: `旧音源${cid}`,
	uploader: '旧上传者',
	uploaderId: 88,
	performer: null,
	artwork: 'https://example.com/old',
	duration: 300,
	domain: 'unclassified',
	audioAvailability: 'unknown',
})

const retainedTables = [
	'sources',
	'likes',
	'settings',
	'resume_points',
	'playlists',
	'playlist_items',
	'playback_sessions',
	'playback_session_items',
] as const
function columns(raw: DatabaseSync) {
	return retainedTables.map((table) => ({
		table,
		names: raw
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.map((row) => {
				assert.equal(typeof row.name, 'string')
				return String(row.name)
			}),
	}))
}
function rows(raw: DatabaseSync, retained = columns(raw)) {
	// Compare every column present at capture, without rejecting later additive columns.
	return JSON.stringify(
		retained.map(({ table, names }) =>
			raw
				.prepare(
					`SELECT ${names.map((name) => `"${name}"`).join(', ')} FROM ${table} ORDER BY rowid`,
				)
				.all(),
		),
	)
}

function pages(raw: DatabaseSync): number {
	const count = raw.prepare('PRAGMA page_count').get()?.page_count
	assert.ok(typeof count === 'number')
	return count
}

function assertOriginalFull(error: unknown, original: unknown): boolean {
	assert.ok(error instanceof Error)
	assert.equal(error.message, 'database or disk is full')
	assert.equal((error as Error & { errcode: number }).errcode, 13)
	assert.equal(error, original)
	return true
}

void test('真实文件SQLite迁移FULL保留原错误、v5完整数据与版本，重开恢复容量后重试成功', (t) => {
	withFile((file) => {
		let { db, raw, observed } = open(file)
		let before = ''
		let legacyColumns: ReturnType<typeof columns> = []
		try {
			migrate(db, migrations.slice(0, 5))
			const a = source(1),
				b = source(2)
			const library = new Library(db)
			library.setLiked(a, true)
			library.save(b)
			library.setSetting('theme', 'anime')
			const playlists = new PlaylistStore(db)
			playlists.create('p', '重复歌单')
			playlists.append(
				'p',
				[
					{ itemId: 'a1', source: a },
					{ itemId: 'b', source: b },
					{ itemId: 'a2', source: a },
				],
				'keep-all',
			)
			new SessionStore(db).saveSession({
				mode: 'music',
				entries: [
					{ entryId: playlistEntryId('a1'), sourceId: a.id },
					{ entryId: playlistEntryId('b'), sourceId: b.id },
					{ entryId: playlistEntryId('a2'), sourceId: a.id },
				],
				currentEntryId: playlistEntryId('a2'),
				currentSourceId: a.id,
				positionSeconds: 52,
				speed: 1,
				updatedAt: 101,
			})
			legacyColumns = columns(raw)
			before = rows(raw, legacyColumns)
			// Start creating v6 tables, then exhaust space in the remaining real DDL.
			raw.exec(`PRAGMA max_page_count = ${pages(raw) + 2}`)
			assert.throws(
				() => migrate(db),
				(error) => assertOriginalFull(error, observed.full),
			)
			t.diagnostic(
				`Migration FULL tables before rollback: ${observed.tablesAtFull.join(', ')}; rollback: ${observed.rollbacks.join('; ')}`,
			)
			assert.ok(observed.tablesAtFull.includes('creators'))
			assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 5)
			assert.equal(rows(raw), before)
			assert.equal(
				raw
					.prepare(
						"SELECT name FROM sqlite_master WHERE name IN ('creators', 'creator_subscriptions')",
					)
					.all().length,
				0,
			)
		} finally {
			raw.close()
		}
		;({ db, raw, observed } = open(file))
		try {
			assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 5)
			assert.equal(rows(raw), before)
			raw.exec(`PRAGMA max_page_count = ${pages(raw) + 128}`)
			migrate(db)
			assert.equal(
				raw.prepare('PRAGMA user_version').get()?.user_version,
				migrations.length,
			)
			assert.equal(rows(raw, legacyColumns), before)
			assert.deepEqual(
				{
					...raw
						.prepare('SELECT description, coverUri FROM playlists WHERE id = ?')
						.get('p'),
				},
				{ description: '', coverUri: null },
			)
			assert.equal(
				raw
					.prepare(
						"SELECT name FROM sqlite_master WHERE name IN ('creators', 'creator_subscriptions')",
					)
					.all().length,
				2,
			)
		} finally {
			raw.close()
		}
	})
})

for (const liked of [true, false]) {
	void test(`真实文件SQLite setLiked(${liked})更新大Source时FULL保留原错误和原源/喜欢，重开后可重试`, (t) => {
		withFile((file) => {
			let { db, raw, observed } = open(file)
			const a = source(1),
				b = source(2)
			const large = { ...a, originalTitle: 'x'.repeat(1024 * 1024) }
			let before = ''
			try {
				migrate(db)
				const library = new Library(db)
				library.setLiked(a, !liked)
				library.setLiked(b, true)
				before = rows(raw)
				raw.exec(`PRAGMA max_page_count = ${pages(raw)}`)
				assert.throws(
					() => library.setLiked(large, liked),
					(error) => assertOriginalFull(error, observed.full),
				)
				t.diagnostic(
					`setLiked(${liked}) FULL rollback result: ${observed.rollbacks.join('; ')}`,
				)
				assert.equal(rows(raw), before)
				assert.deepEqual({ ...library.get(a.id) }, a)
			} finally {
				raw.close()
			}
			;({ db, raw, observed } = open(file))
			try {
				migrate(db)
				assert.equal(rows(raw), before)
				raw.exec(`PRAGMA max_page_count = ${pages(raw) + 1024}`)
				const library = new Library(db)
				library.setLiked(large, liked)
				assert.deepEqual({ ...library.get(a.id) }, large)
				assert.equal(
					library.likes().some((item) => item.id === a.id),
					liked,
				)
				assert.deepEqual({ ...library.get(b.id) }, b)
				assert.ok(library.likes().some((item) => item.id === b.id))
			} finally {
				raw.close()
			}
		})
	})
}
