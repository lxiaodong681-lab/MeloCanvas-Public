import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { CreatorStore } from '../core/creators'
import { Library, migrate, migrations, type Database } from '../core/database'
import { ImportStore } from '../core/imports'
import { ListeningLibrary } from '../core/listening'
import { sourceId } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import { SessionStore } from '../core/sessions'
import { VideoCatalog, videoCatalogLimits } from '../core/video-catalog'
import type { ListeningVideo } from '../listening-source'

const a = 'BV1vT411i7ET',
	b = 'BV1L7qPYBEcQ'
function video(
	bvid = a,
	cids = [11, 22],
	title = '真实视频标题',
): ListeningVideo {
	return {
		bvid,
		title,
		uploader: '原UP',
		parts: cids.map((cid, i) => ({
			page: i + 1,
			title: `原P${i + 1}`,
			source: {
				id: sourceId(bvid, cid),
				bvid,
				cid,
				originalTitle: title,
				uploader: '原UP',
				uploaderId: 88,
				performer: null,
				artwork: 'https://example.invalid/cover.jpg',
				duration: 123 + i,
				domain: 'unclassified',
				audioAvailability: 'unknown',
			},
		})),
	}
}
function open(file = ':memory:') {
	const raw = new DatabaseSync(file)
	const observed: { full: unknown; rollbackErrors: string[] } = {
		full: null,
		rollbackErrors: [],
	}
	const capture = (error: unknown) => {
		if (error instanceof Error && 'errcode' in error && error.errcode === 13)
			observed.full = error
	}
	const db: Database = {
		execSync: (sql) => {
			try {
				raw.exec(sql)
			} catch (error) {
				capture(error)
				if (sql === 'ROLLBACK' && error instanceof Error)
					observed.rollbackErrors.push(error.message)
				throw error
			}
		},
		runSync: (sql, values) => {
			try {
				return raw.prepare(sql).run(...values)
			} catch (error) {
				capture(error)
				throw error
			}
		},
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
	}
	return {
		raw,
		db,
		observed,
		library: new Library(db),
		catalog: new VideoCatalog(db),
		listening: new ListeningLibrary(db),
	}
}
function withFile(run: (file: string) => void) {
	const folder = mkdtempSync(join(tmpdir(), 'melo-video-catalog-'))
	try {
		run(join(folder, 'library.sqlite'))
	} finally {
		rmSync(folder, { recursive: true })
	}
}
function rows(raw: DatabaseSync, tables?: string[]) {
	const names =
		tables ??
		raw
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all()
			.map((row) => String(row.name))
	return JSON.stringify(
		names.map((table) => ({
			table,
			rows: raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
		})),
	)
}
function point(id: string) {
	return {
		sourceId: id,
		positionSeconds: 65,
		durationSeconds: 123,
		completed: false,
		updatedAt: 21,
	}
}

