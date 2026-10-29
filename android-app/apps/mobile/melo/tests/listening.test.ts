import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, migrations, type Database } from '../core/database'
import { ListeningLibrary, type ResumePoint } from '../core/listening'
import { sourceId, type Source } from '../core/model'
import { playlistEntryId } from '../core/queue'
import { SessionStore, type PlaybackSession } from '../core/sessions'

function open(file = ':memory:') {
	const raw = new DatabaseSync(file)
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
	return { db, raw }
}

const part1: Source = {
	id: sourceId('BV1vT411i7ET', 123),
	bvid: 'BV1vT411i7ET',
	cid: 123,
	originalTitle: '原视频 P1',
	uploader: '上传者',
	uploaderId: 88,
	performer: null,
	artwork: 'https://i0.hdslb.com/example.jpg',
	duration: 310,
	domain: 'unclassified',
	audioAvailability: 'unknown',
}
const part2: Source = {
	...part1,
	id: sourceId(part1.bvid, 456),
	cid: 456,
	originalTitle: '原视频 P2',
	duration: 600,
}
const point: ResumePoint = {
	sourceId: part1.id,
	positionSeconds: 23.75,
	durationSeconds: 310,
	completed: false,
	updatedAt: 100,
}
const session: PlaybackSession = {
	mode: 'music',
	entries: [part1.id, part2.id].map((id) => ({ entryId: id, sourceId: id })),
	currentEntryId: part1.id,
	currentSourceId: part1.id,
	positionSeconds: 23.75,
	speed: 1,
	updatedAt: 100,
}

function seed(db: Database): void {
	const library = new Library(db)
	library.save(part1)
	library.save(part2)
}

function withFile(run: (file: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'melocanvas-listening-'))
	if (
		!resolve(dir).startsWith(resolve(tmpdir()) + sep) ||
		!basename(dir).startsWith('melocanvas-listening-')
	)
		throw new Error('Refusing to remove a directory outside the test root')
	try {
		run(join(dir, 'library.db'))
	} finally {
		rmSync(dir, { recursive: true })
	}
}

for (const version of [1, 2]) {
	void test(`真实 SQLite v${version} 追加迁移和重开保留来源、喜欢、设置与两种快照`, () => {
		withFile((file) => {
			let { db, raw } = open(file)
			try {
				migrate(db, migrations.slice(0, version))
				const library = new Library(db)
				library.setLiked(part1, true)
				library.setSetting('theme', 'pastoral')
				migrate(db)
				seed(db)
				new ListeningLibrary(db).saveResumePoint(point)
				const sessions = new SessionStore(db)
				sessions.saveSession(session)
				sessions.saveSession({
					...session,
					mode: 'listening',
					currentEntryId: part2.id,
					currentSourceId: part2.id,
					positionSeconds: 88,
					speed: 1.5,
				})
			} finally {
				raw.close()
			}
			;({ db, raw } = open(file))
			try {
				migrate(db)
				const library = new Library(db)
				assert.deepEqual(
					library.likes().map((source) => ({ ...source })),
					[part1],
				)
				assert.equal(library.setting('theme'), 'pastoral')
				assert.deepEqual({ ...library.get(part2.id) }, part2)
				assert.deepEqual(
					new ListeningLibrary(db).getResumePoint(part1.id),
					point,
				)
				assert.deepEqual(new SessionStore(db).getSession('music'), session)
				assert.deepEqual(new SessionStore(db).getSession('listening'), {
					...session,
					mode: 'listening',
					currentEntryId: part2.id,
					currentSourceId: part2.id,
					positionSeconds: 88,
					speed: 1.5,
				})
				assert.equal(
					db.getFirstSync<{ user_version: number }>('PRAGMA user_version', [])
						?.user_version,
					migrations.length,
				)
			} finally {
				raw.close()
			}
		})
	})
}

