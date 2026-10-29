import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, migrations, type Database } from '../core/database'
import { ImportStore } from '../core/imports'
import { sourceId, type Source } from '../core/model'
import type { MusicLibrarySource } from '../core/music-library-source'
import { PlaylistStore } from '../core/playlists'
import { playLikedCollection } from '../liked-playback'
import { PlaybackIntent } from '../playback-intent'
import type { PlaylistCoverFiles } from '../playlist-cover-files'
import {
	preparePlaylistPlayback,
	selectPlaylistDetailItems,
} from '../playlist-selection'
import { PlaylistSession } from '../playlist-session'

const sourceA: Source = {
	id: sourceId('BV1vT411i7ET', 123),
	bvid: 'BV1vT411i7ET',
	cid: 123,
	originalTitle: '第一段音源',
	uploader: 'UP甲',
	uploaderId: 8,
	performer: null,
	artwork: 'https://i0.hdslb.com/a.jpg',
	duration: 100,
	domain: 'unclassified',
	audioAvailability: 'unknown',
}
const sourceB: Source = {
	...sourceA,
	id: sourceId(sourceA.bvid, 456),
	cid: 456,
	originalTitle: '第二段音源',
	uploader: 'UP乙',
}

function setup(coverFiles?: PlaylistCoverFiles) {
	const raw = new DatabaseSync(':memory:')
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
	migrate(db)
	const library = new Library(db)
	const store = new PlaylistStore(db)
	let id = 0
	const session = new PlaylistSession(
		store,
		library,
		() => `ui-${++id}`,
		coverFiles,
	)
	const create = (name = '本地歌单') => {
		session.requestName('create')
		session.setName(name)
		assert.equal(session.saveName(), true)
		return session.getSnapshot().currentId!
	}
	const add = (sources = [sourceA, sourceB]) => {
		session.openAdd(sources)
		for (const source of sources) session.toggleSource(source.id)
		session.setDuplicatePolicy('keep-all')
		assert.equal(session.appendSelected(), true)
	}
	return { raw, db, library, store, session, create, add }
}

void test('创建、改名、复制、确认删除形成独立本地管理闭环，喜欢与来源保留', () => {
	const { raw, library, store, session, create, add } = setup()
	try {
		library.setLiked(sourceA, true)
		const original = create(' 原歌单 ')
		add([sourceA])
		assert.equal(session.getSnapshot().detail?.name, '原歌单')
		session.requestName('rename')
		session.setName('改过名字')
		assert.equal(session.saveName(), true)
		const originalItem = store.get(original)!.items[0]
		session.requestName('copy')
		session.setName('独立副本')
		assert.equal(session.saveName(), true)
		const copy = session.getSnapshot().detail!
		assert.notEqual(copy.id, original)
		assert.notEqual(copy.items[0].itemId, originalItem.itemId)
		assert.equal(copy.items[0].sourceId, originalItem.sourceId)
		assert.equal(session.confirmDelete(), false)
		session.requestDelete()
		assert.equal(session.confirmDelete(), true)
		assert.equal(session.getSnapshot().currentId, null)
		assert.equal(store.get(copy.id), null)
		assert.equal(store.get(original)?.name, '改过名字')
		assert.equal(library.likes()[0].id, sourceA.id)
		assert.equal(library.get(sourceA.id)?.domain, 'unclassified')
	} finally {
		raw.close()
	}
})

void test('音源选择初始为空，筛选保留选择，按列表顺序追加且必须明确重复策略', () => {
	const { raw, session, create } = setup()
	try {
		create()
		session.openAdd([sourceA, sourceB])
		assert.deepEqual(session.getSnapshot().picker?.selectedSourceIds, [])
		assert.equal(session.appendSelected(), false)
		session.toggleSource(sourceB.id)
		session.setPickerQuery('UP甲')
		session.toggleSource(sourceA.id)
		assert.deepEqual(session.getSnapshot().picker?.selectedSourceIds, [
			sourceB.id,
			sourceA.id,
		])
		session.setPickerQuery('nothing-visible')
		assert.equal(session.appendSelected(), false)
		assert.match(session.getSnapshot().error, /请选择如何处理/)
		session.setDuplicatePolicy('keep-all')
		assert.equal(session.appendSelected(), true)
		assert.deepEqual(
			session.getSnapshot().detail?.items.map((item) => item.sourceId),
			[sourceA.id, sourceB.id],
		)
		assert.equal(session.getSnapshot().picker, null)
		assert.match(session.getSnapshot().notice, /已添加 2 项/)
	} finally {
		raw.close()
	}
})