void test('v8→v9 preserves all old rows, duplicate playlist, import evidence and both sessions across reopen', () => {
	withFile((file) => {
		let f = open(file)
		let before = '',
			tables: string[] = []
		try {
			migrate(f.db, migrations.slice(0, 8))
			const [one, two] = video().parts.map((part) => part.source)
			f.library.setLiked(one, true)
			f.library.save(two)
			f.library.setSetting('theme.state.v1', '{"opaque":"unchanged"}')
			f.listening.saveResumePoint(point(two.id))
			const playlists = new PlaylistStore(f.db)
			playlists.create('old', 'A/B/A')
			playlists.append(
				'old',
				[one, two, one].map((source, i) => ({ itemId: `i${i}`, source })),
				'keep-all',
			)
			for (const mode of ['music', 'listening'] as const)
				new SessionStore(f.db).saveSession({
					mode,
					entries: [one, two].map((source) => ({
						entryId: source.id,
						sourceId: source.id,
					})),
					currentEntryId: two.id,
					currentSourceId: two.id,
					positionSeconds: 65,
					speed: mode === 'music' ? 1 : 1.5,
					updatedAt: 21,
				})
			const creators = new CreatorStore(f.db)
			creators.saveCreator({
				source: 'bilibili',
				mid: '88',
				name: '原UP',
				fetchedAt: 20,
			})
			creators.follow({
				profileId: 'local',
				creatorMid: '88',
				scope: 'all',
				origin: 'manual',
			})
			new ImportStore(f.db).createDirectory({
				taskId: 'old-task',
				taskVersion: 1,
				provider: 'bilibili',
				originalPlaylistId: '123',
				originalMetadata: { original: '证据' },
				entries: [
					{
						entryId: 'e0',
						originalEntryId: '2:11',
						originalPosition: 0,
						originalMetadata: { original: ['无BV失效项'] },
					},
				],
			})
			tables = f.raw
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
				)
				.all()
				.map((row) => String(row.name))
			before = rows(f.raw, tables)
			migrate(f.db, migrations.slice(0, 9))
			assert.equal(f.raw.prepare('PRAGMA user_version').get()?.user_version, 9)
			assert.equal(rows(f.raw, tables), before)
			assert.deepEqual(f.catalog.list(), [])
			f.catalog.save(video(), 100)
		} finally {
			f.raw.close()
		}
		f = open(file)
		try {
			migrate(f.db, migrations.slice(0, 9))
			assert.equal(rows(f.raw, tables), before)
			assert.equal(f.catalog.get(a)!.fetchedAt, 100)
			assert.deepEqual(
				f.catalog.get(a)!.parts.map((part) => part.source.cid),
				[11, 22],
			)
			assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), [])
		} finally {
			f.raw.close()
		}
	})
})

void test('separate BV headers retain all ordered CIDs and preserve user music/performer on Source refresh', () => {
	const f = open()
	try {
		migrate(f.db)
		const old = {
			...video().parts[1].source,
			domain: 'music' as const,
			performer: '用户表演者',
		}
		f.library.save(old)
		f.catalog.save(video(a, [22, 11, 33]), 40)
		f.catalog.save(video(b, [99]), 50)
		assert.deepEqual(
			f.catalog.list().map((v) => [v.bvid, v.partCount, v.fetchedAt]),
			[
				[b, 1, 50],
				[a, 3, 40],
			].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
		)
		const stored = f.catalog.get(a)!
		assert.deepEqual(
			stored.parts.map((p) => [p.page, p.source.cid]),
			[
				[1, 22],
				[2, 11],
				[3, 33],
			],
		)
		assert.equal(stored.parts[0].source.domain, 'music')
		assert.equal(stored.parts[0].source.performer, '用户表演者')
		assert.equal(stored.lastVisited, null)
		assert.equal(f.catalog.get('BV0000000000'), null)
	} finally {
		f.raw.close()
	}
})

void test('cross-BV, duplicate CID, source ID and noncontiguous/unordered pages are rejected before writes', () => {
	const f = open()
	try {
		migrate(f.db)
		f.catalog.save(video(), 1)
		const before = rows(f.raw)
		const invalid = [
			(v: ListeningVideo) => {
				v.parts[1].source = video(b).parts[1].source
			},
			(v: ListeningVideo) => {
				v.parts[1].source = { ...v.parts[0].source }
			},
			(v: ListeningVideo) => {
				v.parts[0].source.id = sourceId(a, 999)
			},
			(v: ListeningVideo) => {
				v.parts[1].page = 1
			},
			(v: ListeningVideo) => {
				v.parts.reverse()
			},
			(v: ListeningVideo) => {
				v.parts[1].page = 3
			},
			(v: ListeningVideo) => {
				v.parts[1].source.duration = Infinity
			},
			(v: ListeningVideo) => {
				v.parts[1].source.uploaderId = 99
			},
			(v: ListeningVideo) => {
				v.bvid = 'invalid'
			},
		]
		for (const change of invalid) {
			const value = video()
			change(value)
			assert.throws(() => f.catalog.save(value, 2))
			assert.equal(rows(f.raw), before)
		}
		assert.throws(() => f.catalog.save(video(), -1))
		assert.equal(rows(f.raw), before)
	} finally {
		f.raw.close()
	}
})

