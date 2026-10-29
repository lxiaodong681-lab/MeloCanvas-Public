import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import type {
	AccountFavoriteIdentity,
	AccountFavoritesPort,
} from '../account-favorites'
import type { BilibiliRequest } from '../bilibili'
import { BilibiliReadGate } from '../bilibili-import-network'
import { BilibiliApiError, BilibiliRequestRestrictedError } from '../bilibili-request-error'
import {
	BilibiliImportSession,
	type BilibiliImportPorts,
} from '../bilibili-import-session'
import { Library, migrate, migrations, type Database } from '../core/database'
import type { ImportDirectorySnapshot } from '../core/import-types'
import { ImportStore } from '../core/imports'
import { PlaylistStore } from '../core/playlists'
import { VideoCatalog } from '../core/video-catalog'
import { VideoSaves } from '../core/video-saves'
import { ListeningLibrarySession } from '../listening-library-session'
import { parseListeningVideo } from '../listening-source'
import { readMusicParts } from '../music-parts'

const bv = 'BV1vT411i7ET'
const encode = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value))
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
function video(bvid = bv, cids = [11, 22]) {
	return parseListeningVideo(
		{
			bvid,
			title: '真实视频',
			owner: { mid: 88, name: '原UP' },
			pic: 'https://example.invalid/cover',
			videos: cids.length,
			pages: cids.map((cid, index) => ({
				cid,
				page: index + 1,
				part: `P${index + 1}`,
				duration: 200,
			})),
		},
		bvid,
	)
}
function videoRead(
	value: ReturnType<typeof video> | Promise<ReturnType<typeof video>>,
): BilibiliRequest<ReturnType<typeof video>> {
	const result = Promise.resolve(value)
	return {
		result,
		settled: result.then(
			() => {},
			() => {},
		),
	}
}
function directory(count = 3, missingBv = false): ImportDirectorySnapshot {
	return {
		taskId: 'task',
		taskVersion: 1,
		provider: 'bilibili',
		originalPlaylistId: '123',
		originalMetadata: {
			completeness: 'complete',
			reportedTotal: count,
			observedCount: count,
			pages: [{ page: 1, info: { id: 123, title: '原收藏夹' } }],
		},
		entries: Array.from({ length: count }, (_, index) => ({
			entryId: `e${index}`,
			originalEntryId: `2:${index === 2 ? 0 : index}`,
			originalPosition: index,
			originalMetadata: {
				media: {
					id: index + 1,
					type: 2,
					bvid: missingBv ? '' : bv,
					title: index === 1 ? 'B' : 'A',
					upper: { name: '原UP' },
					duration: 200,
				},
				observed: { bvid: missingBv ? null : bv },
			},
		})),
	}
}
function fixture(
	file = ':memory:',
	overrides: Partial<BilibiliImportPorts> = {},
	version: number = migrations.length,
) {
	const raw = new DatabaseSync(file)
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
	}
	migrate(db, migrations.slice(0, version))
	const store = new ImportStore(db),
		library = new Library(db),
		playlists = new PlaylistStore(db),
		catalog = new VideoCatalog(db),
		saves = new VideoSaves(db)
	let sequence = 0
	const ports: BilibiliImportPorts = {
		folders: async () =>
			encode({
				code: 0,
				data: {
					list: [{ id: 123, title: '原收藏夹', media_count: 1, fav_state: 0 }],
				},
			}),
		page: async () =>
			encode({
				code: 0,
				data: {
					info: { id: 123, title: '原收藏夹', media_count: 1 },
					has_more: false,
					medias: [
						{
							id: 1,
							type: 2,
							bvid: bv,
							title: 'A',
							upper: { name: '原UP' },
							duration: 200,
						},
					],
				},
			}),
		video: (bvid) => videoRead(video(bvid)),
		...overrides,
	}
	const gate = new BilibiliReadGate()
	const session = new BilibiliImportSession(
		store,
		library,
		playlists,
		catalog,
		saves,
		ports,
		gate,
		() => `local-${++sequence}`,
	)
	return {
		raw,
		db,
		store,
		library,
		playlists,
		catalog,
		saves,
		session,
		gate,
		ports,
	}
}
function seed(f: ReturnType<typeof fixture>, count = 3, missing = false) {
	f.store.createDirectory(directory(count, missing))
	f.session.openTask('task')
}
void test('one folder action creates a playable playlist using the original first part without item review', async () => {
	const f = fixture()
	try {
		f.session.open()
		f.session.setMid('88')
		assert.equal(await f.session.readFolders(), true)
		assert.equal(await f.session.importFolder('123'), true)
		const state = f.session.getSnapshot()
		assert.equal(state.route, 'result')
		assert.ok(state.receipt?.playlistId)
		const playlist = f.playlists.get(state.receipt.playlistId)!
		assert.equal(playlist.name, '原收藏夹')
		assert.equal(playlist.items.length, 1)
		assert.equal(playlist.items[0].sourceId, `bilibili:${bv}:11`)
		assert.equal(f.catalog.get(bv)?.parts.length, 2)
		assert.equal(state.task?.entries[0].review.candidates[0].evidence.method, 'favorite-default-first-part')
		assert.equal(playlist.items[0].importOrigin?.originalPosition, 0)
	} finally {
		f.raw.close()
	}
})
function favoritePage(total: number, page = 1, types?: number[]) {
	return encode({ code: 0, data: {
		info: { id: 123, title: '原收藏夹', media_count: total }, has_more: page * 40 < total,
		medias: Array.from({ length: Math.min(40, Math.max(0, total - (page - 1) * 40)) }, (_, i) => ({
			id: (page - 1) * 40 + i + 1, type: types?.[i] ?? 2, bvid: bv, title: `原条目${(page - 1) * 40 + i + 1}`, upper: { name: '原UP' }, duration: 200,
		})),
	} })
}
void test('quick favorites read all pages once, preserve 41 occurrences and reuse the real catalog for duplicate BV', async () => {
	const pages: number[] = []
	let views = 0
	const f = fixture(':memory:', { page: async ({ page }) => { pages.push(page); return favoritePage(41, page) }, video: (bvid) => { views++; return videoRead(video(bvid)) } })
	try {
		f.session.open(); f.session.setMid('88'); await f.session.readFolders()
		assert.equal(await f.session.importFolder('123'), true)
		assert.deepEqual(pages, [1, 2]); assert.equal(views, 1)
		const state = f.session.getSnapshot(), list = f.playlists.get(state.receipt!.playlistId!)!
		assert.equal(list.items.length, 41)
		assert.equal(new Set(list.items.map((item) => item.itemId)).size, 41)
		assert.deepEqual(list.items.map((item) => item.importOrigin?.originalPosition), Array.from({ length: 41 }, (_, i) => i))
		assert.ok(list.items.every((item) => item.sourceId === `bilibili:${bv}:11`))
		f.session.close(); f.session.openTask(state.task!.taskId)
		assert.equal(f.session.getSnapshot().quick?.phase, 'done')
		assert.equal(f.session.getSnapshot().quick?.playlistId, list.id)
		assert.equal(f.playlists.list().length, 1)
	} finally { f.raw.close() }
})
void test('mixed video/non-video favorites restore the completed original playlist after a database reopen', async () => {
	const prefix = join(tmpdir(), 'melo-favorite-reopen-')
	const folder = mkdtempSync(prefix), file = join(folder, 'library.sqlite')
	let f = fixture(file, { page: async () => favoritePage(2, 1, [2, 12]) })
	try {
		f.session.open()
		f.session.setMid('88')
		assert.equal(await f.session.readFolders(), true)
		assert.equal(await f.session.importFolder('123'), true)
		const imported = f.session.getSnapshot()
		const taskId = imported.task!.taskId, receipt = imported.receipt!
		const playlist = f.playlists.get(receipt.playlistId!)!
		assert.equal(imported.quick?.phase, 'done')
		assert.equal(playlist.items.length, 1)
		assert.equal(receipt.results.length, 1, 'non-video is omitted, not saved as a fake source')
		f.session.close()
		f.raw.close()
		f = fixture(file, {
			page: async () => assert.fail('reopening a local result must not reread favorites'),
			video: () => assert.fail('reopening a local result must not reload parts'),
		})
		const changes = f.raw.prepare('SELECT total_changes() AS count').get()!.count
		for (let attempt = 0; attempt < 2; attempt++) {
			f.session.openTask(taskId)
			const restored = f.session.getSnapshot()
			assert.equal(restored.route, 'result')
			assert.equal(restored.quick?.phase, 'done')
			assert.equal(restored.quick?.playlistId, playlist.id)
			assert.equal(restored.quick?.processed, 2)
			assert.equal(restored.quick?.skipped, 1)
			assert.deepEqual(restored.receipt, receipt)
			assert.equal(await f.session.continueFavoriteImport(), false, 'completed imports do not restart')
			assert.equal(f.session.getSnapshot(), restored, 'a stale Continue action cannot clear result links or counters')
			assert.deepEqual(f.playlists.get(playlist.id), playlist)
			assert.equal(f.playlists.list().length, 1)
			assert.equal(f.store.getMixed(taskId)!.history.length, 1)
			f.session.close()
		}
		assert.equal(f.raw.prepare('SELECT total_changes() AS count').get()!.count, changes)
	} finally {
		f.session.close()
		f.raw.close()
		assert.ok(folder.startsWith(prefix))
		rmSync(folder, { recursive: true })
	}
})
void test('mixed favorites with an unfinished video remain resumable and expose the playlist after completion', async () => {
	const f = fixture(':memory:', {
		page: async () => favoritePage(2, 1, [2, 12]),
		video: () => videoRead(Promise.reject(new Error('网络连接失败'))),
	})
	try {
		f.session.open()
		f.session.setMid('88')
		await f.session.readFolders()
		assert.equal(await f.session.importFolder('123'), false)
		const taskId = f.session.getSnapshot().task!.taskId
		f.session.close()
		f.session.openTask(taskId)
		assert.equal(f.session.getSnapshot().quick?.phase, 'paused')
		assert.equal(f.session.getSnapshot().quick?.playlistId, null)
		assert.equal(f.playlists.list().length, 0)
		f.ports.video = () => videoRead(video())
		assert.equal(await f.session.continueFavoriteImport(), true)
		const playlistId = f.session.getSnapshot().receipt!.playlistId
		f.session.close()
		f.session.openTask(taskId)
		assert.equal(f.session.getSnapshot().quick?.phase, 'done')
		assert.equal(f.session.getSnapshot().quick?.playlistId, playlistId)
	} finally {
		f.session.close()
		f.raw.close()
	}
})
void test('quick favorites keep unavailable original positions, omit non-video entries and do not create empty playlists', async () => {
	const f = fixture(':memory:', { page: async () => favoritePage(3, 1, [2, 12, 2]), video: () => videoRead(Promise.reject(new BilibiliApiError(62002, '内容不可用'))) })
	try {
		f.session.open(); f.session.setMid('88'); await f.session.readFolders()
		assert.equal(await f.session.importFolder('123'), true)
		const state = f.session.getSnapshot(), list = f.playlists.get(state.receipt!.playlistId!)!
		assert.deepEqual(list.items.map((item) => [item.sourceId, item.importOrigin?.originalPosition]), [[null, 0], [null, 2]])
		assert.equal(state.quick?.unavailable.length, 2); assert.equal(state.quick?.skipped, 1)
		assert.equal(state.task?.entries[1].selected, false)
		f.session.open(); f.ports.page = async () => favoritePage(0); f.session.setMid('88'); await f.session.readFolders()
		assert.equal(await f.session.importFolder('123'), true)
		assert.equal(f.session.getSnapshot().quick?.playlistId, null)
		assert.equal(f.playlists.list().length, 1)
		f.session.open(); f.ports.page = async () => favoritePage(2, 1, [12, 12]); f.session.setMid('88'); await f.session.readFolders()
		assert.equal(await f.session.importFolder('123'), true)
		const nonVideoTask = f.session.getSnapshot().task!.taskId
		f.session.close(); f.session.openTask(nonVideoTask)
		assert.equal(f.session.getSnapshot().quick?.phase, 'done')
		assert.equal(f.session.getSnapshot().quick?.playlistId, null)
		assert.equal(f.playlists.list().length, 1)
	} finally { f.raw.close() }
})
void test('quick favorites pause on network/restriction errors and resume one saved task without re-reading accepted parts', async () => {
	for (const failure of [new Error('网络连接失败'), new BilibiliRequestRestrictedError()]) {
		const f = fixture()
		try {
			const snapshot = directory(2)
			snapshot.taskId = 'second'; snapshot.entries[1].originalMetadata.observed = { bvid: 'BV1xx411c7mD' }
			;(snapshot.entries[1].originalMetadata.media as { bvid: string }).bvid = 'BV1xx411c7mD'
			f.store.createDirectory(snapshot); f.session.openTask('second')
			const calls: string[] = []
			f.ports.video = (bvid) => { calls.push(bvid); return videoRead(bvid === bv ? video(bvid) : Promise.reject(failure)) }
			assert.equal(await f.session.importCurrentTask(), false)
			assert.equal(f.playlists.list().length, 0)
			assert.equal(f.session.getSnapshot().quick?.phase, 'paused')
			assert.equal(f.store.getMixed('second')?.entries[0].review.state, 'pending')
			f.ports.video = (bvid) => { calls.push(bvid); return videoRead(video(bvid)) }
			assert.equal(await f.session.continueFavoriteImport(), true)
			assert.deepEqual(calls, [bv, 'BV1xx411c7mD', 'BV1xx411c7mD'])
			assert.equal(f.store.getMixed('second')?.history.length, 1)
		} finally { f.raw.close() }
	}
})
void test('quick import does not publish a late video after cancel or closing the page', async () => {
	for (const action of ['cancelRead', 'close'] as const) {
		const pending = deferred<ReturnType<typeof video>>()
		const f = fixture(':memory:', { video: () => videoRead(pending.promise) })
		try {
			seed(f, 1)
			const result = f.session.importCurrentTask(); await tick()
			f.session[action]()
			assert.equal(await result, false)
			pending.resolve(video()); await tick()
			assert.equal(f.playlists.list().length, 0); assert.equal(f.catalog.get(bv), null)
			assert.equal(f.store.getMixed('task')?.entries[0].review.state, 'pending')
		} finally { f.raw.close() }
	}
})
void test('quick import retains explicit P2 choices and refuses a different BV or a forged default P2 atomically', async () => {
	const f = fixture()
	try {
		seed(f, 2)
		f.session.openEntry('e0'); await f.session.readVideo(); f.session.selectCid(22); f.session.confirmCid(); f.session.back()
		const before = f.store.getMixed('task')!
		assert.throws(() => f.store.defaultFavoritePlaylist('task', [{ entryId: 'e0', sourceId: `bilibili:${bv}:22` }, { entryId: 'e1', sourceId: `bilibili:${bv}:22` }], before.revision), /第一 P/)
		assert.deepEqual(f.store.getMixed('task'), before)
		f.catalog.save(video('BV1xx411c7mD'), Date.now())
		assert.throws(() => f.store.defaultFavoritePlaylist('task', [{ entryId: 'e1', sourceId: 'bilibili:BV1xx411c7mD:11' }], before.revision), /原目录 BV/)
		assert.equal(await f.session.importCurrentTask(), true)
		assert.deepEqual(f.playlists.get(f.session.getSnapshot().receipt!.playlistId!)!.items.map((item) => item.sourceId), [`bilibili:${bv}:22`, `bilibili:${bv}:11`])
		assert.equal(f.store.getMixed('task')!.entries[0].review.candidates[0].evidence.method, 'explicit-original-bv-part')
	} finally { f.raw.close() }
})
void test('quick import retries the same atomic commit after a disk write failure without duplicate playlists', async () => {
	const f = fixture()
	try {
		seed(f, 1)
		f.raw.exec("CREATE TRIGGER quick_fail BEFORE INSERT ON playlist_items BEGIN SELECT RAISE(ABORT, 'disk write failed'); END")
		assert.equal(await f.session.importCurrentTask(), false)
		const command = f.session.getSnapshot().command!
		assert.ok(command); assert.equal(f.playlists.list().length, 0)
		f.raw.exec('DROP TRIGGER quick_fail')
		assert.equal(await f.session.continueFavoriteImport(), true)
		assert.equal(f.session.getSnapshot().receipt?.commitId, command.commitId)
		assert.equal(f.playlists.list().length, 1)
		assert.equal(f.store.getMixed('task')!.history.length, 1)
	} finally { f.raw.close() }
})
void test('quick private favorites isolate account changes while the original video request ignores abort', async () => {
	const auth = myAccountPorts(), pending = deferred<ReturnType<typeof video>>()
	const f = fixture(':memory:', { account: auth.port, video: () => videoRead(pending.promise) })
	try {
		f.session.open(); await f.session.readMyFolders()
		const result = f.session.importFolder('123'); await tick()
		assert.equal(f.store.list().length, 1, 'complete original directory is saved for later')
		auth.change({ mid: '99', name: '新账号', generation: 2 })
		assert.equal(await result, false)
		pending.resolve(video()); await tick()
		assert.equal(f.playlists.list().length, 0); assert.equal(f.catalog.get(bv), null)
		assert.equal(f.session.getSnapshot().quick, null)
		assert.equal(f.store.getMixed(f.store.list()[0].taskId)?.entries[0].selected, false)
	} finally { f.raw.close() }
})
void test('music parts reuse the imported catalog and reject late or wrong-video metadata before saving', async () => {
	const f = fixture()
	try {
		f.catalog.save(video(), Date.now())
		const signal = new AbortController().signal
		const loaded = await readMusicParts(f.catalog, f.gate, () => assert.fail('cached import must not reread'), bv, signal, () => true)
		assert.equal(loaded?.parts[1].source.cid, 22)
		assert.equal(await readMusicParts(f.catalog, f.gate, () => assert.fail('stale panel must not reread'), bv, signal, () => false), null)
		await assert.rejects(() => readMusicParts(f.catalog, f.gate, () => videoRead(video()), 'BV1xx411c7mD', signal, () => true), /不属于当前视频/)
		const pending = deferred<ReturnType<typeof video>>()
		let current = true
		const result = readMusicParts(f.catalog, f.gate, () => videoRead(pending.promise), 'BV1xx411c7mD', signal, () => current)
		current = false; pending.resolve(video('BV1xx411c7mD'))
		assert.equal(await result, null); assert.equal(f.catalog.get('BV1xx411c7mD'), null)
	} finally { f.raw.close() }
})
void test('task return preserves page and scroll in memory; destination reconfirmation creates a fresh command', () => {
	const f = fixture()
	try {
		seed(f, 43)
		f.session.setPage(1)
		f.session.rememberScroll('task:task::public', 650)
		f.session.rememberScroll('task:task::public', Number.NaN)
		f.session.rememberScroll('task:task::public', -1)
		f.session.openEntry('e21')
		f.session.back()
		assert.equal(f.session.getSnapshot().route, 'task')
		assert.equal(f.session.getSnapshot().page, 1)
		assert.equal(f.session.scrollOffset('task:task::public'), 650)
		assert.equal(f.session.scrollOffset('task:another::public'), 0)
		f.session.setSelected('e21', true)
		const changes = f.raw.prepare('SELECT total_changes() AS count').get()!.count
		f.session.openDestination()
		f.session.prepare(null, 'keep-all', 'keep-all')
		const first = f.session.getSnapshot().command
		assert.ok(first)
		f.session.back()
		assert.equal(f.session.getSnapshot().command, null)
		f.session.openDestination()
		f.session.prepare(null, 'keep-all', 'keep-all')
		const second = f.session.getSnapshot().command
		assert.ok(second)
		assert.notEqual(second.commitId, first.commitId)
		assert.equal(f.raw.prepare('SELECT total_changes() AS count').get()!.count, changes)
		f.session.close()
		assert.equal(f.session.scrollOffset('task:task::public'), 0)
	} finally {
		f.raw.close()
	}
})
function myAccountPorts(
	overrides: Partial<Pick<AccountFavoritesPort, 'folders' | 'page' | 'index'>> = {},
) {
	let owner: AccountFavoriteIdentity | null = {
		mid: '88',
		name: '合成账号',
		generation: 1,
	}
	const listeners = new Set<() => void>(),
		calls: string[] = []
	const port: AccountFavoritesPort = {
		...(overrides.index ? {
			index: async (input: { favoriteId: string }, signal: AbortSignal) => {
				calls.push(`index:${input.favoriteId}`)
				return overrides.index!(input, signal)
			},
		} : {}),
		getIdentity: () => owner,
		subscribe: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		folders: async (input, signal) => {
			calls.push(`folders:${input.userMid}`)
			return overrides.folders
				? overrides.folders(input, signal)
				: encode({
						code: 0,
						data: {
							count: 1,
							list: [
								{ id: 123, title: '本人有权夹', media_count: 1, fav_state: 0 },
							],
						},
					})
		},
		page: async (input, signal) => {
			calls.push(`page:${input.favoriteId}:${input.page}`)
			return overrides.page
				? overrides.page(input, signal)
				: encode({
						code: 0,
						data: {
							info: { id: 123, title: '本人有权夹', media_count: 1 },
							has_more: false,
							medias: [
								{
									id: 1,
									type: 2,
									bvid: bv,
									title: '原歌曲',
									upper: { mid: 88, name: '原 UP' },
									duration: 200,
								},
							],
						},
					})
		},
	}
	return {
		port,
		calls,
		listeners,
		change: (next: AccountFavoriteIdentity | null) => {
			owner = next
			for (const listener of listeners) listener()
		},
	}
}
function choose(
	f: ReturnType<typeof fixture>,
	id: string,
	kind: 'song' | 'musicCollection' | 'knowledge' | 'unknown',
) {
	f.session.openEntry(id)
	f.session.setKind(kind)
	f.session.setSelected(id, true)
}

