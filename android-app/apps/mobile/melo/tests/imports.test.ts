import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { CreatorStore } from '../core/creators'
import { Library, migrate, migrations, type Database } from '../core/database'
import {
	ImportConflictError,
	importTaskLimits,
	type ImportDirectorySnapshot,
	type ImportMetadata,
	type ImportReview,
} from '../core/import-types'
import { ImportStore } from '../core/imports'
import { ListeningLibrary } from '../core/listening'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import { SessionStore } from '../core/sessions'

const a: Source = {
	id: sourceId('BV1vT411i7ET', 123),
	bvid: 'BV1vT411i7ET',
	cid: 123,
	originalTitle: '真实已保存的音源',
	uploader: 'UP',
	uploaderId: 88,
	performer: null,
	artwork: '',
	duration: 300,
	domain: 'unclassified',
	audioAvailability: 'unknown',
}
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
	return { raw, db }
}
function setup() {
	const f = open()
	migrate(f.db)
	return { ...f, store: new ImportStore(f.db), library: new Library(f.db) }
}
function snapshot(
	overrides: Partial<ImportDirectorySnapshot> = {},
): ImportDirectorySnapshot {
	return {
		taskId: 'task-1',
		provider: 'netease',
		originalPlaylistId: 'remote-playlist',
		taskVersion: 1,
		originalMetadata: {
			name: '原歌单',
			description: '原平台目录，不是音频',
			total: 3,
		},
		entries: ['A', 'B', 'A'].map((name, index) => ({
			entryId: `occurrence-${index}`,
			originalEntryId: name,
			originalPosition: index * 2 + 1,
			originalMetadata: {
				name,
				artists: ['表演者'],
				album: { name: '原专辑' },
				durationMs: 300001,
			},
		})),
		...overrides,
	}
}
function candidate(
	state: ImportReview['state'] = 'needs-review',
): ImportReview {
	return {
		state,
		candidates: [
			{
				candidateId: 'candidate-a',
				bvid: a.bvid,
				cid: a.cid,
				metadata: { originalTitle: a.originalTitle },
				evidence: { confidence: 'low', reason: '标题线索，需人工审核' },
			},
		],
		confirmation:
			state === 'confirmed'
				? { candidateId: 'candidate-a', sourceId: a.id }
				: null,
	}
}
function withFile(run: (file: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), 'melo-imports-'))
	assert.ok(
		resolve(dir).startsWith(resolve(tmpdir()) + sep) &&
			basename(dir).startsWith('melo-imports-'),
	)
	try {
		run(join(dir, 'library.db'))
	} finally {
		rmSync(dir, { recursive: true })
	}
}
function legacyRows(raw: DatabaseSync): string {
	return JSON.stringify(
		[
			'sources',
			'likes',
			'settings',
			'resume_points',
			'playback_sessions',
			'playback_session_items',
			'playlists',
			'playlist_items',
			'creators',
			'creator_subscriptions',
		].map((table) =>
			raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
		),
	)
}
function seed(db: Database) {
	new Library(db).setLiked(a, true)
	new Library(db).setSetting('theme.state.v1', '{original-theme-registry}')
	new ListeningLibrary(db).saveResumePoint({
		sourceId: a.id,
		positionSeconds: 42,
		durationSeconds: 300,
		completed: false,
		updatedAt: 9,
	})
	const playlists = new PlaylistStore(db)
	playlists.create('existing', '旧歌单')
	playlists.append(
		'existing',
		['A', 'B', 'A2'].map((itemId) => ({ itemId, source: a })),
		'keep-all',
	)
	for (const mode of ['music', 'listening'] as const)
		new SessionStore(db).saveSession({
			mode,
			entries:
				mode === 'music'
					? [
							{ entryId: 'playlist-item:first', sourceId: a.id },
							{ entryId: 'playlist-item:second', sourceId: a.id },
						]
					: [{ entryId: a.id, sourceId: a.id }],
			currentEntryId: mode === 'music' ? 'playlist-item:second' : a.id,
			currentSourceId: a.id,
			positionSeconds: 42,
			speed: 1.25,
			updatedAt: 9,
		})
	const creators = new CreatorStore(db)
	creators.saveCreator({
		source: 'bilibili',
		mid: '88',
		name: 'UP',
		avatar: 'old-avatar',
		bio: '旧资料',
		fetchedAt: 1,
	})
	creators.follow({
		profileId: 'local',
		creatorMid: '88',
		scope: 'all',
		origin: 'manual',
	})
}

