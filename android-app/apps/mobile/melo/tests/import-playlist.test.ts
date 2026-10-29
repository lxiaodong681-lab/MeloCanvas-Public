import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { CreatorStore } from '../core/creators'
import { Library, migrate, migrations, type Database } from '../core/database'
import type {
	ImportCommitRequest,
	ImportPlaylistTarget,
} from '../core/import-playlist-types'
import {
	ImportConflictError,
	type ImportDirectorySnapshot,
	type ImportReview,
} from '../core/import-types'
import { ImportStore } from '../core/imports'
import { ListeningLibrary } from '../core/listening'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore, PlaylistUndoExpiredError } from '../core/playlists'
import { SessionStore } from '../core/sessions'
import {
	playlistItemDescription,
	playlistPlaybackCounts,
	preparePlaylistPlayback,
} from '../playlist-selection'
import { PlaylistSession } from '../playlist-session'

const a: Source = {
	id: sourceId('BV1vT411i7ET', 123),
	bvid: 'BV1vT411i7ET',
	cid: 123,
	originalTitle: '真实音源A',
	uploader: 'UP',
	uploaderId: 88,
	performer: null,
	artwork: '',
	duration: 100,
	domain: 'unclassified',
	audioAvailability: 'unknown',
}
const b: Source = {
	...a,
	id: sourceId(a.bvid, 456),
	cid: 456,
	originalTitle: '真实音源B',
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
function snapshot(): ImportDirectorySnapshot {
	return {
		taskId: 'task',
		provider: 'netease',
		originalPlaylistId: 'remote-list',
		taskVersion: 1,
		originalMetadata: { name: '原平台歌单', description: '只保存在任务中' },
		entries: ['A', 'B', 'A', '未匹配曲目', '未选曲目'].map((name, index) => ({
			entryId: `e${index}`,
			originalEntryId: name,
			originalPosition: index * 3 + 2,
			originalMetadata: {
				name,
				artists: ['原表演者'],
				album: { name: '原专辑' },
			},
		})),
	}
}
function confirmed(source: Source): ImportReview {
	return {
		state: 'confirmed',
		candidates: [
			{
				candidateId: 'chosen',
				bvid: source.bvid,
				cid: source.cid,
				metadata: { originalTitle: source.originalTitle },
				evidence: { confidence: 'low', userReview: 'explicit' },
			},
		],
		confirmation: { candidateId: 'chosen', sourceId: source.id },
	}
}
function setup(connection = open(), version: number = migrations.length) {
	const { raw, db } = connection
	migrate(db, migrations.slice(0, version))
	const library = new Library(db),
		playlists = new PlaylistStore(db),
		imports = new ImportStore(db)
	library.save(a)
	library.save(b)
	return { raw, db, library, playlists, imports }
}
function task(f: ReturnType<typeof setup>) {
	f.imports.createDirectory(snapshot())
	for (const [index, source] of [a, b, a, null].entries())
		f.imports.review(
			'task',
			`e${index}`,
			{
				selected: true,
				...(source
					? { review: confirmed(source) }
					: {
							review: {
								state: 'not-found' as const,
								candidates: [],
								confirmation: null,
							},
						}),
			},
			f.imports.get('task')!.revision,
		)
}
function command(
	f: ReturnType<typeof setup>,
	commitId = 'commit',
	target: ImportPlaylistTarget = {
		kind: 'create',
		playlistId: 'imported',
		name: '本地副本',
	},
): ImportCommitRequest {
	const value = f.imports.get('task')!,
		processed = new Set(
			value.commits.flatMap((receipt) =>
				receipt.results.map((result) => result.entryId),
			),
		)
	return {
		commitId,
		expectedRevision: value.revision,
		target,
		duplicatePolicy: 'keep-all',
		itemIds: value.entries
			.filter((entry) => entry.selected && !processed.has(entry.entryId))
			.map((entry) => ({
				entryId: entry.entryId,
				itemId: `item-${entry.entryId}`,
			})),
	}
}
function conflict(error: unknown) {
	return error instanceof ImportConflictError
}
function withFile(run: (file: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), 'melo-import-commit-'))
	assert.ok(
		resolve(dir).startsWith(resolve(tmpdir()) + sep) &&
			basename(dir).startsWith('melo-import-commit-'),
	)
	try {
		run(join(dir, 'library.db'))
	} finally {
		rmSync(dir, { recursive: true })
	}
}
function oldRows(raw: DatabaseSync): string {
	return JSON.stringify(
		[
			'sources',
			'likes',
			'settings',
			'resume_points',
			'playlists',
			'playlist_items',
			'playback_sessions',
			'playback_session_items',
			'creators',
			'creator_subscriptions',
			'import_tasks',
			'import_entries',
			'import_retry_records',
		].map((table) =>
			raw
				.prepare(
					`SELECT ${table === 'playlist_items' ? 'itemId, playlistId, sourceId, position, addedAt' : table === 'playlists' ? 'id, name, createdAt, updatedAt' : '*'} FROM ${table} ORDER BY rowid`,
				)
				.all(),
		),
	)
}
function seedLegacy(f: ReturnType<typeof setup>) {
	f.library.setLiked(a, true)
	f.library.setSetting('theme.state.v1', 'original-registry')
	f.playlists.create('old', '原本地歌单')
	f.playlists.append(
		'old',
		[a, b, a].map((source, index) => ({ itemId: `old-${index}`, source })),
		'keep-all',
	)
	new ListeningLibrary(f.db).saveResumePoint({
		sourceId: a.id,
		positionSeconds: 12,
		durationSeconds: 100,
		completed: false,
		updatedAt: 4,
	})
	new SessionStore(f.db).saveSession({
		mode: 'music',
		entries: [a, b, a].map((source, index) => ({
			entryId: `playlist-item:old-${index}`,
			sourceId: source.id,
		})),
		currentEntryId: 'playlist-item:old-2',
		currentSourceId: a.id,
		positionSeconds: 12,
		speed: 1,
		updatedAt: 4,
	})
	const creators = new CreatorStore(f.db)
	creators.saveCreator({
		source: 'bilibili',
		mid: '88',
		name: '缓存UP',
		fetchedAt: 1,
	})
	creators.follow({
		profileId: 'local',
		creatorMid: '88',
		scope: 'all',
		origin: 'manual',
	})
	task(f)
}

