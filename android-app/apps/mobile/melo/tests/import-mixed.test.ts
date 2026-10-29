import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, migrations, type Database } from '../core/database'
import type {
	ContentKind,
	MixedCommitRequest,
} from '../core/import-mixed-types'
import type { ImportCommitRequest } from '../core/import-playlist-types'
import {
	ImportConflictError,
	type ImportDirectorySnapshot,
	type ImportReview,
} from '../core/import-types'
import { ImportStore } from '../core/imports'
import { ListeningLibrary } from '../core/listening'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import { SessionStore } from '../core/sessions'
import { VideoCatalog } from '../core/video-catalog'
import { VideoSaves } from '../core/video-saves'
import { parseListeningVideo } from '../listening-source'

const A = 'BV1vT411i7ET',
	B = 'BV1Z9pb6MEwT'
const source = (bvid = A, cid = 11): Source => ({
	id: sourceId(bvid, cid),
	bvid,
	cid,
	originalTitle: `视频${bvid}`,
	uploader: 'UP',
	uploaderId: 88,
	performer: '人工表演者',
	artwork: 'https://example.invalid/cover',
	duration: 90,
	domain: 'music',
	audioAvailability: 'unknown',
})
function video(bvid = A) {
	return parseListeningVideo(
		{
			bvid,
			title: `视频${bvid}`,
			pic: 'https://example.invalid/cover',
			owner: { mid: 88, name: 'UP' },
			videos: 2,
			pages: [11, 22].map((cid, index) => ({
				cid,
				page: index + 1,
				part: `P${index + 1}`,
				duration: 90,
			})),
		},
		bvid,
	)
}
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
		library: new Library(db),
		imports: new ImportStore(db),
		playlists: new PlaylistStore(db),
		catalog: new VideoCatalog(db),
		saves: new VideoSaves(db),
	}
}
type Fixture = ReturnType<typeof open>
function snapshot(
	taskId = 'task',
	bvs: (string | null)[] = [A, B, A, null],
	provider: ImportDirectorySnapshot['provider'] = 'bilibili',
): ImportDirectorySnapshot {
	return {
		taskId,
		provider,
		originalPlaylistId: `remote-${taskId}`,
		taskVersion: 1,
		originalMetadata: { title: '原收藏夹', untouched: ['完整证据'] },
		entries: bvs.map((bvid, index) => ({
			entryId: `e${index}`,
			originalEntryId: bvid === null ? null : `2:${bvid === A ? 1 : 2}`,
			originalPosition: index * 2,
			originalMetadata: {
				media: { bvid, title: bvid ?? '失效内容', untouched: true },
				observed: { bvid },
			},
		})),
	}
}
function make(
	f: Fixture,
	kinds: ContentKind[],
	taskId = 'task',
	bvs: (string | null)[] = kinds.map((_, index) => (index % 2 ? B : A)),
) {
	f.imports.createDirectory(snapshot(taskId, bvs))
	f.imports.setSelected(
		taskId,
		kinds.map((_, index) => `e${index}`),
		true,
		0,
	)
	for (const [index, kind] of kinds.entries())
		if (kind !== 'unknown')
			f.imports.reviewContent(
				taskId,
				`e${index}`,
				{ kind },
				f.imports.get(taskId)!.revision,
			)
}
function confirmed(value: Source): ImportReview {
	return {
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
}
function confirm(
	f: Fixture,
	entryId = 'e0',
	taskId = 'task',
	value = source(),
) {
	f.library.save(value)
	return f.imports.review(
		taskId,
		entryId,
		{ review: confirmed(value) },
		f.imports.get(taskId)!.revision,
	)
}
function command(
	f: Fixture,
	taskId = 'task',
	commitId = `commit-${taskId}`,
): MixedCommitRequest {
	const task = f.imports.getMixed(taskId)!
	const processed = new Set(
		task.history.flatMap((record) =>
			record.receipt.results.map((result) => result.entryId),
		),
	)
	const entries = task.entries.filter(
		(entry) => entry.selected && !processed.has(entry.entryId),
	)
	const hasSong = entries.some(
		(entry) =>
			task.contentReviews.find((review) => review.entryId === entry.entryId)
				?.kind === 'song',
	)
	return {
		commitId,
		expectedRevision: task.revision,
		musicTarget: hasSong
			? { kind: 'create', playlistId: `playlist-${taskId}`, name: ' 本地歌曲 ' }
			: null,
		songDuplicatePolicy: 'keep-all',
		videoDuplicatePolicy: 'keep-all',
		itemIds: entries.map((entry) => ({
			entryId: entry.entryId,
			itemId: `${taskId}:${entry.entryId}`,
		})),
	}
}
function page(f: Fixture, bucket: 'listening' | 'unclassified') {
	return f.saves.list(bucket, { offset: 0, limit: 100 })
}
function dump(f: Fixture) {
	return f.raw
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
		)
		.all()
		.map((row) => ({
			name: row.name,
			rows: f.raw
				.prepare(`SELECT * FROM "${String(row.name)}" ORDER BY rowid`)
				.all(),
		}))
}
function conflict(code: string) {
	return (error: unknown) =>
		error instanceof ImportConflictError && error.code === code
}

