import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, type Database } from '../core/database'
import {
	ImportConflictError,
	type ImportDirectorySnapshot,
} from '../core/import-types'
import { ImportStore } from '../core/imports'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore } from '../core/playlists'

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
	return { raw, db, store: new ImportStore(db) }
}
function snapshot(taskId = 'task', count = 4): ImportDirectorySnapshot {
	return {
		taskId,
		provider: 'netease',
		originalPlaylistId: `playlist-${taskId}`,
		taskVersion: 1,
		originalMetadata: { name: '原目录', retained: ['a', 'b'] },
		entries: Array.from({ length: count }, (_, index) => ({
			entryId: `${taskId}-${index}`,
			originalEntryId: index % 2 ? 'B' : 'A',
			originalPosition: index * 2,
			originalMetadata: { name: `原曲${index}`, artists: ['原表演者'] },
		})),
	}
}
function withFile(run: (file: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), 'melo-batch-selection-'))
	assert.ok(
		resolve(dir).startsWith(resolve(tmpdir()) + sep) &&
			basename(dir).startsWith('melo-batch-selection-'),
	)
	try {
		run(join(dir, 'library.db'))
	} finally {
		rmSync(dir, { recursive: true })
	}
}
function immutableEntries(task: ReturnType<ImportStore['get']>) {
	return task!.entries.map(({ selected: _selected, ...rest }) => rest)
}

void test('混合原状态批量选定/清除/子集一次revision，原证据、审核、候选和重试逐字段不变', () => {
	const f = open()
	try {
		f.store.createDirectory(snapshot())
		f.store.review(
			'task',
			'task-0',
			{
				selected: true,
				review: { state: 'not-found', candidates: [], confirmation: null },
				retry: { errorCode: 'HTTP_412', message: '实际受限结果' },
			},
			0,
		)
		f.store.review(
			'task',
			'task-1',
			{
				review: {
					state: 'needs-review',
					candidates: [
						{
							candidateId: 'candidate',
							bvid: 'BV1vT411i7ET',
							cid: null,
							metadata: { title: '候选原标题' },
							evidence: { reason: '需人工复核' },
						},
					],
					confirmation: null,
				},
			},
			1,
		)
		const before = f.store.get('task')!
		const selected = f.store.setSelected(
			'task',
			['task-2', 'task-0', 'task-1'],
			true,
			before.revision,
		)
		assert.equal(selected.revision, before.revision + 1)
		assert.ok(selected.updatedAt > before.updatedAt)
		assert.deepEqual(
			selected.entries.map((entry) => entry.selected),
			[true, true, true, false],
		)
		assert.deepEqual(immutableEntries(selected), immutableEntries(before))
		assert.deepEqual(selected.originalMetadata, before.originalMetadata)
		const cleared = f.store.setSelected(
			'task',
			['task-1', 'task-2'],
			false,
			selected.revision,
		)
		assert.equal(cleared.revision, selected.revision + 1)
		assert.deepEqual(
			cleared.entries.map((entry) => entry.selected),
			[true, false, false, false],
		)
		assert.deepEqual(immutableEntries(cleared), immutableEntries(before))
		assert.deepEqual(cleared.commits, before.commits)
	} finally {
		f.raw.close()
	}
})

void test('全部已是目标值不改revision/updatedAt且不发UPDATE，但旧revision即使no-op也拒绝', () => {
	const f = open()
	try {
		const before = f.store.createDirectory(snapshot())
		f.raw.exec(
			"CREATE TRIGGER reject_noop BEFORE UPDATE ON import_entries BEGIN SELECT RAISE(ABORT, 'no-op wrote rows'); END",
		)
		assert.deepEqual(
			f.store.setSelected('task', ['task-0', 'task-2'], false, 0),
			before,
		)
		f.raw.exec('DROP TRIGGER reject_noop')
		const selected = f.store.setSelected('task', ['task-0'], true, 0)
		assert.deepEqual(
			f.store.setSelected('task', ['task-0'], true, selected.revision),
			selected,
		)
		assert.throws(
			() => f.store.setSelected('task', ['task-0'], true, 0),
			(error) =>
				error instanceof ImportConflictError &&
				error.code === 'IMPORT_REVISION_CONFLICT',
		)
	} finally {
		f.raw.close()
	}
})