void test('v7→v8重开保留所有旧列/顺序/A-B-A/itemId及任务确认，新legacy字段均NULL', () => {
	withFile((file) => {
		let f = setup(open(file), 7)
		let before = '',
			beforeTask: ReturnType<ImportStore['get']> = null
		try {
			seedLegacy(f)
			before = oldRows(f.raw)
			beforeTask = f.imports.get('task')
			migrate(f.db)
			assert.equal(oldRows(f.raw), before)
			assert.deepEqual(f.imports.get('task'), beforeTask)
			assert.ok(
				f.raw
					.prepare(
						'SELECT importTaskId, originJson, reviewJson FROM playlist_items',
					)
					.all()
					.every(
						(row) =>
							row.importTaskId === null &&
							row.originJson === null &&
							row.reviewJson === null,
					),
			)
			assert.deepEqual(
				f.playlists
					.get('old')!
					.items.map((item) => [
						item.itemId,
						item.sourceId,
						item.importOrigin,
						item.review,
					]),
				[a, b, a].map((source, index) => [
					`old-${index}`,
					source.id,
					null,
					null,
				]),
			)
		} finally {
			f.raw.close()
		}
		f = setup(open(file))
		try {
			assert.equal(
				f.raw.prepare('PRAGMA user_version').get()?.user_version,
				migrations.length,
			)
			assert.equal(oldRows(f.raw), before)
			assert.deepEqual(f.imports.get('task'), beforeTask)
			assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), [])
		} finally {
			f.raw.close()
		}
	})
})

