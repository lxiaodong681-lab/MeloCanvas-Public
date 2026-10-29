import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve as resolvePath, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { Library, migrate, type Database } from '../core/database'
import type { ImportDirectorySnapshot } from '../core/import-types'
import { ImportStore } from '../core/imports'
import type { SearchItem } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import { DirectoryReadError } from '../external-directory'
import { createImportDirectoryReader } from '../import-directory-reader'
import { importEntryDescription } from '../import-display'
import { ImportSession, importBatchBudget } from '../import-session'
import { parseListeningVideo } from '../listening-source'
import { PlaybackIntent, playMusicIntent } from '../playback-intent'

import { preparationPort } from './playback-preparation-fixture'

const bv = 'BV1vT411i7ET'

function automaticCandidates() {
	const candidates = [bv, 'BV1xx411c7mD'].map(bvid => ({
		...item, bvid, originalTitle: '原A', duration: 198,
	}))
	const matchedVideo = parseListeningVideo({
		bvid: candidates[1].bvid, title: '原A', owner: { mid: 88, name: '真实UP' },
		pic: 'https://example.invalid/art',
		pages: [{ cid: 22, page: 1, part: '原A', duration: 198 }],
	}, candidates[1].bvid)
	return { candidates, matchedVideo }
}

void test('automatic import skips a failed candidate and saves the next matching source in original order', async () => {
	const f = setup(), { candidates, matchedVideo } = automaticCandidates(), calls: string[] = []
	try {
		f.ports.search = async query => ({ items: query.includes('原B') ? [] : candidates, more: false })
		f.ports.video = async bvid => {
			calls.push(bvid)
			if (bvid === bv) throw new Error('视频暂不可用')
			return matchedVideo
		}
		f.session.chooseProvider('netease')
		f.session.setUrl('https://music.163.com/playlist?id=123')
		const id = await f.session.importPlaylist()
		assert.ok(id, f.session.getSnapshot().error)
		const rows = f.playlists.get(id)!.items
		assert.deepEqual(calls, [bv, candidates[1].bvid, bv, candidates[1].bvid])
		assert.deepEqual(rows.map(row => row.sourceId), [matchedVideo.parts[0].source.id, null, matchedVideo.parts[0].source.id])
		assert.deepEqual(rows.map(row => row.importOrigin?.originalPosition), [0, 1, 2])
		assert.deepEqual(rows.map(row => row.importOrigin?.originalEntryId), ['A', 'B', 'A'])
		assert.equal(rows[0].review?.state, 'confirmed')
		assert.equal(f.session.getSnapshot().batch?.empty, 1)
	} finally { f.raw.close() }
})

void test('automatic import keeps original pending songs when every candidate fails', async () => {
	const f = setup(), { candidates } = automaticCandidates(), calls: string[] = []
	try {
		openTask(f, 1)
		f.ports.search = async () => ({ items: candidates, more: false })
		f.ports.video = async bvid => { calls.push(bvid); throw new Error('视频暂不可用') }
		const id = await f.session.importPlaylist()
		assert.ok(id)
		assert.deepEqual(calls, candidates.map(candidate => candidate.bvid))
		const rows = f.playlists.get(id)!.items
		assert.equal(rows.length, 1)
		assert.equal(rows[0].sourceId, null)
		assert.equal(rows[0].review?.state, 'pending')
		assert.deepEqual(rows[0].importOrigin?.originalMetadata, directory(1).entries[0].originalMetadata)
		assert.equal(f.session.getSnapshot().batch?.empty, 1)
	} finally { f.raw.close() }
})

for (const name of ['AbortError', 'TimeoutError']) {
	void test(`automatic import does not try another candidate after ${name}`, async () => {
		const f = setup(), { candidates } = automaticCandidates(), calls: string[] = []
		try {
			openTask(f, 1)
			f.ports.search = async () => ({ items: candidates, more: false })
			f.ports.video = async bvid => { calls.push(bvid); throw Object.assign(new Error('stopped'), { name }) }
			const id = await f.session.importPlaylist()
			assert.ok(id)
			assert.deepEqual(calls, [bv])
			assert.equal(f.playlists.get(id)!.items[0].sourceId, null)
		} finally { f.raw.close() }
	})
}

for (const stop of ['pause', 'timeout'] as const) {
	void test(`automatic import ${stop} stops candidate fallback and ignores late video failure`, async t => {
		t.mock.timers.enable({ apis: ['setTimeout'] })
		const f = setup(), { candidates, matchedVideo } = automaticCandidates()
		const pending = deferred<ReturnType<typeof video>>(), started = deferred<void>()
		const calls: string[] = []
		let signal: AbortSignal | undefined
		try {
			openTask(f, 1)
			f.ports.search = async () => ({ items: candidates, more: false })
			f.ports.video = (bvid, nextSignal) => {
				calls.push(bvid); signal = nextSignal; started.resolve()
				return bvid === bv ? pending.promise : Promise.resolve(matchedVideo)
			}
			const run = f.session.importPlaylist()
			await started.promise
			if (stop === 'pause') f.session.pauseBatch()
			else t.mock.timers.tick(importBatchBudget.timeoutMs)
			const id = await run
			assert.equal(signal?.aborted, true)
			if (stop === 'pause') {
				assert.equal(id, null)
				assert.equal(f.playlists.list().length, 0)
				assert.equal(f.session.getSnapshot().batch?.phase, 'paused')
			} else {
				assert.ok(id)
				assert.equal(f.playlists.get(id)!.items[0].sourceId, null)
			}
			pending.reject(new Error('late network failure'))
			await new Promise(resolve => setImmediate(resolve))
			assert.deepEqual(calls, [bv])
			assert.equal(f.store.get('task')!.entries[0].review.state, 'pending')
		} finally { f.raw.close() }
	})
}

void test('one action imports more than twenty songs, matches sources and preserves missing songs in order', async () => {
	const f = setup()
	try {
		f.ports.readDirectory = async input => ({ ...directory(24), taskId: input.taskId })
		f.ports.search = async query => ({ items: query.includes('原B') ? [] : [{ ...item, originalTitle: '原A', duration: 198 }], more: false })
		f.ports.video = async () => ({ ...video(1), title: '原A', parts: [{ ...video(1).parts[0], source: { ...video(1).parts[0].source, duration: 198 } }] })
		f.session.chooseProvider('netease'); f.session.setUrl('https://music.163.com/playlist?id=123')
		const id = await f.session.importPlaylist()
		assert.ok(id, f.session.getSnapshot().error)
		const playlist = f.playlists.get(id)!
		assert.equal(playlist.items.length, 24)
		assert.equal(playlist.items[1].sourceId, null)
		assert.equal(playlist.items.filter(row => row.sourceId).length, 23)
		assert.deepEqual(playlist.items.map(row => row.importOrigin?.originalPosition), Array.from({ length: 24 }, (_, i) => i))
		assert.equal(playlist.items[0].review?.candidates[0].evidence.method, 'automatic-title-duration-match')
		assert.equal(await f.session.importPlaylist(), id)
		assert.equal(f.playlists.list().length, 1)
		const first = playlist.items[0], second = playlist.items[2]
		const replacement = video(2).parts[1].source
		const changed = f.playlists.changeSource(id, first.itemId, replacement, playlist.updatedAt)
		assert.equal(changed.items[0].sourceId, replacement.id)
		assert.equal(changed.items[2].sourceId, second.sourceId)
		assert.deepEqual(changed.items[0].importOrigin, first.importOrigin)
		assert.equal(changed.items[0].position, first.position)
		assert.throws(() => f.playlists.changeSource(id, first.itemId, replacement, playlist.updatedAt), /已变更/)
		const resolved = f.playlists.changeSource(id, changed.items[1].itemId, replacement, changed.updatedAt)
		assert.equal(resolved.items[1].sourceId, replacement.id)
	} finally { f.raw.close() }
})