void test('finite count, per-part and total byte limits refuse oversized metadata without writes', () => {
	const f = open()
	try {
		migrate(f.db)
		const before = rows(f.raw)
		const tooMany = video(
			a,
			Array.from({ length: videoCatalogLimits.parts + 1 }, (_, i) => i + 1),
		)
		const bigPart = video()
		bigPart.parts[1].title = '字'.repeat(6000)
		const total = video(
			a,
			Array.from({ length: 1000 }, (_, i) => i + 1),
		)
		for (const part of total.parts) part.title = 'x'.repeat(9000)
		for (const value of [tooMany, bigPart, total, { ...video(), parts: [] }]) {
			assert.throws(() => f.catalog.save(value, 1))
			assert.equal(rows(f.raw), before)
		}
	} finally {
		f.raw.close()
	}
})

void test('refresh removing visited CID keeps historical Source/resume and pointer, never selects new first P', () => {
	withFile((file) => {
		let f = open(file)
		const oldId = sourceId(a, 22)
		try {
			migrate(f.db)
			f.catalog.save(video(), 100)
			f.catalog.recordVisitedPart(a, oldId)
			f.listening.saveResumePoint(point(oldId))
			f.catalog.save(video(a, [33, 11], '刷新原标题'), 200)
			assert.deepEqual(f.catalog.get(a)!.lastVisited, {
				sourceId: oldId,
				inCurrentParts: false,
			})
			assert.equal(f.catalog.get(a)!.fetchedAt, 200)
			assert.equal(f.library.get(oldId)!.originalTitle, '真实视频标题')
			assert.deepEqual(f.listening.getResumePoint(oldId), point(oldId))
			f.catalog.recordVisitedPart(a, sourceId(a, 11))
			assert.equal(f.catalog.get(a)!.fetchedAt, 200)
			f.catalog.recordVisitedPart(a, oldId)
			assert.deepEqual(f.catalog.list()[0].lastVisited, {
				sourceId: oldId,
				inCurrentParts: false,
			})
		} finally {
			f.raw.close()
		}
		f = open(file)
		try {
			assert.deepEqual(f.catalog.get(a)!.lastVisited, {
				sourceId: oldId,
				inCurrentParts: false,
			})
			assert.deepEqual(f.listening.getResumePoint(oldId), point(oldId))
			f.catalog.save(video(a, [22, 11]), 300)
			assert.deepEqual(f.catalog.get(a)!.lastVisited, {
				sourceId: oldId,
				inCurrentParts: true,
			})
		} finally {
			f.raw.close()
		}
	})
})

void test('visited pointer rejects cross-BV, unknown Source and unknown video without changing records', () => {
	const f = open()
	try {
		migrate(f.db)
		f.catalog.save(video(), 2)
		f.library.save(video(b).parts[0].source)
		const before = rows(f.raw)
		for (const [bv, id] of [
			[a, sourceId(b, 11)],
			[a, sourceId(a, 999)],
			[b, sourceId(b, 11)],
			[a, 'bad'],
		]) {
			assert.throws(() => f.catalog.recordVisitedPart(bv, id))
			assert.equal(rows(f.raw), before)
		}
	} finally {
		f.raw.close()
	}
})

void test('existing uploader identity conflict rolls back Source updates and preserves consistent video head', () => {
	const f = open()
	try {
		migrate(f.db)
		f.catalog.save(video(), 1)
		const before = rows(f.raw)
		const changed = video(a, [11, 22], '新标题')
		for (const part of changed.parts) part.source.uploaderId = 99
		assert.throws(() => f.catalog.save(changed, 2), /UP 身份/)
		assert.equal(rows(f.raw), before)
		assert.equal(f.catalog.get(a)!.uploaderId, 88)
		const newVideo = video(a, [33, 22], '新标题')
		f.raw.exec('UPDATE sources SET uploaderId=99 WHERE cid=22')
		const inconsistentBefore = rows(f.raw)
		assert.throws(() => f.catalog.save(newVideo, 3), /UP 身份/)
		assert.equal(f.library.get(sourceId(a, 33)), null)
		assert.equal(rows(f.raw), inconsistentBefore)
	} finally {
		f.raw.close()
	}
})