void test('v8重建/ledger建表中途失败回滚全部结构与版本，重开v7可重试', () => {
	withFile((file) => {
		let f = setup(open(file), 7),
			before = ''
		try {
			seedLegacy(f)
			before = oldRows(f.raw)
			assert.throws(
				() =>
					migrate({
						...f.db,
						execSync(sql) {
							f.db.execSync(sql)
							if (sql.includes('CREATE TABLE playlist_items_v8'))
								throw new Error('migration interrupted')
						},
					}),
				/migration interrupted/,
			)
			assert.equal(f.raw.prepare('PRAGMA user_version').get()?.user_version, 7)
			assert.equal(
				f.raw
					.prepare(
						"SELECT name FROM sqlite_master WHERE name = 'import_commits'",
					)
					.get(),
				undefined,
			)
			assert.equal(oldRows(f.raw), before)
		} finally {
			f.raw.close()
		}
		f = setup(open(file), 7)
		try {
			assert.equal(oldRows(f.raw), before)
			migrate(f.db)
			assert.equal(oldRows(f.raw), before)
		} finally {
			f.raw.close()
		}
	})
})

void test('一次提交确认与未匹配出现项；不造Source，不复制歌单级元信息，未选留任务', () => {
	const f = setup()
	try {
		task(f)
		const beforeSources = JSON.stringify(
			f.raw.prepare('SELECT * FROM sources ORDER BY id').all(),
		)
		const result = f.imports.commitSelected('task', command(f))
		const playlist = result.playlist!
		assert.deepEqual(
			playlist.items.map((item) => item.sourceId),
			[a.id, b.id, a.id, null],
		)
		assert.deepEqual(
			playlist.items.map((item) => item.itemId),
			['item-e0', 'item-e1', 'item-e2', 'item-e3'],
		)
		assert.deepEqual(
			result.receipt.results.map((item) => item.outcome),
			['added', 'added', 'added', 'added'],
		)
		const pending = playlist.items[3]
		assert.equal(pending.review?.state, 'not-found')
		assert.deepEqual(
			pending.importOrigin?.originalMetadata,
			snapshot().entries[3].originalMetadata,
		)
		assert.equal('playlistMetadata' in pending.importOrigin, false)
		assert.equal(
			JSON.stringify(f.raw.prepare('SELECT * FROM sources ORDER BY id').all()),
			beforeSources,
		)
		assert.equal(f.imports.get('task')!.entries[4].selected, false)
		assert.equal(f.imports.get('task')!.commits.length, 1)
	} finally {
		f.raw.close()
	}
})

void test('提交重放忽略mapping键序且不重加；新commit不能重加已处理occurrence，后选项可分批提交', () => {
	const f = setup()
	try {
		task(f)
		const input = command(f),
			saved = f.imports.commitSelected('task', input)
		assert.deepEqual(
			f.imports.commitSelected('task', {
				...input,
				itemIds: input.itemIds.toReversed(),
			}),
			saved,
		)
		assert.throws(
			() =>
				f.imports.commitSelected('task', {
					...input,
					target: { kind: 'create', playlistId: 'other', name: 'other' },
				}),
			conflict,
		)
		assert.throws(
			() =>
				f.imports.commitSelected('task', {
					...input,
					commitId: 'new',
					expectedRevision: f.imports.get('task')!.revision,
				}),
			conflict,
		)
		f.imports.review(
			'task',
			'e4',
			{ selected: true },
			f.imports.get('task')!.revision,
		)
		const next = command(f, 'second', {
			kind: 'append',
			playlistId: 'imported',
			expectedUpdatedAt: saved.playlist!.updatedAt,
		})
		assert.deepEqual(next.itemIds, [{ entryId: 'e4', itemId: 'item-e4' }])
		const second = f.imports.commitSelected('task', next)
		assert.equal(second.playlist!.items.length, 5)
		assert.equal(f.imports.get('task')!.commits.length, 2)
	} finally {
		f.raw.close()
	}
})

