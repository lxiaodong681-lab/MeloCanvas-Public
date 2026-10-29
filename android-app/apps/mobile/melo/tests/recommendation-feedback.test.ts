import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { CreatorStore } from '../core/creators'
import { Library, migrate, type Database } from '../core/database'
import { ImportStore } from '../core/imports'
import { ListeningLibrary } from '../core/listening'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import { playlistEntryId } from '../core/queue'
import {
	RecommendationStore,
	recommendationSettingKey as key,
} from '../core/recommendations'
import { SessionStore } from '../core/sessions'

const BV = 'BV1vT411i7ET'
const source = (cid: number): Source => ({
	id: sourceId(BV, cid),
	bvid: BV,
	cid,
	originalTitle: `真实音源${cid}`,
	uploader: 'UP',
	uploaderId: 88,
	performer: null,
	artwork: '',
	duration: 100,
	domain: 'music',
	audioAvailability: 'unknown',
})
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
	migrate(db)
	let now = new Date(2026, 9, 19, 12)
	return {
		raw,
		db,
		library: new Library(db),
		store: new RecommendationStore(db, () => now),
		setTime: (time: Date) => {
			now = time
		},
	}
}
type Fixture = ReturnType<typeof open>
const saved = (f: Fixture) => f.library.setting(key)
const ids = (value: ReturnType<RecommendationStore['load']>) =>
	value.items.map((item) => item.source.id)
function seed(f: Fixture, count = 3) {
	for (let cid = 1; cid <= count; cid++) f.library.save(source(cid))
	return f.store.load()
}
function dismiss(f: Fixture, id: string, seconds = 0) {
	f.setTime(new Date(2026, 9, 19, 12, 0, seconds))
	return f.store.dismiss(id)
}

void test('feedback list is strictly read-only, including first open and extreme out-of-range pages', () => {
	const f = open()
	try {
		const readOnly: Database = {
			...f.db,
			runSync: () => {
				throw new Error('unexpected write')
			},
			getAllSync: () => {
				throw new Error('unexpected directory scan')
			},
		}
		const store = new RecommendationStore(readOnly, () => {
			throw new Error('unexpected clock')
		})
		assert.deepEqual(store.listDismissed(), {
			items: [],
			page: 1,
			pageSize: 20,
			total: 0,
			totalPages: 0,
		})
		assert.equal(saved(f), null)
		assert.deepEqual(store.listDismissed(Number.MAX_SAFE_INTEGER, 50), {
			items: [],
			page: Number.MAX_SAFE_INTEGER,
			pageSize: 50,
			total: 0,
			totalPages: 0,
		})
		for (const page of [
			0,
			-1,
			1.5,
			NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER + 1,
			'1' as unknown as number,
		])
			assert.throws(() => store.listDismissed(page), /页码或每页数量无效/)
		for (const size of [
			0,
			-1,
			1.5,
			51,
			NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER,
			true as unknown as number,
		])
			assert.throws(() => store.listDismissed(1, size), /页码或每页数量无效/)
		assert.equal(saved(f), null)
	} finally {
		f.raw.close()
	}
})