void test('重复项按itemId选择排序移除，跳过与保留策略如实对账', () => {
	const { raw, session, create, add } = setup()
	try {
		create()
		add()
		session.openAdd([sourceA])
		session.toggleSource(sourceA.id)
		session.setDuplicatePolicy('skip-existing-source')
		assert.equal(session.appendSelected(), true)
		assert.match(session.getSnapshot().notice, /已添加 0 项，跳过 1 项/)
		add([sourceA])
		const original = session.getSnapshot().detail!.items
		assert.equal(original.length, 3)
		assert.notEqual(original[0].itemId, original[2].itemId)
		session.setEditing(true)
		session.toggleItem(original[2].itemId)
		assert.equal(session.move(original[2].itemId, -1), true)
		assert.deepEqual(session.getSnapshot().selectedItemIds, [
			original[2].itemId,
		])
		assert.equal(session.removeSelected(), true)
		assert.deepEqual(
			session.getSnapshot().detail?.items.map((item) => item.itemId),
			[original[0].itemId, original[1].itemId],
		)
		assert.equal(session.getSnapshot().undoAvailable, true)
		assert.equal(session.undoRemove(), true)
		assert.deepEqual(
			session.getSnapshot().detail?.items.map((item) => item.itemId),
			[original[0].itemId, original[2].itemId, original[1].itemId],
		)
	} finally {
		raw.close()
	}
})

void test('名称为空和真实SQL创建失败保留表单，不显示假成功', () => {
	const { raw, db, session } = setup()
	try {
		session.requestName('create')
		session.setName('   ')
		assert.equal(session.saveName(), false)
		assert.match(session.getSnapshot().error, /起个名字/)
		assert.equal(session.getSnapshot().playlists.length, 0)
		session.setName('保留输入')
		db.execSync(
			"CREATE TRIGGER fail_playlist BEFORE INSERT ON playlists BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
		)
		assert.equal(session.saveName(), false)
		assert.equal(session.getSnapshot().nameForm?.value, '保留输入')
		assert.equal(session.getSnapshot().currentId, null)
		assert.equal(session.getSnapshot().notice, '')
		db.execSync('DROP TRIGGER fail_playlist')
		assert.equal(session.saveName(), true)
	} finally {
		raw.close()
	}
})

void test('整批添加失败保留选择与策略，可重试；不留下半条音源或条目', () => {
	const { raw, db, library, session, create } = setup()
	try {
		create()
		session.openAdd([sourceA, sourceB])
		session.toggleSource(sourceA.id)
		session.toggleSource(sourceB.id)
		session.setDuplicatePolicy('keep-all')
		db.execSync(
			"CREATE TRIGGER fail_second BEFORE INSERT ON playlist_items WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
		)
		assert.equal(session.appendSelected(), false)
		assert.deepEqual(session.getSnapshot().picker?.selectedSourceIds, [
			sourceA.id,
			sourceB.id,
		])
		assert.equal(session.getSnapshot().picker?.duplicatePolicy, 'keep-all')
		assert.equal(session.getSnapshot().detail?.items.length, 0)
		assert.equal(library.get(sourceA.id), null)
		db.execSync('DROP TRIGGER fail_second')
		assert.equal(session.appendSelected(), true)
		assert.equal(session.getSnapshot().detail?.items.length, 2)
	} finally {
		raw.close()
	}
})

void test('移除失败保留选中项；撤销SQL失败保留receipt供重试', () => {
	const { raw, db, session, create, add } = setup()
	try {
		create()
		add()
		const original = session.getSnapshot().detail!.items
		session.setEditing(true)
		session.toggleItem(original[0].itemId)
		db.execSync(
			"CREATE TRIGGER fail_remove BEFORE DELETE ON playlist_items BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
		)
		assert.equal(session.removeSelected(), false)
		assert.deepEqual(session.getSnapshot().selectedItemIds, [
			original[0].itemId,
		])
		assert.equal(session.getSnapshot().undoAvailable, false)
		db.execSync('DROP TRIGGER fail_remove')
		assert.equal(session.removeSelected(), true)
		db.execSync(
			"CREATE TRIGGER fail_undo BEFORE INSERT ON playlist_items BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
		)
		assert.equal(session.undoRemove(), false)
		assert.equal(session.getSnapshot().undoAvailable, true)
		assert.match(session.getSnapshot().error, /disk failure/)
		db.execSync('DROP TRIGGER fail_undo')
		assert.equal(session.undoRemove(), true)
		assert.deepEqual(session.getSnapshot().detail?.items, original)
	} finally {
		raw.close()
	}
})