void test('本人目录及内容明确使用账号ports，仅显式保存任务，原来源与默认不选保留', async () => {
	const auth = myAccountPorts()
	const f = fixture(':memory:', {
		account: auth.port,
		folders: async () => assert.fail('本人目录不能回退游客'),
		page: async () => assert.fail('私有收藏内容不能回退游客'),
	})
	try {
		f.session.open()
		f.session.setMid('55')
		assert.deepEqual(auth.calls, [])
		assert.equal(f.session.getSnapshot().mineAvailable, true)
		assert.equal(await f.session.readMyFolders(), true)
		assert.deepEqual(auth.calls, ['folders:88'])
		assert.equal(f.session.getSnapshot().folderAccount?.mid, '88')
		assert.equal(f.session.getSnapshot().mid, '55')
		assert.equal(f.store.list().length, 0)
		assert.equal(await f.session.chooseFolder('123'), true)
		assert.deepEqual(auth.calls, ['folders:88', 'page:123:1'])
		assert.equal(f.store.list().length, 0)
		assert.equal(f.session.saveDirectory(), true)
		const task = f.session.getSnapshot().task!
		assert.equal(task.originalPlaylistId, '123')
		assert.equal(task.provider, 'bilibili')
		assert.equal(task.entries[0].originalEntryId, '2:1')
		assert.equal(
			(task.entries[0].originalMetadata.observed as { bvid: string }).bvid,
			bv,
		)
		assert(task.entries.every((entry) => !entry.selected))
		assert.equal(f.library.get(`bilibili:${bv}:11`), null)
		assert.equal(f.session.prepare(null, 'keep-all', 'keep-all'), false)
		assert.equal(auth.listeners.size, 0)
		assert.deepEqual(f.session.collector.getSnapshot().pages, [])
		auth.change(null)
		assert.equal(f.store.getMixed(task.taskId)?.entryCount, 1)
		f.session.close()
	} finally {
		f.session.close()
		f.raw.close()
	}
})