void test('previously saved pending songs can be auto-matched in place without duplicating the playlist', async () => {
	const f = setup()
	try {
		openTask(f)
		f.ports.search = async () => ({ items: [], more: false })
		const id = (await f.session.importPlaylist())!
		const before = f.playlists.get(id)!
		assert.equal(before.items.filter(row => row.sourceId).length, 0)
		f.ports.search = async () => ({ items: [{ ...item, originalTitle: '原A', duration: 198 }], more: false })
		f.ports.video = async () => ({ ...video(1), title: '原A', parts: [{ ...video(1).parts[0], source: { ...video(1).parts[0].source, duration: 198 } }] })
		assert.equal(await f.session.importPlaylist(), id)
		const after = f.playlists.get(id)!
		assert.equal(f.playlists.list().length, 1)
		assert.deepEqual(after.items.map(row => row.itemId), before.items.map(row => row.itemId))
		assert.equal(after.items.filter(row => row.sourceId).length, 2)
		assert.equal(after.items[1].sourceId, null)
		assert.equal(after.items[0].review?.candidates[0].evidence.method, 'automatic-title-duration-match')
	} finally { f.raw.close() }
})

void test('pausing automatic import ignores late search results and keeps recoverable task without creating a playlist', async () => {
	const f = setup(), wait = deferred<{ items: SearchItem[]; more: boolean }>()
	try {
		openTask(f)
		f.ports.search = () => wait.promise
		const pending = f.session.importPlaylist()
		f.session.pauseBatch()
		assert.equal(await pending, null)
		wait.resolve({ items: [item], more: false })
		await new Promise(resolve => setImmediate(resolve))
		assert.equal(f.playlists.list().length, 0)
		assert.equal(f.store.get('task')!.entries[0].review.state, 'pending')
		assert.equal(f.session.getSnapshot().batch?.phase, 'paused')
	} finally { f.raw.close() }
})
function video(parts = 2) {
	return parseListeningVideo(
		{
			bvid: bv,
			title: '原视频 Live',
			pic: 'https://example.invalid/art',
			owner: { mid: 88, name: '真实UP' },
			videos: parts,
			pages: Array.from({ length: parts }, (_, index) => ({
				cid: index + 1,
				page: index + 1,
				part: `版本 ${index + 1}`,
				duration: 100 + index,
			})),
		},
		bv,
	)
}
const item: SearchItem = {
	bvid: bv,
	originalTitle: '搜索视频',
	uploader: '真实UP',
	uploaderId: 88,
	artwork: '',
	duration: 100,
	category: 'B站视频',
}
function directory(count = 3): ImportDirectorySnapshot {
	return {
		taskId: 'task',
		taskVersion: 1,
		provider: 'netease',
		originalPlaylistId: '123',
		originalMetadata: {
			playlist: { name: '原歌单' },
			directory: {
				status: 'complete',
				expectedCount: count,
				readMetadataCount: count,
			},
		},
		entries: Array.from({ length: count }, (_, index) => ({
			entryId: `e${index}`,
			originalEntryId: index === 1 ? 'B' : 'A',
			originalPosition: index,
			originalMetadata: {
				track: {
					name: index === 1 ? '原B' : '原A',
					ar: [{ name: '原表演者' }],
					al: { name: '原专辑' },
					dt: 198000,
				},
			},
		})),
	}
}
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void
	const promise = new Promise<T>((a, b) => {
		resolve = a
		reject = b
	})
	return { promise, resolve, reject }
}
function setup(file = ':memory:') {
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
	const library = new Library(db),
		store = new ImportStore(db),
		playlists = new PlaylistStore(db)
	let sequence = 0
	const ports: ConstructorParameters<typeof ImportSession>[3] = {
		readDirectory: async (input) => ({
			...directory(),
			taskId: input.taskId,
			taskVersion: input.taskVersion,
		}),
		search: async () => ({ items: [item], more: false }),
		video: async () => video(),
	}
	const makeSession = () =>
		new ImportSession(
			store,
			library,
			playlists,
			ports,
			() => `new-${++sequence}`,
		)
	const session = makeSession()
	return { raw, db, library, store, playlists, ports, session, makeSession }
}
function openTask(f: ReturnType<typeof setup>, count = 3) {
	f.store.createDirectory(directory(count))
	f.session.openTask('task')
}
async function select(f: ReturnType<typeof setup>, entryId = 'e0', cid = 2) {
	f.session.openEntry(entryId)
	await f.session.readVideo(bv)
	f.session.selectCid(cid)
}
function prepare(
	f: ReturnType<typeof setup>,
	kind: 'create' | 'append' = 'create',
) {
	f.session.openDestination()
	assert.equal(
		f.session.prepareCommit(
			kind === 'create'
				? { kind, playlistId: 'saved', name: '本地副本' }
				: {
						kind,
						playlistId: 'saved',
						expectedUpdatedAt: f.playlists.get('saved')!.updatedAt,
					},
			'keep-all',
		),
		true,
	)
}

void test('显式读取才调用端口，新目录版本不覆盖旧任务；真partial保存后对账可恢复', async () => {
	const f = setup()
	try {
		openTask(f)
		f.session.setSelected(['e0'], true)
		let calls = 0
		f.ports.readDirectory = async (input) => {
			calls++
			const snapshot = {
				...directory(),
				taskId: input.taskId,
				taskVersion: input.taskVersion,
				originalMetadata: {
					directory: {
						status: 'incomplete',
						expectedCount: 5,
						readMetadataCount: 3,
					},
				},
			}
			throw new DirectoryReadError('incomplete', '未完整', {}, snapshot)
		}
		f.session.open()
		assert.equal(calls, 0)
		f.session.chooseProvider('qq')
		f.session.setUrl('https://music.163.com/playlist?id=123')
		assert.equal(await f.session.readDirectory(), false)
		assert.equal(calls, 0)
		f.session.chooseProvider('netease')
		f.session.setUrl('https://music.163.com/playlist?id=123')
		assert.equal(await f.session.readDirectory(), true)
		assert.equal(calls, 1)
		assert.equal(f.session.getSnapshot().task!.taskVersion, 2)
		assert.equal(
			f.session.getSnapshot().task!.originalMetadata.directory &&
				(
					f.session.getSnapshot().task!.originalMetadata.directory as {
						status: string
					}
				).status,
			'incomplete',
		)
		assert.equal(f.store.get('task')!.entries[0].selected, true)
		assert.equal(f.store.list().length, 2)
	} finally {
		f.raw.close()
	}
})

void test('目录取消/旧回包不保存或覆盖较新任务；保存SQL失败保留已读证据而不重新联网', async () => {
	const f = setup()
	try {
		openTask(f)
		const pending = deferred<ImportDirectorySnapshot>()
		f.ports.readDirectory = () => pending.promise
		f.session.chooseProvider('netease')
		f.session.setUrl('https://music.163.com/playlist?id=123')
		const work = f.session.readDirectory()
		f.session.cancelRead()
		f.session.openTask('task')
		pending.resolve({ ...directory(), taskId: 'late', taskVersion: 2 })
		assert.equal(await work, false)
		assert.equal(f.store.get('late'), null)
		assert.equal(f.session.getSnapshot().task!.taskId, 'task')
		f.ports.readDirectory = async (input) => ({
			...directory(),
			taskId: input.taskId,
			taskVersion: input.taskVersion,
		})
		f.raw.exec(
			"CREATE TRIGGER reject_directory BEFORE INSERT ON import_tasks BEGIN SELECT RAISE(ABORT,'disk write'); END",
		)
		f.session.chooseProvider('netease')
		f.session.setUrl('https://music.163.com/playlist?id=123')
		assert.equal(await f.session.readDirectory(), false)
		assert.ok(f.session.getSnapshot().unsaved)
		assert.match(f.session.getSnapshot().error, /disk write/)
		f.raw.exec('DROP TRIGGER reject_directory')
		assert.equal(f.session.saveDirectory(), true)
		assert.equal(f.store.list().length, 2)
	} finally {
		f.raw.close()
	}
})

