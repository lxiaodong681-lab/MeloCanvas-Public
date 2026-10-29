import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, migrations, type Database } from '../core/database'
import { ListeningLibrary } from '../core/listening'
import { sourceId, type Source } from '../core/model'
import {
	PlaylistStore,
	PlaylistUndoExpiredError,
	type PlaylistRemovalReceipt,
} from '../core/playlists'
import { SessionStore } from '../core/sessions'

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
const source = (cid: number): Source => ({
	id: sourceId('BV1vT411i7ET', cid),
	bvid: 'BV1vT411i7ET',
	cid,
	originalTitle: `原视频 P${cid}`,
	uploader: '上传者',
	uploaderId: 88,
	performer: null,
	artwork: 'https://i0.hdslb.com/a.jpg',
	duration: 300,
	domain: 'unclassified',
	audioAvailability: 'unknown',
})
const a = source(123)
const b = source(456)
const c = source(789)
const d = source(890)
const entry = (itemId: string, item: Source = a) => ({ itemId, source: item })

function seed(db: Database, legacySessions = false) {
	const library = new Library(db)
	library.setLiked(a, true)
	library.save(b)
	library.setSetting('theme', 'anime')
	new ListeningLibrary(db).saveResumePoint({
		sourceId: a.id,
		positionSeconds: 99,
		durationSeconds: 300,
		completed: false,
		updatedAt: 200,
	})
	for (const mode of ['music', 'listening'] as const) {
		if (legacySessions) {
			db.runSync('INSERT INTO playback_sessions VALUES (?, ?, ?, ?, ?)', [
				mode,
				a.id,
				99,
				mode === 'music' ? 1 : 1.5,
				200,
			])
			for (const [ordinal, savedSource] of [a, b].entries())
				db.runSync('INSERT INTO playback_session_items VALUES (?, ?, ?)', [
					mode,
					ordinal,
					savedSource.id,
				])
			continue
		}
		new SessionStore(db).saveSession({
			mode,
			entries: [a.id, b.id].map((id) => ({ entryId: id, sourceId: id })),
			currentEntryId: a.id,
			currentSourceId: a.id,
			positionSeconds: 99,
			speed: mode === 'music' ? 1 : 1.5,
			updatedAt: 200,
		})
	}
}
function oldRows(raw: DatabaseSync) {
	return JSON.stringify(
		[
			'sources',
			'likes',
			'settings',
			'resume_points',
			'playback_sessions',
			'playback_session_items',
		].map((table) => raw.prepare(`SELECT * FROM ${table}`).all()),
	)
}
function withFile(run: (file: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), 'melocanvas-playlists-'))
	if (
		!resolve(dir).startsWith(resolve(tmpdir()) + sep) ||
		!basename(dir).startsWith('melocanvas-playlists-')
	)
		throw new Error('Refusing cleanup outside test root')
	try {
		run(join(dir, 'library.db'))
	} finally {
		rmSync(dir, { recursive: true })
	}
}
function setup() {
	const connection = open()
	migrate(connection.db)
	seed(connection.db)
	return {
		...connection,
		store: new PlaylistStore(connection.db),
		library: new Library(connection.db),
	}
}

void test('真实SQLite v3→v4迁移及重开逐字段保留喜欢、主题、来源、断点、双队列和新歌单', () => {
	withFile((file) => {
		let { db, raw } = open(file)
		let before = ''
		let expected: ReturnType<PlaylistStore['get']> = null
		try {
			migrate(db, migrations.slice(0, 3))
			seed(db, true)
			before = oldRows(raw)
			migrate(db, migrations.slice(0, 4))
			const store = new PlaylistStore(db)
			store.create('playlist-1', ' 本地歌单 ')
			store.append(
				'playlist-1',
				[entry('item-a'), entry('item-b', b), entry('item-a-repeat')],
				'keep-all',
			)
			expected = store.get('playlist-1')
			assert.equal(oldRows(raw), before)
		} finally {
			raw.close()
		}
		;({ db, raw } = open(file))
		try {
			migrate(db, migrations.slice(0, 4))
			assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 4)
			assert.equal(oldRows(raw), before)
			assert.deepEqual(new PlaylistStore(db).get('playlist-1'), expected)
		} finally {
			raw.close()
		}
	})
})