void test('私有索引占位身份/原序保留、默认零选择，分类歌曲或待分类均不造可播放音源', async () => {
	const auth = myAccountPorts({
		index: async () => encode({ code: 0, data: [1, 2, 3].map((id) => ({ id, type: 2, bvid: bv })) }),
		page: async () => encode({ code: 0, data: {
			info: { id: 123, title: '原夹', media_count: 3 }, has_more: false,
			medias: [{ id: 1, type: 2, bvid: bv, title: '实际详情' }],
		} }),
	})
	let videoCalls = 0
	const f = fixture(':memory:', {
		account: auth.port,
		index: async () => assert.fail('私有索引不能回退游客'),
		page: async () => assert.fail('私有详情不能回退游客'),
		video: () => { videoCalls++; return videoRead(video()) },
	})
	try {
		f.session.open()
		assert.equal(await f.session.readMyFolders(), true)
		assert.equal(await f.session.chooseFolder('123'), true)
		assert.deepEqual(auth.calls, ['folders:88', 'index:123', 'page:123:1'])
		assert.equal(f.session.getSnapshot().collection?.missingDetailCount, 2)
		assert.equal(f.store.list().length, 0)
		assert.equal(f.session.saveDirectory(), true)
		const task = f.session.getSnapshot().task!
		assert(task.entries.every((entry) => !entry.selected))
		assert.equal(task.entries[1].originalPosition, 1)
		assert.deepEqual(task.entries[1].originalMetadata.resourceIndex, { id: 2, type: 2, bvid: bv })
		f.session.openEntry('index:1')
		assert.equal(f.session.originalBvid(), null)
		assert.equal(await f.session.readVideo(), false)
		assert.equal(f.session.selectedSource(), null)
		assert.equal(f.session.confirmCid(), false)
		assert.equal(videoCalls, 0)
		choose(f, 'index:1', 'song')
		choose(f, 'index:2', 'unknown')
		f.session.openDestination()
		assert.equal(f.session.prepare({ kind: 'create', playlistId: 'missing-music', name: '明确的歌曲' }, 'keep-all', 'keep-all'), true)
		assert.equal(f.playlists.get('missing-music'), null)
		assert.equal(f.session.commit(), true)
		assert.equal(f.playlists.get('missing-music')!.items[0].sourceId, null)
		const saved = f.saves.list('unclassified', { offset: 0, limit: 20 })
		assert.equal(saved.length, 1)
		assert.equal(saved[0].bvid, null)
		assert.equal(saved[0].importOrigin.originalPosition, 2)
		assert.equal(f.library.get(`bilibili:${bv}:11`), null)
	} finally { f.session.close(); f.raw.close() }
})