void test('skip只去重真实Source，A/B/A逐occ对账；重复未匹配原ID不被跳过', () => {
	const f = setup()
	try {
		task(f)
		f.imports.review(
			'task',
			'e4',
			{ selected: true },
			f.imports.get('task')!.revision,
		)
		f.playlists.create('target', '目标')
		f.playlists.append(
			'target',
			[{ itemId: 'existing-a', source: a }],
			'keep-all',
		)
		const input = command(f, 'skip', {
			kind: 'append',
			playlistId: 'target',
			expectedUpdatedAt: f.playlists.get('target')!.updatedAt,
		})
		input.duplicatePolicy = 'skip-existing-source'
		const result = f.imports.commitSelected('task', input)
		assert.deepEqual(
			result.receipt.results.map((row) => [row.entryId, row.outcome]),
			[
				['e0', 'skipped'],
				['e1', 'added'],
				['e2', 'skipped'],
				['e3', 'added'],
				['e4', 'added'],
			],
		)
		assert.deepEqual(
			result.playlist!.items.map((item) => item.sourceId),
			[a.id, b.id, null, null],
		)
		assert.ok(
			result.receipt.results
				.filter((row) => row.outcome === 'skipped')
				.every((row) => row.itemId === null),
		)
		f.playlists.remove('target', ['existing-a'])
		assert.equal(
			f.imports.commitSelected('task', input).playlist!.items.length,
			3,
		)
	} finally {
		f.raw.close()
	}
})

void test('已移除/已删除目标的历史重放不复活条目或歌单，receipt重开仍恢复', () => {
	withFile((file) => {
		let f = setup(open(file))
		let input!: ImportCommitRequest,
			receipt!: ReturnType<ImportStore['commitSelected']>['receipt']
		try {
			task(f)
			input = command(f)
			receipt = f.imports.commitSelected('task', input).receipt
			f.playlists.remove('imported', ['item-e3'])
			assert.equal(
				f.imports.commitSelected('task', input).playlist!.items.length,
				3,
			)
			f.playlists.delete('imported')
			assert.deepEqual(f.imports.commitSelected('task', input), {
				receipt,
				playlist: null,
			})
		} finally {
			f.raw.close()
		}
		f = setup(open(file))
		try {
			assert.deepEqual(f.imports.get('task')!.commits, [receipt])
			assert.deepEqual(f.imports.commitSelected('task', input), {
				receipt,
				playlist: null,
			})
		} finally {
			f.raw.close()
		}
	})
})

void test('旧任务revision/目标updatedAt、已存在create目标及不完整选择明确拒绝，双连接不丢新编辑', () => {
	withFile((file) => {
		const f = setup(open(file)),
			other = setup(open(file))
		try {
			task(f)
			f.playlists.create('target', '目标')
			const input = command(f, 'append', {
				kind: 'append',
				playlistId: 'target',
				expectedUpdatedAt: f.playlists.get('target')!.updatedAt,
			})
			other.playlists.rename('target', '较新名称')
			const before = oldRows(f.raw)
			assert.throws(() => f.imports.commitSelected('task', input), conflict)
			assert.equal(oldRows(f.raw), before)
			assert.throws(
				() =>
					f.imports.commitSelected('task', {
						...command(f),
						target: { kind: 'create', playlistId: 'target', name: '冲突' },
					}),
				conflict,
			)
			assert.throws(
				() =>
					f.imports.commitSelected('task', {
						...command(f),
						expectedRevision: 0,
					}),
				conflict,
			)
			assert.throws(
				() =>
					f.imports.commitSelected('task', {
						...command(f),
						itemIds: command(f).itemIds.slice(1),
					}),
				conflict,
			)
			assert.equal(
				f.raw.prepare('SELECT COUNT(*) n FROM import_commits').get()?.n,
				0,
			)
		} finally {
			other.raw.close()
			f.raw.close()
		}
	})
})

for (const stage of ['item', 'ledger', 'task'])
	void test(`导入${stage}写入中途失败整个创建/条目/ledger/revision回滚，再试成功`, () => {
		const f = setup()
		try {
			task(f)
			const input = command(f),
				before = oldRows(f.raw)
			const sql =
				stage === 'item'
					? "BEFORE INSERT ON playlist_items WHEN NEW.itemId = 'item-e2'"
					: stage === 'ledger'
						? "BEFORE INSERT ON import_commit_entries WHEN NEW.entryId = 'e2'"
						: 'BEFORE UPDATE ON import_tasks'
			f.raw.exec(
				`CREATE TRIGGER fail_commit ${sql} BEGIN SELECT RAISE(ABORT, 'commit failed'); END`,
			)
			assert.throws(
				() => f.imports.commitSelected('task', input),
				/commit failed/,
			)
			assert.equal(oldRows(f.raw), before)
			assert.equal(f.playlists.get('imported'), null)
			assert.equal(
				f.raw.prepare('SELECT COUNT(*) n FROM import_commits').get()?.n,
				0,
			)
			f.raw.exec('DROP TRIGGER fail_commit')
			assert.equal(
				f.imports.commitSelected('task', input).playlist!.items.length,
				4,
			)
		} finally {
			f.raw.close()
		}
	})