void test('v9→当前版本真实文件保留v8原字节命令、补全null历史、已删目标、精确队列与视频目录，重开可重放', () => {
	const dir = mkdtempSync(join(tmpdir(), 'melo-mixed-upgrade-'))
	let connection: Fixture | null = null
	try {
		const file = join(dir, 'library.db')
		let f = open(file, 8)
		connection = f
		const a = source(),
			b = source(B)
		f.library.save(a)
		f.library.save(b)
		f.library.setLiked(a, true)
		new ListeningLibrary(f.db).saveResumePoint({
			sourceId: a.id,
			positionSeconds: 20.227,
			durationSeconds: 90,
			completed: false,
			updatedAt: 100,
		})
		new SessionStore(f.db).saveSession({
			mode: 'music',
			entries: [
				{ entryId: 'playlist-item:first', sourceId: a.id },
				{ entryId: 'playlist-item:middle', sourceId: b.id },
				{ entryId: 'playlist-item:third', sourceId: a.id },
			],
			currentEntryId: 'playlist-item:third',
			currentSourceId: a.id,
			positionSeconds: 20.227,
			speed: 1,
			updatedAt: 101,
		})
		f.imports.createDirectory(snapshot('legacy', [A, B, A], 'netease'))
		f.imports.setSelected('legacy', ['e0', 'e1', 'e2'], true, 0)
		confirm(f, 'e0', 'legacy', a)
		confirm(f, 'e2', 'legacy', a)
		const legacy: ImportCommitRequest = {
			commitId: 'old',
			expectedRevision: f.imports.get('legacy')!.revision,
			target: { kind: 'create', playlistId: 'old-playlist', name: '旧列表' },
			duplicatePolicy: 'skip-existing-source',
			itemIds: ['e0', 'e1', 'e2'].map((entryId) => ({
				entryId,
				itemId: `old-${entryId}`,
			})),
		}
		const oldReceipt = f.imports.commitSelected('legacy', legacy).receipt
		confirm(f, 'e1', 'legacy', b)
		f.imports.resolvePending('legacy', 'e1', {
			playlistId: 'old-playlist',
			itemId: 'old-e1',
			expectedRevision: f.imports.get('legacy')!.revision,
			expectedUpdatedAt: f.playlists.get('old-playlist')!.updatedAt,
		})
		f.playlists.copy('old-playlist', 'copy', '副本', ['copy-a', 'copy-pending'])
		f.imports.createDirectory(snapshot('deleted', [A], 'qq'))
		f.imports.setSelected('deleted', ['e0'], true, 0)
		const deleted: ImportCommitRequest = {
			...legacy,
			commitId: 'deleted-commit',
			expectedRevision: 1,
			target: { kind: 'create', playlistId: 'deleted-target', name: '将删除' },
			itemIds: [{ entryId: 'e0', itemId: 'deleted-item' }],
		}
		f.imports.commitSelected('deleted', deleted)
		f.playlists.delete('deleted-target')
		migrate(f.db, migrations.slice(0, 9))
		f.catalog.save(video(), 500)
		f.catalog.recordVisitedPart(A, a.id)
		const before = dump(f),
			oldCommits = f.raw
				.prepare('SELECT * FROM import_commits ORDER BY commitId')
				.all(),
			oldLedger = f.raw
				.prepare('SELECT * FROM import_commit_entries ORDER BY taskId,entryId')
				.all()
		migrate(f.db)
		for (const table of before.filter(
			(snapshotTable) =>
				!['import_commits', 'import_commit_entries'].includes(
					String(snapshotTable.name),
				),
		))
			assert.deepEqual(
				f.raw
					.prepare(`SELECT * FROM "${String(table.name)}" ORDER BY rowid`)
					.all(),
				table.name === 'playlists'
					? table.rows.map((row) =>
							Object.assign(row, { description: '', coverUri: null }),
						)
					: table.rows,
			)
		for (const row of oldCommits) {
			const after = f.raw
				.prepare('SELECT * FROM import_commits WHERE commitId = ?')
				.get(row.commitId)!
			for (const key of Object.keys(row)) assert.equal(after[key], row[key])
			assert.equal(after.kind, 'playlist')
		}
		for (const row of oldLedger) {
			const after = f.raw
				.prepare(
					'SELECT * FROM import_commit_entries WHERE taskId = ? AND entryId = ?',
				)
				.get(row.taskId, row.entryId)!
			for (const key of Object.keys(row)) assert.equal(after[key], row[key])
			assert.equal(after.targetKind, 'playlist')
		}
		assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), [])
		assert.deepEqual(
			f.imports.commitSelected('legacy', legacy).receipt,
			oldReceipt,
		)
		assert.equal(f.imports.commitSelected('deleted', deleted).playlist, null)
		assert.equal(
			f.raw
				.prepare(
					"SELECT sourceId FROM import_commit_entries WHERE taskId='legacy' AND entryId='e1'",
				)
				.get()!.sourceId,
			null,
		)
		assert.equal(
			f.raw
				.prepare(
					"SELECT resolvedSourceId FROM import_commit_entries WHERE taskId='legacy' AND entryId='e1'",
				)
				.get()!.resolvedSourceId,
			b.id,
		)
		f.raw.close()
		f = open(file)
		connection = f
		assert.deepEqual(
			f.imports.commitSelected('legacy', legacy).receipt,
			oldReceipt,
		)
		assert.equal(
			new SessionStore(f.db).getSession('music')!.currentEntryId,
			'playlist-item:third',
		)
		assert.equal(f.catalog.get(A)!.lastVisited!.sourceId, a.id)
		assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), [])
		f.raw.close()
	} finally {
		try {
			connection?.raw.close()
		} catch {
			/* Already closed after success. */
		}
		rmSync(dir, { recursive: true, force: true })
	}
})