void test('公开收藏夹索引使用公开端口，不调用当前账号私有索引端口', async () => {
	let publicIndexCalls = 0
	const auth = myAccountPorts({ index: async () => assert.fail('公开mid路径不能使用私有账号索引') })
	const f = fixture(':memory:', {
		account: auth.port,
		index: async () => { publicIndexCalls++; return encode({ code: 0, data: [{ id: 1, type: 2, bvid: bv }] }) },
	})
	try {
		f.session.open()
		f.session.setMid('55')
		assert.equal(await f.session.readFolders(), true)
		assert.equal(await f.session.chooseFolder('123'), true)
		assert.equal(publicIndexCalls, 1)
		assert.deepEqual(auth.calls, [])
		assert.equal(f.session.getSnapshot().collection?.indexCount, 1)
		assert.equal(f.store.list().length, 0)
	} finally { f.session.close(); f.raw.close() }
})

void test('私有索引请求中换代清空临时数据且保留未结算gate，晚索引不启动详情或保存', async () => {
	const slow = deferred<Uint8Array>()
	const auth = myAccountPorts({ index: () => slow.promise })
	const f = fixture(':memory:', { account: auth.port })
	try {
		f.session.open()
		await f.session.readMyFolders()
		const reading = f.session.chooseFolder('123')
		await tick()
		auth.change(null)
		assert.equal(await reading, false)
		assert.equal(f.session.getSnapshot().collection, null)
		assert.equal(f.gate.getSnapshot(), true)
		slow.resolve(encode({ code: 0, data: [{ id: 1, type: 2, bvid: bv }] }))
		await tick()
		assert.equal(f.gate.getSnapshot(), false)
		assert.deepEqual(auth.calls, ['folders:88', 'index:123'])
		assert.equal(f.store.list().length, 0)
		assert.equal(f.session.collector.getSnapshot().indexCount, null)
	} finally { f.session.close(); f.raw.close() }
})