void test('提交时重核已确认Source三身份，不能因旧审核记录/FK存在而接受错源', () => {
	const f = setup()
	try {
		task(f)
		const input = command(f),
			before = f.imports.get('task')
		f.raw.prepare('UPDATE sources SET cid = 999 WHERE id = ?').run(a.id)
		assert.throws(() => f.imports.commitSelected('task', input), /真实音源/)
		assert.equal(f.playlists.get('imported'), null)
		assert.deepEqual(f.imports.get('task'), before)
	} finally {
		f.raw.close()
	}
})

void test('后续人工确认补原pending条目，保留itemId/order/addedAt/原证据且不重新追加', () => {
	const f = setup()
	try {
		task(f)
		const original = f.imports.commitSelected('task', command(f)).playlist!,
			pending = original.items[3]
		f.imports.review(
			'task',
			'e3',
			{ review: confirmed(b) },
			f.imports.get('task')!.revision,
		)
		const resolved = f.imports.resolvePending('task', 'e3', {
			playlistId: 'imported',
			itemId: pending.itemId,
			expectedRevision: f.imports.get('task')!.revision,
			expectedUpdatedAt: original.updatedAt,
		})
		assert.equal(resolved.items.length, 4)
		assert.deepEqual(
			[
				resolved.items[3].itemId,
				resolved.items[3].position,
				resolved.items[3].addedAt,
				resolved.items[3].importOrigin,
			],
			[pending.itemId, pending.position, pending.addedAt, pending.importOrigin],
		)
		assert.equal(resolved.items[3].sourceId, b.id)
		assert.equal(resolved.items[3].review?.state, 'confirmed')
		assert.equal(
			resolved.items[3].importOrigin?.reviewAtCommit.state,
			'not-found',
		)
		assert.equal(f.imports.get('task')!.commits[0].results[3].sourceId, null)
		assert.throws(
			() =>
				f.imports.resolvePending('task', 'e3', {
					playlistId: 'imported',
					itemId: pending.itemId,
					expectedRevision: f.imports.get('task')!.revision,
					expectedUpdatedAt: resolved.updatedAt,
				}),
			conflict,
		)
	} finally {
		f.raw.close()
	}
})

void test('补匹配拒绝较新用户编辑/旧revision/副本或移除后重用的itemId，不越过原ledger', () => {
	const f = setup()
	try {
		task(f)
		const original = f.imports.commitSelected('task', command(f)).playlist!
		f.imports.review(
			'task',
			'e3',
			{ review: confirmed(b) },
			f.imports.get('task')!.revision,
		)
		const request = {
			playlistId: 'imported',
			itemId: 'item-e3',
			expectedRevision: f.imports.get('task')!.revision,
			expectedUpdatedAt: original.updatedAt,
		}
		f.playlists.rename('imported', '较新名称')
		assert.throws(
			() => f.imports.resolvePending('task', 'e3', request),
			conflict,
		)
		const current = f.playlists.get('imported')!
		assert.throws(
			() =>
				f.imports.resolvePending('task', 'e3', {
					...request,
					expectedUpdatedAt: current.updatedAt,
					expectedRevision: 0,
				}),
			conflict,
		)
		const copy = f.playlists.copy('imported', 'copy', '副本', [
			'copy-0',
			'copy-1',
			'copy-2',
			'copy-3',
		])
		assert.throws(
			() =>
				f.imports.resolvePending('task', 'e3', {
					...request,
					playlistId: 'copy',
					itemId: 'copy-3',
					expectedUpdatedAt: copy.updatedAt,
				}),
			conflict,
		)
		assert.equal(copy.items[3].sourceId, null)
		f.playlists.remove('imported', ['item-e3'])
		assert.throws(
			() =>
				f.playlists.append(
					'imported',
					[{ itemId: 'item-e3', source: a }],
					'keep-all',
				),
			/已用于导入/,
		)
		assert.throws(
			() =>
				f.imports.resolvePending('task', 'e3', {
					...request,
					expectedUpdatedAt: f.playlists.get('imported')!.updatedAt,
				}),
			conflict,
		)
		assert.equal(f.playlists.get('imported')!.items.length, 3)
	} finally {
		f.raw.close()
	}
})