void test('多ID全部验证后才写，重复/其他任务/坏bool/无效或超量输入不部分改变', () => {
	const f = open()
	try {
		const before = f.store.createDirectory(snapshot())
		f.store.createDirectory(snapshot('other'))
		for (const ids of [
			[],
			['task-0', 'task-0'],
			['task-0', 'missing'],
			['task-0', 'other-0'],
			['task-0', ' bad'],
			['task-0', null as unknown as string],
			new Array<string>(2),
			Array.from({ length: 5001 }, (_, index) => String(index)),
		])
			assert.throws(() => f.store.setSelected('task', ids, true, 0))
		assert.throws(() =>
			f.store.setSelected('task', ['task-0'], 1 as unknown as boolean, 0),
		)
		assert.throws(() => f.store.setSelected('task', ['task-0'], true, -1))
		assert.throws(() => f.store.setSelected('missing', ['task-0'], true, 0))
		assert.deepEqual(f.store.get('task'), before)
		assert.ok(f.store.get('other')!.entries.every((entry) => !entry.selected))
	} finally {
		f.raw.close()
	}
})

void test('真实双连接旧revision整批拒绝，重读后显式提交子集不覆盖其它较新选择', () => {
	withFile((file) => {
		const f = open(file),
			g = open(file)
		try {
			f.store.createDirectory(snapshot())
			const newer = g.store.setSelected('task', ['task-1', 'task-2'], true, 0)
			assert.throws(
				() => f.store.setSelected('task', ['task-0', 'task-3'], true, 0),
				(error) =>
					error instanceof ImportConflictError &&
					error.code === 'IMPORT_REVISION_CONFLICT',
			)
			assert.deepEqual(f.store.get('task'), newer)
			const retried = f.store.setSelected(
				'task',
				['task-0', 'task-3'],
				true,
				newer.revision,
			)
			assert.equal(retried.revision, 2)
			assert.ok(retried.entries.every((entry) => entry.selected))
		} finally {
			g.raw.close()
			f.raw.close()
		}
	})
})

void test('5000项批量选择只读取两份任务，不逐项review且所有SQL绑定低于999', () => {
	const f = open()
	try {
		f.store.createDirectory(snapshot('task', 5000))
		let taskReads = 0,
			updates = 0
		const observed = new ImportStore({
			...f.db,
			// Preserve Database's caller-supplied SQL row type while observing reads.
			// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
			getFirstSync<T>(sql: string, values: (string | number | null)[]) {
				if (sql === 'SELECT * FROM import_tasks WHERE taskId = ?') taskReads++
				return f.db.getFirstSync<T>(sql, values)
			},
			runSync(sql, values) {
				assert.ok(values.length < 999)
				if (sql.startsWith('UPDATE import_entries')) updates++
				return f.db.runSync(sql, values)
			},
		})
		observed.review = () => {
			throw new Error('must not review entries one by one')
		}
		const value = observed.setSelected(
			'task',
			snapshot('task', 5000).entries.map((entry) => entry.entryId),
			true,
			0,
		)
		assert.equal(value.revision, 1)
		assert.ok(value.entries.every((entry) => entry.selected))
		assert.equal(taskReads, 2)
		assert.ok(updates > 0 && updates <= 10)
	} finally {
		f.raw.close()
	}
})