void test('feedback pages sort newest first with stable Source ID ties and read only the requested Source rows', () => {
	const f = open()
	try {
		seed(f, 6)
		for (const cid of [4, 1, 3, 2, 5])
			dismiss(f, source(cid).id, cid === 5 ? 10 : 0)
		const before = saved(f)
		const reads: string[] = []
		const measured: Database = {
			...f.db,
			// The Database caller supplies the SQLite row shape.
			// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
			getFirstSync: <T>(sql: string, values: (string | number | null)[]) => {
				if (sql.includes('FROM sources')) reads.push(values[0] as string)
				return f.db.getFirstSync<T>(sql, values)
			},
			getAllSync: () => {
				throw new Error('feedback listing must not scan candidate/task data')
			},
		}
		const store = new RecommendationStore(measured, () => new Date(NaN))
		const first = store.listDismissed(1, 2)
		assert.deepEqual(
			first.items.map((item) => item.sourceId),
			[source(5).id, source(1).id],
		)
		assert.equal(first.total, 5)
		assert.equal(first.totalPages, 3)
		assert.deepEqual({ ...first.items[0].source }, source(5))
		assert.deepEqual(
			store.listDismissed(2, 2).items.map((item) => item.sourceId),
			[source(2).id, source(3).id],
		)
		assert.deepEqual(
			store.listDismissed(3, 2).items.map((item) => item.sourceId),
			[source(4).id],
		)
		assert.equal(reads.length, 5)
		assert.deepEqual(store.listDismissed(Number.MAX_SAFE_INTEGER, 50).items, [])
		assert.equal(reads.length, 5)
		assert.equal(saved(f), before)
	} finally {
		f.raw.close()
	}
})

void test('missing Source feedback stays identifiable and can be restored without fabricating a Source', () => {
	const f = open()
	try {
		seed(f, 1)
		dismiss(f, source(1).id)
		f.raw.prepare('DELETE FROM sources WHERE id=?').run(source(1).id)
		const page = f.store.listDismissed()
		assert.deepEqual(page.items, [
			{
				sourceId: source(1).id,
				dismissedAt: new Date(2026, 9, 19, 12).getTime(),
				source: null,
			},
		])
		assert.deepEqual(ids(f.store.restoreSource(source(1).id)), [])
		assert.equal(f.store.listDismissed().total, 0)
		assert.equal(f.library.get(source(1).id), null)
	} finally {
		f.raw.close()
	}
})

void test('restoring an older mistaken rejection preserves other feedback and the last undo; absent ID is a no-op', () => {
	const f = open()
	try {
		const first = seed(f)
		dismiss(f, source(1).id)
		dismiss(f, source(2).id, 1)
		const restored = f.store.restoreSource(source(1).id)
		assert.ok(ids(restored).includes(source(1).id))
		assert.ok(!ids(restored).includes(source(2).id))
		assert.equal(restored.canUndo, true)
		assert.deepEqual(
			f.store.listDismissed().items.map((item) => item.sourceId),
			[source(2).id],
		)
		const before = saved(f)
		assert.deepEqual(f.store.restoreSource(source(999).id), restored)
		assert.equal(saved(f), before)
		assert.deepEqual(ids(f.store.undo()), ids(first))
		dismiss(f, source(1).id)
		assert.equal(f.store.restoreSource(source(1).id).canUndo, false)
		assert.throws(() => f.store.restoreSource('bad'), /身份无效/)
	} finally {
		f.raw.close()
	}
})

void test('restore does not fill a rotated snapshot or override changed content qualification; reset generates current eligible pool', () => {
	const f = open()
	try {
		seed(f, 21)
		const rejected = f.store.load().items[0].source.id
		dismiss(f, rejected)
		const rotated = f.store.refresh()
		assert.ok(!ids(rotated).includes(rejected))
		const recordIds = JSON.parse(saved(f)!).sourceIds
		assert.deepEqual(ids(f.store.restoreSource(rejected)), ids(rotated))
		assert.deepEqual(JSON.parse(saved(f)!).sourceIds, recordIds)
		const imports = new ImportStore(f.db)
		imports.createDirectory({
			taskId: 'long',
			provider: 'bilibili',
			originalPlaylistId: 'folder',
			taskVersion: 1,
			originalMetadata: {},
			entries: [
				{
					entryId: 'e',
					originalEntryId: BV,
					originalPosition: 0,
					originalMetadata: { media: { bvid: BV } },
				},
			],
		})
		imports.reviewContent('long', 'e', { kind: 'musicCollection' }, 0)
		assert.deepEqual(ids(f.store.restoreSource(rejected)), [])
		const reset = f.store.resetLocalRecommendations()
		assert.deepEqual(reset, {
			localDate: '2026-10-19',
			revision: 0,
			items: [],
			canUndo: false,
		})
		assert.equal(f.store.listDismissed().total, 0)
		assert.equal(f.library.get(rejected)!.domain, 'music')
	} finally {
		f.raw.close()
	}
})

