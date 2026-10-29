import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, type Database } from '../core/database'
import type { ContentKind } from '../core/import-mixed-types'
import { ImportStore } from '../core/imports'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import {
	RecommendationStore,
	recommendationSettingKey as key,
	type LocalRecommendation,
} from '../core/recommendations'

const BV = 'BV1vT411i7ET',
	OTHER = 'BV1Z9pb6MEwT'
function source(
	cid: number,
	domain: Source['domain'] = 'music',
	bvid = BV,
): Source {
	return {
		id: sourceId(bvid, cid),
		bvid,
		cid,
		originalTitle: `音源 ${cid}`,
		uploader: 'UP',
		uploaderId: 88,
		performer: null,
		artwork: '',
		duration: 180,
		domain,
		audioAvailability: 'unknown',
	}
}
function open(path = ':memory:') {
	const raw = new DatabaseSync(path)
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
	migrate(db)
	return {
		raw,
		db,
		library: new Library(db),
		playlists: new PlaylistStore(db),
		imports: new ImportStore(db),
		store: new RecommendationStore(db, () => new Date(2026, 9, 18)),
	}
}
type Fixture = ReturnType<typeof open>
const ids = (items: LocalRecommendation[]) =>
	items.map((item) => item.source.id)
const saved = (f: Fixture) => f.library.setting(key)
function seed(f: Fixture, count = 3) {
	const sources = Array.from({ length: count }, (_, index) => source(index + 1))
	for (const value of sources) f.library.save(value)
	return sources
}
function confirm(f: Fixture, taskId: string, value: Source) {
	f.library.save(value)
	return f.imports.review(
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
		f.imports.get(taskId)!.revision,
	)
}
function classify(
	f: Fixture,
	taskId: string,
	kind: ContentKind,
	value?: Source,
) {
	f.imports.createDirectory({
		taskId,
		provider: 'bilibili',
		originalPlaylistId: taskId,
		taskVersion: 1,
		originalMetadata: {},
		entries: [
			{
				entryId: 'e',
				originalEntryId: BV,
				originalPosition: 0,
				originalMetadata: { media: { bvid: BV }, observed: { bvid: BV } },
			},
		],
	})
	f.imports.reviewContent(taskId, 'e', { kind }, 0)
	if (value) confirm(f, taskId, value)
}

void test('FM reads beyond the daily twenty with existing deterministic relationship priority, preserving distinct CIDs and current reasons', () => {
	const f = open()
	try {
		const sources = seed(f, 33)
		f.library.setLiked(sources[22], true)
		f.playlists.create('p', '手工歌单')
		f.playlists.append(
			'p',
			[{ itemId: 'item', source: sources[23] }],
			'keep-all',
		)
		const daily = f.store.load(),
			before = saved(f)
		assert.equal(daily.items.length, 20)
		const all = f.store.fmCandidates([], 50)
		assert.equal(all.length, 33)
		assert.deepEqual(
			all.slice(0, 2).map((item) => [item.source.id, item.reasons]),
			[
				[sources[22].id, ['liked']],
				[sources[23].id, ['playlist']],
			],
		)
		assert.ok(
			all.slice(2).every((item) => item.reasons.join() === 'saved-music'),
		)
		const dailyIds = ids(daily.items)
		const excluded = Object.freeze([...dailyIds, dailyIds[0]])
		assert.deepEqual(
			ids(f.store.fmCandidates(excluded, 50)),
			ids(all).filter((id) => !dailyIds.includes(id)),
		)
		assert.deepEqual(ids(f.store.fmCandidates([])), ids(all).slice(0, 20))
		assert.equal(saved(f), before)
		assert.deepEqual(f.store.load(), daily)
	} finally {
		f.raw.close()
	}
})

void test('first read and stale-date feedback are read-only: no clock, setting creation, revision/undo reset or other writes', () => {
	const f = open()
	try {
		const sources = seed(f)
		f.library.setSetting('theme', 'anime')
		const store = new RecommendationStore(f.db, () => {
			throw new Error('clock must not be read')
		})
		f.raw.exec('PRAGMA query_only=ON')
		assert.equal(store.fmCandidates([]).length, 3)
		assert.equal(saved(f), null)
		f.raw.exec('PRAGMA query_only=OFF')
		f.store.load()
		f.store.dismiss(sources[0].id)
		f.store.refresh()
		const before = saved(f)!,
			pretty = JSON.stringify(JSON.parse(before), null, 2)
		f.library.setSetting(key, pretty)
		const changes = f.raw
			.prepare('SELECT total_changes() AS count')
			.get()!.count
		f.raw.exec('PRAGMA query_only=ON')
		assert.deepEqual(ids(store.fmCandidates([sources[1].id])), [sources[2].id])
		assert.equal(saved(f), pretty)
		assert.equal(
			f.raw.prepare('SELECT total_changes() AS count').get()!.count,
			changes,
		)
		assert.equal(f.library.setting('theme'), 'anime')
	} finally {
		f.raw.close()
	}
})