void test('三目标原子保存、原A/B/A顺序、musicCollection保留BV和音乐类型，不虚报音频可用', () => {
	const f = open()
	try {
		make(
			f,
			['song', 'musicCollection', 'knowledge', 'unknown', 'song'],
			'task',
			[A, B, A, null, B],
		)
		confirm(f)
		f.catalog.save(video(B), 900)
		const beforeSource = f.library.get(source().id)
		const result = f.imports.commitMixed('task', command(f))
		assert.deepEqual(
			result.receipt.results.map((row) => row.targetKind),
			['playlist', 'listening', 'listening', 'unclassified', 'playlist'],
		)
		assert.deepEqual(
			result.playlist!.items.map((row) => row.sourceId),
			[source().id, null],
		)
		assert.deepEqual(
			page(f, 'listening').map((row) => [
				row.bvid,
				row.contentKind,
				row.importOrigin.originalPosition,
			]),
			[
				[B, 'musicCollection', 2],
				[A, 'knowledge', 4],
			],
		)
		assert.equal(page(f, 'unclassified')[0].bvid, null)
		assert.equal(result.receipt.results[1].verification.catalogVerified, true)
		assert.equal(result.receipt.results[1].sourceId, null)
		assert.ok(
			result.receipt.results.every(
				(row) => row.verification.audioCapability === 'unchecked',
			),
		)
		assert.deepEqual(result.receipt.counts, {
			playlist: { added: 2, skipped: 0, withoutConfirmedCid: 1 },
			listening: { added: 2, skipped: 0 },
			unclassified: { added: 1, skipped: 0 },
			unselected: 0,
			unprocessed: 0,
		})
		assert.deepEqual(f.library.get(source().id), beforeSource)
		assert.equal(f.imports.get('task')!.commits.length, 0)
		assert.equal(f.imports.getMixed('task')!.history[0].kind, 'mixed')
	} finally {
		f.raw.close()
	}
})

void test('v10迁移末段真实SQL错误回滚表/外键/索引/版本，旧v9重开保持原任务与receipt并可重试', () => {
	const dir = mkdtempSync(join(tmpdir(), 'melo-mixed-migration-fail-'))
	let f: Fixture | null = null
	try {
		const file = join(dir, 'db')
		f = open(file, 9)
		f.imports.createDirectory(snapshot('legacy', [A], 'qq'))
		f.imports.setSelected('legacy', ['e0'], true, 0)
		const old: ImportCommitRequest = {
			commitId: 'legacy',
			expectedRevision: 1,
			target: { kind: 'create', playlistId: 'legacy', name: 'legacy' },
			duplicatePolicy: 'keep-all',
			itemIds: [{ entryId: 'e0', itemId: 'legacy-item' }],
		}
		const receipt = f.imports.commitSelected('legacy', old).receipt
		const before = dump(f),
			schema = f.raw
				.prepare(
					'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name',
				)
				.all()
		const failed = migrations[9].replace(
			'CREATE UNIQUE INDEX import_committed_item_identity',
			'CREATE UNIQUE INDEX saved_video_bucket_bvid',
		)
		assert.throws(
			() => migrate(f!.db, [...migrations.slice(0, 9), failed]),
			/already exists/,
		)
		assert.deepEqual(dump(f), before)
		assert.deepEqual(
			f.raw
				.prepare(
					'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name',
				)
				.all(),
			schema,
		)
		assert.equal(f.raw.prepare('PRAGMA user_version').get()!.user_version, 9)
		assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), [])
		f.raw.close()
		f = open(file, 9)
		assert.deepEqual(f.imports.get('legacy')!.commits[0], receipt)
		migrate(f.db)
		assert.deepEqual(f.imports.commitSelected('legacy', old).receipt, receipt)
	} finally {
		f?.raw.close()
		rmSync(dir, { recursive: true, force: true })
	}
})