void test('reset clears all feedback and undo, generates today revision zero, and never changes library/creator/playback rows', () => {
	const f = open()
	try {
		seed(f)
		f.library.setLiked(source(1), true)
		f.library.setSetting('theme', 'anime')
		const playlists = new PlaylistStore(f.db)
		playlists.create('p', 'A/B/A')
		playlists.append(
			'p',
			[
				{ itemId: 'a1', source: source(1) },
				{ itemId: 'b', source: source(2) },
				{ itemId: 'a2', source: source(1) },
			],
			'keep-all',
		)
		const sessions = new SessionStore(f.db)
		sessions.saveSession({
			mode: 'music',
			entries: [
				{ entryId: playlistEntryId('a1'), sourceId: source(1).id },
				{ entryId: playlistEntryId('b'), sourceId: source(2).id },
				{ entryId: playlistEntryId('a2'), sourceId: source(1).id },
			],
			currentEntryId: playlistEntryId('a2'),
			currentSourceId: source(1).id,
			positionSeconds: 42,
			speed: 1,
			updatedAt: 100,
		})
		new ListeningLibrary(f.db).saveResumePoint({
			sourceId: source(2).id,
			positionSeconds: 12,
			durationSeconds: 100,
			completed: false,
			updatedAt: 100,
		})
		const creators = new CreatorStore(f.db)
		creators.saveCreator({
			source: 'bilibili',
			mid: '88',
			name: 'UP',
			fetchedAt: 0,
		})
		creators.follow({
			profileId: 'local',
			creatorMid: '88',
			scope: 'all',
			origin: 'manual',
		})
		const dump = () =>
			f.db
				.getAllSync<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name!='settings' ORDER BY name",
					[],
				)
				.map((row) => [
					row.name,
					f.raw.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all(),
				])
		const unchanged = dump()
		dismiss(f, source(1).id)
		dismiss(f, source(2).id)
		f.store.refresh()
		f.setTime(new Date(2026, 9, 20, 10))
		const result = f.store.resetLocalRecommendations()
		assert.equal(result.localDate, '2026-10-20')
		assert.equal(result.revision, 0)
		assert.equal(result.canUndo, false)
		assert.equal(result.items.length, 3)
		assert.equal(f.store.listDismissed().total, 0)
		assert.equal(f.library.setting('theme'), 'anime')
		assert.deepEqual(dump(), unchanged)
		assert.equal(
			sessions.getSession('music')!.currentEntryId,
			playlistEntryId('a2'),
		)
	} finally {
		f.raw.close()
	}
})

void test('file reopen and two connections restore latest feedback without losing another Source rejection', () => {
	const directory = mkdtempSync(join(tmpdir(), 'melo-feedback-')),
		file = join(directory, 'state.sqlite')
	let f = open(file)
	try {
		seed(f)
		dismiss(f, source(1).id)
		f.raw.close()
		f = open(file)
		const other = open(file)
		try {
			assert.equal(f.store.listDismissed().total, 1)
			dismiss(other, source(2).id, 1)
			f.store.restoreSource(source(1).id)
			assert.deepEqual(
				other.store.listDismissed().items.map((item) => item.sourceId),
				[source(2).id],
			)
			assert.equal(f.store.load().canUndo, true)
			other.store.resetLocalRecommendations()
			assert.equal(f.store.listDismissed().total, 0)
			assert.equal(f.store.load().canUndo, false)
		} finally {
			other.raw.close()
		}
	} finally {
		f.raw.close()
		rmSync(directory, { recursive: true, force: true })
	}
})