void test('v6→v7及重开逐字段保留所有旧业务表，目录原证据和A/B/A独立出现项完整恢复', () => {
	withFile((file) => {
		let f = open(file)
		let before = '',
			expected: ReturnType<ImportStore['get']> = null
		try {
			migrate(f.db, migrations.slice(0, 6))
			seed(f.db)
			before = legacyRows(f.raw)
			migrate(f.db, migrations.slice(0, 7))
			const store = new ImportStore(f.db)
			expected = store.createDirectory(snapshot())
			assert.equal(expected.revision, 0)
			assert.deepEqual(
				expected.entries.map((entry) => entry.originalEntryId),
				['A', 'B', 'A'],
			)
			assert.ok(
				expected.entries.every(
					(entry) =>
						!entry.selected &&
						entry.review.state === 'pending' &&
						entry.review.confirmation === null,
				),
			)
			assert.equal(legacyRows(f.raw), before)
		} finally {
			f.raw.close()
		}
		f = open(file)
		try {
			migrate(f.db, migrations.slice(0, 7))
			assert.equal(f.raw.prepare('PRAGMA user_version').get()?.user_version, 7)
			assert.equal(legacyRows(f.raw), before)
			assert.deepEqual(new ImportStore(f.db).get('task-1'), expected)
		} finally {
			f.raw.close()
		}
	})
})

void test('v7迁移中断完整回滚，重开仍v6且可重试', () => {
	withFile((file) => {
		let f = open(file)
		let before = ''
		try {
			migrate(f.db, migrations.slice(0, 6))
			seed(f.db)
			before = legacyRows(f.raw)
			assert.throws(
				() =>
					migrate({
						...f.db,
						execSync(sql) {
							f.db.execSync(sql)
							if (sql.includes('CREATE TABLE import_tasks'))
								throw new Error('migration interrupted')
						},
					}),
				/migration interrupted/,
			)
			assert.equal(f.raw.prepare('PRAGMA user_version').get()?.user_version, 6)
			assert.equal(
				f.raw
					.prepare("SELECT name FROM sqlite_master WHERE name = 'import_tasks'")
					.get(),
				undefined,
			)
			assert.equal(legacyRows(f.raw), before)
		} finally {
			f.raw.close()
		}
		f = open(file)
		try {
			migrate(f.db, migrations.slice(0, 7))
			assert.equal(legacyRows(f.raw), before)
			assert.equal(new ImportStore(f.db).list().length, 0)
		} finally {
			f.raw.close()
		}
	})
})

void test('create幂等忽略对象键序，保留后续审核与重试；不同快照/任务ID/数组顺序明确冲突', () => {
	const f = setup()
	try {
		f.store.createDirectory(snapshot())
		const changed = f.store.review(
			'task-1',
			'occurrence-2',
			{
				selected: true,
				retry: { errorCode: 'HTTP_412', message: '真实受限结果' },
			},
			0,
		)
		const reordered = snapshot({
			originalMetadata: {
				total: 3,
				description: '原平台目录，不是音频',
				name: '原歌单',
			},
		})
		assert.deepEqual(f.store.createDirectory(reordered), changed)
		for (const input of [
			snapshot({ taskId: 'another-id' }),
			snapshot({ originalMetadata: { name: '变更' } }),
			snapshot({
				entries: snapshot().entries.map((entry, i) => ({
					...entry,
					originalMetadata: { names: i ? ['x', 'y'] : ['y', 'x'] },
				})),
			}),
		]) {
			assert.throws(
				() => f.store.createDirectory(input),
				(error) =>
					error instanceof ImportConflictError &&
					error.code === 'IMPORT_DIRECTORY_CONFLICT',
			)
		}
		assert.deepEqual(f.store.get('task-1'), changed)
		f.store.createDirectory(snapshot({ taskId: 'version-2', taskVersion: 2 }))
		f.store.createDirectory(snapshot({ taskId: 'qq-task', provider: 'qq' }))
		assert.equal(f.store.list().length, 3)
	} finally {
		f.raw.close()
	}
})

