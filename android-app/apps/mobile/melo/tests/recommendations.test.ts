import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { CreatorStore } from '../core/creators'
import { Library, migrate, type Database } from '../core/database'
import type { ContentKind } from '../core/import-mixed-types'
import { ImportStore } from '../core/imports'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import {
	RecommendationStore,
	recommendationSettingKey as key,
} from '../core/recommendations'
import { SessionStore } from '../core/sessions'

const BV = 'BV1vT411i7ET'
const OTHER = 'BV1Z9pb6MEwT'
const source = (
	cid: number,
	domain: Source['domain'] = 'music',
	bvid = BV,
): Source => ({
	id: sourceId(bvid, cid),
	bvid,
	cid,
	originalTitle: `真实音源 ${cid}`,
	uploader: '上传者',
	uploaderId: 88,
	performer: null,
	artwork: '',
	duration: 100,
	domain,
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
	let time = new Date(2026, 9, 18, 12)
	return {
		raw,
		db,
		library: new Library(db),
		playlists: new PlaylistStore(db),
		imports: new ImportStore(db),
		store: new RecommendationStore(db, () => new Date(time)),
		setTime: (value: Date) => {
			time = value
		},
	}
}
type Fixture = ReturnType<typeof open>
const ids = (value: ReturnType<RecommendationStore['load']>) =>
	value.items.map((item) => item.source.id)
const saved = (f: Fixture) => f.library.setting(key)
function classify(
	f: Fixture,
	taskId: string,
	kind: ContentKind,
	value: Source | null,
	bvid = value?.bvid ?? BV,
) {
	f.imports.createDirectory({
		taskId,
		provider: 'bilibili',
		originalPlaylistId: taskId,
		taskVersion: 1,
		originalMetadata: { title: '真实收藏夹' },
		entries: [
			{
				entryId: 'e',
				originalEntryId: bvid,
				originalPosition: 0,
				originalMetadata: { media: { bvid }, observed: { bvid } },
			},
		],
	})
	f.imports.reviewContent(taskId, 'e', { kind }, 0)
	if (value) {
		f.library.save(value)
		f.imports.review(
			taskId,
			'e',
			{
				review: {
					state: 'confirmed',
					candidates: [
						{
							candidateId: 'c',
							bvid: value.bvid,
							cid: value.cid,
							metadata: {},
							evidence: {},
						},
					],
					confirmation: { candidateId: 'c', sourceId: value.id },
				},
			},
			1,
		)
	}
}

void test('only explicit music/song admits a real Source; like, playlist, mode, follow and NetQQ confirmation do not classify', () => {
	const f = open()
	try {
		const unknown = source(1, 'unclassified')
		f.library.setLiked(unknown, true)
		f.playlists.create('p', '普通歌单')
		f.playlists.append('p', [{ itemId: 'u', source: unknown }], 'keep-all')
		new SessionStore(f.db).saveSession({
			mode: 'music',
			entries: [{ entryId: unknown.id, sourceId: unknown.id }],
			currentSourceId: unknown.id,
			currentEntryId: unknown.id,
			positionSeconds: 0,
			speed: 1,
			updatedAt: 10,
		})
		const creators = new CreatorStore(f.db)
		creators.saveCreator({
			source: 'bilibili',
			mid: '88',
			name: '上传者',
			fetchedAt: 0,
		})
		creators.follow({
			profileId: 'local',
			creatorMid: '88',
			scope: 'music',
			origin: 'manual',
		})
		for (const provider of ['netease', 'qq'] as const) {
			f.imports.createDirectory({
				taskId: provider,
				provider,
				originalPlaylistId: 'remote',
				taskVersion: 1,
				originalMetadata: {},
				entries: [
					{
						entryId: 'e',
						originalEntryId: 'song',
						originalPosition: 0,
						originalMetadata: { title: '歌曲标题' },
					},
				],
			})
			f.imports.review(
				provider,
				'e',
				{
					review: {
						state: 'confirmed',
						candidates: [
							{
								candidateId: 'c',
								bvid: BV,
								cid: 1,
								metadata: {},
								evidence: {},
							},
						],
						confirmation: { candidateId: 'c', sourceId: unknown.id },
					},
				},
				0,
			)
		}
		classify(f, 'pending', 'song', null, OTHER)
		assert.deepEqual(ids(f.store.load()), [])
		const approved = source(2, 'unclassified', OTHER)
		classify(f, 'approved', 'song', approved)
		// Newly qualified music can fill an empty snapshot on the same day.
		assert.deepEqual(ids(f.store.load()), [approved.id])
		assert.deepEqual(ids(f.store.refresh()), [approved.id])
		assert.equal(f.library.get(approved.id)!.domain, 'unclassified')
		assert.equal(f.library.get(unknown.id)!.domain, 'unclassified')
	} finally {
		f.raw.close()
	}
})

void test('explicit non-song reviews override broad music domain across all CIDs, including conflicting tasks', () => {
	for (const kind of [
		'musicCollection',
		'audioDrama',
		'audiobook',
		'knowledge',
		'commentary',
		'other',
		'unknown',
	] as const) {
		const f = open()
		try {
			f.library.save(source(1))
			f.library.save(source(2))
			classify(f, 'song', 'song', source(1))
			classify(f, 'conflict', kind, null)
			assert.deepEqual(ids(f.store.load()), [], kind)
			f.imports.reviewContent('conflict', 'e', { kind: 'song' }, 1)
			assert.equal(f.store.refresh().items.length, 2)
		} finally {
			f.raw.close()
		}
	}
})

void test('Source dedup preserves original A/B/A occurrence, source fields and truthful current reasons', () => {
	const f = open()
	try {
		const a = source(1),
			b = source(2)
		f.library.setLiked(a, true)
		f.playlists.create('p', '保留重复')
		f.playlists.append(
			'p',
			[
				{ itemId: 'a1', source: a },
				{ itemId: 'b', source: b },
				{ itemId: 'a2', source: a },
			],
			'keep-all',
		)
		const first = f.store.load()
		assert.deepEqual(ids(first), [a.id, b.id])
		assert.deepEqual(first.items[0].reasons, ['liked', 'playlist'])
		assert.deepEqual(first.items[1].reasons, ['playlist'])
		assert.deepEqual(first.items[0].source, a)
		const text = saved(f)
		f.library.setLiked(a, false)
		f.playlists.remove('p', ['a1', 'a2'])
		assert.deepEqual(f.store.load().items[0].reasons, ['saved-music'])
		assert.equal(saved(f), text)
		assert.deepEqual(
			f.playlists.get('p')!.items.map((item) => item.itemId),
			['b'],
		)
		assert.equal(f.library.get(a.id)!.domain, 'music')
	} finally {
		f.raw.close()
	}
})

void test('local day snapshot is stable, explicit rotation repeats after a full cycle, and new day generates once', () => {
	const f = open()
	try {
		for (const cid of [1, 2, 3]) f.library.save(source(cid))
		const first = f.store.load()
		assert.equal(first.localDate, '2026-10-18')
		assert.equal(first.revision, 0)
		const next = f.store.refresh()
		assert.deepEqual(ids(next), [...ids(first).slice(1), ids(first)[0]])
		f.store.refresh()
		assert.deepEqual(ids(f.store.refresh()), ids(first))
		const text = saved(f)
		f.setTime(new Date(2026, 9, 18, 23, 59, 59))
		assert.equal(f.store.load().revision, 3)
		assert.equal(saved(f), text)
		f.setTime(new Date(2026, 9, 19, 0, 0, 1))
		const tomorrow = f.store.load()
		assert.equal(tomorrow.localDate, '2026-10-19')
		assert.equal(tomorrow.revision, 0)
		assert.deepEqual(ids(tomorrow), ids(first))
		const stable = saved(f)
		f.raw.exec(
			"CREATE TRIGGER no_rewrite BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'unexpected rewrite'); END",
		)
		assert.deepEqual(f.store.load(), tomorrow)
		assert.equal(saved(f), stable)
	} finally {
		f.raw.close()
	}
})

void test('same-day stale identity/classification is filtered without filling, persisting or reordering the snapshot', () => {
	const f = open()
	try {
		f.library.save(source(1))
		f.library.save(source(2, 'music', OTHER))
		const first = ids(f.store.load()),
			text = saved(f)
		classify(f, 'long', 'musicCollection', null)
		f.library.save(source(3, 'music', OTHER))
		assert.deepEqual(
			ids(f.store.load()),
			first.filter((id) => id === sourceId(OTHER, 2)),
		)
		assert.equal(saved(f), text)
		f.raw.prepare('DELETE FROM sources WHERE id=?').run(sourceId(OTHER, 2))
		assert.deepEqual(ids(f.store.load()), [])
		assert.equal(saved(f), text)
		assert.deepEqual(ids(f.store.refresh()), [sourceId(OTHER, 3)])
	} finally {
		f.raw.close()
	}
})

void test('20-item bounded snapshot rotates through a larger local pool without duplicate IDs', () => {
	const f = open()
	try {
		for (let cid = 1; cid <= 25; cid++) f.library.save(source(cid))
		const first = ids(f.store.load())
		assert.equal(first.length, 20)
		const seen = new Set(first)
		for (let index = 0; index < 5; index++)
			for (const id of ids(f.store.refresh())) seen.add(id)
		assert.equal(seen.size, 25)
		assert.equal(new Set(ids(f.store.load())).size, 20)
	} finally {
		f.raw.close()
	}
})

void test('single Source dismissal is idempotent, reversible in its old slot, and does not reject another CID', () => {
	const f = open()
	try {
		for (const cid of [1, 2, 3]) f.library.save(source(cid))
		const first = f.store.load()
		assert.equal(first.canUndo, false)
		const a = first.items[0].source.id,
			b = first.items[1].source.id
		assert.deepEqual(ids(f.store.dismiss(a)), ids(first).slice(1))
		const text = saved(f)
		assert.equal(f.store.dismiss(a).canUndo, true)
		assert.equal(saved(f), text)
		assert.deepEqual(ids(f.store.undo()), ids(first))
		f.store.dismiss(a)
		f.store.dismiss(b)
		assert.deepEqual(ids(f.store.undo()), ids(first).slice(1))
		assert.equal(f.store.undo().canUndo, false)
		assert.throws(() => f.store.dismiss(sourceId(BV, 999)), /不在当前有效推荐/)
		assert.throws(() => f.store.dismiss('bad'), /身份无效/)
	} finally {
		f.raw.close()
	}
})

void test("file reopen preserves negative feedback and undo; separate connections do not lose each other's writes", () => {
	const directory = mkdtempSync(join(tmpdir(), 'melo-recommendations-'))
	const file = join(directory, 'data.sqlite')
	let f = open(file)
	try {
		for (const cid of [1, 2, 3]) f.library.save(source(cid))
		const initial = ids(f.store.load()),
			a = initial[0],
			b = initial[1]
		f.store.dismiss(a)
		f.raw.close()
		f = open(file)
		assert.deepEqual(ids(f.store.load()), initial.slice(1))
		const other = open(file)
		try {
			other.store.dismiss(b)
			assert.deepEqual(ids(f.store.load()), initial.slice(2))
			assert.deepEqual(ids(f.store.undo()), initial.slice(1))
			const next = other.store.refresh()
			assert.ok(!ids(next).includes(a))
			assert.deepEqual(f.store.load(), next)
		} finally {
			other.raw.close()
		}
	} finally {
		f.raw.close()
		rmSync(directory, { recursive: true, force: true })
	}
})

void test('malformed/future settings, invalid identity/date/undo, and duplicates fail closed without replacing old bytes', () => {
	const f = open()
	try {
		f.library.save(source(1))
		f.store.load()
		const valid = JSON.parse(saved(f)!)
		const corrupt = [
			'{',
			'null',
			'[]',
			JSON.stringify({ ...valid, version: 2 }),
			JSON.stringify({ ...valid, localDate: '2026-02-30' }),
			JSON.stringify({ ...valid, revision: -1 }),
			JSON.stringify({
				...valid,
				sourceIds: [sourceId(BV, 1), sourceId(BV, 1)],
			}),
			JSON.stringify({ ...valid, sourceIds: ['bilibili:bad:1'] }),
			JSON.stringify({
				...valid,
				sourceIds: [`bilibili:${BV}:9007199254740992`],
			}),
			JSON.stringify({ ...valid, undoSourceId: sourceId(BV, 1) }),
			JSON.stringify({
				...valid,
				dismissed: [{ sourceId: sourceId(BV, 1), dismissedAt: -1 }],
			}),
			JSON.stringify({ ...valid, extra: true }),
			' '.repeat(1024 * 1024 + 1),
		]
		for (const text of corrupt) {
			f.library.setSetting(key, text)
			for (const action of [
				() => f.store.load(),
				() => f.store.refresh(),
				() => f.store.dismiss(sourceId(BV, 1)),
				() => f.store.undo(),
			]) {
				assert.throws(action, /设置损坏或版本不受支持/)
				assert.equal(saved(f), text)
			}
		}
	} finally {
		f.raw.close()
	}
})

void test('valid settings with different JSON key order/whitespace remain byte-identical on a no-op read', () => {
	const f = open()
	try {
		f.library.save(source(1))
		f.store.load()
		const value = JSON.parse(saved(f)!)
		const reordered = JSON.stringify(
			Object.fromEntries(Object.entries(value).toReversed()),
			null,
			2,
		)
		f.library.setSetting(key, reordered)
		f.raw.exec(
			"CREATE TRIGGER no_rewrite BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'unexpected rewrite'); END",
		)
		assert.equal(f.store.load().items.length, 1)
		assert.equal(saved(f), reordered)
		assert.equal(f.store.undo().canUndo, false)
	} finally {
		f.raw.close()
	}
})

void test('read failure, SQL write failure and failed first creation leave durable recommendation and unrelated settings intact', () => {
	const f = open()
	try {
		f.library.save(source(1))
		f.library.setSetting('theme', 'anime')
		f.raw.exec(
			`CREATE TRIGGER fail_insert BEFORE INSERT ON settings WHEN NEW.key='${key}' BEGIN SELECT RAISE(ABORT,'insert failed'); END`,
		)
		assert.throws(() => f.store.load(), /insert failed/)
		assert.equal(saved(f), null)
		f.raw.exec('DROP TRIGGER fail_insert')
		f.store.load()
		const text = saved(f)
		f.raw.exec(
			`CREATE TRIGGER fail_update BEFORE UPDATE ON settings WHEN NEW.key='${key}' BEGIN SELECT RAISE(ABORT,'update failed'); END`,
		)
		assert.throws(() => f.store.dismiss(sourceId(BV, 1)), /update failed/)
		assert.equal(saved(f), text)
		const readError = new Error('read failed')
		const failing: Database = {
			...f.db,
			getAllSync: () => {
				throw readError
			},
		}
		assert.throws(
			() =>
				new RecommendationStore(failing, () => new Date(2026, 9, 19)).load(),
			(error) => error === readError,
		)
		assert.equal(saved(f), text)
		assert.equal(f.library.setting('theme'), 'anime')
		f.raw.exec('DROP TRIGGER fail_update')
		assert.equal(f.store.dismiss(sourceId(BV, 1)).canUndo, true)
	} finally {
		f.raw.close()
	}
})

void test('actual deferred-FK COMMIT failure rolls back setting and preserves original error if rollback also fails', () => {
	const f = open()
	try {
		f.library.save(source(1))
		f.store.load()
		const text = saved(f)
		f.raw.exec(`CREATE TABLE guard_parent(id INTEGER PRIMARY KEY);
			CREATE TABLE guard_child(id INTEGER REFERENCES guard_parent(id) DEFERRABLE INITIALLY DEFERRED);
			CREATE TRIGGER deferred_failure AFTER UPDATE ON settings WHEN NEW.key='${key}' BEGIN INSERT INTO guard_child VALUES (99); END`)
		assert.throws(() => f.store.refresh(), /FOREIGN KEY constraint failed/)
		assert.equal(saved(f), text)
		assert.equal(
			f.raw.prepare('SELECT count(*) AS n FROM guard_child').get()!.n,
			0,
		)
		f.raw.exec('DROP TRIGGER deferred_failure')
		const original = new Error('original SQLite write error')
		const failing: Database = {
			...f.db,
			runSync: () => {
				throw original
			},
			execSync: (sql) => {
				f.db.execSync(sql)
				if (sql === 'ROLLBACK') throw new Error('secondary rollback error')
			},
		}
		assert.throws(
			() =>
				new RecommendationStore(failing, () => new Date(2026, 9, 18)).refresh(),
			(error) => error === original,
		)
		assert.equal(saved(f), text)
		assert.equal(f.store.refresh().revision, 1)
	} finally {
		f.raw.close()
	}
})

void test('invalid clock cannot generate or replace a snapshot', () => {
	const f = open()
	try {
		for (const time of [new Date(NaN), new Date(-1)]) {
			assert.throws(
				() => new RecommendationStore(f.db, () => time).load(),
				/时钟无效/,
			)
			assert.equal(saved(f), null)
		}
	} finally {
		f.raw.close()
	}
})

void test('1000-entry directory with 1000 current reviews is read as one task snapshot', (context) => {
	const f = open()
	try {
		const entries = Array.from({ length: 1000 }, (_, index) => {
			const bvid = `BV${index.toString(36).padStart(10, '0')}`
			return {
				entryId: `e${index}`,
				originalEntryId: bvid,
				originalPosition: index * 2,
				originalMetadata: {
					media: { bvid },
					observed: { bvid },
					originalEvidence: 'a'.repeat(300),
				},
			}
		})
		f.imports.createDirectory({
			taskId: 'large',
			provider: 'bilibili',
			originalPlaylistId: 'large',
			taskVersion: 1,
			originalMetadata: {},
			entries,
		})
		f.raw.exec('BEGIN IMMEDIATE')
		for (const [index, entry] of entries.entries()) {
			f.library.save(source(1, 'music', entry.originalEntryId))
			f.raw
				.prepare('INSERT INTO import_content_reviews VALUES (?,?,?,?)')
				.run(
					'large',
					entry.entryId,
					index % 2 ? 'musicCollection' : 'song',
					100,
				)
		}
		f.raw.exec('COMMIT')
		let snapshotRows = 0
		const measured: Database = {
			...f.db,
			// The Database caller supplies the SQLite row shape.
			// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
			getFirstSync: <T>(sql: string, values: (string | number | null)[]) => {
				const row = f.db.getFirstSync<T>(sql, values)
				if (sql.includes('snapshotJson') && row !== null) snapshotRows++
				return row
			},
			getAllSync: <T>(sql: string, values: (string | number | null)[]) => {
				if (sql.includes('FROM sources s'))
					context.diagnostic(
						'candidate query plan: ' +
							JSON.stringify(
								f.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values),
							),
					)
				const rows = f.db.getAllSync<T>(sql, values)
				assert.ok(
					!sql.includes('snapshotJson'),
					'must not bulk-read full task snapshots',
				)
				return rows
			},
		}
		const started = performance.now()
		const result = new RecommendationStore(
			measured,
			() => new Date(2026, 9, 18),
		).load()
		context.diagnostic(
			`1000 reviews load milliseconds: ${Math.round(performance.now() - started)}; snapshot rows: ${snapshotRows}`,
		)
		assert.equal(result.items.length, 20)
		assert.ok(
			result.items.every(
				(item) => parseInt(item.source.bvid.slice(2), 36) % 2 === 0,
			),
		)
		// A task is parsed once, regardless of how many reviewed occurrences it contains.
		assert.equal(snapshotRows, 1)
	} finally {
		f.raw.close()
	}
})

void test('multiple rejected tasks fetch full directory JSON individually by primary key', () => {
	const f = open()
	try {
		f.library.save(source(1))
		classify(f, 'first', 'musicCollection', null)
		classify(f, 'second', 'knowledge', null, OTHER)
		const reads: string[] = []
		const individual: Database = {
			...f.db,
			getAllSync: <T>(sql: string, values: (string | number | null)[]) => {
				assert.ok(
					!sql.includes('snapshotJson'),
					'never retain a batch of full task JSON',
				)
				return f.db.getAllSync<T>(sql, values)
			},
			// The Database caller supplies the SQLite row shape.
			// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
			getFirstSync: <T>(sql: string, values: (string | number | null)[]) => {
				if (sql.includes('snapshotJson')) {
					assert.match(sql, /WHERE taskId=\?/)
					assert.equal(values.length, 1)
					reads.push(values[0] as string)
				}
				return f.db.getFirstSync<T>(sql, values)
			},
		}
		assert.deepEqual(
			ids(
				new RecommendationStore(individual, () => new Date(2026, 9, 18)).load(),
			),
			[],
		)
		assert.deepEqual(reads.toSorted(), ['first', 'second'])
	} finally {
		f.raw.close()
	}
})