void test('外部编辑使撤销失效时明确报错且不覆盖后来操作', () => {
	const { raw, store, session, create, add } = setup()
	try {
		const id = create()
		add()
		session.setEditing(true)
		session.selectAll()
		assert.equal(session.removeSelected(), true)
		store.rename(id, '外部较新名称')
		assert.equal(session.undoRemove(), false)
		assert.equal(session.getSnapshot().undoAvailable, false)
		assert.match(session.getSnapshot().error, /失效|修改/)
		assert.equal(store.get(id)?.name, '外部较新名称')
		assert.equal(store.get(id)?.items.length, 0)
	} finally {
		raw.close()
	}
})

void test('skip-all添加和复制保留来源撤销，同歌单成功改名清除撤销', () => {
	const { raw, session, create, add } = setup()
	try {
		const id = create()
		add()
		session.setEditing(true)
		session.toggleItem(session.getSnapshot().detail!.items[1].itemId)
		session.removeSelected()
		session.openAdd([sourceA])
		session.toggleSource(sourceA.id)
		session.setDuplicatePolicy('skip-existing-source')
		session.appendSelected()
		assert.equal(session.getSnapshot().undoAvailable, true)
		session.requestName('copy')
		session.setName('另一张')
		session.saveName()
		session.open(id)
		assert.equal(session.getSnapshot().undoAvailable, true)
		session.requestName('rename')
		session.setName('新名字')
		session.saveName()
		assert.equal(session.getSnapshot().undoAvailable, false)
		assert.equal(session.undoRemove(), false)
	} finally {
		raw.close()
	}
})

void test('打开已删除歌单不显示上一张详情，也不能误操作上一张', () => {
	const { raw, store, session, create } = setup()
	try {
		const old = create('原歌单')
		session.open('missing')
		assert.equal(session.getSnapshot().detail, null)
		assert.match(session.getSnapshot().error, /已不存在/)
		session.requestName('rename')
		assert.equal(session.saveName(), false)
		assert.equal(store.get(old)?.name, '原歌单')
	} finally {
		raw.close()
	}
})

void test('搜索音源显式选择目标与条目后才写入，取消不写，保留来源分类', () => {
	const { raw, store, session, library, create } = setup()
	try {
		const id = create()
		session.close()
		session.requestAddSources([sourceA])
		session.closeSheet()
		assert.equal(store.get(id)?.items.length, 0)
		assert.equal(library.get(sourceA.id), null)
		session.requestAddSources([sourceA])
		session.selectTarget(id)
		assert.deepEqual(session.getSnapshot().picker?.selectedSourceIds, [])
		session.toggleSource(sourceA.id)
		assert.equal(session.appendSelected(), false)
		session.setDuplicatePolicy('keep-all')
		assert.equal(session.appendSelected(), true)
		assert.equal(store.get(id)?.items[0].sourceId, sourceA.id)
		assert.equal(library.get(sourceA.id)?.domain, 'unclassified')
		session.requestAddSources([sourceB])
		session.requestName('create')
		session.setName('搜索新歌单')
		assert.equal(session.saveName(), true)
		const nextId = session.getSnapshot().currentId!
		assert.notEqual(nextId, id)
		assert.equal(store.get(nextId)?.items.length, 0)
		assert.equal(session.getSnapshot().picker?.sources[0].id, sourceB.id)
		session.closeSheet()
		assert.equal(library.get(sourceB.id), null)
	} finally {
		raw.close()
	}
})

void test('歌单播放准备完整保留 A/B/A 与第三项起点，缺源或失效起点整批拒绝', () => {
	const { raw, store, session, library, create, add } = setup()
	try {
		const id = create()
		add()
		add([sourceA])
		const detail = store.get(id)!
		const target = preparePlaylistPlayback(
			store,
			library,
			id,
			detail.items[2].itemId,
		)
		assert.deepEqual(
			target.entries.map((entry) => entry.source.id),
			[sourceA.id, sourceB.id, sourceA.id],
		)
		assert.deepEqual(
			target.entries.map((entry) => entry.itemId),
			detail.items.map((item) => item.itemId),
		)
		assert.equal(target.startItemId, detail.items[2].itemId)
		assert.throws(
			() => preparePlaylistPlayback(store, library, id, sourceA.id),
			/条目已变更/,
		)
		assert.throws(
			() =>
				preparePlaylistPlayback(
					store,
					{ getMusic: () => null },
					id,
					detail.items[0].itemId,
				),
			/第 1 项/,
		)
		assert.throws(
			() =>
				preparePlaylistPlayback(
					store,
					library,
					'missing',
					detail.items[0].itemId,
				),
			/已不存在/,
		)
		session.requestName('create')
		session.setName('空歌单')
		session.saveName()
		assert.throws(
			() =>
				preparePlaylistPlayback(
					store,
					library,
					session.getSnapshot().currentId!,
					'none',
				),
			/没有音源/,
		)
	} finally {
		raw.close()
	}
})