void test('real SQL interruption after header/Source writes and part deletion restores complete old snapshot', () => {
	const f = open()
	try {
		migrate(f.db)
		f.catalog.save(video(), 1)
		f.catalog.recordVisitedPart(a, sourceId(a, 22))
		const before = rows(f.raw)
		f.raw.exec(
			"CREATE TEMP TRIGGER stop_parts BEFORE INSERT ON video_catalog_parts WHEN NEW.page=2 BEGIN SELECT RAISE(ABORT, 'interrupted second part'); END",
		)
		assert.throws(
			() => f.catalog.save(video(a, [33, 44], '新标题'), 2),
			/interrupted second part/,
		)
		assert.equal(rows(f.raw), before)
		f.raw.exec('DROP TRIGGER stop_parts')
		f.catalog.save(video(a, [33, 44]), 3)
		assert.deepEqual(
			f.catalog.get(a)!.parts.map((part) => part.source.cid),
			[33, 44],
		)
	} finally {
		f.raw.close()
	}
})

void test('real deferred foreign-key COMMIT failure rolls back catalog and Source updates', () => {
	const f = open()
	try {
		migrate(f.db)
		f.catalog.save(video(), 1)
		f.raw.exec(
			'CREATE TABLE deferred_probe(id TEXT REFERENCES sources(id) DEFERRABLE INITIALLY DEFERRED)',
		)
		const before = rows(f.raw)
		f.raw.exec(
			"CREATE TEMP TRIGGER fail_commit AFTER INSERT ON video_catalog_parts BEGIN INSERT INTO deferred_probe VALUES ('missing'); END",
		)
		assert.throws(
			() => f.catalog.save(video(a, [33, 44]), 2),
			(error: unknown) =>
				error instanceof Error && 'errcode' in error && error.errcode === 787,
		)
		assert.equal(rows(f.raw), before)
		f.raw.exec('DROP TRIGGER fail_commit')
		f.catalog.save(video(a, [33, 44]), 3)
	} finally {
		f.raw.close()
	}
})

void test('real file SQLITE_FULL automatic rollback preserves original errcode, old rows and reopening retry', (context) => {
	withFile((file) => {
		let f = open(file)
		let before = ''
		const large = video(a, [33, 44], '更新视频')
		for (const part of large.parts) part.title = 'x'.repeat(8000)
		try {
			migrate(f.db)
			f.catalog.save(video(), 1)
			f.catalog.recordVisitedPart(a, sourceId(a, 22))
			f.listening.saveResumePoint(point(sourceId(a, 22)))
			before = rows(f.raw)
			// Table-rebuilding migrations can leave reusable pages. Exhaust actual
			// file capacity rather than letting the fixture fit in that free space.
			f.raw.exec('VACUUM')
			const pages = f.raw.prepare('PRAGMA page_count').get()?.page_count
			assert.ok(typeof pages === 'number')
			f.raw.exec(`PRAGMA max_page_count=${pages}`)
			assert.throws(
				() => f.catalog.save(large, 2),
				(error: unknown) => {
					assert.equal(error, f.observed.full)
					assert.ok(error instanceof Error && 'errcode' in error)
					assert.equal(error.errcode, 13)
					assert.equal(error.message, 'database or disk is full')
					return true
				},
			)
			assert.equal(rows(f.raw), before)
			assert.ok(
				f.observed.rollbackErrors.includes(
					'cannot rollback - no transaction is active',
				),
			)
			context.diagnostic(
				`Real FULL rollback: ${f.observed.rollbackErrors.join('; ')}`,
			)
		} finally {
			f.raw.close()
		}
		f = open(file)
		try {
			assert.equal(rows(f.raw), before)
			f.raw.exec('PRAGMA max_page_count=100000')
			f.catalog.save(large, 3)
			assert.deepEqual(
				f.catalog.get(a)!.parts.map((part) => part.source.cid),
				[33, 44],
			)
			assert.deepEqual(
				f.listening.getResumePoint(sourceId(a, 22)),
				point(sourceId(a, 22)),
			)
		} finally {
			f.raw.close()
		}
	})
})