void test('create中途SQLite错误不留下任务或部分目录，重试成功', () => {
	const f = setup()
	try {
		f.raw.exec(
			"CREATE TRIGGER reject_entry BEFORE INSERT ON import_entries WHEN NEW.entryId = 'occurrence-1' BEGIN SELECT RAISE(ABORT, 'directory failed'); END",
		)
		assert.throws(() => f.store.createDirectory(snapshot()), /directory failed/)
		assert.deepEqual(f.store.list(), [])
		assert.equal(
			f.raw.prepare('SELECT COUNT(*) n FROM import_entries').get()?.n,
			0,
		)
		f.raw.exec('DROP TRIGGER reject_entry')
		assert.equal(f.store.createDirectory(snapshot()).entryCount, 3)
	} finally {
		f.raw.close()
	}
})

void test('候选证据/用户确认/选择独立；只更新指定occurrence，不创建或改分类Source', () => {
	const f = setup()
	try {
		f.store.createDirectory(snapshot())
		f.library.save(a)
		const oldSource = f.library.get(a.id)
		let task = f.store.review(
			'task-1',
			'occurrence-0',
			{ review: candidate() },
			0,
		)
		assert.equal(task.entries[0].review.confirmation, null)
		assert.equal(task.entries[0].selected, false)
		task = f.store.review(
			'task-1',
			'occurrence-0',
			{ selected: true, review: candidate('confirmed') },
			1,
		)
		assert.deepEqual(task.entries[0].review.confirmation, {
			candidateId: 'candidate-a',
			sourceId: a.id,
		})
		assert.equal(
			task.entries[0].review.candidates[0].evidence.confidence,
			'low',
		)
		assert.equal(task.entries[2].review.state, 'pending')
		task = f.store.review('task-1', 'occurrence-0', { selected: false }, 2)
		assert.equal(task.entries[0].review.state, 'confirmed')
		assert.equal(task.entries[0].selected, false)
		assert.deepEqual(f.library.get(a.id), oldSource)
		assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM sources').get()?.n, 1)
		assert.equal(
			f.raw.prepare('SELECT COUNT(*) n FROM playlist_items').get()?.n,
			0,
		)
	} finally {
		f.raw.close()
	}
})

void test('人工确认拒绝缺源/未知候选/缺CID/与真实已有Source身份不一致，整次选择与revision保留', () => {
	const f = setup()
	try {
		const original = f.store.createDirectory(snapshot())
		assert.throws(
			() =>
				f.store.review(
					'task-1',
					'occurrence-0',
					{ selected: true, review: candidate('confirmed') },
					0,
				),
			/真实音源/,
		)
		f.library.save(a)
		for (const change of [
			{
				...candidate('confirmed'),
				confirmation: { candidateId: 'unknown', sourceId: a.id },
			},
			{
				...candidate('confirmed'),
				candidates: [{ ...candidate().candidates[0], cid: null }],
			},
			{
				...candidate('confirmed'),
				confirmation: { candidateId: 'candidate-a', sourceId: 'fake' },
			},
			{
				...candidate(),
				confirmation: { candidateId: 'candidate-a', sourceId: a.id },
			},
		])
			assert.throws(() =>
				f.store.review(
					'task-1',
					'occurrence-0',
					{ selected: true, review: change },
					0,
				),
			)
		f.raw.prepare('UPDATE sources SET cid = 999 WHERE id = ?').run(a.id)
		assert.throws(
			() =>
				f.store.review(
					'task-1',
					'occurrence-0',
					{ selected: true, review: candidate('confirmed') },
					0,
				),
			/真实音源/,
		)
		assert.deepEqual(f.store.get('task-1'), original)
	} finally {
		f.raw.close()
	}
})