void test('current classification overrides all CIDs of a conflicting BV without changing daily IDs, sources or playback classification', () => {
	const f = open()
	try {
		const values = seed(f, 2),
			other = source(3, 'music', OTHER),
			unknown = source(4, 'unclassified', OTHER)
		f.library.save(other)
		f.library.setLiked(unknown, true)
		f.playlists.create('p', '未核对本地音源')
		f.playlists.append(
			'p',
			[{ itemId: 'unknown', source: unknown }],
			'keep-all',
		)
		f.store.load()
		const before = saved(f)
		classify(f, 'song', 'song', values[0])
		assert.equal(f.store.fmCandidates([]).length, 3)
		classify(f, 'long', 'musicCollection')
		assert.deepEqual(ids(f.store.fmCandidates([])), [other.id])
		assert.equal(f.library.get(values[0].id)!.domain, 'music')
		assert.equal(saved(f), before)
		f.imports.reviewContent('long', 'e', { kind: 'song' }, 1)
		assert.equal(f.store.fmCandidates([]).length, 3)
		f.raw
			.prepare("UPDATE sources SET domain='unclassified' WHERE id=?")
			.run(other.id)
		assert.ok(!ids(f.store.fmCandidates([])).includes(other.id))
		assert.equal(saved(f), before)
	} finally {
		f.raw.close()
	}
})

void test('FM reuses verified-and-saved external song evidence, retains genuine copies, and rejects confirmation-only or subsequently invalidated proof', () => {
	for (const provider of ['netease', 'qq'] as const) {
		const f = open(),
			value = source(1, 'unclassified')
		try {
			f.imports.createDirectory({
				taskId: 'task',
				provider,
				originalPlaylistId: 'public-original',
				taskVersion: 1,
				originalMetadata: {},
				entries: [
					{
						entryId: 'e',
						originalEntryId: 'song',
						originalPosition: 0,
						originalMetadata: { title: '原曲' },
					},
				],
			})
			confirm(f, 'task', value)
			assert.deepEqual(f.store.fmCandidates([]), [])
			const selected = f.imports.setSelected(
				'task',
				['e'],
				true,
				f.imports.get('task')!.revision,
			)
			f.imports.commitSelected('task', {
				commitId: 'commit',
				expectedRevision: selected.revision,
				target: { kind: 'create', playlistId: 'p', name: '已保存原项' },
				duplicatePolicy: 'keep-all',
				itemIds: [{ entryId: 'e', itemId: 'i' }],
			})
			const result = f.store.fmCandidates([])
			assert.deepEqual(
				result.map((item) => [item.source.id, item.reasons]),
				[[value.id, ['playlist', 'imported-song']]],
			)
			assert.equal(result[0].source.audioAvailability, 'unknown')
			assert.equal(f.library.get(value.id)!.domain, 'unclassified')
			f.playlists.copy('p', 'copy', '保留来源的副本', ['copy-i'])
			f.playlists.remove('p', ['i'])
			assert.deepEqual(ids(f.store.fmCandidates([])), [value.id])
			f.imports.review(
				'task',
				'e',
				{ review: { state: 'pending', candidates: [], confirmation: null } },
				f.imports.get('task')!.revision,
			)
			assert.deepEqual(f.store.fmCandidates([]), [])
			assert.equal(saved(f), null)
		} finally {
			f.raw.close()
		}
	}
})

void test('one read transaction observes a coherent WAL snapshot and the next call sees other-connection feedback and qualification changes', () => {
	const dir = mkdtempSync(join(tmpdir(), 'melo-fm-')),
		file = join(dir, 'db.sqlite'),
		a = open(file)
	a.raw.exec('PRAGMA journal_mode=WAL')
	const b = open(file)
	try {
		const values = seed(a)
		a.store.load()
		let changed = false
		const observed: Database = {
			...a.db,
			// The Database caller supplies the SQLite row shape.
			// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
			getFirstSync: <T>(sql: string, params: (string | number | null)[]) => {
				const result = a.db.getFirstSync<T>(sql, params)
				if (!changed && sql.includes('SELECT value FROM settings')) {
					changed = true
					b.store.dismiss(values[0].id)
					b.raw
						.prepare("UPDATE sources SET domain='unclassified' WHERE id=?")
						.run(values[1].id)
				}
				return result
			},
		}
		const store = new RecommendationStore(observed, () => {
			throw new Error('unexpected clock')
		})
		assert.deepEqual(
			ids(store.fmCandidates([])),
			ids(values.map((value) => ({ source: value, reasons: [] }))),
		)
		const durable = saved(b)
		assert.deepEqual(ids(store.fmCandidates([])), [values[2].id])
		assert.equal(saved(a), durable)
	} finally {
		b.raw.close()
		a.raw.close()
		rmSync(dir, { recursive: true, force: true })
	}
})