void test('v4建表后故障完整回滚，重开仍v3且旧数据不变，随后可重试升级', () => {
	withFile((file) => {
		let { db, raw } = open(file)
		let before = ''
		try {
			migrate(db, migrations.slice(0, 3))
			seed(db, true)
			before = oldRows(raw)
			const fault: Database = {
				...db,
				execSync: (sql) => {
					db.execSync(sql)
					if (sql.includes('CREATE TABLE playlists'))
						throw new Error('migration write failure')
				},
			}
			assert.throws(
				() => migrate(fault, migrations.slice(0, 4)),
				/migration write failure/,
			)
			assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 3)
			assert.deepEqual(
				raw
					.prepare(
						"SELECT name FROM sqlite_master WHERE name IN ('playlists','playlist_items')",
					)
					.all(),
				[],
			)
			assert.equal(oldRows(raw), before)
		} finally {
			raw.close()
		}
		;({ db, raw } = open(file))
		try {
			assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 3)
			assert.equal(oldRows(raw), before)
			migrate(db, migrations.slice(0, 4))
			assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 4)
			assert.equal(oldRows(raw), before)
		} finally {
			raw.close()
		}
	})
})

void test('本地歌单CRUD、名称trim、同名不同身份、空和不存在输入明确处理', () => {
	const { store, raw } = setup()
	try {
		assert.deepEqual(store.list(), [])
		assert.equal(store.get('missing'), null)
		const created = store.create('p1', '  旅途  ')
		assert.equal(created.name, '旅途')
		store.create('p2', '旅途')
		assert.equal(store.list().length, 2)
		const renamed = store.rename('p1', '  夜晚 ')
		assert.equal(renamed.name, '夜晚')
		assert.equal(renamed.createdAt, created.createdAt)
		assert.equal(store.get('p1')?.name, '夜晚')
		assert.throws(() => store.create('p1', '重复身份'))
		for (const id of ['', ' ', ' p1'])
			assert.throws(() => store.get(id), /身份无效/)
		for (const name of ['', '  ', '\t\n']) {
			assert.throws(() => store.create('invalid', name), /名称不能为空/)
			assert.throws(() => store.rename('p1', name), /名称不能为空/)
		}
		assert.equal(store.get('invalid'), null)
		assert.throws(() => store.rename('missing', '新名字'), /歌单不存在/)
		assert.throws(() => store.append('missing', [], 'keep-all'), /歌单不存在/)
		assert.equal(store.delete('missing'), false)
		assert.equal(store.delete('p1'), true)
		assert.equal(store.get('p1'), null)
		assert.equal(store.list()[0].id, 'p2')
	} finally {
		raw.close()
	}
})

void test('同Source多个稳定itemId可保留，重排和移除精确到条目且顺序连续', () => {
	const { store, raw } = setup()
	try {
		store.create('p', '重复项')
		const added = store.append(
			'p',
			[entry('a1'), entry('b1', b), entry('a2')],
			'keep-all',
		)
		assert.deepEqual(added.skippedItemIds, [])
		assert.deepEqual(
			added.added.map((item) => item.sourceId),
			[a.id, b.id, a.id],
		)
		const timestamps = new Map(
			added.added.map((item) => [item.itemId, item.addedAt]),
		)
		store.reorder('p', ['a2', 'a1', 'b1'])
		assert.deepEqual(
			store.get('p')?.items.map((item) => item.itemId),
			['a2', 'a1', 'b1'],
		)
		store.remove('p', ['a1'])
		const items = store.get('p')!.items
		assert.deepEqual(
			items.map((item) => [item.itemId, item.sourceId, item.position]),
			[
				['a2', a.id, 0],
				['b1', b.id, 1],
			],
		)
		for (const item of items)
			assert.equal(item.addedAt, timestamps.get(item.itemId))
	} finally {
		raw.close()
	}
})

