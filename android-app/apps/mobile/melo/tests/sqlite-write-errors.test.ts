import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, type Database } from '../core/database'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore, PlaylistUndoExpiredError } from '../core/playlists'
import { playlistEntryId } from '../core/queue'
import { SessionStore, type PlaybackSession } from '../core/sessions'

function open(file: string) {
	const raw = new DatabaseSync(file)
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
	migrate(db)
	return { raw, db }
}

function withFile(run: (file: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), 'melocanvas-write-errors-'))
	if (
		!resolve(dir).startsWith(resolve(tmpdir()) + sep) ||
		!basename(dir).startsWith('melocanvas-write-errors-')
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
	originalTitle: `原稿${cid}`,
	uploader: 'UP',
	uploaderId: 88,
	performer: null,
	artwork: '',
	duration: 300,
	domain: 'unclassified',
	audioAvailability: 'unknown',
})
const a = source(1),
	b = source(2)

function seed(db: Database) {
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
	const session: PlaybackSession = {
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
		updatedAt: 100,
	}
	const sessions = new SessionStore(db)
	sessions.saveSession(session)
	sessions.saveSession({
		mode: 'listening',
		entries: [{ entryId: b.id, sourceId: b.id }],
		currentEntryId: b.id,
		currentSourceId: b.id,
		positionSeconds: 99,
		speed: 1.5,
		updatedAt: 101,
	})
	new Library(db).setLiked(a, true)
	return { playlists, sessions }
}

function limitPages(raw: DatabaseSync) {
	const count = raw.prepare('PRAGMA page_count').get()?.page_count
	assert.ok(typeof count === 'number')
	raw.exec(`PRAGMA max_page_count = ${count}`)
}

function full(action: () => unknown) {
	assert.throws(action, (error: unknown) => {
		assert.ok(error instanceof Error)
		assert.match(error.message, /database or disk is full/)
		assert.equal((error as Error & { errcode: number }).errcode, 13)
		return true
	})
}

// Remove normally frees space. A test-only trigger exercises real SQLite allocation
// inside its DELETE/INSERT statement, without synthesizing or replacing the SQL error.
function pressure(raw: DatabaseSync, operation: 'DELETE' | 'INSERT') {
	raw.exec(`CREATE TABLE pressure (payload BLOB);
        CREATE TRIGGER write_pressure BEFORE ${operation} ON playlist_items BEGIN
            INSERT INTO pressure VALUES (zeroblob(1048576));
        END;`)
	limitPages(raw)
}

function releasePressure(raw: DatabaseSync) {
	raw.exec(
		'DROP TRIGGER write_pressure; DROP TABLE pressure; PRAGMA max_page_count = 1073741823;',
	)
}

void test('真实SQLite FULL自动回滚playlist改名，保留完整歌单和既有移除凭证', () => {
	withFile((file) => {
		const { db, raw } = open(file)
		try {
			const { playlists } = seed(db)
			const original = playlists.get('p')
			const receipt = playlists.remove('p', ['a2'])
			assert.ok(receipt)
			const before = playlists.get('p')
			limitPages(raw)
			full(() => playlists.rename('p', 'x'.repeat(1048576)))
			assert.deepEqual(playlists.get('p'), before)
			raw.exec('PRAGMA max_page_count = 1073741823')
			assert.deepEqual(playlists.undoRemove(receipt).items, original?.items)
		} finally {
			raw.close()
		}
	})
})