void test('创建/复制写入成功后刷新读失败，后续添加删除始终指向新歌单', () => {
	const { raw, store, session, create, add } = setup()
	try {
		const originalId = create('原歌单')
		add([sourceA])
		const list = store.listSummaries.bind(store)
		store.listSummaries = () => {
			throw new Error('read failed after commit')
		}
		session.requestName('copy')
		session.setName('副本')
		assert.equal(session.saveName(), true)
		const copyId = session.getSnapshot().currentId!
		assert.notEqual(copyId, originalId)
		assert.equal(session.getSnapshot().detail?.id, copyId)
		assert.match(session.getSnapshot().error, /read failed/)
		session.requestDelete()
		assert.equal(session.confirmDelete(), true)
		assert.equal(store.get(copyId), null)
		assert.equal(store.get(originalId)?.items.length, 1)
		session.open(originalId)
		store.listSummaries = list
		session.refresh()
		store.listSummaries = () => {
			throw new Error('read failed after commit')
		}
		session.requestName('create')
		session.setName('新建')
		assert.equal(session.saveName(), true)
		const newId = session.getSnapshot().currentId!
		assert.equal(session.getSnapshot().detail?.id, newId)
		assert.equal(session.getSnapshot().sources.size, 0)
		add([sourceB])
		assert.equal(store.get(newId)?.items[0].sourceId, sourceB.id)
		assert.deepEqual(
			store.get(originalId)?.items.map((item) => item.sourceId),
			[sourceA.id],
		)
	} finally {
		raw.close()
	}
})

void test('歌单简介可保存清空、复制保留，SQL失败保留表单且取消不写入', () => {
	const f = setup()
	try {
		const id = f.create()
		f.add([sourceA])
		f.session.requestName('description')
		assert.equal(f.session.getSnapshot().nameForm?.value, '')
		const text = ' 夜晚的歌单\n' + '完整保留'.repeat(100) + ' '
		f.session.setName(text)
		f.raw.exec(
			"CREATE TRIGGER fail_description BEFORE UPDATE OF description ON playlists BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
		)
		assert.equal(f.session.saveName(), false)
		assert.equal(f.session.getSnapshot().nameForm?.value, text)
		assert.equal(f.store.get(id)?.description, '')
		f.raw.exec('DROP TRIGGER fail_description')
		assert.equal(f.session.saveName(), true)
		assert.equal(f.store.get(id)?.description, text.trim())
		f.session.requestName('copy')
		f.session.setName('副本')
		assert.equal(f.session.saveName(), true)
		assert.equal(f.session.getSnapshot().detail?.description, text.trim())
		f.session.requestName('rename')
		f.session.setName('改名')
		assert.equal(f.session.saveName(), true)
		assert.equal(f.session.getSnapshot().detail?.description, text.trim())
		f.session.requestName('description')
		f.session.setName('不会保存')
		f.session.closeSheet()
		assert.equal(f.session.saveName(), false)
		assert.equal(f.session.getSnapshot().detail?.description, text.trim())
		f.session.requestName('description')
		f.session.setName('  ')
		assert.equal(f.session.saveName(), true)
		assert.equal(f.session.getSnapshot().detail?.description, '')
		assert.equal(f.store.get(id)?.description, text.trim())
	} finally {
		f.raw.close()
	}
})