void test('v2→v3 中途失败重开仍为 v2，收藏设置不变且可重试迁移', () => {
	withFile((file) => {
		let { db, raw } = open(file)
		try {
			migrate(db, migrations.slice(0, 2))
			new Library(db).setLiked(part1, true)
			new Library(db).setSetting('theme', 'anime')
			assert.throws(() =>
				migrate(db, [
					...migrations.slice(0, 2),
					`${migrations[2]} INSERT INTO missing_table VALUES (1);`,
				]),
			)
		} finally {
			raw.close()
		}
		;({ db, raw } = open(file))
		try {
			assert.equal(
				db.getFirstSync<{ user_version: number }>('PRAGMA user_version', [])
					?.user_version,
				2,
			)
			assert.equal(
				db.getFirstSync(
					"SELECT name FROM sqlite_master WHERE name = 'resume_points'",
					[],
				),
				null,
			)
			assert.equal(
				db.getFirstSync(
					"SELECT name FROM sqlite_master WHERE name = 'playback_sessions'",
					[],
				),
				null,
			)
			assert.deepEqual(
				new Library(db).likes().map((source) => ({ ...source })),
				[part1],
			)
			assert.equal(new Library(db).setting('theme'), 'anime')
			migrate(db)
			new ListeningLibrary(db).saveResumePoint(point)
			assert.deepEqual(new ListeningLibrary(db).getResumePoint(part1.id), point)
		} finally {
			raw.close()
		}
	})
})

void test('同 BV 两个 CID 的断点独立，完成标记及未知时长原样保存', () => {
	const { db, raw } = open()
	try {
		migrate(db)
		seed(db)
		const library = new ListeningLibrary(db)
		assert.equal(library.getResumePoint(part1.id), null)
		assert.deepEqual(library.listResumePoints(), [])
		library.saveResumePoint(point)
		const second = {
			...point,
			sourceId: part2.id,
			positionSeconds: 600,
			durationSeconds: 600,
			completed: true,
			updatedAt: 200,
		}
		library.saveResumePoint(second)
		assert.deepEqual(library.listResumePoints(), [second, point])
		const unknown = {
			...point,
			durationSeconds: 0,
			positionSeconds: 50,
			updatedAt: 300,
		}
		library.saveResumePoint(unknown)
		assert.deepEqual(library.getResumePoint(part1.id), unknown)
		assert.deepEqual(library.getResumePoint(part2.id), second)
		assert.equal(new Library(db).get(part1.id)?.domain, 'unclassified')
		assert.deepEqual(new Library(db).likes(), [])
	} finally {
		raw.close()
	}
})

void test('断点拒绝无效身份、负数、非有限值、越界与无效时间，旧值不变', () => {
	const { db, raw } = open()
	try {
		migrate(db)
		seed(db)
		const library = new ListeningLibrary(db)
		library.saveResumePoint(point)
		for (const invalid of [
			{ sourceId: '' },
			{ sourceId: 'https://cdn.test/audio?signature=secret' },
			{ sourceId: sourceId(part1.bvid, Number.MAX_SAFE_INTEGER + 1) },
			{ positionSeconds: -1 },
			{ positionSeconds: NaN },
			{ positionSeconds: Infinity },
			{ durationSeconds: -1 },
			{ durationSeconds: Infinity },
			{ positionSeconds: 311 },
			{ updatedAt: -1 },
			{ updatedAt: 0.5 },
			{ updatedAt: NaN },
			{ completed: 1 },
		]) {
			assert.throws(() =>
				library.saveResumePoint({ ...point, ...invalid } as ResumePoint),
			)
			assert.deepEqual(library.getResumePoint(part1.id), point)
		}
		assert.throws(
			() =>
				library.saveResumePoint({
					...point,
					sourceId: sourceId(part1.bvid, 999),
				}),
			/FOREIGN KEY/,
		)
		assert.equal(library.listResumePoints().length, 1)
		db.execSync(
			"CREATE TRIGGER fail_resume BEFORE UPDATE ON resume_points BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
		)
		assert.throws(
			() => library.saveResumePoint({ ...point, positionSeconds: 40 }),
			/disk failure/,
		)
		assert.deepEqual(library.getResumePoint(part1.id), point)
	} finally {
		raw.close()
	}
})

void test('双队列顺序、当前位置、速度独立；清空一边保留另一边与断点', () => {
	const { db, raw } = open()
	try {
		migrate(db)
		seed(db)
		const store = new SessionStore(db)
		assert.equal(store.getSession('music'), null)
		assert.equal(store.getSession('listening'), null)
		new ListeningLibrary(db).saveResumePoint(point)
		store.saveSession(session)
		const listening: PlaybackSession = {
			...session,
			mode: 'listening',
			entries: [part2.id, part1.id].map((id) => ({
				entryId: id,
				sourceId: id,
			})),
			currentEntryId: part2.id,
			currentSourceId: part2.id,
			speed: 2,
			positionSeconds: 80,
		}
		store.saveSession(listening)
		assert.deepEqual(store.getSession('music'), session)
		assert.deepEqual(store.getSession('listening'), listening)
		const empty: PlaybackSession = {
			...session,
			entries: [].map((id) => ({ entryId: id, sourceId: id })),
			currentEntryId: null,
			currentSourceId: null,
			positionSeconds: 0,
		}
		store.saveSession(empty)
		assert.deepEqual(store.getSession('music'), empty)
		assert.deepEqual(store.getSession('listening'), listening)
		assert.deepEqual(new ListeningLibrary(db).getResumePoint(part1.id), point)
	} finally {
		raw.close()
	}
})