void test('真实SQLite FULL使新remove失败，保留完整歌单与旧撤销凭证，恢复后可撤销并重开', () => {
	withFile((file) => {
		let { db, raw } = open(file)
		let restored: ReturnType<PlaylistStore['get']> = null
		try {
			const { playlists, sessions } = seed(db)
			const before = playlists.get('p'),
				music = sessions.getSession('music'),
				listening = sessions.getSession('listening')
			const receipt = playlists.remove('p', ['a2'])
			assert.ok(receipt)
			const after = playlists.get('p')
			pressure(raw, 'DELETE')
			full(() => playlists.remove('p', ['a1']))
			assert.deepEqual(playlists.get('p'), after)
			assert.deepEqual(sessions.getSession('music'), music)
			assert.deepEqual(sessions.getSession('listening'), listening)
			assert.equal(
				raw.prepare('SELECT count(*) AS count FROM pressure').get()?.count,
				0,
			)
			releasePressure(raw)
			restored = playlists.undoRemove(receipt)
			assert.deepEqual(restored.items, before?.items)
			assert.equal(restored.name, before?.name)
			assert.equal(restored.createdAt, before?.createdAt)
		} finally {
			raw.close()
		}
		;({ db, raw } = open(file))
		try {
			const playlists = new PlaylistStore(db)
			assert.deepEqual(playlists.get('p'), restored)
			playlists.rename('p', '恢复后可写')
			assert.equal(playlists.get('p')?.name, '恢复后可写')
		} finally {
			raw.close()
		}
	})
})

void test('真实SQLite FULL使undo部分恢复回滚，保留同一凭证供重试且不改变其他域', () => {
	withFile((file) => {
		let { db, raw } = open(file)
		let expected: ReturnType<PlaylistStore['get']> = null
		try {
			const { playlists, sessions } = seed(db)
			const before = playlists.get('p'),
				music = sessions.getSession('music'),
				listening = sessions.getSession('listening')
			const receipt = playlists.remove('p', ['a1', 'a2'])
			assert.ok(receipt)
			const after = playlists.get('p')
			pressure(raw, 'INSERT')
			full(() => playlists.undoRemove(receipt))
			assert.deepEqual(playlists.get('p'), after)
			assert.deepEqual(sessions.getSession('music'), music)
			assert.deepEqual(sessions.getSession('listening'), listening)
			assert.equal(new Library(db).likes().length, 1)
			releasePressure(raw)
			expected = playlists.undoRemove(receipt)
			assert.deepEqual(expected.items, before?.items)
			assert.throws(
				() => playlists.undoRemove(receipt),
				PlaylistUndoExpiredError,
			)
		} finally {
			raw.close()
		}
		;({ db, raw } = open(file))
		try {
			assert.deepEqual(new PlaylistStore(db).get('p'), expected)
		} finally {
			raw.close()
		}
	})
})

void test('真实SQLite FULL回滚session头/清队列/条目，精确第三项游标与其他域保留且恢复可写', () => {
	withFile((file) => {
		let { db, raw } = open(file)
		let expected: PlaybackSession | null = null
		try {
			const { playlists, sessions } = seed(db)
			const before = sessions.getSession('music'),
				listening = sessions.getSession('listening'),
				playlist = playlists.get('p')
			assert.ok(before)
			const oversized = playlistEntryId('x'.repeat(1048576))
			limitPages(raw)
			full(() =>
				sessions.saveSession({
					...before,
					entries: [
						{ entryId: playlistEntryId('first-new'), sourceId: b.id },
						{ entryId: oversized, sourceId: a.id },
					],
					currentEntryId: playlistEntryId('first-new'),
					currentSourceId: b.id,
					positionSeconds: 7,
					updatedAt: 200,
				}),
			)
			assert.deepEqual(sessions.getSession('music'), before)
			assert.deepEqual(sessions.getSession('listening'), listening)
			assert.deepEqual(playlists.get('p'), playlist)
			raw.exec('PRAGMA max_page_count = 1073741823')
			expected = { ...before, positionSeconds: 53, updatedAt: 201 }
			sessions.saveSession(expected)
		} finally {
			raw.close()
		}
		;({ db, raw } = open(file))
		try {
			assert.deepEqual(new SessionStore(db).getSession('music'), expected)
		} finally {
			raw.close()
		}
	})
})