void test('本人读取换号立即清临时目录，保留真正未结算gate，晚正文不恢复也不自动重试', async () => {
	const slow = deferred<Uint8Array>()
	let signal: AbortSignal | undefined
	const auth = myAccountPorts({
		folders: (_input, active) => {
			signal = active
			return slow.promise
		},
	})
	const f = fixture(':memory:', { account: auth.port })
	try {
		f.session.open()
		const pending = f.session.readMyFolders()
		await tick()
		auth.change({ mid: '99', name: '另一账号', generation: 2 })
		assert.equal(signal?.aborted, true)
		assert.equal(await pending, false)
		assert.equal(f.session.getSnapshot().folders, null)
		assert.equal(f.session.getSnapshot().folderAccount, null)
		assert.equal(f.gate.getSnapshot(), true)
		assert.equal(await f.session.readMyFolders(), false)
		slow.resolve(encode({ code: 0, data: { list: [] } }))
		await tick()
		assert.equal(f.gate.getSnapshot(), false)
		assert.equal(f.session.getSnapshot().folders, null)
		assert.equal(f.session.saveDirectory(), false)
		assert.equal(f.store.list().length, 0)
		assert.deepEqual(auth.calls, ['folders:88'])
		assert.equal(auth.listeners.size, 0)
	} finally {
		f.session.close()
		f.raw.close()
	}
})

void test('私有页读完未保存时退出清collector目录；公开mid路径可继续，保留原输入', async () => {
	const auth = myAccountPorts()
	let publicFolders = 0,
		publicPages = 0
	const f = fixture(':memory:', { account: auth.port })
	const readFolders = f.ports.folders,
		readPage = f.ports.page
	f.ports.folders = (...args) => {
		publicFolders++
		return readFolders(...args)
	}
	f.ports.page = (...args) => {
		publicPages++
		return readPage(...args)
	}
	try {
		f.session.open()
		f.session.setMid('55')
		await f.session.readMyFolders()
		await f.session.chooseFolder('123')
		assert.ok(f.session.collector.getSnapshot().directory)
		auth.change(null)
		assert.equal(f.session.getSnapshot().route, 'folders')
		assert.equal(f.session.getSnapshot().collection, null)
		assert.deepEqual(f.session.collector.getSnapshot().pages, [])
		assert.equal(f.session.collector.getSnapshot().directory, null)
		assert.equal(f.session.collector.getSnapshot().identity, null)
		assert.equal(f.session.saveDirectory(), false)
		assert.equal(f.store.list().length, 0)
		f.session.usePublicFolders()
		assert.equal(f.session.getSnapshot().mid, '55')
		assert.equal(await f.session.readFolders(), true)
		assert.equal(await f.session.chooseFolder('123'), true)
		assert.equal(publicFolders, 1)
		assert.equal(publicPages, 1)
		assert.equal(auth.calls.length, 2)
	} finally {
		f.session.close()
		f.raw.close()
	}
})

void test('账号拒绝私有内容保留真实失败，不退游客、不保存空任务', async () => {
	const auth = myAccountPorts({
		page: async () =>
			encode({ code: -403, message: 'permission denied', data: null }),
	})
	const f = fixture(':memory:', {
		account: auth.port,
		folders: async () => assert.fail('不能回退游客目录'),
		page: async () => assert.fail('不能回退游客内容'),
	})
	try {
		f.session.open()
		await f.session.readMyFolders()
		assert.equal(await f.session.chooseFolder('123'), false)
		assert.equal(f.session.getSnapshot().collection?.error?.code, 'platform')
		assert.equal(f.session.getSnapshot().collection?.directory, null)
		assert.equal(f.session.saveDirectory(), false)
		assert.equal(f.store.list().length, 0)
	} finally {
		f.session.close()
		f.raw.close()
	}
})

void test('guest explicit folder→page→complete save is separate; no auto contents, selection or source creation', async () => {
	let folderCalls = 0,
		pageCalls = 0
	const f = fixture()
	try {
		const originalFolders = f.ports.folders,
			originalPage = f.ports.page
		f.ports.folders = async (...args) => {
			folderCalls++
			return originalFolders(...args)
		}
		f.ports.page = async (...args) => {
			pageCalls++
			return originalPage(...args)
		}
		f.session.open()
		f.session.setMid('88')
		assert.equal(await f.session.readFolders(), true)
		assert.equal(folderCalls, 1)
		assert.equal(pageCalls, 0)
		assert.equal(await f.session.chooseFolder('123'), true)
		assert.equal(pageCalls, 1)
		assert.equal(f.store.list().length, 0)
		assert.equal(f.session.saveDirectory(), true)
		assert.equal(f.store.list().length, 1)
		assert(
			f.session.getSnapshot().task!.entries.every((entry) => !entry.selected),
		)
		assert.equal(f.library.get(`bilibili:${bv}:11`), null)
		assert.equal(f.session.prepare(null, 'keep-all', 'keep-all'), false)
	} finally {
		f.raw.close()
	}
})

void test('folder cancellation keeps real raw gate until late body settlement and never restores closed UI', async () => {
	const slow = deferred<Uint8Array>()
	let calls = 0
	const f = fixture(':memory:', {
		folders: async () => {
			calls++
			return slow.promise
		},
	})
	try {
		f.session.open()
		f.session.setMid('88')
		const pending = f.session.readFolders()
		await tick()
		f.session.close()
		assert.equal(await pending, false)
		f.session.open()
		assert.equal(await f.session.readFolders(), false)
		assert.equal(calls, 1)
		assert.equal(f.gate.getSnapshot(), true)
		slow.resolve(encode({ code: 0, data: { list: [] } }))
		await tick()
		assert.equal(f.gate.getSnapshot(), false)
		assert.equal(f.session.getSnapshot().folders, null)
	} finally {
		f.raw.close()
	}
})