void test('真实双连接审核冲突拒绝旧revision且不追加重试，重新读取后可继续', () => {
	withFile((file) => {
		const f = open(file)
		migrate(f.db)
		const g = open(file)
		try {
			migrate(g.db)
			const one = new ImportStore(f.db),
				two = new ImportStore(g.db)
			one.createDirectory(snapshot())
			const changed = one.review(
				'task-1',
				'occurrence-0',
				{ selected: true },
				0,
			)
			assert.throws(
				() =>
					two.review(
						'task-1',
						'occurrence-2',
						{ selected: true, retry: { errorCode: null, message: '过期结果' } },
						0,
					),
				(error) =>
					error instanceof ImportConflictError &&
					error.code === 'IMPORT_REVISION_CONFLICT',
			)
			assert.deepEqual(two.get('task-1'), changed)
			assert.equal(
				two.review(
					'task-1',
					'occurrence-2',
					{ selected: true },
					two.get('task-1')!.revision,
				).revision,
				2,
			)
		} finally {
			g.raw.close()
			f.raw.close()
		}
	})
})

void test('审核/选择/重试/任务revision同事务，中途写失败全部回滚并可重试', () => {
	const f = setup()
	try {
		const before = f.store.createDirectory(snapshot())
		f.raw.exec(
			"CREATE TRIGGER reject_revision BEFORE UPDATE ON import_tasks BEGIN SELECT RAISE(ABORT, 'review failed'); END",
		)
		const decision = {
			selected: true,
			review: candidate(),
			retry: { errorCode: 'TIMEOUT', message: '一次请求超时' },
		}
		assert.throws(
			() => f.store.review('task-1', 'occurrence-0', decision, 0),
			/review failed/,
		)
		assert.deepEqual(f.store.get('task-1'), before)
		assert.equal(
			f.raw.prepare('SELECT COUNT(*) n FROM import_retry_records').get()?.n,
			0,
		)
		f.raw.exec('DROP TRIGGER reject_revision')
		const saved = f.store.review('task-1', 'occurrence-0', decision, 0)
		assert.equal(saved.revision, 1)
		assert.deepEqual(
			saved.entries[0].retries.map((retry) => [
				retry.sequence,
				retry.taskRevision,
				retry.message,
			]),
			[[1, 1, '一次请求超时']],
		)
	} finally {
		f.raw.close()
	}
})

void test('COMMIT失败与SQLite已自动回滚时保留原始错误，未保存审核可重试', () => {
	const f = setup()
	try {
		const before = f.store.createDirectory(snapshot()),
			failure = new Error('SQLITE_FULL original')
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
			() => broken.review('task-1', 'occurrence-0', { selected: true }, 0),
			(error) => error === failure,
		)
		assert.deepEqual(f.store.get('task-1'), before)
		assert.equal(
			f.store.review('task-1', 'occurrence-0', { selected: true }, 0).revision,
			1,
		)
	} finally {
		f.raw.close()
	}
})

void test('审核、原元信息、候选与重试记录关闭重开后逐字段恢复，调用方修改返回值不污染库', () => {
	withFile((file) => {
		let f = open(file)
		let expected: ReturnType<ImportStore['get']> = null
		try {
			migrate(f.db)
			new Library(f.db).save(a)
			const store = new ImportStore(f.db)
			store.createDirectory(snapshot())
			store.review(
				'task-1',
				'occurrence-0',
				{ review: candidate('confirmed'), selected: true },
				0,
			)
			expected = store.review(
				'task-1',
				'occurrence-1',
				{
					review: { state: 'unreadable', candidates: [], confirmation: null },
					retry: { errorCode: '403', message: '无权读取原条目' },
				},
				1,
			)
			const detached = store.get('task-1')!
			detached.entries[0].originalMetadata.name = 'changed'
			detached.entries[0].review.candidates[0].evidence.confidence = 'high'
			assert.deepEqual(store.get('task-1'), expected)
		} finally {
			f.raw.close()
		}
		f = open(file)
		try {
			migrate(f.db)
			assert.deepEqual(new ImportStore(f.db).get('task-1'), expected)
		} finally {
			f.raw.close()
		}
	})
})

