import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, migrations, type Database } from '../core/database'
import type { ContentKind } from '../core/import-mixed-types'
import type { ImportOrganizationRequest } from '../core/import-organization-types'
import type {
	ImportDirectorySnapshot,
	ImportReview,
} from '../core/import-types'
import { ImportConflictError } from '../core/import-types'
import { ImportStore } from '../core/imports'
import { ListeningLibrary } from '../core/listening'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import { VideoSaves } from '../core/video-saves'

const A = 'BV1vT411i7ET',
	B = 'BV1Z9pb6MEwT'
const source = (bvid = A, cid = 11): Source => ({
	id: sourceId(bvid, cid),
	bvid,
	cid,
	originalTitle: '真实视频',
	uploader: 'UP',
	uploaderId: 88,
	performer: '人工表演者',
	artwork: 'https://example.invalid/a',
	duration: 90,
	domain: 'music',
	audioAvailability: 'unknown',
})
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
		imports: new ImportStore(db),
		library: new Library(db),
		playlists: new PlaylistStore(db),
		videos: new VideoSaves(db),
	}
}
type Fixture = ReturnType<typeof open>
function snapshot(
	taskId = 'task',
	bvs: (string | null)[] = [A, B, A],
): ImportDirectorySnapshot {
	return {
		taskId,
		provider: 'bilibili',
		originalPlaylistId: taskId,
		taskVersion: 1,
		originalMetadata: { title: '原收藏夹' },
		entries: bvs.map((bvid, index) => ({
			entryId: `e${index}`,
			originalEntryId: bvid,
			originalPosition: index * 3,
			originalMetadata: {
				media: { bvid, title: '原视频', evidence: { unchanged: true } },
				observed: { bvid },
			},
		})),
	}
}
function seed(f: Fixture, bvs: (string | null)[] = [A, B, A], taskId = 'task') {
	f.imports.createDirectory(snapshot(taskId, bvs))
	f.imports.setSelected(
		taskId,
		bvs.map((_, index) => `e${index}`),
		true,
		0,
	)
	return f.imports.commitMixed(taskId, {
		commitId: `initial-${taskId}`,
		expectedRevision: 1,
		musicTarget: null,
		songDuplicatePolicy: 'keep-all',
		videoDuplicatePolicy: 'keep-all',
		itemIds: bvs.map((_, index) => ({
			entryId: `e${index}`,
			itemId: `${taskId}:e${index}`,
		})),
	}).receipt
}
function decide(
	f: Fixture,
	kind: ContentKind,
	entryId = 'e0',
	taskId = 'task',
) {
	f.imports.reviewContent(
		taskId,
		entryId,
		{ kind },
		f.imports.get(taskId)!.revision,
	)
}
function request(
	f: Fixture,
	entryId = 'e0',
	taskId = 'task',
	operationId = `organize-${taskId}-${entryId}`,
): ImportOrganizationRequest {
	const { itemId, bvid, position, addedAt } = f.videos.get(
		`${taskId}:${entryId}`,
	)!
	const kind = f.imports
		.getMixed(taskId)!
		.contentReviews.find((row) => row.entryId === entryId)!.kind
	return {
		operationId,
		expectedRevision: f.imports.get(taskId)!.revision,
		expectedItem: { itemId, bvid, position, addedAt },
		musicTarget:
			kind === 'song'
				? {
						kind: 'create',
						playlistId: `music-${taskId}-${entryId}`,
						name: ' 整理后的歌曲 ',
					}
				: null,
	}
}
function confirm(
	f: Fixture,
	entryId = 'e0',
	taskId = 'task',
	value = source(),
) {
	f.library.save(value)
	const review: ImportReview = {
		state: 'confirmed',
		candidates: [
			{
				candidateId: value.id,
				bvid: value.bvid,
				cid: value.cid,
				metadata: { title: value.originalTitle },
				evidence: { method: 'explicit-user' },
			},
		],
		confirmation: { candidateId: value.id, sourceId: value.id },
	}
	return f.imports.review(
		taskId,
		entryId,
		{ review },
		f.imports.get(taskId)!.revision,
	)
}
function dump(f: Fixture) {
	return f.raw
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all()
		.map((row) => ({
			name: row.name,
			rows: f.raw
				.prepare(`SELECT * FROM "${String(row.name)}" ORDER BY rowid`)
				.all(),
		}))
}
function conflict(code = 'IMPORT_TARGET_CONFLICT') {
	return (error: unknown) =>
		error instanceof ImportConflictError && error.code === code
}
function originBytes(f: Fixture, itemId: string) {
	return f.raw
		.prepare('SELECT originJson FROM saved_video_items WHERE itemId=?')
		.get(itemId)!.originJson
}