void test('partial/cancelled collection cannot be saved and no page starts after route close', async () => {
	const f = fixture(':memory:', {
		page: async () =>
			encode({
				code: 0,
				data: {
					info: { id: 123, title: '原夹', media_count: 41 },
					has_more: true,
					medias: Array.from({ length: 40 }, (_, i) => ({
						id: i + 1,
						type: 2,
						title: '原媒体',
					})),
				},
			}),
	})
	try {
		f.session.open()
		f.session.setMid('88')
		await f.session.readFolders()
		await f.session.chooseFolder('123')
		assert.equal(f.session.saveDirectory(), false)
		assert.equal(f.store.list().length, 0)
		f.session.close()
		assert.equal(await f.session.nextPage(), false)
	} finally {
		f.raw.close()
	}
})

void test('view only requests original BV, stores verified catalog, and selection/preview do not confirm CID', async () => {
	const asked: string[] = []
	const f = fixture(':memory:', {
		video: (bvid) => {
			asked.push(bvid)
			return videoRead(video(bvid))
		},
	})
	try {
		seed(f)
		f.session.openEntry('e0')
		assert.equal(await f.session.readVideo(), true)
		assert.deepEqual(asked, [bv])
		assert.equal(f.catalog.get(bv)!.parts.length, 2)
		assert.equal(f.session.selectedSource(), null)
		f.session.selectCid(22)
		assert.equal(f.store.getMixed('task')!.entries[0].review.state, 'pending')
		assert.equal(f.session.confirmCid(), true)
		assert.equal(
			f.store.getMixed('task')!.entries[0].review.confirmation!.sourceId,
			`bilibili:${bv}:22`,
		)
		assert.equal(f.session.kind('e0'), 'unknown')
	} finally {
		f.raw.close()
	}
})

void test('cancelled old view cannot publish metadata or clear new entry, raw gate blocks overlapping fetch', async () => {
	const slow = deferred<ReturnType<typeof video>>()
	let calls = 0
	const f = fixture(':memory:', {
		video: () => {
			calls++
			return videoRead(slow.promise)
		},
	})
	try {
		seed(f)
		f.session.openEntry('e0')
		const pending = f.session.readVideo()
		await tick()
		f.session.openEntry('e1')
		assert.equal(await f.session.readVideo(), false)
		slow.resolve(video())
		assert.equal(await pending, false)
		assert.equal(calls, 1)
		assert.equal(f.session.getSnapshot().entryId, 'e1')
		assert.equal(f.session.getSnapshot().video, null)
		assert.equal(f.catalog.get(bv), null)
	} finally {
		f.raw.close()
	}
})

void test('mixed selected occurrences persist independent kinds and no-BV unknown; zero songs create no playlist', () => {
	const f = fixture()
	try {
		seed(f, 3, true)
		choose(f, 'e0', 'musicCollection')
		choose(f, 'e2', 'unknown')
		f.session.openDestination()
		assert.equal(f.session.prepare(null, 'keep-all', 'keep-all'), true)
		assert.equal(f.session.commit(), true)
		const receipt = f.session.getSnapshot().receipt!
		assert.equal(receipt.playlistId, null)
		assert.deepEqual(f.playlists.list(), [])
		assert.equal(receipt.counts.listening.added, 1)
		assert.equal(receipt.counts.unclassified.added, 1)
		assert.equal(
			f.saves.list('listening', { offset: 0, limit: 20 })[0].contentKind,
			'musicCollection',
		)
		assert.equal(
			f.saves.list('unclassified', { offset: 0, limit: 20 })[0].bvid,
			null,
		)
		f.session.openTask('task')
		assert.deepEqual([...f.session.processed()], ['e0', 'e2'])
		assert.equal(f.session.setSelected('e0', true), false)
	} finally {
		f.raw.close()
	}
})

void test('fixed command survives SQL failure, retries same commitId; skip occurrences remain processed', () => {
	const f = fixture()
	try {
		seed(f)
		choose(f, 'e0', 'knowledge')
		choose(f, 'e2', 'knowledge')
		f.session.openDestination()
		f.session.prepare(null, 'keep-all', 'skip-existing-video')
		const command = f.session.getSnapshot().command!
		f.raw.exec(
			"CREATE TEMP TRIGGER fail_save BEFORE INSERT ON saved_video_items BEGIN SELECT RAISE(ABORT,'fixture write failure'); END",
		)
		assert.equal(f.session.commit(), false)
		assert.equal(f.session.getSnapshot().command, command)
		assert.equal(f.session.prepare(null, 'keep-all', 'keep-all'), false)
		f.raw.exec('DROP TRIGGER fail_save')
		assert.equal(f.session.commit(), true)
		const receipt = f.session.getSnapshot().receipt!
		assert.equal(receipt.commitId, command.commitId)
		assert.equal(receipt.counts.listening.added, 1)
		assert.equal(receipt.counts.listening.skipped, 1)
		assert.deepEqual(f.store.commitMixed('task', command).receipt, receipt)
		f.session.openTask('task')
		assert.equal(f.session.processed().size, 2)
	} finally {
		f.raw.close()
	}
})

void test('revision conflict discards prepared command and re-reads instead of retrying stale selection', () => {
	const f = fixture()
	try {
		seed(f)
		choose(f, 'e0', 'song')
		f.session.openDestination()
		f.session.prepare(
			{ kind: 'create', playlistId: 'music', name: '音乐副本' },
			'keep-all',
			'keep-all',
		)
		const task = f.store.getMixed('task')!
		f.store.reviewContent('task', 'e1', { kind: 'knowledge' }, task.revision)
		assert.equal(f.session.commit(), false)
		assert.equal(f.session.getSnapshot().command, null)
		assert.equal(f.session.getSnapshot().route, 'task')
		assert.equal(f.playlists.get('music'), null)
	} finally {
		f.raw.close()
	}
})

void test('initial mixed song pending can confirm original CID and fill only original item, receipt stays null', async () => {
	const f = fixture()
	try {
		seed(f, 1)
		choose(f, 'e0', 'song')
		f.session.openDestination()
		f.session.prepare(
			{ kind: 'create', playlistId: 'music', name: '歌曲' },
			'keep-all',
			'keep-all',
		)
		f.session.commit()
		const receipt = f.session.getSnapshot().receipt!,
			itemId = receipt.results[0].itemId!
		f.playlists.copy('music', 'copy', '副本', ['copy-item'])
		f.session.openPending('task', 'e0', 'copy', 'copy-item')
		assert.equal(f.session.getSnapshot().binding, null)
		await f.session.readVideo()
		f.session.selectCid(11)
		assert.equal(f.session.confirmCid(), false)
		f.session.openPending('task', 'e0', 'music', itemId)
		await f.session.readVideo()
		f.session.selectCid(22)
		assert.equal(f.session.confirmCid(), true)
		assert.equal(f.session.resolvePending(), true)
		assert.equal(
			f.playlists.get('music')!.items[0].sourceId,
			`bilibili:${bv}:22`,
		)
		assert.equal(f.playlists.get('copy')!.items[0].sourceId, null)
		assert.equal(
			f.store.getMixed('task')!.history[0].receipt.results[0].sourceId,
			null,
		)
	} finally {
		f.raw.close()
	}
})