void test('补匹配的条目/目标/ledger/任务写入原子，SQLite失败可重试且旧撤销凭据不被SQL失败影响', () => {
	const f = setup()
	try {
		task(f)
		f.imports.commitSelected('task', command(f))
		const undo = f.playlists.remove('imported', ['item-e0'])!
		f.imports.review(
			'task',
			'e3',
			{ review: confirmed(b) },
			f.imports.get('task')!.revision,
		)
		const request = {
			playlistId: 'imported',
			itemId: 'item-e3',
			expectedRevision: f.imports.get('task')!.revision,
			expectedUpdatedAt: f.playlists.get('imported')!.updatedAt,
		}
		const before = oldRows(f.raw),
			beforeItem = f.playlists.get('imported')
		f.raw.exec(
			"CREATE TRIGGER fail_resolve BEFORE UPDATE ON import_commit_entries BEGIN SELECT RAISE(ABORT, 'resolve failed'); END",
		)
		assert.throws(
			() => f.imports.resolvePending('task', 'e3', request),
			/resolve failed/,
		)
		assert.equal(oldRows(f.raw), before)
		assert.deepEqual(f.playlists.get('imported'), beforeItem)
		f.raw.exec('DROP TRIGGER fail_resolve')
		assert.equal(f.playlists.undoRemove(undo).items.length, 4)
		assert.equal(
			f.imports.resolvePending('task', 'e3', {
				...request,
				expectedUpdatedAt: f.playlists.get('imported')!.updatedAt,
			}).items[3].sourceId,
			b.id,
		)
	} finally {
		f.raw.close()
	}
})

void test('pending复制/排序/移除/撤销/删除不丢证据；跨Store补匹配使旧撤销凭据过期', () => {
	const f = setup()
	try {
		task(f)
		const original = f.imports.commitSelected('task', command(f)).playlist!
		const receipt = f.playlists.remove('imported', ['item-e3'])!
		assert.deepEqual(f.playlists.undoRemove(receipt).items, original.items)
		f.playlists.reorder('imported', [
			'item-e3',
			'item-e2',
			'item-e1',
			'item-e0',
		])
		const sorted = f.playlists.get('imported')!
		const copy = f.playlists.copy('imported', 'copy', '副本', [
			'c3',
			'c2',
			'c1',
			'c0',
		])
		assert.deepEqual(copy.items[0].importOrigin, original.items[3].importOrigin)
		assert.equal(copy.items[0].sourceId, null)
		assert.deepEqual(f.playlists.get('imported'), sorted)
		assert.equal(f.playlists.delete('copy'), true)
		const oldUndo = f.playlists.remove('imported', ['item-e0'])!
		f.imports.review(
			'task',
			'e3',
			{ review: confirmed(b) },
			f.imports.get('task')!.revision,
		)
		f.imports.resolvePending('task', 'e3', {
			playlistId: 'imported',
			itemId: 'item-e3',
			expectedRevision: f.imports.get('task')!.revision,
			expectedUpdatedAt: f.playlists.get('imported')!.updatedAt,
		})
		assert.throws(
			() => f.playlists.undoRemove(oldUndo),
			PlaylistUndoExpiredError,
		)
		assert.equal(f.imports.get('task')!.commits.length, 1)
	} finally {
		f.raw.close()
	}
})