void test('追加必须显式重复策略，跳过现有与本批前项并报告每个跳过身份', () => {
	const { store, library, raw } = setup()
	try {
		store.create('p', '重复策略')
		store.append('p', [entry('a1')], 'keep-all')
		const result = store.append(
			'p',
			[entry('skip-a'), entry('b1', b), entry('skip-b', b), entry('c1', c)],
			'skip-existing-source',
		)
		assert.deepEqual(
			result.added.map((item) => item.itemId),
			['b1', 'c1'],
		)
		assert.deepEqual(result.skippedItemIds, ['skip-a', 'skip-b'])
		assert.deepEqual(
			store.get('p')?.items.map((item) => item.position),
			[0, 1, 2],
		)
		const before = store.get('p')
		assert.throws(
			() => store.append('p', [entry('d1', d)], undefined as never),
			/明确选择/,
		)
		assert.throws(
			() => store.append('p', [entry('d1', d)], 'automatic' as never),
			/明确选择/,
		)
		assert.equal(library.get(d.id), null)
		assert.deepEqual(store.get('p'), before)
		assert.throws(
			() => store.append('p', [entry('same', c), entry('same', d)], 'keep-all'),
			/身份不能重复/,
		)
	} finally {
		raw.close()
	}
})

void test('追加中后项来源身份无效时来源元信息更新、全批项目和歌单头都回滚', () => {
	const { store, library, raw } = setup()
	try {
		store.create('p', '原歌单')
		store.append('p', [entry('a1')], 'keep-all')
		const before = store.get('p')
		assert.throws(
			() =>
				store.append(
					'p',
					[
						entry('new-c', c),
						entry('refresh-a', { ...a, originalTitle: '不应留下的更新' }),
						entry('bad', { ...d, cid: -1 }),
					],
					'keep-all',
				),
			/音源身份无效/,
		)
		assert.deepEqual(store.get('p'), before)
		assert.equal(library.get(c.id), null)
		assert.equal(library.get(a.id)?.originalTitle, a.originalTitle)
	} finally {
		raw.close()
	}
})

void test('真实SQLite追加后项插入失败，不残留前项来源或半个批次', () => {
	const { store, library, raw } = setup()
	try {
		store.create('p', '原歌单')
		const before = store.get('p')
		raw.exec(
			`CREATE TRIGGER append_fault BEFORE INSERT ON playlist_items WHEN NEW.itemId = 'fail' BEGIN SELECT RAISE(ABORT, 'append disk fault'); END`,
		)
		assert.throws(
			() => store.append('p', [entry('c', c), entry('fail', d)], 'keep-all'),
			/append disk fault/,
		)
		assert.deepEqual(store.get('p'), before)
		assert.equal(library.get(c.id), null)
		assert.equal(library.get(d.id), null)
	} finally {
		raw.close()
	}
})

void test('全局itemId冲突、跨歌单条目、外键无效引用均拒绝，不串改现有条目', () => {
	const { store, library, raw } = setup()
	try {
		store.create('p1', '一')
		store.create('p2', '二')
		store.append('p1', [entry('global-a')], 'keep-all')
		store.append('p2', [entry('global-b', b)], 'keep-all')
		const before = store.get('p1')
		assert.throws(
			() => store.append('p2', [entry('global-a', c)], 'keep-all'),
			/UNIQUE/,
		)
		assert.equal(library.get(c.id), null)
		assert.throws(
			() => store.remove('p1', ['global-a', 'global-b']),
			/不在该歌单/,
		)
		assert.throws(
			() =>
				raw
					.prepare('INSERT INTO playlist_items (itemId, playlistId, sourceId, position, addedAt) VALUES (?, ?, ?, ?, ?)')
					.run('orphan', 'p1', c.id, 1, 0),
			/FOREIGN KEY/,
		)
		for (const ids of [
			[],
			['global-a', 'unknown'],
			['global-a', 'global-a'],
			['global-b'],
		])
			assert.throws(() => store.reorder('p1', ids))
		assert.deepEqual(store.get('p1'), before)
		assert.deepEqual(
			store.get('p2')?.items.map((item) => item.itemId),
			['global-b'],
		)
	} finally {
		raw.close()
	}
})