void test('移动读取gate按实际transport Promise限入：公开取消后未settle不启动第二请求', async () => {
	const pending = deferred<Uint8Array>()
	const body = new TextEncoder().encode(
		JSON.stringify({
			code: 200,
			playlist: { id: 123, name: '空歌单', trackCount: 0, tracks: [] },
		}),
	)
	let calls = 0
	const read = createImportDirectoryReader(async () =>
		++calls === 1 ? pending.promise : body,
	)
	const input = {
		url: 'https://music.163.com/playlist?id=123',
		taskId: 'gate',
		taskVersion: 1,
	}
	const controller = new AbortController(),
		first = read({ ...input, signal: controller.signal })
	await Promise.resolve()
	controller.abort()
	await assert.rejects(
		first,
		(error) =>
			error instanceof DirectoryReadError && error.code === 'cancelled',
	)
	await assert.rejects(read(input), /上次目录读取仍在结束/)
	assert.equal(calls, 1)
	pending.resolve(body)
	await pending.promise
	await Promise.resolve()
	await Promise.resolve()
	assert.equal((await read(input)).entries.length, 0)
	assert.equal(calls, 2)
})

void test('261项批量选择只调用一次真实setSelected，跨页按occurrence保留A/B/A', () => {
	const f = setup()
	try {
		openTask(f, 261)
		const original = f.store.setSelected.bind(f.store)
		let calls = 0
		f.store.setSelected = (...args) => {
			calls++
			return original(...args)
		}
		assert.equal(
			f.session.setSelected(
				f.session.getSnapshot().task!.entries.map((entry) => entry.entryId),
				true,
			),
			true,
		)
		assert.equal(calls, 1)
		assert.equal(
			f.session.getSnapshot().task!.entries.filter((entry) => entry.selected)
				.length,
			261,
		)
		f.session.setSelected(['e1'], false)
		assert.equal(f.session.getSnapshot().task!.entries[2].selected, true)
	} finally {
		f.raw.close()
	}
})

void test('候选错误不标未找到，旧query/entry晚回包不覆盖；更换查询重置分页键', async () => {
	const f = setup()
	try {
		openTask(f)
		f.session.openEntry('e0')
		f.session.setQuery('旧查询')
		const pending = deferred<{ items: SearchItem[]; more: boolean }>()
		f.ports.search = () => pending.promise
		const old = f.session.searchCandidates()
		f.session.setQuery('新查询')
		pending.resolve({ items: [item], more: true })
		assert.equal(await old, false)
		assert.deepEqual(f.session.getSnapshot().candidates, [])
		assert.equal(f.session.getSnapshot().searchPage, 0)
		f.ports.search = async (query, page) => {
			assert.equal(query, '新查询')
			assert.equal(page, 1)
			throw new Error('游客受限')
		}
		assert.equal(await f.session.searchCandidates(), false)
		assert.equal(f.session.markNotFound(), false)
		assert.equal(f.store.get('task')!.entries[0].review.state, 'pending')
		assert.equal(f.store.get('task')!.entries[0].retries.length, 1)
		assert.match(f.session.getSnapshot().searchError, /游客受限/)
		f.ports.search = async () => ({ items: [], more: false })
		assert.equal(await f.session.searchCandidates(), true)
		assert.equal(f.session.markNotFound(), true)
		assert.equal(f.store.get('task')!.entries[0].review.state, 'not-found')
	} finally {
		f.raw.close()
	}
})

void test('候选跨页按当前query累积并去重BV，不影响原目录重复出现项', async () => {
	const f = setup()
	try {
		openTask(f)
		f.session.openEntry('e0')
		f.session.setQuery('明确版本')
		const calls: number[] = []
		f.ports.search = async (keyword, page) => {
			assert.equal(keyword, '明确版本')
			calls.push(page)
			return {
				items: page === 1 ? [item] : [item, { ...item, bvid: 'BV1xx411c7mD' }],
				more: page === 1,
			}
		}
		assert.equal(await f.session.searchCandidates(), true)
		assert.equal(await f.session.searchCandidates(true), true)
		assert.deepEqual(calls, [1, 2])
		assert.deepEqual(
			f.session.getSnapshot().candidates.map((candidate) => candidate.bvid),
			[bv, 'BV1xx411c7mD'],
		)
		assert.deepEqual(
			f.store.get('task')!.entries.map((entry) => entry.originalEntryId),
			['A', 'B', 'A'],
		)
	} finally {
		f.raw.close()
	}
})

void test('旧视频view晚回包不成为新条目的CID选择或确认对象', async () => {
	const f = setup()
	try {
		openTask(f)
		f.session.openEntry('e0')
		const pending = deferred<ReturnType<typeof video>>()
		f.ports.video = () => pending.promise
		const work = f.session.readVideo(bv)
		f.session.openEntry('e1')
		pending.resolve(video())
		assert.equal(await work, false)
		assert.equal(f.session.getSnapshot().entryId, 'e1')
		assert.equal(f.session.getSnapshot().video, null)
		assert.equal(f.session.selectedSource(), null)
		assert.equal(f.session.confirmCandidate(), false)
		assert.equal(f.store.get('task')!.entries[1].review.state, 'pending')
	} finally {
		f.raw.close()
	}
})

void test('来源目录分页与滚动在核对后返回仍保留，新条目与新任务从头显示', () => {
	const f = setup()
	try {
		openTask(f, 261)
		f.session.setTaskPage(2)
		f.session.rememberScroll('task:task:', 620)
		f.session.openEntry('e45')
		assert.equal(f.session.scrollOffset('entry:task:e45'), 0)
		f.session.back()
		assert.equal(f.session.getSnapshot().route, 'task')
		assert.equal(f.session.getSnapshot().taskPage, 2)
		assert.equal(f.session.scrollOffset('task:task:'), 620)
		f.session.setSelected(['e45'], true)
		assert.equal(f.session.getSnapshot().taskPage, 2)
		f.store.createDirectory({
			...directory(),
			taskId: 'new-task',
			taskVersion: 2,
		})
		f.session.openTask('new-task')
		assert.equal(f.session.getSnapshot().taskPage, 0)
		f.session.openTask('task')
		assert.equal(f.session.getSnapshot().taskPage, 2)
	} finally {
		f.raw.close()
	}
})

void test('严格view解析100P后CID不默认，显式一项候选持久恢复；试听不写confirmed', async () => {
	const f = setup()
	try {
		openTask(f)
		f.session.openEntry('e0')
		f.ports.video = async () => video(100)
		await f.session.readVideo(bv)
		assert.equal(f.session.selectedSource(), null)
		assert.equal(f.session.confirmCandidate(), false)
		f.session.selectCid(99)
		let task = f.store.get('task')!
		assert.equal(task.entries[0].review.candidates.length, 1)
		assert.equal(task.entries[0].review.candidates[0].cid, 99)
		assert.equal(task.entries[0].review.state, 'needs-review')
		let started = 0
		assert.equal(
			await f.session.playPreview(
				async (source) => {
					assert.equal(source.cid, 99)
					return true
				},
				() => started++,
			),
			true,
		)
		assert.equal(started, 1)
		task = f.store.get('task')!
		assert.equal(task.entries[0].review.state, 'needs-review')
		assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM sources').get()?.n, 0)
		const reopened = f.makeSession()
		reopened.openTask('task')
		reopened.openEntry('e0')
		assert.equal(
			reopened.getSnapshot().task!.entries[0].review.candidates[0].cid,
			99,
		)
	} finally {
		f.raw.close()
	}
})