void test('mixed歌单只准备可播放occurrence并报告pending数，保留第二A起点；真实坏Source仍整批报错', () => {
	const f = setup()
	try {
		task(f)
		const playlist = f.imports.commitSelected('task', command(f)).playlist!
		const prepared = preparePlaylistPlayback(
			f.playlists,
			f.library,
			'imported',
			'item-e2',
		)
		assert.deepEqual(
			prepared.entries.map((entry) => [entry.itemId, entry.source.id]),
			[
				['item-e0', a.id],
				['item-e1', b.id],
				['item-e2', a.id],
			],
		)
		assert.equal(prepared.startItemId, 'item-e2')
		assert.equal(prepared.pendingCount, 1)
		assert.throws(
			() =>
				preparePlaylistPlayback(f.playlists, f.library, 'imported', 'item-e3'),
			/待匹配/,
		)
		assert.throws(
			() =>
				preparePlaylistPlayback(
					f.playlists,
					{ getMusic: (id) => (id === b.id ? null : f.library.get(id)) },
					'imported',
					'item-e0',
				),
			/第 2 项/,
		)
		assert.deepEqual(playlistPlaybackCounts(playlist.items), {
			playableCount: 3,
			pendingCount: 1,
			firstPlayableItemId: 'item-e0',
		})
		assert.deepEqual(playlistItemDescription(playlist.items[3], null), {
			title: '未匹配曲目',
			subtitle: '原表演者，原专辑',
			status: '待匹配，尚未找到音源',
		})
		assert.equal(
			playlistItemDescription(playlist.items[0], a).subtitle,
			'原表演者，原专辑',
		)
	} finally {
		f.raw.close()
	}
})

void test('纯pending详情不读取假Source、保留零可播放计数，可在现有管理流程移除/撤销/复制', () => {
	const f = setup()
	try {
		f.imports.createDirectory(snapshot())
		f.imports.review('task', 'e3', { selected: true }, 0)
		const playlist = f.imports.commitSelected('task', command(f)).playlist!
		let reads = 0
		const session = new PlaylistSession(
			f.playlists,
			{
				getMusic(id) {
					assert.notEqual(id, null)
					reads++
					return f.library.get(id)
				},
				musicLikes: () => [],
			},
			() => `copy-${reads++}`,
		)
		session.open('imported')
		assert.equal(reads, 0)
		assert.equal(session.getSnapshot().detail!.items.length, 1)
		assert.equal(session.getSnapshot().playlists[0].pendingCount, 1)
		assert.equal(session.getSnapshot().sources.size, 0)
		assert.deepEqual(playlistPlaybackCounts(playlist.items), {
			playableCount: 0,
			pendingCount: 1,
			firstPlayableItemId: null,
		})
		session.setEditing(true)
		session.toggleItem('item-e3')
		assert.equal(session.removeSelected(), true)
		assert.equal(session.undoRemove(), true)
		assert.deepEqual(session.getSnapshot().detail!.items, playlist.items)
		session.requestName('copy')
		session.setName('独立副本')
		assert.equal(session.saveName(), true)
		assert.equal(session.getSnapshot().detail!.items[0].sourceId, null)
	} finally {
		f.raw.close()
	}
})

void test('schema和codec拒绝无导入证据的null Source、确认与首选源不一致，移除撤销校验导入证据', () => {
	const f = setup()
	try {
		task(f)
		f.imports.commitSelected('task', command(f))
		assert.throws(
			() =>
				f.raw
					.prepare(
						'INSERT INTO playlist_items (itemId, playlistId, sourceId, position, addedAt) VALUES (?, ?, NULL, ?, ?)',
					)
					.run('fake', 'imported', 4, 1),
			/CHECK/,
		)
		f.raw
			.prepare('UPDATE playlist_items SET sourceId = ? WHERE itemId = ?')
			.run(a.id, 'item-e3')
		assert.throws(() => f.playlists.get('imported'), /审核状态/)
		f.raw
			.prepare('UPDATE playlist_items SET sourceId = NULL WHERE itemId = ?')
			.run('item-e3')
		const receipt = f.playlists.remove('imported', ['item-e0'])!
		const row = f.raw
			.prepare('SELECT originJson FROM playlist_items WHERE itemId = ?')
			.get('item-e3')!
		const origin = JSON.parse(String(row.originJson))
		origin.originalMetadata.name = '较新证据'
		f.raw
			.prepare('UPDATE playlist_items SET originJson = ? WHERE itemId = ?')
			.run(JSON.stringify(origin), 'item-e3')
		assert.throws(
			() => f.playlists.undoRemove(receipt),
			PlaylistUndoExpiredError,
		)
	} finally {
		f.raw.close()
	}
})