void test('真实v10→v11迁移/重开保持所有旧行、unknown出现项与初始receipt；迁移SQL末段失败仍可重试', () => {
	const dir = mkdtempSync(join(tmpdir(), 'melo-organization-upgrade-'))
	let f: Fixture | null = null
	try {
		const file = join(dir, 'db')
		f = open(file, 10)
		const initial = seed(f)
		f.library.setLiked(source(), true)
		new ListeningLibrary(f.db).saveResumePoint({
			sourceId: source().id,
			positionSeconds: 20.227,
			durationSeconds: 90,
			completed: false,
			updatedAt: 100,
		})
		const before = dump(f),
			schema = f.raw.prepare('SELECT * FROM sqlite_master ORDER BY name').all()
		const failure = migrations[10].replace(
			'CREATE INDEX import_item_organizations_task',
			'CREATE INDEX saved_video_bucket_bvid',
		)
		assert.throws(
			() => migrate(f!.db, [...migrations.slice(0, 10), failure]),
			/already exists/,
		)
		assert.deepEqual(dump(f), before)
		assert.deepEqual(
			f.raw.prepare('SELECT * FROM sqlite_master ORDER BY name').all(),
			schema,
		)
		assert.equal(f.raw.prepare('PRAGMA user_version').get()!.user_version, 10)
		migrate(f.db)
		for (const table of before)
			assert.deepEqual(
				f.raw
					.prepare(`SELECT * FROM "${String(table.name)}" ORDER BY rowid`)
					.all(),
				table.rows,
			)
		assert.deepEqual(f.imports.getMixed('task')!.organizations, [])
		assert.deepEqual(f.imports.getMixed('task')!.history[0].receipt, initial)
		f.raw.close()
		f = open(file)
		decide(f, 'knowledge')
		const input = request(f),
			result = f.imports.organizeUnclassified('task', 'e0', input)
		f.raw.close()
		f = open(file)
		assert.deepEqual(
			f.imports.organizeUnclassified('task', 'e0', input).receipt,
			result.receipt,
		)
		assert.deepEqual(f.imports.getMixed('task')!.history[0].receipt, initial)
		assert.equal(f.imports.getMixed('task')!.organizations.length, 1)
		assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), [])
	} finally {
		f?.raw.close()
		rmSync(dir, { recursive: true, force: true })
	}
})

void test('unknown→长内容/音乐合集只移原出现项，A/B/A按目标末尾稳定追加，origin/addedAt原字节保留', () => {
	const f = open()
	try {
		const initial = seed(f),
			items = f.videos.list('unclassified', { offset: 0, limit: 100 }),
			bytes = items.map((item) => originBytes(f, item.itemId)),
			ledger = f.raw
				.prepare('SELECT * FROM import_commit_entries ORDER BY entryId')
				.all()
		for (const [index, kind] of [
			'knowledge',
			'musicCollection',
			'audioDrama',
		].entries()) {
			decide(f, kind as ContentKind, `e${index}`)
			const result = f.imports.organizeUnclassified(
				'task',
				`e${index}`,
				request(f, `e${index}`),
			)
			assert.equal(result.playlist, null)
			assert.equal(result.video!.itemId, items[index].itemId)
			assert.equal(result.video!.addedAt, items[index].addedAt)
			assert.deepEqual(result.video!.importOrigin, items[index].importOrigin)
			assert.equal(originBytes(f, items[index].itemId), bytes[index])
			assert.equal(result.video!.position, index)
			assert.equal(result.receipt.verification.audioCapability, 'unchecked')
		}
		assert.deepEqual(
			f.videos
				.list('listening', { offset: 0, limit: 100 })
				.map((item) => [item.bvid, item.contentKind]),
			[
				[A, 'knowledge'],
				[B, 'musicCollection'],
				[A, 'audioDrama'],
			],
		)
		assert.equal(
			f.videos.list('unclassified', { offset: 0, limit: 100 }).length,
			0,
		)
		assert.deepEqual(
			f.raw
				.prepare('SELECT * FROM import_commit_entries ORDER BY entryId')
				.all(),
			ledger,
		)
		assert.deepEqual(
			f.imports.getMixed('task')!.history.map((row) => row.receipt),
			[initial],
		)
		assert.equal(f.imports.getMixed('task')!.organizations.length, 3)
		assert.equal(f.playlists.list().length, 0)
	} finally {
		f.raw.close()
	}
})