void test('零歌曲不建空歌单，unknown无BV/CID照常保留；不接受零选择或多余音乐目标', () => {
	const f = open()
	try {
		make(f, ['unknown', 'unknown'], 'task', [null, null])
		const input = command(f)
		assert.throws(
			() =>
				f.imports.commitMixed('task', {
					...input,
					musicTarget: {
						kind: 'create',
						playlistId: 'empty',
						name: '不应创建',
					},
				}),
			/零歌曲/,
		)
		assert.equal(f.playlists.get('empty'), null)
		assert.equal(f.imports.commitMixed('task', input).playlist, null)
		assert.equal(page(f, 'unclassified').length, 2)
		assert.equal(f.playlists.list().length, 0)
		assert.throws(
			() =>
				f.imports.commitMixed('task', {
					...input,
					commitId: 'nothing',
					expectedRevision: f.imports.get('task')!.revision,
					itemIds: [],
				}),
			/请选择/,
		)
		make(f, ['song'], 'song')
		assert.throws(
			() =>
				f.imports.commitMixed('song', {
					...command(f, 'song'),
					musicTarget: null,
				}),
			/存在歌曲/,
		)
	} finally {
		f.raw.close()
	}
})

void test('真实v9 Bili无BV原证据pending升级后仍可review确认并resolve原项；旧命令重放先于新入口禁用', () => {
	const f = open(':memory:', 9)
	try {
		const old = snapshot('legacy-bili', [null])
		old.entries[0].originalMetadata = { title: '旧版失效项，仅原始文本' }
		f.imports.createDirectory(old)
		f.imports.setSelected(old.taskId, ['e0'], true, 0)
		const input: ImportCommitRequest = {
			commitId: 'legacy-bili',
			expectedRevision: 1,
			target: { kind: 'create', playlistId: 'legacy-bili', name: '旧Bili' },
			duplicatePolicy: 'keep-all',
			itemIds: [{ entryId: 'e0', itemId: 'old-bili-item' }],
		}
		const receipt = f.imports.commitSelected(old.taskId, input).receipt
		migrate(f.db)
		assert.deepEqual(
			f.imports.commitSelected(old.taskId, input).receipt,
			receipt,
		)
		assert.deepEqual(f.imports.getMixed(old.taskId)!.history, [
			{ kind: 'playlist', receipt },
		])
		confirm(f, 'e0', old.taskId, source(B))
		assert.equal(
			f.imports.resolvePending(old.taskId, 'e0', {
				playlistId: 'legacy-bili',
				itemId: 'old-bili-item',
				expectedRevision: f.imports.get(old.taskId)!.revision,
				expectedUpdatedAt: f.playlists.get('legacy-bili')!.updatedAt,
			}).items[0].sourceId,
			source(B).id,
		)
		assert.deepEqual(
			f.imports.commitSelected(old.taskId, input).receipt,
			receipt,
		)
		assert.equal(receipt.results[0].sourceId, null)
		make(f, ['knowledge'], 'new-bili', [A])
		assert.throws(
			() =>
				f.imports.commitSelected('new-bili', {
					...input,
					commitId: 'bypass-content',
					expectedRevision: f.imports.get('new-bili')!.revision,
					target: { kind: 'create', playlistId: 'bypass', name: '错误歌单' },
					itemIds: [{ entryId: 'e0', itemId: 'bypass-item' }],
				}),
			/须使用 commitMixed/,
		)
		assert.equal(f.playlists.get('bypass'), null)
		assert.throws(() => confirm(f, 'e0', 'new-bili', source(B)), /原目录 BV/)
	} finally {
		f.raw.close()
	}
})