void test('人工确认保留已有Source分类/表演者；新搜索及真空不清除confirmed', async () => {
	const f = setup()
	try {
		openTask(f)
		await select(f)
		const source = f.session.selectedSource()!
		f.library.save({ ...source, domain: 'music', performer: '已有人工表演者' })
		assert.equal(f.session.confirmCandidate(), true)
		assert.equal(f.library.get(source.id)!.domain, 'music')
		assert.equal(f.library.get(source.id)!.performer, '已有人工表演者')
		f.session.setQuery('另查版本')
		f.ports.search = async () => ({ items: [], more: false })
		await f.session.searchCandidates()
		assert.equal(f.session.markNotFound(), false)
		assert.equal(
			f.store.get('task')!.entries[0].review.confirmation!.sourceId,
			source.id,
		)
	} finally {
		f.raw.close()
	}
})

void test('任务revision冲突刷新保原审核，不用旧决定静默重放', async () => {
	const f = setup()
	try {
		openTask(f)
		f.store.setSelected('task', ['e1'], true, 0)
		assert.equal(f.session.setSelected(['e0'], true), false)
		assert.match(f.session.getSnapshot().error, /变更/)
		assert.equal(f.session.getSnapshot().task!.entries[0].selected, false)
		assert.equal(f.session.getSnapshot().task!.entries[1].selected, true)
	} finally {
		f.raw.close()
	}
})

void test('commit SQL失败固定命令/mapping可重试，成功后双击不重复追加；receipt恢复', () => {
	const f = setup()
	try {
		openTask(f)
		f.session.setSelected(['e0', 'e2'], true)
		prepare(f)
		const command = f.session.getSnapshot().command
		f.raw.exec(
			"CREATE TRIGGER reject_commit BEFORE INSERT ON import_commit_entries BEGIN SELECT RAISE(ABORT,'commit failure'); END",
		)
		assert.equal(f.session.commit(), false)
		assert.deepEqual(f.session.getSnapshot().command, command)
		assert.equal(f.playlists.get('saved'), null)
		f.raw.exec('DROP TRIGGER reject_commit')
		assert.equal(f.session.commit(), true)
		assert.equal(f.session.commit(), false)
		assert.equal(f.playlists.get('saved')!.items.length, 2)
		assert.deepEqual(
			f.playlists.get('saved')!.items.map((entry) => entry.sourceId),
			[null, null],
		)
		const reopened = f.makeSession()
		reopened.openTask('task')
		assert.deepEqual(reopened.getSnapshot().task!.commits, [
			f.session.getSnapshot().receipt,
		])
	} finally {
		f.raw.close()
	}
})

void test('写成功后异常的固定command重放原receipt；commit后读取失败仍显示成功结果', () => {
	const f = setup()
	try {
		openTask(f)
		f.session.setSelected(['e0'], true)
		prepare(f)
		const commit = f.store.commitSelected.bind(f.store)
		let once = true
		f.store.commitSelected = (...args) => {
			const result = commit(...args)
			if (once) {
				once = false
				throw new Error('提交结果未送达')
			}
			return result
		}
		assert.equal(f.session.commit(), false)
		const get = f.store.get.bind(f.store)
		f.store.get = () => {
			throw new Error('refresh failure')
		}
		assert.equal(f.session.commit(), true)
		assert.equal(f.session.getSnapshot().route, 'result')
		assert.ok(f.session.getSnapshot().receipt)
		assert.match(f.session.getSnapshot().error, /refresh failure/)
		f.store.get = get
		assert.equal(f.playlists.get('saved')!.items.length, 1)
	} finally {
		f.raw.close()
	}
})

void test('追加目标冲突丢弃旧命令，需重新选择目标并准备；已处理项不再进入mapping', () => {
	const f = setup()
	try {
		openTask(f)
		f.session.setSelected(['e0'], true)
		prepare(f)
		f.session.commit()
		f.session.continueTask()
		f.session.setSelected(['e1'], true)
		prepare(f, 'append')
		const before = f.session.getSnapshot().command!
		assert.deepEqual(
			before.itemIds.map((row) => row.entryId),
			['e1'],
		)
		f.playlists.rename('saved', '用户新编辑')
		assert.equal(f.session.commit(), false)
		assert.equal(f.session.getSnapshot().command, null)
		assert.equal(f.session.getSnapshot().route, 'task')
		prepare(f, 'append')
		assert.notEqual(f.session.getSnapshot().command!.commitId, before.commitId)
		assert.equal(f.session.commit(), true)
		assert.equal(f.playlists.get('saved')!.items.length, 2)
	} finally {
		f.raw.close()
	}
})

void test('已提交pending人工确认后补原item；resolve成功后读取失败也不重复追加', async () => {
	const f = setup()
	try {
		openTask(f)
		f.session.setSelected(['e0'], true)
		prepare(f)
		f.session.commit()
		const original = f.playlists.get('saved')!.items[0]
		f.session.continueTask()
		await select(f)
		assert.equal(f.session.confirmCandidate(), true)
		const get = f.store.get.bind(f.store)
		f.store.get = () => {
			throw new Error('refresh unavailable')
		}
		assert.equal(f.session.resolvePending(), true)
		assert.notEqual(f.session.getSnapshot().binding!.sourceId, null)
		f.store.get = get
		const next = f.playlists.get('saved')!.items[0]
		assert.equal(next.itemId, original.itemId)
		assert.equal(next.addedAt, original.addedAt)
		assert.equal(next.position, 0)
		assert.equal(f.playlists.get('saved')!.items.length, 1)
		assert.equal(next.sourceId, video().parts[1].source.id)
	} finally {
		f.raw.close()
	}
})

void test('试听取消归属：换任务不打开旧播放器，也不取消后来其他域的播放意图', async () => {
	const f = setup()
	try {
		openTask(f)
		await select(f)
		const pending = deferred<ReturnType<typeof video>['parts'][0]['source']>(),
			intent = new PlaybackIntent()
		let active = '',
			opened = 0,
			nativeCancelled = 0
		const work = f.session.playPreview(
			(source, own) =>
				playMusicIntent(intent, source, {
					resolve: () => pending.promise,
					preparation: preparationPort(),
					activate: async (next) => {
						active = next.id
						return true
					},
					onPending: () => {},
					onStarted: () => {},
					onRequest: (request) =>
						own(() => {
							if (request.cancel()) nativeCancelled++
						}, request.isCurrent),
				}),
			() => opened++,
		)
		await Promise.resolve()
		await intent.run({
			preparation: preparationPort(),
			prepare: async () => 'new-domain',
			activate: async (next) => {
				active = next
				return true
			},
			onSuccess: () => {},
		})
		f.session.close()
		pending.resolve(video().parts[1].source)
		assert.equal(await work, false)
		assert.equal(opened, 0)
		assert.equal(nativeCancelled, 0)
		assert.equal(active, 'new-domain')
		assert.equal(f.session.getSnapshot().route, 'closed')
	} finally {
		f.raw.close()
	}
})