void test('unknown original explicit organization moves same item, then organized pending resolves without replaying initial receipt', async () => {
	const f = fixture()
	try {
		seed(f, 1)
		choose(f, 'e0', 'unknown')
		f.session.openDestination()
		f.session.prepare(null, 'keep-all', 'keep-all')
		f.session.commit()
		const initial = f.session.getSnapshot().receipt!,
			itemId = initial.results[0].itemId!
		f.session.openTask('task')
		f.session.openEntry('e0')
		assert.equal(f.session.getSnapshot().organizationItem!.itemId, itemId)
		assert.equal(f.session.setKind('song'), true)
		assert(f.saves.get(itemId))
		f.session.openOrganization()
		assert.equal(
			f.session.prepareOrganization({
				kind: 'create',
				playlistId: 'organized',
				name: '整理歌曲',
			}),
			true,
		)
		const request = f.session.getSnapshot().organizationCommand!
		assert.equal(f.session.organize(), true)
		assert.equal(f.saves.get(itemId), null)
		assert.equal(f.playlists.get('organized')!.items[0].itemId, itemId)
		assert.deepEqual(
			f.store.organizeUnclassified('task', 'e0', request).receipt,
			f.session.getSnapshot().organizationReceipt,
		)
		f.session.openPending('task', 'e0', 'organized', itemId)
		await f.session.readVideo()
		f.session.selectCid(22)
		f.session.confirmCid()
		assert.equal(f.session.resolvePending(), true)
		const restored = f.store.getMixed('task')!
		assert.equal(restored.history[0].receipt.results[0].sourceId, null)
		assert.equal(restored.organizations[0].sourceId, null)
		assert.equal(
			f.playlists.get('organized')!.items[0].sourceId,
			`bilibili:${bv}:22`,
		)
	} finally {
		f.raw.close()
	}
})

void test('cold reopen restores review, occurrences and real saved lists; missing visited P never selects first', async () => {
	const folder = mkdtempSync(join(tmpdir(), 'melo-bili-ui-')),
		file = join(folder, 'library.sqlite')
	let f = fixture(file)
	try {
		seed(f)
		for (const id of ['e0', 'e1', 'e2']) choose(f, id, 'musicCollection')
		f.session.openDestination()
		f.session.prepare(null, 'keep-all', 'keep-all')
		f.session.commit()
		f.catalog.save(video(), 1)
		f.catalog.recordVisitedPart(bv, `bilibili:${bv}:22`)
		f.catalog.save(video(bv, [33]), 2)
		f.raw.close()
		f = fixture(file)
		f.session.openTask('task')
		assert.equal(f.session.kind('e2'), 'musicCollection')
		const library = new ListeningLibrarySession(
			f.saves,
			f.catalog,
			f.ports.video,
			f.gate,
		)
		library.open('listening')
		assert.deepEqual(
			library
				.getSnapshot()
				.items.map(
					(item) =>
						item.importOrigin.originalMetadata.media &&
						(item.importOrigin.originalMetadata.media as { title: string })
							.title,
				),
			['A', 'B', 'A'],
		)
		library.openItem(library.getSnapshot().items[0].itemId)
		assert.equal(library.getSnapshot().selectedCid, null)
		assert.match(library.getSnapshot().notice, /重新|重选/)
		assert.equal(library.selectedSource(), null)
		library.selectCid(33)
		assert.equal(library.selectedSource()!.cid, 33)
		assert.equal(library.remove(), true)
		assert.equal(f.saves.list('listening', { offset: 0, limit: 20 }).length, 2)
		assert.equal(f.store.getMixed('task')!.history[0].receipt.results.length, 3)
	} finally {
		f.raw.close()
		rmSync(folder, { recursive: true })
	}
})

void test('completed selection/confirmation writes do not depend on redundant task rereads', async () => {
	const f = fixture()
	try {
		seed(f, 1)
		f.session.openEntry('e0')
		await f.session.readVideo()
		f.session.selectCid(22)
		const getMixed = f.store.getMixed.bind(f.store)
		f.store.getMixed = () => {
			throw new Error('post-write read unavailable')
		}
		assert.equal(f.session.setSelected('e0', true), true)
		assert.equal(f.session.getSnapshot().task!.entries[0].selected, true)
		assert.equal(f.session.confirmCid(), true)
		assert.equal(
			f.session.getSnapshot().task!.entries[0].review.state,
			'confirmed',
		)
		f.store.getMixed = getMixed
		assert.equal(
			f.session.getSnapshot().task!.revision,
			f.store.getMixed('task')!.revision,
		)
	} finally {
		f.raw.close()
	}
})

void test('successful pending resolution remains success when later getMixed fails, and old button cannot write twice', async () => {
	const f = fixture()
	try {
		seed(f, 1)
		choose(f, 'e0', 'song')
		f.session.openDestination()
		f.session.prepare(
			{ kind: 'create', playlistId: 'music', name: '歌曲' },
			'keep-all',
			'keep-all',
		)
		f.session.commit()
		f.session.openTask('task')
		f.session.openEntry('e0')
		await f.session.readVideo()
		f.session.selectCid(11)
		f.session.confirmCid()
		const getMixed = f.store.getMixed.bind(f.store)
		f.store.getMixed = () => {
			throw new Error('post-write read unavailable')
		}
		assert.equal(f.session.resolvePending(), true)
		assert.equal(f.session.getSnapshot().binding!.sourceId, `bilibili:${bv}:11`)
		assert.match(f.session.getSnapshot().notice, /已补全/)
		assert.match(f.session.getSnapshot().error, /已补全.*重/)
		assert.equal(f.session.resolvePending(), false)
		assert.equal(
			f.playlists.get('music')!.items[0].sourceId,
			`bilibili:${bv}:11`,
		)
		f.store.getMixed = getMixed
	} finally {
		f.raw.close()
	}
})