void test('只接受B站任务；分类独立持久默认unknown，无造建议，刷新目录/视频不改人工决定', () => {
	const f = open()
	try {
		f.imports.createDirectory(snapshot())
		assert.deepEqual(
			f.imports
				.getMixed('task')!
				.contentReviews.map((row) => [row.kind, row.reviewedAt]),
			[
				['unknown', null],
				['unknown', null],
				['unknown', null],
				['unknown', null],
			],
		)
		const changed = f.imports.reviewContent(
			'task',
			'e0',
			{ kind: 'musicCollection' },
			0,
		)
		assert.equal(changed.revision, 1)
		assert.equal(changed.entries[0].review.state, 'pending')
		assert.ok(changed.contentReviews[0].reviewedAt !== null)
		f.imports.createDirectory(snapshot())
		f.catalog.save(video(), 123)
		assert.equal(
			f.imports.getMixed('task')!.contentReviews[0].kind,
			'musicCollection',
		)
		assert.throws(
			() =>
				f.imports.reviewContent(
					'task',
					'e0',
					{ kind: 'invented' as ContentKind },
					1,
				),
			/类型/,
		)
		f.imports.createDirectory(snapshot('external', [A], 'netease'))
		assert.throws(() => f.imports.getMixed('external'), /仅适用/)
		assert.throws(
			() => f.imports.reviewContent('external', 'e0', { kind: 'song' }, 0),
			/仅适用/,
		)
		const input = {
			...command(f),
			itemIds: [{ entryId: 'e0', itemId: 'external-item' }],
		}
		assert.throws(() => f.imports.commitMixed('external', input), /仅适用/)
	} finally {
		f.raw.close()
	}
})

void test('歌曲确认核真实candidate/BV/CID/Source且只能原BV；外部跨平台匹配仍可用', () => {
	const f = open()
	try {
		make(f, ['song'])
		f.library.save(source(B))
		assert.throws(() => confirm(f, 'e0', 'task', source(B)), /原目录 BV/)
		const before = dump(f)
		assert.throws(
			() =>
				f.imports.review(
					'task',
					'e0',
					{
						review: {
							...confirmed(source()),
							confirmation: {
								candidateId: source().id,
								sourceId: sourceId(A, 99),
							},
						},
					},
					f.imports.get('task')!.revision,
				),
			/对应明确/,
		)
		assert.deepEqual(dump(f), before)
		assert.throws(
			() =>
				f.imports.review(
					'task',
					'e0',
					{ review: confirmed(source()) },
					f.imports.get('task')!.revision,
				),
			/本机真实/,
		)
		confirm(f)
		// Recheck the identity in the commit transaction, not only when review was saved.
		f.raw
			.prepare('UPDATE import_tasks SET snapshotJson = ? WHERE taskId = ?')
			.run(JSON.stringify(snapshot('task', [B])), 'task')
		assert.throws(() => f.imports.commitMixed('task', command(f)), /原目录 BV/)
		f.imports.createDirectory(snapshot('external', [A], 'qq'))
		confirm(f, 'e0', 'external', source(B))
		assert.equal(
			f.imports.get('external')!.entries[0].review.confirmation!.sourceId,
			source(B).id,
		)
	} finally {
		f.raw.close()
	}
})

void test('歌曲与BV两类去重键按目标独立；无BV/pending不靠原ID跳过，A/B/A证据仍在ledger', () => {
	const f = open()
	try {
		make(
			f,
			[
				'song',
				'song',
				'knowledge',
				'knowledge',
				'unknown',
				'unknown',
				'song',
				'song',
			],
			'task',
			[A, A, B, B, B, null, null, null],
		)
		confirm(f, 'e0')
		confirm(f, 'e1')
		const input = {
			...command(f),
			songDuplicatePolicy: 'skip-existing-source' as const,
			videoDuplicatePolicy: 'skip-existing-video' as const,
		}
		const result = f.imports.commitMixed('task', input)
		assert.deepEqual(
			result.receipt.results.map((row) => row.outcome),
			[
				'added',
				'skipped',
				'added',
				'skipped',
				'added',
				'added',
				'added',
				'added',
			],
		)
		assert.equal(result.receipt.results[1].skipKey, source().id)
		assert.equal(result.receipt.results[3].skipKey, B)
		assert.equal(result.receipt.results[3].sourceId, null)
		assert.equal(
			f.raw.prepare('SELECT count(*) n FROM import_commit_entries').get()!.n,
			8,
		)
		assert.equal(f.imports.get('task')!.entries.length, 8)
		assert.equal(page(f, 'listening').length, 1)
		assert.equal(page(f, 'unclassified').length, 2)
		make(f, ['knowledge', 'knowledge', 'knowledge'], 'next', [A, B, A])
		const next = {
			...command(f, 'next'),
			videoDuplicatePolicy: 'skip-existing-video' as const,
		}
		f.imports.commitMixed('next', next)
		assert.deepEqual(
			page(f, 'listening').map((row) => row.bvid),
			[B, A],
		)
	} finally {
		f.raw.close()
	}
})