void test('unknown→确认CID歌曲保原item/origin/addedAt且不改变Source分类，目标已有相同Source仍保留原出现项', () => {
	const f = open()
	try {
		seed(f, [A])
		const old = f.videos.get('task:e0')!,
			bytes = originBytes(f, old.itemId)
		decide(f, 'song')
		confirm(f)
		f.playlists.create('existing', '已有')
		f.playlists.append(
			'existing',
			[{ itemId: 'existing-copy', source: source() }],
			'keep-all',
		)
		const input = {
			...request(f),
			musicTarget: {
				kind: 'append' as const,
				playlistId: 'existing',
				expectedUpdatedAt: f.playlists.get('existing')!.updatedAt,
			},
		}
		assert.throws(
			() =>
				f.imports.organizeUnclassified('task', 'e0', {
					...input,
					musicTarget: null,
				}),
			/歌曲须明确音乐目标/,
		)
		const beforeSource = f.library.get(source().id),
			result = f.imports.organizeUnclassified('task', 'e0', input)
		assert.deepEqual(
			result.playlist!.items.map((item) => item.sourceId),
			[source().id, source().id],
		)
		const moved = result.playlist!.items[1]
		assert.equal(moved.itemId, old.itemId)
		assert.equal(moved.addedAt, old.addedAt)
		assert.deepEqual(moved.importOrigin, old.importOrigin)
		assert.equal(
			f.raw
				.prepare('SELECT originJson FROM playlist_items WHERE itemId=?')
				.get(old.itemId)!.originJson,
			bytes,
		)
		assert.equal(f.videos.get(old.itemId), null)
		assert.equal(result.receipt.position, 1)
		assert.equal(result.receipt.sourceId, source().id)
		assert.equal(result.receipt.verification.audioCapability, 'unchecked')
		assert.deepEqual(f.library.get(source().id), beforeSource)
		assert.equal(f.library.likes().length, 0)
	} finally {
		f.raw.close()
	}
})