void test('简介迁移为已有歌单补空值且保留原列，重跑迁移不覆盖全文', () => {
	const raw = new DatabaseSync(':memory:')
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, args) => raw.prepare(sql).run(...args),
		getAllSync: <T>(sql: string, args: (string | number | null)[]) =>
			raw.prepare(sql).all(...args) as T[],
		getFirstSync: <T>(sql: string, args: (string | number | null)[]) =>
			(raw.prepare(sql).get(...args) as T) ?? null,
	}
	try {
		migrate(
			db,
			migrations.slice(
				0,
				migrations.findIndex((sql) => sql.includes('ADD COLUMN description')),
			),
		)
		raw
			.prepare(
				'INSERT INTO playlists(id,name,createdAt,updatedAt) VALUES (?,?,?,?)',
			)
			.run('old', '旧歌单', 1, 2)
		migrate(db)
		assert.deepEqual(
			{ ...raw.prepare('SELECT * FROM playlists').get() },
			{
				id: 'old',
				name: '旧歌单',
				createdAt: 1,
				updatedAt: 2,
				description: '',
				coverUri: null,
			},
		)
		const store = new PlaylistStore(db)
		store.setDescription('old', '完整简介')
		migrate(db)
		assert.equal(new PlaylistStore(db).get('old')?.description, '完整简介')
	} finally {
		raw.close()
	}
})

void test('本地封面预览后保存、复制保留、显式恢复自动；写失败保留预览且清理未提交副本', async () => {
	let copies = 0,
		discarded = 0
	const f = setup({
		pick: async () => 'file:///cache/chosen.png',
		persist: async () => ({
			uri: `file:///private/cover-${++copies}`,
			discard: () => {
				discarded++
			},
		}),
	})
	try {
		const id = f.create()
		f.add([sourceA])
		f.session.requestCover()
		assert.equal(await f.session.pickCover(), true)
		assert.equal(
			f.session.getSnapshot().coverForm?.uri,
			'file:///cache/chosen.png',
		)
		assert.equal(f.store.get(id)?.coverUri, null)
		f.raw.exec(
			"CREATE TRIGGER fail_cover BEFORE UPDATE OF coverUri ON playlists BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
		)
		assert.equal(await f.session.saveCover(), false)
		assert.equal(discarded, 1)
		assert.equal(
			f.session.getSnapshot().coverForm?.uri,
			'file:///cache/chosen.png',
		)
		assert.equal(f.store.get(id)?.coverUri, null)
		f.raw.exec('DROP TRIGGER fail_cover')
		assert.equal(await f.session.saveCover(), true)
		assert.equal(f.store.get(id)?.coverUri, 'file:///private/cover-2')
		assert.equal(
			f.session.getSnapshot().playlists.find((p) => p.playlist.id === id)
				?.artwork,
			'file:///private/cover-2',
		)
		f.session.requestName('copy')
		f.session.setName('封面副本')
		assert.equal(f.session.saveName(), true)
		assert.equal(
			f.session.getSnapshot().detail?.coverUri,
			'file:///private/cover-2',
		)
		f.session.requestCover()
		f.session.useAutomaticCover()
		assert.equal(await f.session.saveCover(), true)
		assert.equal(f.session.getSnapshot().detail?.coverUri, null)
		assert.equal(f.store.get(id)?.coverUri, 'file:///private/cover-2')
		assert.equal(discarded, 1)
	} finally {
		f.raw.close()
	}
})

void test('关闭封面编辑后迟到的选择或复制不会覆盖歌单，取消选择保留原预览', async () => {
	let resolvePick!: (uri: string | null) => void,
		resolveSave!: (saved: { uri: string; discard: () => void }) => void
	let discarded = 0
	const f = setup({
		pick: () =>
			new Promise((resolve) => {
				resolvePick = resolve
			}),
		persist: () =>
			new Promise((resolve) => {
				resolveSave = resolve
			}),
	})
	try {
		const id = f.create()
		f.session.requestCover()
		const pick = f.session.pickCover()
		f.session.closeSheet()
		resolvePick('file:///cache/old')
		assert.equal(await pick, false)
		assert.equal(f.session.getSnapshot().coverForm, null)
		f.session.requestCover()
		const selected = f.session.pickCover()
		resolvePick('file:///cache/new')
		await selected
		const canceled = f.session.pickCover()
		resolvePick(null)
		assert.equal(await canceled, false)
		assert.equal(f.session.getSnapshot().coverForm?.uri, 'file:///cache/new')
		const save = f.session.saveCover()
		f.session.closeSheet()
		resolveSave({
			uri: 'file:///private/late',
			discard: () => {
				discarded++
			},
		})
		assert.equal(await save, false)
		assert.equal(discarded, 1)
		assert.equal(f.store.get(id)?.coverUri, null)
	} finally {
		f.raw.close()
	}
})