void test('legacy v8 Bilibili playlist pending routes to original-BV confirmation after v11 migration', async () => {
	const f = fixture(':memory:', {}, 8)
	try {
		f.store.createDirectory(directory(1))
		const selected = f.store.setSelected('task', ['e0'], true, 0)
		f.store.commitSelected('task', {
			commitId: 'legacy',
			expectedRevision: selected.revision,
			target: { kind: 'create', playlistId: 'legacy-music', name: '旧歌曲' },
			duplicatePolicy: 'keep-all',
			itemIds: [{ entryId: 'e0', itemId: 'legacy-item' }],
		})
		migrate(f.db)
		f.session.openPending('task', 'e0', 'legacy-music', 'legacy-item')
		assert.equal(f.session.getSnapshot().binding!.itemId, 'legacy-item')
		await f.session.readVideo()
		f.session.selectCid(22)
		assert.equal(f.session.confirmCid(), true)
		assert.equal(f.session.resolvePending(), true)
		assert.equal(
			f.playlists.get('legacy-music')!.items[0].sourceId,
			`bilibili:${bv}:22`,
		)
		assert.equal(f.store.getMixed('task')!.history[0].kind, 'playlist')
		assert.equal(
			f.store.getMixed('task')!.history[0].receipt.results[0].sourceId,
			null,
		)
	} finally {
		f.raw.close()
	}
})

void test('organization failure preserves fixed operation for retry and never moves merely by reviewing kind', () => {
	const f = fixture()
	try {
		seed(f, 1)
		choose(f, 'e0', 'unknown')
		f.session.openDestination()
		f.session.prepare(null, 'keep-all', 'keep-all')
		f.session.commit()
		const itemId = f.session.getSnapshot().receipt!.results[0].itemId!
		f.session.openTask('task')
		f.session.openEntry('e0')
		f.session.setKind('musicCollection')
		assert.equal(f.saves.get(itemId)!.bucket, 'unclassified')
		f.session.openOrganization()
		f.session.prepareOrganization(null)
		const command = f.session.getSnapshot().organizationCommand!
		f.raw.exec(
			"CREATE TEMP TRIGGER fail_organization BEFORE INSERT ON import_item_organizations BEGIN SELECT RAISE(ABORT,'organization write failure'); END",
		)
		assert.equal(f.session.organize(), false)
		assert.equal(f.session.getSnapshot().organizationCommand, command)
		assert.equal(f.saves.get(itemId)!.bucket, 'unclassified')
		f.raw.exec('DROP TRIGGER fail_organization')
		assert.equal(f.session.organize(), true)
		assert.equal(
			f.session.getSnapshot().organizationReceipt!.operationId,
			command.operationId,
		)
		assert.equal(f.saves.get(itemId)!.bucket, 'listening')
		assert.equal(f.saves.get(itemId)!.contentKind, 'musicCollection')
	} finally {
		f.raw.close()
	}
})

void test('saved video list pages preserve all occurrences and no-BV records remain readable/removable', () => {
	const f = fixture()
	try {
		seed(f, 25, true)
		for (let i = 0; i < 25; i++) choose(f, `e${i}`, 'unknown')
		f.session.openDestination()
		f.session.prepare(null, 'keep-all', 'keep-all')
		f.session.commit()
		const library = new ListeningLibrarySession(
			f.saves,
			f.catalog,
			f.ports.video,
			f.gate,
		)
		library.open('unclassified')
		assert.equal(library.getSnapshot().items.length, 20)
		assert.equal(library.getSnapshot().more, true)
		library.next()
		assert.deepEqual(
			library
				.getSnapshot()
				.items.map((item) => item.importOrigin.originalPosition),
			[20, 21, 22, 23, 24],
		)
		const item = library.getSnapshot().items[0]
		library.openItem(item.itemId)
		assert.equal(library.getSnapshot().item!.bvid, null)
		assert.equal(library.selectedSource(), null)
		assert.equal(library.remove(), true)
		assert.equal(f.saves.get(item.itemId), null)
		assert.equal(
			f.store.getMixed('task')!.history[0].receipt.results.length,
			25,
		)
	} finally {
		f.raw.close()
	}
})

void test('explicit empty folders, missing response and restriction stay distinct UI states', async () => {
	for (const [raw, expected] of [
		[{ code: 0, data: { list: [] } }, 'empty'],
		[{ code: 0, data: null }, 'null-data'],
		[{ code: 0, data: { list: null } }, 'error'],
		[{ code: 0, data: { v_voucher: 'not-saved-token' } }, 'restricted'],
	] as const) {
		let calls = 0
		const f = fixture(':memory:', {
			folders: async () => {
				calls++
				return encode(raw)
			},
		})
		try {
			const before = f.raw
				.prepare('SELECT total_changes() AS count')
				.get()!.count
			f.session.open()
			f.session.setMid('88')
			assert.equal(await f.session.readFolders(), expected === 'empty')
			if (expected === 'empty') {
				assert.equal(f.session.getSnapshot().folders!.observedCount, 0)
				assert.equal(f.session.getSnapshot().error, '')
			} else {
				assert.equal(f.session.getSnapshot().folders, null)
				assert(f.session.getSnapshot().error)
				if (expected === 'restricted')
					assert.match(f.session.getSnapshot().error, /风控/)
				if (expected === 'null-data')
					assert.equal(
						f.session.getSnapshot().error,
						'平台未返回可读取的收藏夹列表，暂时无法判断是否为空。',
					)
			}
			assert.equal(calls, 1)
			assert.equal(
				f.raw.prepare('SELECT total_changes() AS count').get()!.count,
				before,
			)
			assert.equal(f.store.list().length, 0)
		} finally {
			f.raw.close()
		}
	}
})

void test('view timeout ends waiting but raw gate and no-publish condition survive until actual settlement', async (context) => {
	context.mock.timers.enable({ apis: ['setTimeout'] })
	const slow = deferred<ReturnType<typeof video>>()
	const f = fixture(':memory:', { video: () => videoRead(slow.promise) })
	try {
		seed(f, 1)
		f.session.openEntry('e0')
		const pending = f.session.readVideo()
		context.mock.timers.tick(30000)
		assert.equal(await pending, false)
		assert.equal(f.session.getSnapshot().busy, false)
		assert.match(f.session.getSnapshot().error, /超时/)
		assert.equal(f.gate.getSnapshot(), true)
		assert.equal(await f.session.readVideo(), false)
		slow.resolve(video())
		await tick()
		assert.equal(f.gate.getSnapshot(), false)
		assert.equal(f.catalog.get(bv), null)
	} finally {
		context.mock.timers.reset()
		f.raw.close()
	}
})

void test('catalog read error does not hide the real saved evidence or prevent explicit removal', () => {
	const f = fixture()
	try {
		seed(f, 1)
		choose(f, 'e0', 'knowledge')
		f.session.openDestination()
		f.session.prepare(null, 'keep-all', 'keep-all')
		f.session.commit()
		f.catalog.save(video(), 1)
		f.raw.exec('UPDATE sources SET uploaderId=99')
		const library = new ListeningLibrarySession(
			f.saves,
			f.catalog,
			f.ports.video,
			f.gate,
		)
		library.open('listening')
		const id = library.getSnapshot().items[0].itemId
		library.openItem(id)
		assert.equal(library.getSnapshot().item!.itemId, id)
		assert(library.getSnapshot().error)
		assert.equal(library.getSnapshot().video, null)
		assert.equal(library.remove(), true)
	} finally {
		f.raw.close()
	}
})