void test('空目录合法；无效身份/位置/重复occurrence被拒绝，重复原平台ID允许', () => {
	const f = setup()
	try {
		assert.equal(
			f.store.createDirectory(snapshot({ entries: [] })).entryCount,
			0,
		)
		assert.equal(f.store.get('missing'), null)
		const fresh = { taskId: 'fresh', taskVersion: 2 }
		for (const input of [
			snapshot({ ...fresh, taskId: ' bad' }),
			snapshot({ ...fresh, taskVersion: 0 }),
			snapshot({ ...fresh, provider: 'invalid' as 'qq' }),
			snapshot({
				...fresh,
				entries: [snapshot().entries[1], snapshot().entries[0]],
			}),
			snapshot({
				...fresh,
				entries: [
					snapshot().entries[0],
					{ ...snapshot().entries[1], entryId: 'occurrence-0' },
				],
			}),
			snapshot({
				...fresh,
				entries: [{ ...snapshot().entries[0], originalPosition: NaN }],
			}),
		])
			assert.throws(() => f.store.createDirectory(input))
		assert.equal(f.store.list().length, 1)
	} finally {
		f.raw.close()
	}
})

void test('JSON证据拒绝有损/可执行/循环/过深/超限值，不调用getter；保留特殊对象键', () => {
	const f = setup()
	try {
		const cycle: Record<string, unknown> = {}
		cycle.self = cycle
		let depth: unknown = {}
		for (let i = 0; i < 10; i++) depth = { child: depth }
		let accessed = false
		const getter = Object.defineProperty({}, 'value', {
			enumerable: true,
			get() {
				accessed = true
				return 'hidden'
			},
		})
		for (const value of [
			{ value: NaN },
			{ value: undefined },
			{ value: 2n },
			{ value: () => 1 },
			{ value: new Date() },
			{ value: new Array(2) },
			cycle,
			depth,
			getter,
			{ text: '字'.repeat(importTaskLimits.playlistMetadataBytes) },
		])
			assert.throws(() =>
				f.store.createDirectory(
					snapshot({ originalMetadata: value as ImportMetadata }),
				),
			)
		assert.equal(accessed, false)
		assert.deepEqual(f.store.list(), [])
		const metadata = JSON.parse(
			'{"__proto__":{"name":"原值"},"constructor":"原证据"}',
		) as ImportMetadata
		assert.deepEqual(
			f.store.createDirectory(snapshot({ originalMetadata: metadata }))
				.originalMetadata,
			metadata,
		)
		assert.equal(({} as Record<string, unknown>).name, undefined)
	} finally {
		f.raw.close()
	}
})

void test('目录总大小/数量及候选唯一和大小上限在写前生效', () => {
	const f = setup()
	try {
		assert.throws(
			() =>
				f.store.createDirectory(
					snapshot({
						entries: Array.from(
							{ length: importTaskLimits.entries + 1 },
							(_, i) => ({
								...snapshot().entries[0],
								entryId: String(i),
								originalPosition: i,
							}),
						),
					}),
				),
			/条目数/,
		)
		assert.throws(
			() =>
				f.store.createDirectory(
					snapshot({
						entries: Array.from({ length: 700 }, (_, i) => ({
							...snapshot().entries[0],
							entryId: String(i),
							originalPosition: i,
							originalMetadata: { text: 'x'.repeat(13000) },
						})),
					}),
				),
			/大小上限/,
		)
		const before = f.store.createDirectory(snapshot())
		const original = candidate()
		for (const review of [
			{
				...original,
				candidates: [original.candidates[0], original.candidates[0]],
			},
			{
				...original,
				candidates: Array.from({ length: 21 }, (_, i) => ({
					...original.candidates[0],
					candidateId: String(i),
				})),
			},
			{
				...original,
				candidates: Array.from({ length: 5 }, (_, i) => ({
					...original.candidates[0],
					candidateId: String(i),
					evidence: { text: 'x'.repeat(15000) },
				})),
			},
		])
			assert.throws(() =>
				f.store.review('task-1', 'occurrence-0', { review }, 0),
			)
		assert.deepEqual(f.store.get('task-1'), before)
	} finally {
		f.raw.close()
	}
})