void test('复制生成独立条目、保留重复来源与顺序，删除仅影响本歌单而不动喜欢来源断点或双队列', () => {
	const { store, raw } = setup()
	try {
		const before = oldRows(raw)
		store.create('original', '同名歌单')
		store.append(
			'original',
			[entry('a1'), entry('b1', b), entry('a2')],
			'keep-all',
		)
		const original = store.get('original')
		const copied = store.copy('original', 'copy', ' 同名歌单 ', [
			'copy-a1',
			'copy-b1',
			'copy-a2',
		])
		assert.equal(copied.name, '同名歌单')
		assert.deepEqual(
			copied.items.map((item) => item.sourceId),
			[a.id, b.id, a.id],
		)
		assert.deepEqual(
			copied.items.map((item) => item.position),
			[0, 1, 2],
		)
		store.rename('copy', '副本')
		store.remove('copy', ['copy-a1'])
		assert.deepEqual(store.get('original'), original)
		assert.equal(store.delete('original'), true)
		assert.equal(store.get('original'), null)
		assert.deepEqual(
			store.get('copy')?.items.map((item) => item.itemId),
			['copy-b1', 'copy-a2'],
		)
		assert.equal(oldRows(raw), before)
	} finally {
		raw.close()
	}
})

void test('复制身份数量、重复身份或现有身份冲突完整回滚新歌单及所有新条目', () => {
	const { store, raw } = setup()
	try {
		store.create('p', '源')
		store.append('p', [entry('a1'), entry('b1', b)], 'keep-all')
		const before = store.get('p')
		assert.throws(
			() => store.copy('p', 'copy', '副本', ['new-a']),
			/数量不匹配/,
		)
		assert.throws(
			() => store.copy('p', 'copy', '副本', ['new-a', 'new-a']),
			/身份不能重复/,
		)
		assert.throws(
			() => store.copy('p', 'copy', '副本', ['new-a', 'b1']),
			/UNIQUE/,
		)
		assert.equal(store.get('copy'), null)
		raw.exec(
			`CREATE TRIGGER copy_fault BEFORE INSERT ON playlist_items WHEN NEW.itemId = 'copy-fail' BEGIN SELECT RAISE(ABORT, 'copy disk fault'); END`,
		)
		assert.throws(
			() => store.copy('p', 'copy', '副本', ['new-a', 'copy-fail']),
			/copy disk fault/,
		)
		assert.equal(store.get('copy'), null)
		assert.deepEqual(store.get('p'), before)
		assert.equal(
			raw
				.prepare(
					"SELECT COUNT(*) AS count FROM playlist_items WHERE itemId = 'new-a'",
				)
				.get()?.count,
			0,
		)
	} finally {
		raw.close()
	}
})

void test('重排、批量移除和级联删除故障均保留完整原歌单及原顺序', () => {
	const { store, raw } = setup()
	try {
		store.create('p', '原歌单')
		store.append('p', [entry('a1'), entry('b1', b), entry('a2')], 'keep-all')
		const before = store.get('p')
		const data = oldRows(raw)
		raw.exec(
			`CREATE TRIGGER reorder_fault BEFORE INSERT ON playlist_items WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, 'reorder disk fault'); END`,
		)
		assert.throws(
			() => store.reorder('p', ['a2', 'b1', 'a1']),
			/reorder disk fault/,
		)
		assert.deepEqual(store.get('p'), before)
		raw.exec('DROP TRIGGER reorder_fault')
		raw.exec(
			`CREATE TRIGGER remove_fault BEFORE DELETE ON playlist_items WHEN OLD.itemId = 'b1' BEGIN SELECT RAISE(ABORT, 'remove disk fault'); END`,
		)
		assert.throws(() => store.remove('p', ['a1', 'a2']), /remove disk fault/)
		assert.deepEqual(store.get('p'), before)
		assert.throws(() => store.delete('p'), /remove disk fault/)
		assert.deepEqual(store.get('p'), before)
		assert.equal(oldRows(raw), data)
	} finally {
		raw.close()
	}
})

void test('空歌单可复制、空批次和空排列合法，损坏排序读取不伪装正常', () => {
	const { store, raw } = setup()
	try {
		store.create('empty', '空歌单')
		assert.deepEqual(store.append('empty', [], 'keep-all'), {
			added: [],
			skippedItemIds: [],
		})
		store.remove('empty', [])
		store.reorder('empty', [])
		assert.deepEqual(store.copy('empty', 'copy', '空副本', []).items, [])
		assert.equal(store.delete('copy'), true)
		store.append('empty', [entry('a1')], 'keep-all')
		raw.exec("UPDATE playlist_items SET position = 4 WHERE itemId = 'a1'")
		assert.throws(() => store.get('empty'), /顺序无效/)
	} finally {
		raw.close()
	}
})