void test('歌曲无CID可整理为pending，公共review→remove/undo→resolve仅补原item并只写组织resolved事实', () => {
	const f = open()
	try {
		const initial = seed(f, [A]),
			ledger = f.raw.prepare('SELECT * FROM import_commit_entries').all()
		decide(f, 'song')
		const input = request(f),
			result = f.imports.organizeUnclassified('task', 'e0', input),
			receipt = result.receipt
		assert.equal(result.playlist!.items[0].sourceId, null)
		f.playlists.copy(receipt.targetId, 'copy', '副本', ['copy-item'])
		const removal = f.playlists.remove(receipt.targetId, [receipt.itemId])!
		f.playlists.undoRemove(removal)
		assert.throws(() => confirm(f, 'e0', 'task', source(B)), /原目录 BV/)
		confirm(f)
		const resolve = {
			playlistId: receipt.targetId,
			itemId: receipt.itemId,
			expectedRevision: f.imports.get('task')!.revision,
			expectedUpdatedAt: f.playlists.get(receipt.targetId)!.updatedAt,
		}
		assert.throws(
			() =>
				f.imports.resolvePending('task', 'e0', {
					...resolve,
					playlistId: 'copy',
					itemId: 'copy-item',
					expectedUpdatedAt: f.playlists.get('copy')!.updatedAt,
				}),
			conflict(),
		)
		assert.equal(
			f.imports.resolvePending('task', 'e0', resolve).items[0].sourceId,
			source().id,
		)
		assert.equal(f.playlists.get('copy')!.items[0].sourceId, null)
		assert.deepEqual(
			f.raw.prepare('SELECT * FROM import_commit_entries').all(),
			ledger,
		)
		assert.equal(
			f.raw
				.prepare('SELECT resolvedSourceId FROM import_item_organizations')
				.get()!.resolvedSourceId,
			source().id,
		)
		assert.deepEqual(f.imports.getMixed('task')!.history[0].receipt, initial)
		assert.deepEqual(f.imports.getMixed('task')!.organizations[0], receipt)
		assert.deepEqual(
			f.imports.organizeUnclassified('task', 'e0', input).receipt,
			receipt,
		)
		assert.equal(receipt.sourceId, null)
		assert.throws(
			() =>
				f.imports.resolvePending('task', 'e0', {
					...resolve,
					expectedRevision: f.imports.get('task')!.revision,
					expectedUpdatedAt: f.playlists.get(receipt.targetId)!.updatedAt,
				}),
			conflict(),
		)
	} finally {
		f.raw.close()
	}
})

void test('原证据缺BV仍可保留并整理为pending歌曲，但不能由候选伪造BV确认；未知类型不移动', () => {
	const f = open()
	try {
		seed(f, [null])
		const before = dump(f)
		assert.throws(
			() => f.imports.organizeUnclassified('task', 'e0', request(f)),
			/明确核对内容类型/,
		)
		assert.deepEqual(dump(f), before)
		decide(f, 'song')
		assert.throws(() => confirm(f), /原目录 BV/)
		const result = f.imports.organizeUnclassified('task', 'e0', request(f))
		assert.equal(result.receipt.bvid, null)
		assert.equal(result.playlist!.items[0].sourceId, null)
		assert.equal(
			result.playlist!.items[0].importOrigin!.originalMetadata.media &&
				typeof result.playlist!.items[0].importOrigin!.originalMetadata.media,
			'object',
		)
		assert.throws(() => confirm(f), /原目录 BV/)
		assert.equal(result.receipt.verification.sourceConfirmed, false)
	} finally {
		f.raw.close()
	}
})

void test('精确operationId canonical重放先于当前revision/item/目标检查，不复活删除结果；换operation不能重搬', () => {
	const f = open()
	try {
		seed(f, [A, B])
		decide(f, 'song')
		const input = request(f),
			receipt = f.imports.organizeUnclassified('task', 'e0', input).receipt
		f.playlists.delete(receipt.targetId)
		decide(f, 'knowledge')
		const replay = f.imports.organizeUnclassified('task', 'e0', {
			...input,
			musicTarget: {
				kind: 'create',
				playlistId: receipt.targetId,
				name: '整理后的歌曲',
			},
		})
		assert.deepEqual(replay.receipt, receipt)
		assert.equal(replay.playlist, null)
		assert.equal(f.videos.get(receipt.itemId), null)
		assert.throws(
			() =>
				f.imports.organizeUnclassified('task', 'e0', {
					...input,
					expectedRevision: f.imports.get('task')!.revision,
					operationId: 'different',
				}),
			conflict('IMPORT_COMMIT_CONFLICT'),
		)
		assert.throws(
			() =>
				f.imports.organizeUnclassified('task', 'e0', {
					...input,
					expectedRevision: input.expectedRevision + 1,
				}),
			conflict('IMPORT_COMMIT_CONFLICT'),
		)
		assert.throws(
			() => f.imports.organizeUnclassified('task', 'e1', input),
			conflict('IMPORT_COMMIT_CONFLICT'),
		)
		decide(f, 'musicCollection', 'e1')
		const longInput = request(f, 'e1'),
			long = f.imports.organizeUnclassified('task', 'e1', longInput)
		f.videos.remove(long.receipt.itemId)
		decide(f, 'song', 'e1')
		assert.equal(
			f.imports.organizeUnclassified('task', 'e1', longInput).video,
			null,
		)
		assert.deepEqual(
			f.imports.getMixed('task')!.organizations.map((row) => row.contentKind),
			['song', 'musicCollection'],
		)
	} finally {
		f.raw.close()
	}
})