void test('换CID取消旧试听，旧成功不抢回当前页面；返回播放器只恢复自己的已挂起流程', async () => {
	const f = setup()
	try {
		openTask(f)
		await select(f)
		const pending = deferred<boolean>()
		let cancelled = 0,
			opened = 0
		const work = f.session.playPreview(
			async (_, own) => {
				own(
					() => cancelled++,
					() => true,
				)
				return pending.promise
			},
			() => opened++,
		)
		f.session.selectCid(1)
		pending.resolve(true)
		assert.equal(await work, false)
		assert.equal(cancelled, 1)
		assert.equal(opened, 0)
		assert.equal(f.session.getSnapshot().playbackBusy, false)
		await f.session.playPreview(
			async (_, own) => {
				own(
					() => {},
					() => true,
				)
				return true
			},
			() => opened++,
		)
		assert.equal(f.session.getSnapshot().suspended, true)
		f.session.resumeFromPlayer(
			video().parts[0].source.id,
			video().parts[0].source.id,
		)
		assert.equal(f.session.getSnapshot().route, 'entry')
		f.session.close()
		f.session.resumeFromPlayer(null, null)
		assert.equal(f.session.getSnapshot().route, 'closed')
	} finally {
		f.raw.close()
	}
})

void test('成功试听返回绑定原播放意图与队列项，暂停或seek不影响；换域和重复Source的另一项不恢复旧审核', async () => {
	const f = setup(),
		intent = new PlaybackIntent()
	let cancelled = 0
	try {
		openTask(f)
		const sourceId = video().parts[1].source.id
		const start = async () => {
			f.session.openTask('task')
			await select(f)
			assert.equal(
				await f.session.playPreview(
					(source, own) =>
						playMusicIntent(intent, source, {
							resolve: async (value) => value,
							preparation: preparationPort(),
							activate: async () => true,
							onPending: () => {},
							onStarted: () => {},
							onRequest: (request) =>
								own(() => {
									if (request.cancel()) cancelled++
								}, request.isCurrent),
						}),
					() => {},
				),
				true,
			)
			f.session.observePlayer(sourceId, 'entry-a')
		}
		await start()
		// Position and playing flags are deliberately absent from ownership: seek/pause keep this entry.
		f.session.observePlayer(sourceId, 'entry-a')
		assert.equal(f.session.resumeFromPlayer(sourceId, 'entry-a'), true)
		assert.equal(f.session.getSnapshot().route, 'entry')
		await start()
		const later = intent.begin()
		assert.equal(f.session.resumeFromPlayer(sourceId, 'entry-a'), false)
		assert.equal(f.session.getSnapshot().route, 'closed')
		assert.equal(later.isCurrent(), true)
		await start()
		f.session.observePlayer(sourceId, 'entry-a-second-occurrence')
		assert.equal(f.session.getSnapshot().route, 'closed')
		assert.equal(
			f.session.resumeFromPlayer(sourceId, 'entry-a-second-occurrence'),
			false,
		)
		assert.equal(cancelled, 0)
		assert.equal(f.store.get('task')?.entries.length, 3)
	} finally {
		f.raw.close()
	}
})

void test('真实文件重开恢复原A/B/A、selection、已提交pending与历史；本地浏览不触网', () => {
	const dir = mkdtempSync(join(tmpdir(), 'melo-import-ui-'))
	assert.ok(
		resolvePath(dir).startsWith(resolvePath(tmpdir()) + sep) &&
			basename(dir).startsWith('melo-import-ui-'),
	)
	try {
		const file = join(dir, 'library.db')
		let f = setup(file)
		openTask(f)
		f.session.setSelected(['e0', 'e2'], true)
		prepare(f)
		f.session.commit()
		const receipt = f.session.getSnapshot().receipt
		f.raw.close()
		f = setup(file)
		try {
			let calls = 0
			f.ports.search = async () => {
				calls++
				return { items: [], more: false }
			}
			f.session.open()
			f.session.openTask('task')
			assert.equal(calls, 0)
			assert.deepEqual(f.session.getSnapshot().task!.commits, [receipt])
			assert.deepEqual(
				f.session
					.getSnapshot()
					.task!.entries.map((entry) => entry.originalEntryId),
				['A', 'B', 'A'],
			)
			assert.equal(
				importEntryDescription(
					f.session.getSnapshot().task!.entries[0],
					'netease',
				).duration,
				198,
			)
			assert.equal(f.playlists.get('saved')!.items.length, 2)
		} finally {
			f.raw.close()
		}
	} finally {
		rmSync(dir, { recursive: true })
	}
})