void test('copy→delete→copy回原身份不得让副本冒充原ledger的pending条目', () => {
	const f = setup()
	try {
		task(f)
		const original = f.imports.commitSelected('task', command(f)).playlist!
		f.playlists.copy('imported', 'backup', '备份', [
			'backup-0',
			'backup-1',
			'backup-2',
			'backup-3',
		])
		f.playlists.delete('imported')
		assert.throws(
			() =>
				f.playlists.copy(
					'backup',
					'imported',
					'重建副本',
					original.items.map((item) => item.itemId),
				),
			/已用于导入/,
		)
		assert.equal(f.playlists.get('imported'), null)
		assert.equal(f.playlists.get('backup')!.items[3].sourceId, null)
	} finally {
		f.raw.close()
	}
})

void test('新commit不能复用已导入并移除的itemId，skip未创建的requestedId可正常用于新条目', () => {
	const f = setup()
	try {
		task(f)
		const input = command(f)
		input.duplicatePolicy = 'skip-existing-source'
		const saved = f.imports.commitSelected('task', input)
		assert.equal(saved.receipt.results[2].outcome, 'skipped')
		f.playlists.append(
			'imported',
			[{ itemId: 'item-e2', source: b }],
			'keep-all',
		)
		assert.equal(f.playlists.get('imported')!.items.length, 4)
		f.playlists.remove('imported', ['item-e3'])
		f.imports.review(
			'task',
			'e4',
			{ selected: true },
			f.imports.get('task')!.revision,
		)
		const next = command(f, 'new', {
			kind: 'append',
			playlistId: 'imported',
			expectedUpdatedAt: f.playlists.get('imported')!.updatedAt,
		})
		next.itemIds[0].itemId = 'item-e3'
		assert.throws(() => f.imports.commitSelected('task', next), /已用于导入/)
		assert.equal(f.imports.get('task')!.commits.length, 1)
	} finally {
		f.raw.close()
	}
})

void test('真实网易/QQ nested track及partial目录证据显示原元信息，不改证据或假称无权读取', () => {
	const f = setup()
	try {
		const input = snapshot()
		input.entries[0].originalMetadata = {
			track: {
				name: '网易原曲',
				ar: [{ name: '网易歌手' }],
				al: { name: '网易专辑' },
				dt: 198000,
			},
			directoryItem: { id: 123 },
			metadataStatus: 'read',
		}
		input.entries[1].originalMetadata = {
			track: {
				name: 'QQ原曲',
				singer: [{ name: 'QQ歌手' }],
				album: { name: 'QQ专辑' },
				interval: 222,
			},
			directoryItem: null,
			metadataStatus: 'read',
		}
		input.entries[2].originalMetadata = {
			track: null,
			directoryItem: { id: 789 },
			returnedPosition: null,
			metadataStatus: 'unread',
		}
		input.entries[2].originalEntryId = '789'
		f.imports.createDirectory(input)
		for (let index = 0; index < 3; index++)
			f.imports.review(
				'task',
				`e${index}`,
				{
					selected: true,
					review: {
						state: index === 2 ? 'unreadable' : 'pending',
						candidates: [],
						confirmation: null,
					},
				},
				f.imports.get('task')!.revision,
			)
		const playlist = f.imports.commitSelected('task', command(f)).playlist!
		assert.deepEqual(playlistItemDescription(playlist.items[0], null), {
			title: '网易原曲',
			subtitle: '网易歌手，网易专辑',
			status: '未匹配，点击查找音源',
		})
		assert.deepEqual(playlistItemDescription(playlist.items[1], null), {
			title: 'QQ原曲',
			subtitle: 'QQ歌手，QQ专辑',
			status: '未匹配，点击查找音源',
		})
		assert.equal(
			playlistItemDescription(playlist.items[2], null).title,
			'原平台条目 789',
		)
		assert.equal(
			playlistItemDescription(playlist.items[2], null).status,
			'待匹配，暂时无法读取',
		)
		assert.deepEqual(
			playlist.items.map((item) => item.importOrigin!.originalMetadata),
			input.entries.slice(0, 3).map((entry) => entry.originalMetadata),
		)
	} finally {
		f.raw.close()
	}
})