void test('目录头保留1MiB UTF8原证据并重开恢复，超过1MiB拒绝且保留旧任务', () => {
	withFile((file) => {
		const exact = {
			text: 'x'.repeat(1024 * 1024 - JSON.stringify({ text: '' }).length),
		}
		let f = open(file)
		migrate(f.db)
		try {
			const store = new ImportStore(f.db)
			assert.equal(
				Buffer.byteLength(JSON.stringify(exact), 'utf8'),
				1024 * 1024,
			)
			const before = store.createDirectory(
				snapshot({ originalMetadata: exact }),
			)
			assert.deepEqual(before.originalMetadata, exact)
			assert.throws(
				() =>
					store.createDirectory(
						snapshot({
							taskId: 'too-large',
							taskVersion: 2,
							originalMetadata: { text: exact.text + 'x' },
						}),
					),
				/大小上限/,
			)
			assert.deepEqual(store.get('task-1'), before)
			assert.equal(store.get('too-large'), null)
		} finally {
			f.raw.close()
		}
		f = open(file)
		try {
			assert.deepEqual(
				new ImportStore(f.db).get('task-1')?.originalMetadata,
				exact,
			)
		} finally {
			f.raw.close()
		}
	})
})

void test('重试只追加实际记录，上限拒绝整次审核且保留原记录/选择/revision', () => {
	const f = setup()
	try {
		f.store.createDirectory(snapshot())
		for (let i = 0; i < 100; i++)
			f.store.review(
				'task-1',
				'occurrence-0',
				{ retry: { errorCode: null, message: `第${i + 1}次实际结果` } },
				i,
			)
		const before = f.store.get('task-1')!
		assert.equal(before.entries[0].retries.length, 100)
		assert.throws(
			() =>
				f.store.review(
					'task-1',
					'occurrence-0',
					{ selected: true, retry: { errorCode: null, message: '超限' } },
					100,
				),
			/上限/,
		)
		assert.deepEqual(f.store.get('task-1'), before)
	} finally {
		f.raw.close()
	}
})

void test('全任务审核预算按UTF8字节累计，超限更新连同选择/revision回滚', () => {
	const f = setup()
	try {
		const entries = Array.from({ length: 300 }, (_, index) => ({
			...snapshot().entries[0],
			entryId: `entry-${index}`,
			originalPosition: index,
		}))
		f.store.createDirectory(snapshot({ entries }))
		const large = candidate()
		large.candidates[0].metadata = { text: '字'.repeat(5000) }
		large.candidates[0].evidence = { text: '字'.repeat(5000) }
		// Seed valid earlier reviews in one SQLite fixture transaction; avoid hundreds
		// of unrelated full-detail reads just to reach the cumulative byte boundary.
		const text = JSON.stringify(large.candidates)
		const count = Math.floor(
			(importTaskLimits.taskReviewBytes - 600) / Buffer.byteLength(text),
		)
		f.raw
			.prepare(
				"UPDATE import_entries SET state = 'needs-review', candidatesJson = ? WHERE originalPosition < ?",
			)
			.run(text, count)
		const before = f.store.get('task-1')!
		assert.throws(
			() =>
				f.store.review(
					'task-1',
					`entry-${count}`,
					{ selected: true, review: large },
					0,
				),
			/大小上限/,
		)
		assert.deepEqual(f.store.get('task-1'), before)
	} finally {
		f.raw.close()
	}
})

void test('审核拒绝空/坏参数/跨任务entry，任务版本与审核revision分别处理', () => {
	const f = setup()
	try {
		const before = f.store.createDirectory(snapshot())
		assert.throws(() => f.store.review('task-1', 'occurrence-0', {}, 0))
		assert.throws(() =>
			f.store.review(
				'task-1',
				'occurrence-0',
				{ selected: 'yes' as unknown as boolean },
				0,
			),
		)
		assert.throws(() =>
			f.store.review('task-1', 'occurrence-0', { selected: true }, -1),
		)
		assert.throws(() =>
			f.store.review('task-1', 'unknown-entry', { selected: true }, 0),
		)
		assert.throws(() =>
			f.store.review('missing', 'occurrence-0', { selected: true }, 0),
		)
		assert.deepEqual(f.store.get('task-1'), before)
	} finally {
		f.raw.close()
	}
})