for (const stage of ['entries', 'task'])
	void test(`批量${stage}SQL中断回滚全部选择和revision，不留下前一批500项`, () => {
		const f = open()
		try {
			const input = snapshot('task', 510),
				before = f.store.createDirectory(input)
			const trigger =
				stage === 'entries'
					? "BEFORE UPDATE ON import_entries WHEN NEW.entryId = 'task-505'"
					: 'BEFORE UPDATE ON import_tasks'
			f.raw.exec(
				`CREATE TRIGGER reject_batch ${trigger} BEGIN SELECT RAISE(ABORT, 'batch interrupted'); END`,
			)
			assert.throws(
				() =>
					f.store.setSelected(
						'task',
						input.entries.map((entry) => entry.entryId),
						true,
						0,
					),
				/batch interrupted/,
			)
			assert.deepEqual(f.store.get('task'), before)
			f.raw.exec('DROP TRIGGER reject_batch')
			assert.equal(
				f.store.setSelected(
					'task',
					input.entries.map((entry) => entry.entryId),
					true,
					0,
				).revision,
				1,
			)
		} finally {
			f.raw.close()
		}
	})

void test('COMMIT失败/SQLite已回滚时原错误保留，无部分选择且可重试', () => {
	const f = open()
	try {
		const before = f.store.createDirectory(snapshot()),
			failure = new Error('original commit failure')
		const broken = new ImportStore({
			...f.db,
			execSync(sql) {
				if (sql === 'COMMIT') {
					f.raw.exec('ROLLBACK')
					throw failure
				}
				f.db.execSync(sql)
			},
		})
		assert.throws(
			() => broken.setSelected('task', ['task-0', 'task-2'], true, 0),
			(error) => error === failure,
		)
		assert.deepEqual(f.store.get('task'), before)
		assert.equal(
			f.store.setSelected('task', ['task-0', 'task-2'], true, 0).revision,
			1,
		)
	} finally {
		f.raw.close()
	}
})

void test('关闭重开恢复选择和所有历史，已处理项仍可勾选但commit绝不重复', () => {
	withFile((file) => {
		let f = open(file)
		let expected: ReturnType<ImportStore['get']> = null
		try {
			const source: Source = {
				id: sourceId('BV1vT411i7ET', 123),
				bvid: 'BV1vT411i7ET',
				cid: 123,
				originalTitle: '真实Source',
				uploader: 'UP',
				uploaderId: 88,
				performer: null,
				artwork: '',
				duration: 30,
				domain: 'unclassified',
				audioAvailability: 'unknown',
			}
			new Library(f.db).save(source)
			f.store.createDirectory(snapshot())
			f.store.review(
				'task',
				'task-0',
				{
					selected: true,
					review: {
						state: 'confirmed',
						candidates: [
							{
								candidateId: 'actual',
								bvid: source.bvid,
								cid: source.cid,
								metadata: {},
								evidence: { manual: true },
							},
						],
						confirmation: { candidateId: 'actual', sourceId: source.id },
					},
					retry: { errorCode: null, message: '原有尝试记录' },
				},
				0,
			)
			const request = {
				commitId: 'commit',
				expectedRevision: 1,
				target: {
					kind: 'create' as const,
					playlistId: 'playlist',
					name: '本地副本',
				},
				duplicatePolicy: 'keep-all' as const,
				itemIds: [{ entryId: 'task-0', itemId: 'original-item' }],
			}
			const committed = f.store.commitSelected('task', request)
			const cleared = f.store.setSelected(
				'task',
				['task-0', 'task-1', 'task-2'],
				false,
				committed.receipt.taskRevision,
			)
			expected = f.store.setSelected(
				'task',
				['task-0', 'task-2'],
				true,
				cleared.revision,
			)
			assert.deepEqual(expected.commits, [committed.receipt])
			assert.deepEqual(
				f.store.commitSelected('task', request).receipt,
				committed.receipt,
			)
			assert.equal(new PlaylistStore(f.db).get('playlist')!.items.length, 1)
			assert.throws(
				() =>
					f.store.commitSelected('task', {
						...request,
						commitId: 'different',
						expectedRevision: expected!.revision,
						target: {
							kind: 'append',
							playlistId: 'playlist',
							expectedUpdatedAt: committed.playlist!.updatedAt,
						},
					}),
				ImportConflictError,
			)
		} finally {
			f.raw.close()
		}
		f = open(file)
		try {
			assert.deepEqual(f.store.get('task'), expected)
			assert.equal(new PlaylistStore(f.db).get('playlist')!.items.length, 1)
		} finally {
			f.raw.close()
		}
	})
})