void test('播放全部喜欢读取最新有序集合，空或读取失败不激活，不创建歌单', async () => {
	const f = setup(),
		intent = new PlaybackIntent()
	let opened = 0,
		activations = 0
	let queued: string[] = []
	const player = {
		reservePlayback: async () => ({ token: 1 }),
		isPreparationCurrent: async () => true,
		cancelPreparation: async () => {},
		playPlaylist: async (
			entries: { itemId: string; source: MusicLibrarySource }[],
			start: string,
		) => {
			activations++
			queued = entries.map((e) => e.source.id)
			assert.equal(start, entries[0].itemId)
			return true
		},
	}
	try {
		await assert.rejects(
			playLikedCollection(f.library, intent, player, () => {
				opened++
			}),
			/还没有喜欢/,
		)
		assert.equal(activations, 0)
		f.library.setLiked(sourceA, true)
		f.library.setLiked(sourceB, true)
		f.raw
			.prepare('UPDATE likes SET likedAt = ? WHERE sourceId = ?')
			.run(1, sourceA.id)
		f.raw
			.prepare('UPDATE likes SET likedAt = ? WHERE sourceId = ?')
			.run(2, sourceB.id)
		assert.equal(
			await playLikedCollection(f.library, intent, player, () => {
				opened++
			}),
			true,
		)
		assert.deepEqual(queued, [sourceB.id, sourceA.id])
		assert.equal(opened, 1)
		f.library.setLiked(sourceB, false)
		await playLikedCollection(f.library, intent, player, () => {
			opened++
		})
		assert.deepEqual(queued, [sourceA.id])
		assert.equal(f.store.list().length, 0)
		await assert.rejects(
			playLikedCollection(
				{
					musicLikes: () => {
						throw new Error('读取失败')
					},
				},
				intent,
				player,
				() => {
					opened++
				},
			),
			/读取失败/,
		)
		assert.equal(activations, 2)
		assert.equal(opened, 2)
		assert.equal(
			await playLikedCollection(
				f.library,
				intent,
				{ ...player, playPlaylist: async () => false },
				() => {
					opened++
				},
			),
			false,
		)
		assert.equal(opened, 2)
	} finally {
		f.raw.close()
	}
})

void test('喜欢另存按保存时最新顺序原子创建，失败留输入且不改变喜欢', () => {
	const { raw, library, store, session } = setup()
	try {
		session.requestName('from-likes')
		session.setName(' 我的精选 ')
		assert.equal(session.saveName(), false)
		assert.equal(store.list().length, 0)
		assert.equal(session.getSnapshot().nameForm?.value, ' 我的精选 ')
		library.setLiked(sourceA, true)
		library.setLiked(sourceB, true)
		raw
			.prepare('UPDATE likes SET likedAt = ? WHERE sourceId = ?')
			.run(200, sourceA.id)
		raw
			.prepare('UPDATE likes SET likedAt = ? WHERE sourceId = ?')
			.run(300, sourceB.id)
		const latest = library.likes().map((source) => source.id)
		raw.exec(
			"CREATE TRIGGER reject_snapshot BEFORE INSERT ON playlist_items BEGIN SELECT RAISE(ABORT, 'disk write failed'); END",
		)
		assert.equal(session.saveName(), false)
		assert.equal(store.list().length, 0)
		assert.equal(session.getSnapshot().nameForm?.value, ' 我的精选 ')
		assert.match(session.getSnapshot().error, /disk write failed/)
		raw.exec('DROP TRIGGER reject_snapshot')
		assert.equal(session.saveName(), true)
		const detail = session.getSnapshot().detail!
		assert.equal(detail.name, '我的精选')
		assert.equal(detail.description, '')
		assert.equal(detail.coverUri, null)
		assert.deepEqual(
			detail.items.map((item) => item.sourceId),
			latest,
		)
		assert.deepEqual(
			detail.items.map((item) => item.position),
			[0, 1],
		)
		assert.equal(new Set(detail.items.map((item) => item.itemId)).size, 2)
		assert.equal(session.getSnapshot().nameForm, null)
		assert.match(session.getSnapshot().notice, /喜欢保持不变/)
		assert.deepEqual(
			library.likes().map((source) => source.id),
			latest,
		)
		library.setLiked(sourceB, false)
		assert.deepEqual(
			store.get(detail.id)!.items.map((item) => item.sourceId),
			latest,
		)
	} finally {
		raw.close()
	}
})