void test('invalid exclusions and limits fail before a transaction; sparse, noncanonical or oversized arrays are not silently normalized', () => {
	const f = open()
	try {
		seed(f)
		let calls = 0
		const watched: Database = {
			...f.db,
			execSync: (sql) => {
				calls++
				f.db.execSync(sql)
			},
		}
		const store = new RecommendationStore(watched, () => new Date())
		for (const limit of [
			0,
			-1,
			1.1,
			51,
			NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER + 1,
			null,
			'20',
		])
			assert.throws(() => store.fmCandidates([], limit as number), /数量/)
		const invalid = [
			null,
			{},
			'not-array',
			[sourceId(BV, 0)],
			['bilibili:BVwrong:1'],
			[sourceId(BV, 1) + '\n'],
			[sourceId(BV, 1) + ' '],
			[`bilibili:${BV}:01`],
			[`bilibili:${BV}:9007199254740992`],
			[null],
			Array(2),
			Array(5001).fill(sourceId(BV, 1)),
		]
		for (const exclusions of invalid)
			assert.throws(() => store.fmCandidates(exclusions as string[]), /排除/)
		assert.equal(calls, 0)
		assert.equal(saved(f), null)
		assert.equal(store.fmCandidates([], 1).length, 1)
		assert.equal(
			store.fmCandidates(Array(5000).fill(sourceId(BV, 1)), 50).length,
			2,
		)
	} finally {
		f.raw.close()
	}
})

void test('bad settings or candidate reads preserve exact old bytes and the original error, release the transaction and allow another read', () => {
	const f = open()
	try {
		seed(f)
		const records = [
			'{broken',
			JSON.stringify({ version: 2 }),
			JSON.stringify({
				version: 1,
				localDate: '2026-10-18',
				revision: 0,
				sourceIds: [],
				dismissed: [{ sourceId: 'wrong', dismissedAt: 0 }],
				undoSourceId: null,
			}),
		]
		for (const text of records) {
			f.library.setSetting(key, text)
			assert.throws(() => f.store.fmCandidates([]), /设置损坏|版本/)
			assert.equal(saved(f), text)
			assert.equal(f.raw.isTransaction, false)
		}
		f.raw.prepare('DELETE FROM settings WHERE key=?').run(key)
		f.store.load()
		const before = saved(f),
			failure = new Error('candidate query denied')
		const failing: Database = {
			...f.db,
			getAllSync: () => {
				throw failure
			},
			execSync: (sql) => {
				f.db.execSync(sql)
				if (sql === 'ROLLBACK') throw new Error('secondary cleanup error')
			},
		}
		assert.throws(
			() => new RecommendationStore(failing, () => new Date()).fmCandidates([]),
			(error) => error === failure,
		)
		assert.equal(f.raw.isTransaction, false)
		assert.equal(saved(f), before)
		assert.equal(f.store.fmCandidates([]).length, 3)
	} finally {
		f.raw.close()
	}
})

void test('an injected COMMIT-boundary SQLite error never returns candidates and leaves no changes or held transaction', () => {
	const f = open()
	try {
		seed(f)
		f.store.load()
		const before = saved(f)
		let rejected = false
		const failing: Database = {
			...f.db,
			execSync: (sql) => {
				if (sql === 'COMMIT' && !rejected) {
					rejected = true
					f.raw.exec('COMMIT invalid syntax')
				}
				f.db.execSync(sql)
			},
		}
		assert.throws(
			() => new RecommendationStore(failing, () => new Date()).fmCandidates([]),
			/syntax error/,
		)
		assert.equal(f.raw.isTransaction, false)
		assert.equal(saved(f), before)
		assert.equal(f.store.fmCandidates([]).length, 3)
	} finally {
		f.raw.close()
	}
})

void test('an actual missing-table SQLite query error rolls back the read and a repaired schema can be read again without replacing settings', () => {
	const f = open()
	try {
		seed(f)
		f.store.load()
		const before = saved(f)
		f.raw.exec('ALTER TABLE sources RENAME TO unavailable_sources')
		assert.throws(() => f.store.fmCandidates([]), /no such table: sources/)
		assert.equal(f.raw.isTransaction, false)
		assert.equal(saved(f), before)
		f.raw.exec('ALTER TABLE unavailable_sources RENAME TO sources')
		assert.equal(f.store.fmCandidates([]).length, 3)
		assert.equal(saved(f), before)
	} finally {
		f.raw.close()
	}
})