void test('keep-all默认契约由调用者显式提供，收藏追加原顺序不按同毫秒随机itemId排序，分页有界', () => {
	const f = open()
	try {
		make(f, ['knowledge', 'knowledge', 'knowledge'], 'task', [A, B, A])
		const input = command(f)
		input.itemIds = [
			{ entryId: 'e0', itemId: 'z' },
			{ entryId: 'e1', itemId: 'a' },
			{ entryId: 'e2', itemId: 'm' },
		]
		assert.throws(
			() =>
				f.imports.commitMixed('task', {
					...input,
					videoDuplicatePolicy: undefined!,
				}),
			/明确选择/,
		)
		f.imports.commitMixed('task', input)
		make(f, ['knowledge'], 'later', [B])
		f.imports.commitMixed('later', command(f, 'later'))
		assert.deepEqual(
			page(f, 'listening').map((row) => row.bvid),
			[A, B, A, B],
		)
		assert.deepEqual(
			f.saves
				.list('listening', { offset: 1, limit: 2 })
				.map((row) => row.itemId),
			['a', 'm'],
		)
		assert.throws(
			() => f.saves.list('listening', { offset: 0, limit: 101 }),
			/最多/,
		)
	} finally {
		f.raw.close()
	}
})

void test('canonical同commitId重放原receipt，后续分类/选择/目标删除不重算，不复活各目标', () => {
	const f = open()
	try {
		make(f, ['song', 'knowledge', 'unknown'])
		const input = command(f),
			receipt = f.imports.commitMixed('task', input).receipt
		f.saves.remove('task:e1')
		f.saves.remove('task:e2')
		f.playlists.delete('playlist-task')
		f.imports.reviewContent(
			'task',
			'e1',
			{ kind: 'song' },
			f.imports.get('task')!.revision,
		)
		f.imports.setSelected(
			'task',
			['e0'],
			false,
			f.imports.get('task')!.revision,
		)
		const replay = f.imports.commitMixed('task', {
			...input,
			itemIds: input.itemIds.toReversed(),
			musicTarget: {
				kind: 'create',
				playlistId: 'playlist-task',
				name: '本地歌曲',
			},
		})
		assert.deepEqual(replay.receipt, receipt)
		assert.equal(replay.playlist, null)
		assert.equal(page(f, 'listening').length, 0)
		assert.equal(page(f, 'unclassified').length, 0)
		assert.equal(
			f.imports.getMixed('task')!.history[0].receipt.results[1].outcome,
			'added',
		)
		assert.throws(
			() =>
				f.imports.commitMixed('task', {
					...input,
					videoDuplicatePolicy: 'skip-existing-video',
				}),
			conflict('IMPORT_COMMIT_CONFLICT'),
		)
		assert.throws(
			() =>
				f.imports.commitSelected('task', {
					commitId: input.commitId,
					expectedRevision: 0,
					target: { kind: 'create', playlistId: 'x', name: 'x' },
					duplicatePolicy: 'keep-all',
					itemIds: [{ entryId: 'e0', itemId: 'x' }],
				}),
			conflict('IMPORT_COMMIT_CONFLICT'),
		)
	} finally {
		f.raw.close()
	}
})

void test('共享ledger：旧playlist与mixed互见已处理，分批只提交新出现项，计数固定', () => {
	const f = open(':memory:', 9)
	try {
		f.imports.createDirectory(snapshot('task', [A, B, A]))
		f.imports.setSelected('task', ['e0'], true, 0)
		f.imports.commitSelected('task', {
			commitId: 'old',
			expectedRevision: 1,
			target: { kind: 'create', playlistId: 'old', name: 'old' },
			duplicatePolicy: 'keep-all',
			itemIds: [{ entryId: 'e0', itemId: 'old-item' }],
		})
		migrate(f.db)
		f.imports.setSelected('task', ['e1'], true, f.imports.get('task')!.revision)
		f.imports.reviewContent(
			'task',
			'e1',
			{ kind: 'knowledge' },
			f.imports.get('task')!.revision,
		)
		const input = command(f)
		assert.deepEqual(
			input.itemIds.map((row) => row.entryId),
			['e1'],
		)
		const receipt = f.imports.commitMixed('task', input).receipt
		assert.equal(receipt.counts.unselected, 1)
		assert.equal(receipt.counts.unprocessed, 1)
		assert.deepEqual(
			f.imports.getMixed('task')!.history.map((row) => row.kind),
			['playlist', 'mixed'],
		)
		assert.equal(f.imports.get('task')!.commits.length, 1)
		assert.throws(
			() =>
				f.imports.commitSelected('task', {
					commitId: 'bypass',
					expectedRevision: f.imports.get('task')!.revision,
					target: { kind: 'create', playlistId: 'bad', name: 'bad' },
					duplicatePolicy: 'keep-all',
					itemIds: [{ entryId: 'e1', itemId: 'again' }],
				}),
			/须使用 commitMixed/,
		)
		f.imports.setSelected('task', ['e2'], true, f.imports.get('task')!.revision)
		f.imports.commitMixed('task', command(f, 'task', 'batch2'))
		assert.equal(f.imports.getMixed('task')!.history.length, 3)
	} finally {
		f.raw.close()
	}
})