void test('队列拒绝重复、坏值及队列外当前项，旧快照不变', () => {
	const { db, raw } = open()
	try {
		migrate(db)
		seed(db)
		const store = new SessionStore(db)
		store.saveSession(session)
		for (const invalid of [
			{ mode: 'video' },
			{
				entries: [part1.id, part1.id].map((id) => ({
					entryId: id,
					sourceId: id,
				})),
			},
			{ entries: [{ entryId: 'signed-url', sourceId: 'signed-url' }] },
			{ entries: [] },
			{ currentSourceId: sourceId(part1.bvid, 999) },
			{ currentSourceId: null },
			{ positionSeconds: -1 },
			{ positionSeconds: NaN },
			{ speed: 0 },
			{ speed: 3.1 },
			{ speed: Infinity },
			{ speed: NaN },
			{ updatedAt: -1 },
			{ updatedAt: 0.5 },
		]) {
			assert.throws(() =>
				store.saveSession({ ...session, ...invalid } as PlaybackSession),
			)
			assert.deepEqual(store.getSession('music'), session)
		}
		store.saveSession({
			...session,
			currentEntryId: null,
			currentSourceId: null,
			positionSeconds: 0,
			speed: 0.1,
		})
		assert.equal(store.getSession('music')?.speed, 0.1)
		store.saveSession({ ...session, speed: 3 })
		assert.equal(store.getSession('music')?.speed, 3)
	} finally {
		raw.close()
	}
})

void test('队列后项无效引用及中途磁盘错误回滚头、删除和全部队列项', () => {
	const { db, raw } = open()
	try {
		migrate(db)
		seed(db)
		const store = new SessionStore(db)
		store.saveSession(session)
		const listening: PlaybackSession = {
			...session,
			mode: 'listening',
			speed: 1.5,
		}
		store.saveSession(listening)
		assert.throws(
			() =>
				store.saveSession({
					...session,
					entries: [part2.id, sourceId(part1.bvid, 999)].map((id) => ({
						entryId: id,
						sourceId: id,
					})),
					currentEntryId: part2.id,
					currentSourceId: part2.id,
					speed: 2,
				}),
			/FOREIGN KEY/,
		)
		assert.deepEqual(store.getSession('music'), session)
		assert.deepEqual(store.getSession('listening'), listening)
		db.execSync(
			"CREATE TRIGGER fail_second_item BEFORE INSERT ON playback_session_items WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
		)
		assert.throws(
			() =>
				store.saveSession({
					...session,
					entries: [part2.id, part1.id].map((id) => ({
						entryId: id,
						sourceId: id,
					})),
					currentEntryId: part2.id,
					currentSourceId: part2.id,
					positionSeconds: 99,
					speed: 2,
				}),
			/disk failure/,
		)
		assert.deepEqual(store.getSession('music'), session)
		assert.deepEqual(store.getSession('listening'), listening)
	} finally {
		raw.close()
	}
})

void test('损坏的本地位置或当前项不能作为可恢复状态返回', () => {
	const { db, raw } = open()
	try {
		migrate(db)
		seed(db)
		const library = new ListeningLibrary(db)
		library.saveResumePoint(point)
		const store = new SessionStore(db)
		store.saveSession(session)
		db.execSync(
			'PRAGMA ignore_check_constraints = ON; UPDATE resume_points SET completed = 2;',
		)
		assert.throws(() => library.getResumePoint(part1.id), /续听记录无效/)
		assert.throws(() => library.listResumePoints(), /续听记录无效/)
		db.runSync('DELETE FROM playback_session_items WHERE sourceId = ?', [
			part1.id,
		])
		assert.throws(() => store.getSession('music'), /当前项与/)
	} finally {
		raw.close()
	}
})