void test('4,144 occurrences search globally, hydrate distinct sources once, union hidden selections and restore exact batch identity/order', () => {
	const f = setup()
	try {
		const id = f.create('大歌单')
		const tail: Source = {
			...sourceA,
			id: sourceId(sourceA.bvid, 999),
			cid: 999,
			originalTitle: '窗口外的最后一首',
		}
		const entries = Array.from({ length: 4096 }, (_, index) => ({
			itemId: `large-${index}`,
			source: index === 4095 ? tail : index % 2 ? sourceB : sourceA,
		}))
		f.store.append(id, entries, 'keep-all')
		const imports = new ImportStore(f.db)
		imports.createDirectory({
			taskId: 'large-pending',
			provider: 'qq',
			originalPlaylistId: 'pending-directory',
			taskVersion: 1,
			originalMetadata: {},
			entries: Array.from({ length: 48 }, (_, index) => ({
				entryId: `pending-${index}`,
				originalEntryId: `original-${index}`,
				originalPosition: index,
				originalMetadata: {
					track: {
						name: `最后待匹配 ${index}`,
						singer: [{ name: '远端艺人' }],
					},
				},
			})),
		})
		const task = imports.get('large-pending')!
		imports.setSelected(
			'large-pending',
			task.entries.map((entry) => entry.entryId),
			true,
			task.revision,
		)
		imports.commitSelected('large-pending', {
			commitId: 'large-pending-commit',
			expectedRevision: imports.get('large-pending')!.revision,
			target: {
				kind: 'append',
				playlistId: id,
				expectedUpdatedAt: f.store.get(id)!.updatedAt,
			},
			duplicatePolicy: 'keep-all',
			itemIds: task.entries.map((entry) => ({
				entryId: entry.entryId,
				itemId: entry.entryId,
			})),
		})
		const reads: string[] = []
		const read = f.library.getMusic.bind(f.library)
		f.library.getMusic = (idToRead) => {
			reads.push(idToRead)
			return read(idToRead)
		}
		f.session.refresh()
		assert.deepEqual(reads.sort(), [sourceA.id, sourceB.id, tail.id].sort())
		assert.equal(f.session.getSnapshot().detail!.items.length, 4144)
		assert.equal(f.session.getSnapshot().sources.size, 3)
		const matches = () => {
			const state = f.session.getSnapshot()
			return selectPlaylistDetailItems(
				state.detail,
				state.sources,
				state.detailQuery,
				state.detailFilter,
			).map(({ item }) => item.itemId)
		}
		f.session.setDetailQuery('窗口外的最后一首')
		assert.deepEqual(matches(), ['large-4095'])
		f.session.setEditing(true)
		f.session.selectAll()
		f.session.setDetailQuery('第一段音源')
		assert.equal(matches().length, 2048)
		f.session.selectAll()
		assert.equal(f.session.getSnapshot().selectedItemIds.length, 2049)
		assert.equal(f.session.getSnapshot().selectedItemIds[0], 'large-4095')
		f.session.setDetailFilter('pending')
		f.session.setDetailQuery('最后待匹配 47')
		assert.deepEqual(matches(), ['pending-47'])
		f.session.selectAll()
		assert.equal(f.session.getSnapshot().selectedItemIds.length, 2050)
		const original = f.store.get(id)!
		const queue = preparePlaylistPlayback(f.store, f.library, id, 'large-4095')
		assert.deepEqual(
			queue.entries.map((entry) => entry.itemId),
			entries.map((entry) => entry.itemId),
		)
		assert.deepEqual(
			queue.entries.map((entry) => entry.source.id),
			entries.map((entry) => entry.source.id),
		)
		assert.equal(queue.pendingCount, 48)
		assert.equal(queue.startItemId, 'large-4095')
		assert.equal(f.session.removeSelected(), true)
		assert.equal(f.store.get(id)!.items.length, 2094)
		assert.deepEqual(matches(), [])
		assert.equal(f.session.undoRemove(), true)
		assert.deepEqual(f.store.get(id)!.items, original.items)
		assert.deepEqual(matches(), ['pending-47'])
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, [])
		f.session.selectAll()
		f.session.clearDetailFilters()
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, ['pending-47'])
		f.session.clearSelection()
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, [])
	} finally {
		f.raw.close()
	}
})