void test('跨目标历史added身份永久保留，删除后playlist append/copy和新mixed都不能冒用；skip请求身份未占用', () => {
	const f = open()
	try {
		make(f, ['knowledge', 'knowledge'], 'task', [A, A])
		f.imports.commitMixed('task', {
			...command(f),
			videoDuplicatePolicy: 'skip-existing-video',
		})
		f.saves.remove('task:e0')
		f.playlists.create('manual', '手动')
		assert.throws(
			() =>
				f.playlists.append(
					'manual',
					[{ itemId: 'task:e0', source: source() }],
					'keep-all',
				),
			/已用于导入/,
		)
		f.playlists.append(
			'manual',
			[{ itemId: 'manual', source: source() }],
			'keep-all',
		)
		assert.throws(
			() => f.playlists.copy('manual', 'copy', 'copy', ['task:e0']),
			/已用于导入/,
		)
		f.playlists.append(
			'manual',
			[{ itemId: 'task:e1', source: source() }],
			'keep-all',
		)
		make(f, ['unknown'], 'later', [null])
		const next = command(f, 'later')
		next.itemIds[0].itemId = 'task:e0'
		assert.throws(
			() => f.imports.commitMixed('later', next),
			conflict('IMPORT_COMMIT_CONFLICT'),
		)
		next.itemIds[0].itemId = 'manual'
		assert.throws(
			() => f.imports.commitMixed('later', next),
			conflict('IMPORT_COMMIT_CONFLICT'),
		)
		assert.equal(page(f, 'unclassified').length, 0)
	} finally {
		f.raw.close()
	}
})