void test('原子撤销恢复原itemId、重复来源顺序及addedAt，仅消费本次凭据一次', () => {
	const { store, raw } = setup()
	try {
		store.create('p', '原歌单')
		store.append('p', [entry('a1'), entry('b1', b), entry('a2')], 'keep-all')
		const before = store.get('p')!
		const data = oldRows(raw)
		const receipt = store.remove('p', ['a1', 'b1'])!
		assert.ok(Object.isFrozen(receipt))
		const after = store.get('p')!
		assert.deepEqual(
			after.items.map((item) => item.itemId),
			['a2'],
		)
		const restored = store.undoRemove(receipt)
		assert.deepEqual(restored.items, before.items)
		assert.equal(restored.name, before.name)
		assert.equal(restored.createdAt, before.createdAt)
		assert.ok(restored.updatedAt > after.updatedAt)
		assert.equal(oldRows(raw), data)
		assert.throws(
			() => store.undoRemove(receipt),
			(error) =>
				error instanceof PlaylistUndoExpiredError &&
				error.code === 'PLAYLIST_UNDO_EXPIRED',
		)
	} finally {
		raw.close()
	}
})

void test('撤销SQL中途失败回滚全部状态、保留凭据，移除故障后能重试成功', () => {
	const { store, raw } = setup()
	try {
		store.create('p', '原歌单')
		store.append('p', [entry('a1'), entry('b1', b), entry('a2')], 'keep-all')
		const before = store.get('p')!
		const receipt = store.remove('p', ['a1'])!
		const after = store.get('p')
		raw.exec(
			`CREATE TRIGGER undo_fault BEFORE INSERT ON playlist_items WHEN NEW.itemId = 'a1' BEGIN SELECT RAISE(ABORT, 'undo disk fault'); END`,
		)
		assert.throws(
			() => store.undoRemove(receipt),
			(error) =>
				error instanceof Error &&
				!(error instanceof PlaylistUndoExpiredError) &&
				/undo disk fault/.test(error.message),
		)
		assert.deepEqual(store.get('p'), after)
		raw.exec('DROP TRIGGER undo_fault')
		assert.deepEqual(store.undoRemove(receipt).items, before.items)
	} finally {
		raw.close()
	}
})

void test('同歌单成功编辑使旧撤销失效，同顺序重排也算编辑', () => {
	for (const mutate of [
		(store: PlaylistStore) => store.rename('p', '新名字'),
		(store: PlaylistStore) => store.append('p', [entry('c1', c)], 'keep-all'),
		(store: PlaylistStore) => store.reorder('p', ['b1', 'a2']),
		(store: PlaylistStore) => store.delete('p'),
	]) {
		const { store, raw } = setup()
		try {
			store.create('p', '原歌单')
			store.append('p', [entry('a1'), entry('b1', b), entry('a2')], 'keep-all')
			const receipt = store.remove('p', ['a1'])!
			mutate(store)
			const edited = store.get('p')
			assert.throws(() => store.undoRemove(receipt), PlaylistUndoExpiredError)
			assert.deepEqual(store.get('p'), edited)
		} finally {
			raw.close()
		}
	}
})

void test('失败的同歌单写入不丢有效撤销，失败的新移除也不替换旧凭据', () => {
	const { store, raw } = setup()
	try {
		store.create('p', '原歌单')
		store.append('p', [entry('a1'), entry('b1', b), entry('a2')], 'keep-all')
		const before = store.get('p')!
		const receipt = store.remove('p', ['a1'])!
		assert.throws(() => store.rename('p', '  '))
		assert.throws(() =>
			store.append(
				'p',
				[entry('c1', c), entry('bad', { ...d, cid: -1 })],
				'keep-all',
			),
		)
		assert.throws(() => store.reorder('p', ['b1']))
		assert.throws(() => store.remove('p', ['missing']))
		raw.exec(
			`CREATE TRIGGER failed_write BEFORE DELETE ON playlist_items WHEN OLD.itemId = 'b1' BEGIN SELECT RAISE(ABORT, 'write fault'); END`,
		)
		assert.throws(() => store.remove('p', ['b1']), /write fault/)
		assert.throws(() => store.delete('p'), /write fault/)
		raw.exec('DROP TRIGGER failed_write')
		assert.deepEqual(store.undoRemove(receipt).items, before.items)
	} finally {
		raw.close()
	}
})