void test('malformed/future settings cannot be listed, restored or reset and stay byte-identical', () => {
	const f = open()
	try {
		seed(f)
		const valid = JSON.parse(saved(f)!)
		for (const text of [
			'{',
			'null',
			JSON.stringify({ ...valid, version: 2 }),
			JSON.stringify({ ...valid, undoSourceId: source(1).id }),
		]) {
			f.library.setSetting(key, text)
			for (const action of [
				() => f.store.listDismissed(),
				() => f.store.restoreSource(source(1).id),
				() => f.store.resetLocalRecommendations(),
			]) {
				assert.throws(action, /设置损坏或版本不受支持/)
				assert.equal(saved(f), text)
			}
		}
	} finally {
		f.raw.close()
	}
})

void test('read and write failures do not publish partial restore/reset; successful commit performs no post-write read', () => {
	const f = open()
	try {
		seed(f)
		dismiss(f, source(1).id)
		const before = saved(f)
		const readError = new Error('candidate read failed')
		const unreadable = new RecommendationStore(
			{
				...f.db,
				getAllSync: () => {
					throw readError
				},
			},
			() => new Date(2026, 9, 19),
		)
		for (const action of [
			() => unreadable.restoreSource(source(1).id),
			() => unreadable.resetLocalRecommendations(),
		]) {
			assert.throws(action, (error) => error === readError)
			assert.equal(saved(f), before)
		}
		f.raw.exec(
			`CREATE TRIGGER fail_feedback BEFORE UPDATE ON settings WHEN NEW.key='${key}' BEGIN SELECT RAISE(ABORT,'write failed'); END`,
		)
		for (const action of [
			() => f.store.restoreSource(source(1).id),
			() => f.store.resetLocalRecommendations(),
		]) {
			assert.throws(action, /write failed/)
			assert.equal(saved(f), before)
		}
		f.raw.exec('DROP TRIGGER fail_feedback')
		let committed = false
		const guarded: Database = {
			...f.db,
			execSync: (sql) => {
				f.db.execSync(sql)
				if (sql === 'COMMIT') committed = true
			},
			// The Database caller supplies the SQLite row shape.
			// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
			getFirstSync: <T>(sql: string, values: (string | number | null)[]) => {
				assert.equal(committed, false)
				return f.db.getFirstSync<T>(sql, values)
			},
			getAllSync: <T>(sql: string, values: (string | number | null)[]) => {
				assert.equal(committed, false)
				return f.db.getAllSync<T>(sql, values)
			},
		}
		assert.equal(
			new RecommendationStore(
				guarded,
				() => new Date(2026, 9, 19),
			).restoreSource(source(1).id).canUndo,
			false,
		)
		assert.equal(committed, true)
		assert.equal(f.store.listDismissed().total, 0)
	} finally {
		f.raw.close()
	}
})

void test('actual deferred-FK COMMIT failure rolls restore and reset back, then retry succeeds', () => {
	const f = open()
	try {
		seed(f)
		dismiss(f, source(1).id)
		const before = saved(f)
		f.raw.exec(`CREATE TABLE feedback_parent(id INTEGER PRIMARY KEY);
			CREATE TABLE feedback_child(id INTEGER REFERENCES feedback_parent(id) DEFERRABLE INITIALLY DEFERRED);
			CREATE TRIGGER bad_commit AFTER UPDATE ON settings WHEN NEW.key='${key}' BEGIN INSERT INTO feedback_child VALUES(99); END`)
		for (const action of [
			() => f.store.restoreSource(source(1).id),
			() => f.store.resetLocalRecommendations(),
		]) {
			assert.throws(action, /FOREIGN KEY constraint failed/)
			assert.equal(saved(f), before)
			assert.equal(
				f.raw.prepare('SELECT count(*) AS n FROM feedback_child').get()!.n,
				0,
			)
		}
		f.raw.exec('DROP TRIGGER bad_commit')
		assert.equal(f.store.resetLocalRecommendations().canUndo, false)
		assert.equal(f.store.listDismissed().total, 0)
	} finally {
		f.raw.close()
	}
})