void test('原saved item精确guard、原ledger绑定、错误条目/目标/源删除均不吞数据', () => {
	const f = open()
	try {
		seed(f, [A, B])
		decide(f, 'knowledge')
		const input = request(f),
			before = dump(f)
		for (const expectedItem of [
			{ ...input.expectedItem, itemId: 'task:e1' },
			{ ...input.expectedItem, bvid: B },
			{ ...input.expectedItem, addedAt: input.expectedItem.addedAt + 1 },
			{ ...input.expectedItem, position: 999 },
		])
			assert.throws(
				() =>
					f.imports.organizeUnclassified('task', 'e0', {
						...input,
						expectedItem,
					}),
				conflict(),
			)
		assert.throws(
			() => f.imports.organizeUnclassified('task', 'missing', input),
			/出现项不存在/,
		)
		assert.deepEqual(dump(f), before)
		f.videos.remove('task:e0')
		assert.throws(
			() => f.imports.organizeUnclassified('task', 'e0', input),
			conflict(),
		)
		assert.equal(f.imports.getMixed('task')!.organizations.length, 0)
		assert.equal(f.videos.get('task:e1')!.bucket, 'unclassified')
	} finally {
		f.raw.close()
	}
})

void test('双连接任务/目的地版本冲突拒绝旧操作，类型修改本身不自动移动保存项', () => {
	const dir = mkdtempSync(join(tmpdir(), 'melo-organize-conflict-'))
	let f: Fixture | null = null,
		other: Fixture | null = null
	try {
		const file = join(dir, 'db')
		f = open(file)
		other = open(file)
		seed(f, [A])
		decide(f, 'song')
		const old = request(f)
		other.imports.reviewContent(
			'task',
			'e0',
			{ kind: 'knowledge' },
			other.imports.get('task')!.revision,
		)
		assert.throws(
			() => f!.imports.organizeUnclassified('task', 'e0', old),
			conflict('IMPORT_REVISION_CONFLICT'),
		)
		assert.equal(f.videos.get('task:e0')!.bucket, 'unclassified')
		decide(f, 'song')
		f.playlists.create('append', '目标')
		const append = {
			...request(f),
			musicTarget: {
				kind: 'append' as const,
				playlistId: 'append',
				expectedUpdatedAt: f.playlists.get('append')!.updatedAt,
			},
		}
		other.playlists.rename('append', '较新编辑')
		assert.throws(
			() => f!.imports.organizeUnclassified('task', 'e0', append),
			conflict(),
		)
		other.playlists.delete('append')
		assert.throws(
			() => f!.imports.organizeUnclassified('task', 'e0', append),
			conflict(),
		)
		assert.equal(f.videos.get('task:e0')!.bucket, 'unclassified')
		assert.equal(f.imports.getMixed('task')!.organizations.length, 0)
	} finally {
		other?.raw.close()
		f?.raw.close()
		rmSync(dir, { recursive: true, force: true })
	}
})