void test('其他歌单编辑、复制来源、空操作和skip-all追加不作废当前凭据，不覆盖更新后的Source或喜欢', () => {
	const { store, library, db, raw } = setup()
	try {
		store.create('p', '原歌单')
		store.append('p', [entry('a1'), entry('b1', b), entry('a2')], 'keep-all')
		const before = store.get('p')!
		const receipt = store.remove('p', ['a1'])!
		const after = store.get('p')!
		store.create('q', '另一歌单')
		store.append('q', [entry('q1', b)], 'keep-all')
		store.rename('q', '别的名字')
		store.reorder('q', ['q1'])
		store.delete('q')
		store.copy('p', 'copy', '副本', ['copy-b1', 'copy-a2'])
		assert.equal(store.remove('p', []), null)
		assert.deepEqual(store.append('p', [], 'keep-all'), {
			added: [],
			skippedItemIds: [],
		})
		store.append(
			'p',
			[entry('skip-a', { ...a, originalTitle: '后来的资料更新' })],
			'skip-existing-source',
		)
		library.setLiked({ ...a, originalTitle: '后来的资料更新' }, false)
		assert.equal(store.get('p')?.updatedAt, after.updatedAt)
		const data = oldRows(raw)
		assert.deepEqual(store.undoRemove(receipt).items, before.items)
		assert.equal(library.get(a.id)?.originalTitle, '后来的资料更新')
		assert.equal(oldRows(raw), data)
		assert.deepEqual(new Library(db).likes(), [])
		assert.deepEqual(
			store.get('copy')?.items.map((item) => item.sourceId),
			[b.id, a.id],
		)
	} finally {
		raw.close()
	}
})

void test('最新一次成功移除替换旧凭据，即使新移除发生在另一歌单', () => {
	const { store, raw } = setup()
	try {
		for (const id of ['p', 'q']) {
			store.create(id, id)
			store.append(id, [entry(`${id}-a`, a), entry(`${id}-b`, b)], 'keep-all')
		}
		const first = store.remove('p', ['p-a'])!
		const second = store.remove('q', ['q-a'])!
		assert.throws(() => store.undoRemove(first), PlaylistUndoExpiredError)
		assert.deepEqual(
			store.undoRemove(second).items.map((item) => item.itemId),
			['q-a', 'q-b'],
		)
		assert.deepEqual(
			store.get('p')?.items.map((item) => item.itemId),
			['p-b'],
		)
	} finally {
		raw.close()
	}
})

void test('伪造、复制或不同Store实例的凭据被拒绝，不消费原有效凭据', () => {
	const { store, db, raw } = setup()
	try {
		store.create('p', '原歌单')
		store.append('p', [entry('a1'), entry('b1', b)], 'keep-all')
		const receipt = store.remove('p', ['a1'])!
		assert.throws(
			() => store.undoRemove({} as PlaylistRemovalReceipt),
			PlaylistUndoExpiredError,
		)
		assert.throws(
			() => store.undoRemove(structuredClone(receipt)),
			PlaylistUndoExpiredError,
		)
		assert.throws(
			() => new PlaylistStore(db).undoRemove(receipt),
			PlaylistUndoExpiredError,
		)
		assert.deepEqual(
			store.undoRemove(receipt).items.map((item) => item.itemId),
			['a1', 'b1'],
		)
	} finally {
		raw.close()
	}
})

void test('同毫秒另一Store改名后改回，after-items相同也不能撤销覆盖新编辑', (context) => {
	context.mock.method(Date, 'now', () => 1000)
	const { store, db, raw } = setup()
	try {
		store.create('p', '原歌单')
		store.append('p', [entry('a1'), entry('b1', b)], 'keep-all')
		const receipt = store.remove('p', ['a1'])!
		const after = store.get('p')!
		const other = new PlaylistStore(db)
		other.rename('p', '临时名字')
		other.rename('p', '原歌单')
		const edited = store.get('p')!
		assert.deepEqual(edited.items, after.items)
		assert.equal(edited.name, after.name)
		assert.ok(edited.updatedAt > after.updatedAt)
		assert.throws(
			() => store.undoRemove(receipt),
			(error) =>
				error instanceof PlaylistUndoExpiredError &&
				/发生更改/.test(error.message),
		)
		assert.deepEqual(store.get('p'), edited)
	} finally {
		raw.close()
	}
})