// Extract the actual button callback, so a session-only fix cannot leave UI wiring stale.
function originalVideoAction(
	f: ReturnType<typeof setup>,
	openURL: (url: string) => Promise<unknown>,
) {
	const source = readFileSync(
		new URL('../import-ui.tsx', import.meta.url),
		'utf8',
	)
	const tree = ts.createSourceFile(
		'import-ui.tsx',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	let callback = ''
	function visit(node: ts.Node) {
		if (
			ts.isJsxElement(node) &&
			node.openingElement.attributes.properties.some(
				(attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === 'accessibilityLabel' && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === '查看原视频',
			)
		) {
			const press = node.openingElement.attributes.properties.find(
				(value) =>
					ts.isJsxAttribute(value) && value.name.getText(tree) === 'onPress',
			)
			assert(
				press &&
					ts.isJsxAttribute(press) &&
					press.initializer &&
					ts.isJsxExpression(press.initializer) &&
					press.initializer.expression,
			)
			callback = press.initializer.expression.getText(tree)
		}
		ts.forEachChild(node, visit)
	}
	visit(tree)
	assert(callback, 'actual original-video action must exist')
	return runInNewContext(
		ts.transpileModule(`globalThis.action = ${callback}`, {
			compilerOptions: { target: ts.ScriptTarget.ES2022 },
		}).outputText + '\naction',
		{
			state: f.session.getSnapshot(),
			session: f.session,
			Linking: { openURL },
		},
	) as () => void
}
const settleLink = () => new Promise<void>((resolve) => setImmediate(resolve))

void test('actual original-video action preserves target and reports current native failure', async () => {
	const f = setup(),
		pending = deferred<unknown>(),
		urls: string[] = []
	try {
		openTask(f)
		await select(f)
		originalVideoAction(f, (url) => {
			urls.push(url)
			return pending.promise
		})()
		pending.reject(new Error('No browser available'))
		await settleLink()
		assert.deepEqual(urls, [`https://www.bilibili.com/video/${bv}?p=2`])
		assert.equal(f.session.getSnapshot().error, 'No browser available')
	} finally {
		f.raw.close()
	}
})

for (const navigation of ['close', 'entry', 'reopen'] as const) {
	void test(`actual original-video late failure cannot contaminate ${navigation}`, async () => {
		const f = setup(),
			pending = deferred<unknown>()
		try {
			openTask(f)
			await select(f)
			originalVideoAction(f, () => pending.promise)()
			if (navigation === 'close') f.session.close()
			else if (navigation === 'entry') f.session.openEntry('e1')
			else {
				f.session.close()
				f.session.openTask('task')
				await select(f)
			}
			f.session.reportError(new Error('new page error'))
			pending.reject(new Error('stale link error'))
			await settleLink()
			assert.equal(f.session.getSnapshot().error, 'new page error')
		} finally {
			f.raw.close()
		}
	})
}

void test('actual original-video success is silent and repeated opens keep only newest failure authority', async () => {
	const f = setup(),
		first = deferred<unknown>(),
		second = deferred<unknown>()
	try {
		openTask(f)
		await select(f)
		originalVideoAction(f, () => first.promise)()
		originalVideoAction(f, () => second.promise)()
		second.reject(new Error('latest link error'))
		await settleLink()
		first.reject(new Error('old link error'))
		await settleLink()
		assert.equal(f.session.getSnapshot().error, 'latest link error')
		originalVideoAction(f, async () => undefined)()
		await settleLink()
		assert.equal(f.session.getSnapshot().error, 'latest link error')
	} finally {
		f.raw.close()
	}
})

void test('actual original-video stale rendered callback cannot open a replacement video or a closed session', async () => {
	const f = setup(),
		urls: string[] = []
	try {
		openTask(f)
		await select(f)
		const press = originalVideoAction(f, async (url) => {
			urls.push(url)
		})
		const other = 'BV1xx411c7mD'
		f.ports.video = async () =>
			parseListeningVideo(
				{
					bvid: other,
					title: '另一个视频',
					pic: 'https://example.invalid/art',
					owner: { mid: 88, name: 'UP' },
					videos: 1,
					pages: [{ cid: 7, page: 1, part: '另一P', duration: 100 }],
				},
				other,
			)
		await f.session.readVideo(other)
		press()
		await settleLink()
		assert.equal(urls.length, 0)
		const currentPress = originalVideoAction(f, async (url) => {
			urls.push(url)
		})
		f.session.close()
		currentPress()
		await settleLink()
		assert.equal(urls.length, 0)
	} finally {
		f.raw.close()
	}
})

void test('actual original-video newer success cannot be followed by an older failure', async () => {
	const f = setup(),
		pending = deferred<unknown>()
	try {
		openTask(f)
		await select(f)
		originalVideoAction(f, () => pending.promise)()
		originalVideoAction(f, async () => undefined)()
		await settleLink()
		pending.reject(new Error('older failure'))
		await settleLink()
		assert.equal(f.session.getSnapshot().error, '')
	} finally {
		f.raw.close()
	}
})

void test('review stale callback after same BV reopen must not own new session', async () => {
	const f = setup()
	const urls: string[] = []
	try {
		openTask(f)
		await select(f)
		const press = originalVideoAction(f, async (url) => {
			urls.push(url)
			throw new Error('old callback error')
		})
		f.session.close()
		f.session.openTask('task')
		await select(f)
		f.session.reportError(new Error('new page error'))
		press()
		await settleLink()
		assert.deepEqual(
			{ urls, error: f.session.getSnapshot().error },
			{ urls: [], error: 'new page error' },
		)
	} finally {
		f.raw.close()
	}
})
void test('review actual callback catches synchronous Linking throw', async () => {
	const f = setup()
	try {
		openTask(f)
		await select(f)
		originalVideoAction(f, () => {
			throw new Error('sync native error')
		})()
		await settleLink()
		assert.equal(f.session.getSnapshot().error, 'sync native error')
	} finally {
		f.raw.close()
	}
})

void test('填入原曲信息仅编辑查询、取消旧回包、不覆盖确认；重复 occurrence 和旧点击隔离', async () => {
	const f = setup()
	try {
		openTask(f)
		f.session.openEntry('e0')
		let searchCalls = 0
		const pending = deferred<{ items: SearchItem[]; more: boolean }>()
		f.ports.search = () => {
			searchCalls++
			return pending.promise
		}
		f.session.setQuery('手工搜索')
		const reading = f.session.searchCandidates()
		const before = JSON.stringify(f.store.get('task'))
		f.session.createOriginalQueryAction()()
		assert.equal(f.session.getSnapshot().query, '原A 原表演者')
		assert.equal(searchCalls, 1)
		assert.equal(JSON.stringify(f.store.get('task')), before)
		pending.resolve({ items: [item], more: false })
		assert.equal(await reading, false)
		assert.deepEqual(f.session.getSnapshot().candidates, [])
		const oldFill = f.session.createOriginalQueryAction()
		f.session.openEntry('e2')
		oldFill()
		assert.equal(f.session.getSnapshot().query, '')
		f.session.createOriginalQueryAction()()
		assert.equal(f.session.getSnapshot().query, '原A 原表演者')
		await f.session.readVideo(bv)
		f.session.selectCid(2)
		f.session.confirmCandidate()
		const confirmed = JSON.stringify(f.store.get('task'))
		f.session.setQuery('自定义 Live')
		f.session.createOriginalQueryAction()()
		assert.equal(JSON.stringify(f.store.get('task')), confirmed)
		assert.equal(f.session.selectedSource(), null)
		assert.equal(f.session.confirmCandidate(), false)
		assert.equal(f.store.get('task')?.entries[0].review.state, 'pending')
		assert.equal(f.store.get('task')?.entries[2].review.state, 'confirmed')
	} finally {
		f.raw.close()
	}
})

void test('填入查询使异步旧视频失效，分 P 切换仅取所选 Source', async () => {
	const f = setup()
	try {
		openTask(f)
		f.session.openEntry('e0')
		const pending = deferred<ReturnType<typeof video>>()
		f.ports.video = () => pending.promise
		const reading = f.session.readVideo(bv)
		f.session.createOriginalQueryAction()()
		pending.resolve(video())
		assert.equal(await reading, false)
		assert.equal(f.session.selectedSource(), null)
		f.ports.video = async () => video()
		await f.session.readVideo(bv)
		assert.equal(f.session.selectedSource(), null)
		f.session.selectCid(1)
		assert.equal(f.session.selectedSource()?.duration, 100)
		f.session.selectCid(2)
		assert.equal(f.session.selectedSource()?.duration, 101)
	} finally {
		f.raw.close()
	}
})

void test('batch searches serially with exact cover/Live title and performer, no video, confirm or download', async () => {
	const f = setup()
	const data = directory(3)
	data.entries[0].originalMetadata = {
		track: { name: '歌名（翻唱 / Live）', ar: [{ name: '实际翻唱表演者' }] },
	}
	f.store.createDirectory(data)
	f.session.openTask('task')
	const calls: string[] = []
	let active = 0
	let peak = 0
	f.ports.video = async () => {
		throw new Error('batch must never read video')
	}
	f.ports.search = async (query, page) => {
		calls.push(query)
		assert.equal(page, 1)
		active++
		peak = Math.max(peak, active)
		await Promise.resolve()
		active--
		return { items: [item, item], more: true }
	}
	assert.equal(await f.session.findBatchCandidates(), true)
	assert.equal(peak, 1)
	assert.equal(calls[0], '歌名（翻唱 / Live） 实际翻唱表演者')
	assert.equal(calls.length, 3)
	const task = f.store.get('task')!
	for (const entry of task.entries) {
		assert.equal(entry.review.state, 'needs-review')
		assert.equal(entry.review.confirmation, null)
		assert.equal(entry.review.candidates.length, 1)
		assert.equal(entry.review.candidates[0].cid, null)
		assert.equal(entry.review.candidates[0].metadata.uploader, '真实UP')
	}
	assert.notEqual(task.entries[0].entryId, task.entries[2].entryId)
	assert.equal(f.session.getSnapshot().selectedCid, null)
	assert.equal(f.session.getSnapshot().video, null)
	f.raw.close()
})

void test('batch caps 20 requests, requires another explicit run and persists progress by occurrence', async () => {
	const f = setup()
	openTask(f, 23)
	let requests = 0
	f.ports.search = async () => {
		requests++
		return { items: [item], more: true }
	}
	await f.session.findBatchCandidates()
	assert.equal(requests, 20)
	assert.deepEqual(f.session.getSnapshot().batch, {
		phase: 'completed',
		eligible: 23,
		skipped: 0,
		budget: 20,
		requested: 20,
		completed: 20,
		empty: 0,
	})
	const reopened = f.makeSession()
	reopened.openTask('task')
	await reopened.findBatchCandidates()
	assert.equal(requests, 23)
	assert.equal(reopened.getSnapshot().batch?.skipped, 20)
	f.raw.close()
})

void test('batch skips missing evidence and all manual review states without overwriting', async () => {
	const f = setup()
	const data = directory(6)
	data.entries[0].originalMetadata = { track: { name: '仅曲名翻唱' } }
	data.entries[1].originalMetadata = { track: { ar: [{ name: '仅表演者' }] } }
	f.store.createDirectory(data)
	for (const [i, state] of [
		'not-found',
		'unreadable',
		'needs-review',
	].entries()) {
		const current = f.store.get('task')!
		f.store.review(
			'task',
			`e${i + 2}`,
			{
				review: {
					state: state as 'not-found' | 'unreadable' | 'needs-review',
					candidates: [],
					confirmation: null,
				},
			},
			current.revision,
		)
	}
	f.session.openTask('task')
	const before = f.store.get('task')!.entries.slice(0, 5)
	await f.session.findBatchCandidates()
	assert.deepEqual(f.store.get('task')!.entries.slice(0, 5), before)
	assert.equal(f.session.getSnapshot().batch?.skipped, 5)
	assert.equal(f.session.getSnapshot().batch?.completed, 1)
	f.session.openEntry('e0')
	f.session.createOriginalQueryAction()()
	assert.equal(f.session.getSnapshot().query, '仅曲名翻唱')
	f.raw.close()
})

void test('empty first page is marked reviewed, never not-found and never repeatedly requested', async () => {
	const f = setup()
	openTask(f, 2)
	let calls = 0
	f.ports.search = async () => {
		calls++
		return { items: [], more: true }
	}
	await f.session.findBatchCandidates()
	assert.equal(f.session.getSnapshot().batch?.empty, 2)
	await f.session.findBatchCandidates()
	assert.equal(calls, 2)
	assert.ok(
		f.store
			.get('task')!
			.entries.every((entry) => entry.review.state === 'needs-review'),
	)
	f.session.openEntry('e0')
	f.session.setQuery('人工补充版本')
	await f.session.searchCandidates()
	assert.equal(calls, 3)
	f.raw.close()
})

void test('batch failure stops immediately and keeps earlier persisted candidates for explicit retry', async () => {
	const f = setup()
	openTask(f)
	let calls = 0
	f.ports.search = async () => {
		if (++calls === 2) throw new Error('synthetic network failure')
		return { items: [item], more: false }
	}
	assert.equal(await f.session.findBatchCandidates(), false)
	assert.equal(calls, 2)
	assert.equal(f.session.getSnapshot().batch?.phase, 'failed')
	assert.equal(f.session.getSnapshot().batch?.completed, 1)
	assert.equal(f.store.get('task')!.entries[0].review.candidates.length, 1)
	assert.equal(f.store.get('task')!.entries[1].review.state, 'pending')
	await f.session.findBatchCandidates()
	assert.equal(calls, 4)
	f.raw.close()
})

void test('pause, close, back, entry navigation and task switch discard late batch results', async () => {
	for (const stop of [
		'pauseBatch',
		'close',
		'back',
		'openEntry',
		'openTask',
	] as const) {
		const f = setup()
		openTask(f, 2)
		const pending = deferred<{ items: SearchItem[]; more: boolean }>()
		let signal: AbortSignal | undefined
		f.ports.search = async (_, __, nextSignal) => {
			signal = nextSignal
			return pending.promise
		}
		const run = f.session.findBatchCandidates()
		if (stop === 'openEntry') f.session.openEntry('e1')
		else if (stop === 'openTask') f.session.openTask('task')
		else f.session[stop]()
		assert.equal(signal?.aborted, true)
		assert.equal(await run, false)
		pending.resolve({ items: [item], more: false })
		await Promise.resolve()
		assert.ok(
			f.store
				.get('task')!
				.entries.every((entry) => entry.review.state === 'pending'),
		)
		f.raw.close()
	}
})

void test('concurrent manual review while search pending wins and stale result cannot persist', async () => {
	const f = setup()
	openTask(f)
	const pending = deferred<{ items: SearchItem[]; more: boolean }>()
	f.ports.search = () => pending.promise
	const run = f.session.findBatchCandidates()
	const task = f.store.get('task')!
	const manual = f.store.review(
		'task',
		'e0',
		{ review: { state: 'not-found', candidates: [], confirmation: null } },
		task.revision,
	)
	pending.resolve({ items: [item], more: false })
	assert.equal(await run, false)
	assert.deepEqual(f.store.get('task'), manual)
	assert.equal(f.session.getSnapshot().batch?.phase, 'failed')
	f.raw.close()
})

void test('batch ignores double click and caps per-entry candidates using store limit', async () => {
	const f = setup()
	openTask(f, 1)
	const pending = deferred<{ items: SearchItem[]; more: boolean }>()
	let calls = 0
	f.ports.search = () => {
		calls++
		return pending.promise
	}
	const run = f.session.findBatchCandidates()
	assert.equal(await f.session.findBatchCandidates(), false)
	pending.resolve({
		items: Array.from({ length: 25 }, (_, index) => ({
			...item,
			bvid: `BV${String(index).padStart(10, '0')}`,
		})),
		more: true,
	})
	assert.equal(await run, true)
	assert.equal(calls, 1)
	assert.equal(f.store.get('task')!.entries[0].review.candidates.length, 20)
	f.raw.close()
})

void test('batch cancellation settles even when transport ignores abort and preserves pending occurrence', async () => {
	const f = setup()
	openTask(f, 1)
	f.ports.search = () => new Promise(() => {})
	const run = f.session.findBatchCandidates()
	f.session.pauseBatch()
	assert.equal(await run, false)
	assert.equal(f.store.get('task')!.entries[0].review.state, 'pending')
	f.raw.close()
})

void test('batch deadline stops a hung transport without retries or late writes', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const f = setup()
	openTask(f, 2)
	const pending = deferred<{ items: SearchItem[]; more: boolean }>()
	let calls = 0
	let signal: AbortSignal | undefined
	f.ports.search = (_, page, nextSignal, reread) => {
		calls++
		signal = nextSignal
		assert.equal(page, 1)
		assert.equal(reread, false)
		return pending.promise
	}
	const run = f.session.findBatchCandidates()
	t.mock.timers.tick(importBatchBudget.timeoutMs)
	assert.equal(await run, false)
	assert.equal(calls, 1)
	assert.equal(signal?.aborted, true)
	assert.equal(f.session.getSnapshot().batch?.phase, 'failed')
	pending.resolve({ items: [item], more: false })
	await Promise.resolve()
	assert.ok(
		f.store
			.get('task')!
			.entries.every((entry) => entry.review.state === 'pending'),
	)
	f.raw.close()
})

void test('batch candidates and empty markers survive SQLite close/reopen without auto-search', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'melo-batch-'))
	try {
		const file = join(dir, 'library.db')
		const f = setup(file)
		openTask(f, 2)
		let calls = 0
		f.ports.search = async () => ({
			items: ++calls === 1 ? [item] : [],
			more: false,
		})
		await f.session.findBatchCandidates()
		const saved = f.store.get('task')
		f.session.close()
		f.raw.close()
		const reopened = setup(file)
		reopened.session.openTask('task')
		assert.deepEqual(reopened.store.get('task'), saved)
		reopened.ports.search = async () => {
			throw new Error('must not query already searched entries')
		}
		assert.equal(await reopened.session.findBatchCandidates(), true)
		assert.equal(reopened.session.getSnapshot().batch?.budget, 0)
		reopened.raw.close()
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

void test('batch leaves an explicitly confirmed version and saved source untouched', async () => {
	const f = setup()
	openTask(f)
	await select(f, 'e0')
	assert.equal(f.session.confirmCandidate(), true)
	const confirmed = f.store.get('task')!.entries[0]
	const saved = f.library.get(confirmed.review.confirmation!.sourceId)
	f.session.back()
	await f.session.findBatchCandidates()
	assert.deepEqual(f.store.get('task')!.entries[0], confirmed)
	assert.deepEqual(
		f.library.get(confirmed.review.confirmation!.sourceId),
		saved,
	)
	assert.equal(f.session.getSnapshot().batch?.completed, 2)
	f.raw.close()
})

void test('actual useImports background listener cancels batch and unmount removes listener', async () => {
	const f = setup()
	openTask(f, 1)
	const pending = deferred<{ items: SearchItem[]; more: boolean }>()
	f.ports.search = () => pending.promise
	let onAppState: ((value: string) => void) | undefined
	let cleanup: (() => void) | undefined
	let removed = false
	const bridgeArguments: unknown[][] = [],
		transportFetchers: unknown[] = []
	const unexpectedFetches: string[] = [],
		accountListeners = new Set<() => void>()
	const access = { onlineAllowed: true, sessionGeneration: 1 }
	const fetchDirectory = async () => {
		unexpectedFetches.push('raw')
		throw new Error('background-listener test must not fetch a directory')
	}
	const guardedFetch = async () => {
		unexpectedFetches.push('guarded')
		throw new Error('background-listener test must not issue a guarded request')
	}
	const getAccess = () => access
	const subscribeAccount = (listener: () => void) => {
		accountListeners.add(listener)
		return () => {
			accountListeners.delete(listener)
		}
	}
	const exports = {} as typeof import('../useImports')
	runInNewContext(
		ts.transpileModule(
			readFileSync(new URL('../useImports.ts', import.meta.url), 'utf8'),
			{
				compilerOptions: { module: ts.ModuleKind.CommonJS },
			},
		).outputText,
		{
			exports,
			require: (name: string) => {
				if (name === 'react')
					return {
						useMemo: (make: () => unknown) => make(),
						useSyncExternalStore: () => f.session.getSnapshot(),
						useEffect: (effect: () => () => void) => {
							cleanup = effect()
						},
					}
				if (name === 'react-native')
					return {
						AppState: {
							addEventListener: (
								_: string,
								listener: (value: string) => void,
							) => {
								onAppState = listener
								return {
									remove: () => {
										removed = true
									},
								}
							},
						},
					}
				if (name === './import-session')
					return {
						ImportSession: function () {
							return f.session
						},
					}
				if (name === './external-directory-transport')
					return {
						createExternalDirectoryTransport: (fetcher: unknown) => {
							transportFetchers.push(fetcher)
							return {}
						},
					}
				if (name === 'expo/fetch') return { fetch: fetchDirectory }
				if (name === './account-access') return { getAccountAccess: getAccess }
				if (name === './account-runtime')
					return { accountSession: { subscribe: subscribeAccount } }
				if (name === './account-directory-fetch')
					return {
						createAccountDirectoryFetch: (...args: unknown[]) => {
							bridgeArguments.push(args)
							return guardedFetch
						},
					}
				if (name === './import-directory-reader')
					return { createImportDirectoryReader: () => ({}) }
				return {}
			},
		},
	)
	exports.useImports(f.store, f.library, f.playlists)
	assert.deepEqual(bridgeArguments, [
		[fetchDirectory, getAccess, subscribeAccount],
	])
	assert.deepEqual(
		transportFetchers,
		[guardedFetch],
		'directory transport receives the account-guarded fetcher',
	)
	const run = f.session.findBatchCandidates()
	onAppState!('background')
	assert.equal(await run, false)
	pending.resolve({ items: [item], more: false })
	await Promise.resolve()
	assert.equal(f.store.get('task')!.entries[0].review.state, 'pending')
	assert.equal(f.session.getSnapshot().batch?.phase, 'paused')
	cleanup!()
	assert.equal(removed, true)
	assert.equal(f.session.getSnapshot().route, 'closed')
	assert.deepEqual(unexpectedFetches, [])
	assert.equal(accountListeners.size, 0)
	f.raw.close()
})

void test('review filter is local, keeps occurrence selection, restores per task and clamps after review', async () => {
	const f = setup()
	try {
		openTask(f, 21)
		let requests = 0
		f.ports.search = async () => {
			requests++
			return { items: [], more: false }
		}
		const before = f.store.get('task')!
		f.session.createTaskFilterAction()('pending')
		f.session.setTaskPage(1)
		f.session.openEntry('e20')
		f.session.setQuery('原曲 Live 翻唱')
		await f.session.searchCandidates()
		assert.equal(f.session.markNotFound(), true)
		f.session.back()
		assert.equal(f.session.getSnapshot().taskFilter, 'pending')
		assert.equal(f.session.getSnapshot().taskPage, 0)
		assert.equal(f.session.scrollOffset('task:task:'), 0)
		assert.deepEqual(
			f.store.get('task')!.entries.map((e) => e.selected),
			before.entries.map((e) => e.selected),
		)
		const stale = f.session.createTaskFilterAction()
		f.store.createDirectory({ ...directory(), taskId: 'other', taskVersion: 2 })
		f.session.openTask('other')
		assert.equal(stale('confirmed'), false)
		assert.equal(f.session.getSnapshot().taskFilter, 'all')
		f.session.openTask('task')
		assert.equal(f.session.getSnapshot().taskFilter, 'pending')
		const revision = f.store.get('task')!.revision
		f.session.createTaskFilterAction()('unreadable')
		assert.equal(f.session.getSnapshot().taskPage, 0)
		assert.equal(f.store.get('task')!.revision, revision)
		assert.equal(requests, 1)
		const closed = f.session.createTaskFilterAction()
		f.session.close()
		assert.equal(closed('all'), false)
	} finally {
		f.raw.close()
	}
})

void test('original video opens explicitly chosen part only; unselected video stays at root without inferring CID', async () => {
	const f = setup(),
		urls: string[] = []
	try {
		openTask(f)
		f.session.openEntry('e0')
		await f.session.readVideo(bv)
		const before = JSON.stringify(f.store.get('task'))
		await f.session.createOriginalVideoAction(bv, async (url) => {
			urls.push(url)
		})()
		assert.deepEqual(urls, [`https://www.bilibili.com/video/${bv}`])
		assert.equal(f.session.getSnapshot().selectedCid, null)
		assert.equal(JSON.stringify(f.store.get('task')), before)
		f.session.selectCid(2)
		const selected = JSON.stringify(f.store.get('task'))
		const oldPress = f.session.createOriginalVideoAction(bv, async (url) => {
			urls.push(url)
		})
		await oldPress()
		assert.equal(urls.at(-1), `https://www.bilibili.com/video/${bv}?p=2`)
		assert.equal(JSON.stringify(f.store.get('task')), selected)
		assert.equal(f.store.get('task')!.entries[0].review.confirmation, null)
		f.session.selectCid(1)
		await oldPress()
		assert.equal(
			urls.length,
			2,
			'a stale rendered part action must not open another part',
		)
		await f.session.createOriginalVideoAction(bv, async (url) => {
			urls.push(url)
		})()
		assert.equal(urls.at(-1), `https://www.bilibili.com/video/${bv}?p=1`)
		assert.equal(f.store.get('task')!.entries[0].review.confirmation, null)
	} finally {
		f.raw.close()
	}
})