void test('所有去向原身份仍被历史ledger保留，公开append/copy/new mixed不能在整理删除后冒用', () => {
	const f = open()
	try {
		seed(f, [A])
		decide(f, 'song')
		const result = f.imports.organizeUnclassified('task', 'e0', request(f))
		f.playlists.delete(result.receipt.targetId)
		f.playlists.create('manual', 'manual')
		f.playlists.append(
			'manual',
			[{ itemId: 'm', source: source() }],
			'keep-all',
		)
		assert.throws(
			() =>
				f.playlists.append(
					'manual',
					[{ itemId: 'task:e0', source: source() }],
					'keep-all',
				),
			/已用于导入/,
		)
		assert.throws(
			() => f.playlists.copy('manual', 'copy', 'copy', ['task:e0']),
			/已用于导入/,
		)
		f.imports.createDirectory(snapshot('new', [B]))
		f.imports.setSelected('new', ['e0'], true, 0)
		assert.throws(
			() =>
				f.imports.commitMixed('new', {
					commitId: 'new',
					expectedRevision: 1,
					musicTarget: null,
					songDuplicatePolicy: 'keep-all',
					videoDuplicatePolicy: 'keep-all',
					itemIds: [{ entryId: 'e0', itemId: 'task:e0' }],
				}),
			conflict('IMPORT_COMMIT_CONFLICT'),
		)
		assert.equal(f.imports.getMixed('task')!.history.length, 1)
	} finally {
		f.raw.close()
	}
})

for (const [stage, trigger] of [
	[
		'target',
		"CREATE TRIGGER fail BEFORE INSERT ON playlist_items BEGIN SELECT RAISE(ABORT,'fail-target'); END",
	],
	[
		'source',
		"CREATE TRIGGER fail BEFORE DELETE ON saved_video_items BEGIN SELECT RAISE(ABORT,'fail-source'); END",
	],
	[
		'record',
		"CREATE TRIGGER fail BEFORE INSERT ON import_item_organizations BEGIN SELECT RAISE(ABORT,'fail-record'); END",
	],
	[
		'revision',
		"CREATE TRIGGER fail BEFORE UPDATE ON import_tasks BEGIN SELECT RAISE(ABORT,'fail-revision'); END",
	],
] as const)
	void test(`整理歌曲${stage}真实SQLite失败完整回滚新目标/原项/记录/revision，原命令可重试`, () => {
		const f = open()
		try {
			seed(f, [A])
			decide(f, 'song')
			const input = request(f),
				before = dump(f)
			f.raw.exec(trigger)
			assert.throws(
				() => f.imports.organizeUnclassified('task', 'e0', input),
				new RegExp(`fail-${stage}`),
			)
			f.raw.exec('DROP TRIGGER fail')
			assert.deepEqual(dump(f), before)
			assert.equal(
				f.imports.organizeUnclassified('task', 'e0', input).playlist!.items[0]
					.itemId,
				'task:e0',
			)
		} finally {
			f.raw.close()
		}
	})

void test('长内容bucket更新失败/真实deferred FK COMMIT失败回滚，仍保原unknown与账本', () => {
	const f = open()
	try {
		seed(f, [A])
		decide(f, 'musicCollection')
		const input = request(f),
			before = dump(f)
		f.raw.exec(
			"CREATE TRIGGER fail BEFORE UPDATE ON saved_video_items BEGIN SELECT RAISE(ABORT,'fail-bucket'); END",
		)
		assert.throws(
			() => f.imports.organizeUnclassified('task', 'e0', input),
			/fail-bucket/,
		)
		f.raw.exec('DROP TRIGGER fail')
		assert.deepEqual(dump(f), before)
		f.raw.exec(
			"CREATE TRIGGER deferred AFTER INSERT ON import_item_organizations BEGIN INSERT INTO video_catalog_parts(bvid,page,sourceId,title) VALUES ('missing',1,'missing','bad'); END",
		)
		const exec = f.db.execSync.bind(f.db)
		let atCommit = false
		f.db.execSync = (sql) => {
			if (sql === 'COMMIT') atCommit = true
			exec(sql)
			if (sql === 'BEGIN IMMEDIATE') exec('PRAGMA defer_foreign_keys=ON')
		}
		assert.throws(
			() => f.imports.organizeUnclassified('task', 'e0', input),
			/FOREIGN KEY/,
		)
		f.db.execSync = exec
		f.raw.exec('DROP TRIGGER deferred')
		assert.equal(atCommit, true)
		assert.deepEqual(dump(f), before)
		assert.equal(
			f.imports.organizeUnclassified('task', 'e0', input).video!.bucket,
			'listening',
		)
		assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), [])
	} finally {
		f.raw.close()
	}
})