void test('另一数据库连接重排后拒绝旧凭据，保留较新歌单顺序', () => {
	withFile((file) => {
		const first = open(file)
		const second = open(file)
		try {
			migrate(first.db)
			migrate(second.db)
			seed(first.db)
			const store = new PlaylistStore(first.db)
			store.create('p', '原歌单')
			store.append('p', [entry('a1'), entry('b1', b), entry('a2')], 'keep-all')
			const receipt = store.remove('p', ['a1'])!
			new PlaylistStore(second.db).reorder('p', ['a2', 'b1'])
			const edited = store.get('p')
			assert.throws(() => store.undoRemove(receipt), PlaylistUndoExpiredError)
			assert.deepEqual(store.get('p'), edited)
		} finally {
			first.raw.close()
			second.raw.close()
		}
	})
})

void test('移除后的itemId被其他歌单使用时撤销原子失败，不删新条目，解除冲突后仍可重试', () => {
	const { store, raw } = setup()
	try {
		store.create('p', '原歌单')
		store.append('p', [entry('a1'), entry('b1', b)], 'keep-all')
		const receipt = store.remove('p', ['a1'])!
		const after = store.get('p')
		store.create('q', '另一个歌单')
		store.append('q', [entry('a1', c)], 'keep-all')
		assert.throws(
			() => store.undoRemove(receipt),
			(error) =>
				error instanceof Error &&
				!(error instanceof PlaylistUndoExpiredError) &&
				/UNIQUE/.test(error.message),
		)
		assert.deepEqual(store.get('p'), after)
		assert.equal(store.get('q')?.items[0].sourceId, c.id)
		store.delete('q')
		assert.deepEqual(
			store.undoRemove(receipt).items.map((item) => item.itemId),
			['a1', 'b1'],
		)
	} finally {
		raw.close()
	}
})

void test('COMMIT故障不消费凭据也不残留改名或撤销的半成品，修复后可重试', () => {
	const { db, raw } = setup()
	let failCommit = false
	const fault: Database = {
		...db,
		execSync: (sql) => {
			if (sql === 'COMMIT' && failCommit) throw new Error('commit fault')
			db.execSync(sql)
		},
	}
	const store = new PlaylistStore(fault)
	try {
		store.create('p', '原歌单')
		store.append('p', [entry('a1'), entry('b1', b)], 'keep-all')
		const before = store.get('p')!
		const receipt = store.remove('p', ['a1'])!
		const after = store.get('p')
		failCommit = true
		assert.throws(() => store.rename('p', '不能留下的名字'), /commit fault/)
		assert.deepEqual(store.get('p'), after)
		assert.throws(() => store.undoRemove(receipt), /commit fault/)
		assert.deepEqual(store.get('p'), after)
		failCommit = false
		assert.deepEqual(store.undoRemove(receipt).items, before.items)
	} finally {
		raw.close()
	}
})

void test('原始条目addedAt或顺序被外部改写时凭据明确过期，不把冲突误当可重试SQL故障', () => {
	for (const change of [
		"UPDATE playlist_items SET addedAt = addedAt + 1 WHERE itemId = 'b1'",
		"UPDATE playlist_items SET position = 4 WHERE itemId = 'b1'",
	]) {
		const { store, raw } = setup()
		try {
			store.create('p', '原歌单')
			store.append('p', [entry('a1'), entry('b1', b)], 'keep-all')
			const receipt = store.remove('p', ['a1'])!
			raw.exec(change)
			const edited = raw
				.prepare("SELECT * FROM playlist_items WHERE playlistId = 'p'")
				.all()
			assert.throws(() => store.undoRemove(receipt), PlaylistUndoExpiredError)
			assert.deepEqual(
				raw
					.prepare("SELECT * FROM playlist_items WHERE playlistId = 'p'")
					.all(),
				edited,
			)
		} finally {
			raw.close()
		}
	}
})