void test('双连接过期revision及目标版本拒绝，分类变化让旧命令失效且失败保所有内容', () => {
	const dir = mkdtempSync(join(tmpdir(), 'melo-mixed-conflict-'))
	try {
		const file = join(dir, 'db'),
			f = open(file),
			other = open(file)
		make(f, ['song'])
		const input = command(f)
		other.imports.reviewContent(
			'task',
			'e0',
			{ kind: 'knowledge' },
			other.imports.get('task')!.revision,
		)
		const before = dump(f)
		assert.throws(
			() => f.imports.commitMixed('task', input),
			conflict('IMPORT_REVISION_CONFLICT'),
		)
		assert.deepEqual(dump(f), before)
		f.imports.reviewContent(
			'task',
			'e0',
			{ kind: 'song' },
			f.imports.get('task')!.revision,
		)
		f.playlists.create('append', 'append')
		const append = {
			...command(f),
			musicTarget: {
				kind: 'append' as const,
				playlistId: 'append',
				expectedUpdatedAt: f.playlists.get('append')!.updatedAt,
			},
		}
		other.playlists.rename('append', 'changed')
		assert.throws(
			() => f.imports.commitMixed('task', append),
			conflict('IMPORT_TARGET_CONFLICT'),
		)
		assert.equal(f.playlists.get('append')!.items.length, 0)
		other.raw.close()
		f.raw.close()
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

void test('三目标中段SQLite写失败完整回滚，可用固定命令重试；COMMIT真实延迟外键失败同样回滚', () => {
	const f = open()
	try {
		make(f, ['song', 'knowledge', 'unknown'], 'task', [A, B, null])
		confirm(f)
		const input = command(f),
			before = dump(f)
		f.raw.exec(
			"CREATE TRIGGER fail_last BEFORE INSERT ON saved_video_items WHEN NEW.bucket='unclassified' BEGIN SELECT RAISE(ABORT,'fail-last-target'); END",
		)
		assert.throws(
			() => f.imports.commitMixed('task', input),
			/fail-last-target/,
		)
		f.raw.exec('DROP TRIGGER fail_last')
		assert.deepEqual(dump(f), before)
		f.raw.exec(
			"CREATE TRIGGER deferred_failure AFTER INSERT ON saved_video_items WHEN NEW.bucket='listening' BEGIN INSERT INTO video_catalog_parts(bvid,page,sourceId,title) VALUES ('missing',1,'missing','bad'); END",
		)
		let commitReached = false
		const base = f.db.execSync.bind(f.db)
		f.db.execSync = (sql) => {
			if (sql === 'COMMIT') commitReached = true
			base(sql)
			if (sql === 'BEGIN IMMEDIATE') base('PRAGMA defer_foreign_keys = ON')
		}
		assert.throws(
			() => f.imports.commitMixed('task', input),
			(error: unknown) =>
				error instanceof Error && /FOREIGN KEY/.test(error.message),
		)
		assert.equal(commitReached, true)
		f.db.execSync = base
		f.raw.exec('DROP TRIGGER deferred_failure')
		assert.deepEqual(dump(f), before)
		assert.equal(f.imports.commitMixed('task', input).receipt.results.length, 3)
		assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), [])
	} finally {
		f.raw.close()
	}
})

void test('ledger写失败回滚已写目标/receipt/revision，删除收藏只删出现项而保留Source/断点/视频/任务', () => {
	const f = open()
	try {
		make(f, ['knowledge'])
		f.catalog.save(video(), 100)
		new ListeningLibrary(f.db).saveResumePoint({
			sourceId: source().id,
			positionSeconds: 12,
			durationSeconds: 90,
			completed: false,
			updatedAt: 101,
		})
		f.library.setLiked(source(), true)
		const input = command(f),
			before = dump(f)
		f.raw.exec(
			"CREATE TRIGGER fail_ledger BEFORE INSERT ON import_commit_entries BEGIN SELECT RAISE(ABORT,'ledger-failed'); END",
		)
		assert.throws(() => f.imports.commitMixed('task', input), /ledger-failed/)
		f.raw.exec('DROP TRIGGER fail_ledger')
		assert.deepEqual(dump(f), before)
		f.imports.commitMixed('task', input)
		assert.equal(f.saves.remove('task:e0'), true)
		assert.equal(f.saves.remove('task:e0'), false)
		assert.ok(f.catalog.get(A))
		assert.ok(f.library.get(source().id))
		assert.equal(f.library.likes().length, 1)
		assert.equal(
			new ListeningLibrary(f.db).getResumePoint(source().id)!.positionSeconds,
			12,
		)
		assert.equal(f.imports.getMixed('task')!.history.length, 1)
		assert.equal(
			f.imports.commitMixed('task', input).receipt.results[0].itemId,
			'task:e0',
		)
		assert.equal(f.saves.get('task:e0'), null)
	} finally {
		f.raw.close()
	}
})

void test('混合pending歌曲复用resolvePending原项和undo，收藏/待分类与副本不能冒充原歌曲', () => {
	const f = open()
	try {
		make(f, ['song', 'knowledge', 'unknown'], 'task', [A, B, null])
		const receipt = f.imports.commitMixed('task', command(f)).receipt
		const removal = f.playlists.remove('playlist-task', ['task:e0'])!
		f.playlists.undoRemove(removal)
		f.playlists.copy('playlist-task', 'copy', 'copy', ['copy-item'])
		confirm(f)
		const request = {
			playlistId: 'playlist-task',
			itemId: 'task:e0',
			expectedRevision: f.imports.get('task')!.revision,
			expectedUpdatedAt: f.playlists.get('playlist-task')!.updatedAt,
		}
		assert.throws(
			() =>
				f.imports.resolvePending('task', 'e1', {
					...request,
					itemId: 'task:e1',
				}),
			conflict('IMPORT_TARGET_CONFLICT'),
		)
		assert.throws(
			() =>
				f.imports.resolvePending('task', 'e0', {
					...request,
					playlistId: 'copy',
					itemId: 'copy-item',
					expectedUpdatedAt: f.playlists.get('copy')!.updatedAt,
				}),
			conflict('IMPORT_TARGET_CONFLICT'),
		)
		assert.equal(
			f.imports.resolvePending('task', 'e0', request).items[0].sourceId,
			source().id,
		)
		assert.equal(f.playlists.get('copy')!.items[0].sourceId, null)
		assert.equal(
			f.imports.getMixed('task')!.history[0].receipt.results[0].sourceId,
			null,
		)
		assert.deepEqual(
			f.imports.commitMixed('task', receipt.request).receipt,
			receipt,
		)
	} finally {
		f.raw.close()
	}
})

void test('v10目标约束不把BV跳过当CID歌曲，坏skip/错误类别或resolved值在SQL层拒绝', () => {
	const f = open()
	try {
		make(f, ['knowledge', 'knowledge'], 'task', [A, A])
		f.imports.commitMixed('task', {
			...command(f),
			videoDuplicatePolicy: 'skip-existing-video',
		})
		assert.throws(
			() =>
				f.raw.exec(
					"UPDATE import_commit_entries SET sourceId='bad' WHERE entryId='e1'",
				),
			/constraint/i,
		)
		assert.throws(
			() =>
				f.raw.exec(
					"UPDATE import_commit_entries SET bvid=NULL WHERE entryId='e1'",
				),
			/constraint/i,
		)
		assert.throws(
			() =>
				f.raw.exec(
					"UPDATE import_commit_entries SET contentKind=NULL WHERE entryId='e0'",
				),
			/constraint/i,
		)
		assert.throws(
			() =>
				f.raw.exec(
					"UPDATE import_commit_entries SET resolvedSourceId='bad' WHERE entryId='e0'",
				),
			/constraint/i,
		)
		assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), [])
	} finally {
		f.raw.close()
	}
})