void test('组织后resolve失败只回滚补全，保留原pending和冻结整理receipt，修复可重试', () => {
	const f = open()
	try {
		seed(f, [A])
		decide(f, 'song')
		const result = f.imports.organizeUnclassified('task', 'e0', request(f))
		confirm(f)
		const input = {
				playlistId: result.receipt.targetId,
				itemId: 'task:e0',
				expectedRevision: f.imports.get('task')!.revision,
				expectedUpdatedAt: f.playlists.get(result.receipt.targetId)!.updatedAt,
			},
			before = dump(f)
		f.raw.exec(
			"CREATE TRIGGER fail BEFORE UPDATE OF resolvedSourceId ON import_item_organizations BEGIN SELECT RAISE(ABORT,'fail-resolve'); END",
		)
		assert.throws(
			() => f.imports.resolvePending('task', 'e0', input),
			/fail-resolve/,
		)
		f.raw.exec('DROP TRIGGER fail')
		assert.deepEqual(dump(f), before)
		assert.equal(
			f.imports.resolvePending('task', 'e0', input).items[0].sourceId,
			source().id,
		)
		assert.deepEqual(f.imports.getMixed('task')!.organizations, [
			result.receipt,
		])
	} finally {
		f.raw.close()
	}
})

void test('只整理初始added unknown原项，普通听视频及跳过项不能借复制证据或错误目标进入组织路径', () => {
	const f = open()
	try {
		seed(f, [A])
		decide(f, 'knowledge')
		const long = f.imports.organizeUnclassified('task', 'e0', request(f))
		assert.throws(
			() =>
				f.imports.resolvePending('task', 'e0', {
					playlistId: 'fake',
					itemId: 'task:e0',
					expectedRevision: f.imports.get('task')!.revision,
					expectedUpdatedAt: 1,
				}),
			conflict(),
		)
		assert.throws(
			() =>
				f.imports.organizeUnclassified('task', 'e0', {
					...long.receipt.request,
					operationId: 'again',
					expectedRevision: f.imports.get('task')!.revision,
				}),
			conflict('IMPORT_COMMIT_CONFLICT'),
		)
		f.imports.createDirectory(snapshot('known', [B]))
		f.imports.setSelected('known', ['e0'], true, 0)
		decide(f, 'knowledge', 'e0', 'known')
		f.imports.commitMixed('known', {
			commitId: 'known',
			expectedRevision: f.imports.get('known')!.revision,
			musicTarget: null,
			songDuplicatePolicy: 'keep-all',
			videoDuplicatePolicy: 'keep-all',
			itemIds: [{ entryId: 'e0', itemId: 'known:e0' }],
		})
		assert.throws(
			() =>
				f.imports.organizeUnclassified(
					'known',
					'e0',
					request(f, 'e0', 'known'),
				),
			conflict(),
		)
		assert.equal(f.videos.get('known:e0')!.bucket, 'listening')
		f.imports.createDirectory(snapshot('skip', [B, B]))
		f.imports.setSelected('skip', ['e0', 'e1'], true, 0)
		f.imports.commitMixed('skip', {
			commitId: 'skip',
			expectedRevision: 1,
			musicTarget: null,
			songDuplicatePolicy: 'keep-all',
			videoDuplicatePolicy: 'skip-existing-video',
			itemIds: [
				{ entryId: 'e0', itemId: 'skip:e0' },
				{ entryId: 'e1', itemId: 'skip:e1' },
			],
		})
		decide(f, 'knowledge', 'e1', 'skip')
		assert.throws(
			() =>
				f.imports.organizeUnclassified('skip', 'e1', {
					operationId: 'organize-skipped',
					expectedRevision: f.imports.get('skip')!.revision,
					expectedItem: { itemId: 'skip:e1', bvid: B, position: 0, addedAt: 0 },
					musicTarget: null,
				}),
			conflict(),
		)
		assert.equal(f.videos.get('skip:e1'), null)
	} finally {
		f.raw.close()
	}
})