void test('per-playlist browsing survives switching/close/reopen while stale native callbacks cannot overwrite restored route/filter position', () => {
	const f = setup()
	try {
		const first = f.create('甲歌单')
		f.add([sourceA, sourceB])
		f.add([sourceA])
		const ids = f.session.getSnapshot().detail!.items.map((item) => item.itemId)
		f.session.setDetailQuery('第一段')
		f.session.setEditing(true)
		f.session.toggleItem(ids[2])
		const firstToken = f.session.getSnapshot().detailViewToken
		let notifications = 0
		const unsubscribe = f.session.subscribe(() => {
			notifications++
		})
		f.session.recordDetailScroll(firstToken, {
			itemId: ids[2],
			index: 1,
			offset: 900,
		})
		assert.equal(notifications, 0, 'scroll does not rerender the whole page')
		const second = f.create('乙歌单')
		f.add([sourceB])
		f.session.setDetailFilter('pending')
		const secondToken = f.session.getSnapshot().detailViewToken
		f.session.recordDetailScroll(firstToken, {
			itemId: ids[0],
			index: 0,
			offset: 4000,
		})
		assert.deepEqual(f.session.getDetailScroll(secondToken), {
			itemId: null,
			index: 0,
			offset: 0,
		})
		f.session.open(first)
		let state = f.session.getSnapshot()
		assert.equal(state.detailQuery, '第一段')
		assert.equal(state.editing, true)
		assert.deepEqual(state.selectedItemIds, [ids[2]])
		assert.deepEqual(f.session.getDetailScroll(state.detailViewToken), {
			itemId: ids[2],
			index: 1,
			offset: 900,
		})
		assert.notEqual(state.detailViewToken, firstToken)
		f.session.recordDetailScroll(firstToken, {
			itemId: ids[0],
			index: 0,
			offset: 10,
		})
		assert.equal(f.session.getDetailScroll(state.detailViewToken).offset, 900)
		f.session.close()
		f.session.recordDetailScroll(state.detailViewToken, {
			itemId: ids[0],
			index: 0,
			offset: 5,
		})
		f.session.open(first)
		state = f.session.getSnapshot()
		assert.equal(f.session.getDetailScroll(state.detailViewToken).offset, 900)
		f.session.setDetailQuery('第二段')
		const filtered = f.session.getSnapshot()
		assert.notEqual(filtered.detailViewToken, state.detailViewToken)
		assert.deepEqual(f.session.getDetailScroll(filtered.detailViewToken), {
			itemId: null,
			index: 0,
			offset: 0,
		})
		f.session.recordDetailScroll(state.detailViewToken, {
			itemId: ids[2],
			index: 1,
			offset: 800,
		})
		assert.deepEqual(f.session.getDetailScroll(filtered.detailViewToken), {
			itemId: null,
			index: 0,
			offset: 0,
		})
		assert.deepEqual(filtered.selectedItemIds, [ids[2]])
		f.session.open(second)
		assert.equal(f.session.getSnapshot().detailFilter, 'pending')
		assert.equal(f.session.getSnapshot().detailQuery, '')
		unsubscribe()
	} finally {
		f.raw.close()
	}
})

void test('refresh prunes only deleted selections and relocates occurrence anchors after edits; read failure keeps last good browse state', () => {
	const f = setup()
	try {
		const id = f.create()
		f.add([sourceA, sourceB])
		f.add([sourceA])
		const ids = f.session.getSnapshot().detail!.items.map((item) => item.itemId)
		f.session.setEditing(true)
		f.session.selectAll()
		const token = f.session.getSnapshot().detailViewToken
		f.session.recordDetailScroll(token, {
			itemId: ids[2],
			index: 2,
			offset: 1200,
		})
		f.store.remove(id, [ids[0]])
		f.session.refresh()
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, [ids[1], ids[2]])
		assert.deepEqual(f.session.getDetailScroll(token), {
			itemId: ids[2],
			index: 1,
			offset: 0,
		})
		f.store.remove(id, [ids[2]])
		f.session.refresh()
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, [ids[1]])
		assert.deepEqual(f.session.getDetailScroll(token), {
			itemId: ids[1],
			index: 0,
			offset: 0,
		})
		const read = f.store.listSummaries.bind(f.store)
		f.store.listSummaries = () => {
			throw new Error('later refresh unavailable')
		}
		f.session.refresh()
		assert.match(f.session.getSnapshot().error, /later refresh/)
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, [ids[1]])
		assert.equal(f.session.getSnapshot().detail!.items[0].itemId, ids[1])
		f.store.listSummaries = read
		f.session.open('missing')
		assert.equal(f.session.getSnapshot().detail, null)
		f.session.recordDetailScroll(token, {
			itemId: ids[1],
			index: 0,
			offset: 100,
		})
		f.session.open(id)
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, [ids[1]])
		assert.deepEqual(
			f.session.getDetailScroll(f.session.getSnapshot().detailViewToken),
			{ itemId: ids[1], index: 0, offset: 0 },
		)
		f.session.setEditing(false)
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, [])
	} finally {
		f.raw.close()
	}
})