for (const version of [3, 4]) {
	void test(`真实SQLite v${version}→v5保留双队列和Source外键，重复项重开仍指向第二个A`, () => {
		withFile((file) => {
			let { db, raw } = open(file)
			let playlistRows: string | null = null
			try {
				migrate(db, migrations.slice(0, version))
				seed(db)
				new Library(db).setLiked(part1, true)
				new ListeningLibrary(db).saveResumePoint(point)
				if (version === 4) {
					db.runSync('INSERT INTO playlists VALUES (?, ?, ?, ?)', [
						'old-list',
						'旧歌单',
						100,
						100,
					])
					for (const [position, source] of [part1, part2, part1].entries())
						db.runSync('INSERT INTO playlist_items VALUES (?, ?, ?, ?, ?)', [
							`old-${position}`,
							'old-list',
							source.id,
							position,
							100,
						])
					playlistRows = JSON.stringify(
						raw.prepare('SELECT * FROM playlist_items ORDER BY position').all(),
					)
				}
				for (const mode of ['music', 'listening']) {
					db.runSync('INSERT INTO playback_sessions VALUES (?, ?, ?, ?, ?)', [
						mode,
						part2.id,
						66,
						1,
						100,
					])
					for (const [ordinal, source] of [part1, part2].entries())
						db.runSync('INSERT INTO playback_session_items VALUES (?, ?, ?)', [
							mode,
							ordinal,
							source.id,
						])
				}
				migrate(db, migrations.slice(0, 5))
				for (const mode of ['music', 'listening'] as const) {
					const saved = new SessionStore(db).getSession(mode)!
					assert.equal(saved.currentEntryId, part2.id)
					assert.equal(saved.currentSourceId, part2.id)
					assert.equal(saved.positionSeconds, 66)
					assert.deepEqual(
						saved.entries,
						[part1, part2].map((source) => ({
							entryId: source.id,
							sourceId: source.id,
						})),
					)
				}
				new SessionStore(db).saveSession({
					...session,
					entries: [
						{ entryId: playlistEntryId('a1'), sourceId: part1.id },
						{ entryId: playlistEntryId('b'), sourceId: part2.id },
						{ entryId: playlistEntryId('a2'), sourceId: part1.id },
					],
					currentEntryId: playlistEntryId('a2'),
				})
			} finally {
				raw.close()
			}
			;({ db, raw } = open(file))
			try {
				migrate(db, migrations.slice(0, 5))
				const saved = new SessionStore(db).getSession('music')!
				assert.equal(saved.currentEntryId, playlistEntryId('a2'))
				assert.equal(saved.currentSourceId, part1.id)
				assert.equal(saved.entries.length, 3)
				assert.deepEqual(
					new ListeningLibrary(db).getResumePoint(part1.id),
					point,
				)
				assert.equal(new Library(db).likes().length, 1)
				if (playlistRows !== null)
					assert.equal(
						JSON.stringify(
							raw
								.prepare('SELECT * FROM playlist_items ORDER BY position')
								.all(),
						),
						playlistRows,
					)
				assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), [])
				assert.throws(
					() =>
						new SessionStore(db).saveSession({
							...saved,
							entries: [
								...saved.entries,
								{
									entryId: playlistEntryId('absent'),
									sourceId: sourceId(part1.bvid, 999),
								},
							],
						}),
					/FOREIGN KEY/,
				)
				assert.deepEqual(new SessionStore(db).getSession('music'), saved)
			} finally {
				raw.close()
			}
		})
	})
}

void test('v5迁移中途失败完整回滚v4结构和旧游标，重试可用', () => {
	const { db, raw } = open()
	try {
		migrate(db, migrations.slice(0, 4))
		seed(db)
		db.runSync('INSERT INTO playback_sessions VALUES (?, ?, ?, ?, ?)', [
			'music',
			part1.id,
			22,
			1,
			100,
		])
		db.runSync('INSERT INTO playback_session_items VALUES (?, ?, ?)', [
			'music',
			0,
			part1.id,
		])
		const before = raw.prepare('SELECT * FROM playback_sessions').all()
		assert.throws(
			() =>
				migrate({
					...db,
					execSync: (sql) => {
						db.execSync(sql)
						if (sql.includes('playback_session_items_v5'))
							throw new Error('migration disk failure')
					},
				}),
			/migration disk failure/,
		)
		assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 4)
		assert.deepEqual(
			raw.prepare('SELECT * FROM playback_sessions').all(),
			before,
		)
		assert.equal(
			raw
				.prepare(
					"SELECT name FROM sqlite_master WHERE name='playback_session_items_v5'",
				)
				.get(),
			undefined,
		)
		migrate(db)
		assert.equal(
			new SessionStore(db).getSession('music')?.currentEntryId,
			part1.id,
		)
	} finally {
		raw.close()
	}
})
