import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import {
	bilibiliFavoriteLimits,
	readBilibiliFavoritePage,
} from '../bilibili-favorite'
import { BilibiliFavoriteCollectionSession } from '../bilibili-favorite-collection'
import { migrate, type Database } from '../core/database'
import { directory } from '../core/import-validation'
import { ImportStore } from '../core/imports'
import { originalVideoBvid } from '../core/import-mixed-validation'

const identity = { favoriteId: '123', taskId: 'task-favorite', taskVersion: 1 }
const encode = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value))
const media = (id: number | string, overrides = {}) => ({
	id,
	type: 2,
	bvid: 'BV1vT411i7ET',
	title: '原视频',
	attr: 0,
	upper: { mid: '900719925474099312345', name: '原UP' },
	...overrides,
})
function response(
	page = 1,
	total = 41,
	options: {
		favoriteId?: string
		items?: ReturnType<typeof media>[]
		header?: string
	} = {},
) {
	const length = Math.min(40, Math.max(0, total - (page - 1) * 40))
	return {
		code: 0,
		customEnvelope: { page },
		data: {
			info: {
				id: options.favoriteId ?? '123',
				title: '原收藏夹',
				media_count: total,
				description: options.header ?? '',
			},
			medias:
				options.items ??
				Array.from({ length }, (_, index) =>
					media((page - 1) * 40 + index + 1),
				),
			has_more: page * 40 < total,
			customData: { original: page },
		},
	}
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

void test('clear忘记私有页和身份但不释放未结算raw读取，晚响应不能恢复页面', async () => {
	const slow = deferred<Uint8Array>()
	const session = new BilibiliFavoriteCollectionSession(() => slow.promise)
	const reading = session.start(identity)
	await tick()
	session.clear()
	assert.equal(session.getSnapshot().identity, null)
	assert.deepEqual(session.getSnapshot().pages, [])
	assert.equal(session.getSnapshot().directory, null)
	assert.equal(session.getSnapshot().transportBusy, true)
	assert.equal(await session.next(), false)
	slow.resolve(encode(response()))
	assert.equal(await reading, false)
	await tick()
	assert.equal(session.getSnapshot().transportBusy, false)
	assert.equal(session.getSnapshot().identity, null)
	assert.deepEqual(session.getSnapshot().pages, [])
})

void test('explicit pages preserve repeated, invalid and unknown occurrences and every raw header', async () => {
	const calls: number[] = []
	const first = response()
	first.data.medias[0] = media('900719925474099312345', {
		attr: 9,
		bvid: '',
		title: '已失效视频',
		custom: ['原信息'],
	})
	first.data.medias[1] = media(2, { type: 12, bvid: '', title: '非视频内容' })
	first.data.medias[2] = media(3, { type: 9999, bvid: '', title: '未知类型' })
	const last = response(2, 41, { items: [first.data.medias[0]] })
	const session = new BilibiliFavoriteCollectionSession(async ({ page }) => {
		calls.push(page)
		return encode(page === 1 ? first : last)
	})
	assert.equal(await session.start(identity), true)
	assert.deepEqual(calls, [1])
	assert.equal(session.getSnapshot().phase, 'partial')
	assert.equal(session.getSnapshot().directory, null)
	assert.equal(session.getSnapshot().loadedCount, 40)
	assert.equal(await session.next(), true)
	const state = session.getSnapshot(),
		snapshot = state.directory!
	assert.deepEqual(calls, [1, 2])
	assert.equal(state.phase, 'complete')
	assert.equal(snapshot.entries.length, 41)
	assert.equal(
		snapshot.entries[0].originalEntryId,
		snapshot.entries[40].originalEntryId,
	)
	assert.notEqual(snapshot.entries[0].entryId, snapshot.entries[40].entryId)
	assert.deepEqual(
		snapshot.entries.map((entry) => entry.originalPosition),
		Array.from({ length: 41 }, (_, i) => i),
	)
	assert.deepEqual(
		snapshot.entries[40].originalMetadata.media,
		first.data.medias[0],
	)
	assert.equal(snapshot.originalMetadata.positionBasis, 'observed-page-order')
	const headers = snapshot.originalMetadata.pages as Record<string, unknown>[]
	assert.deepEqual(headers[0].info, first.data.info)
	assert.deepEqual(headers[1].originalEnvelope, {
		code: 0,
		customEnvelope: { page: 2 },
	})
	assert.deepEqual(headers[1].originalData, {
		has_more: false,
		customData: { original: 2 },
	})
	assert.deepEqual(directory(snapshot).snapshot, snapshot)
	assert.equal(await session.next(), false)
	assert.deepEqual(calls, [1, 2])
	assert.equal(Reflect.set(state.pages[0].info, 'title', '篡改'), false)
	assert.equal(state.pages[0].info.title, '原收藏夹')
})

void test('only page one total zero is a complete empty directory; nothing autoloads', async () => {
	let calls = 0
	const session = new BilibiliFavoriteCollectionSession(async () => {
		calls++
		return encode(response(1, 0))
	})
	assert.equal(await session.next(), false)
	assert.equal(calls, 0)
	assert.equal(await session.start(identity), true)
	assert.equal(session.getSnapshot().directory!.entries.length, 0)
	assert.equal(session.getSnapshot().phase, 'complete')
	assert.equal(await session.next(), false)
	assert.equal(calls, 1)
})

void test('changed total requires restart, retains accepted page and bounded rejected-page evidence', async () => {
	let calls = 0
	const session = new BilibiliFavoriteCollectionSession(async ({ page }) => {
		calls++
		return encode(response(page, page === 1 ? 41 : 42))
	})
	await session.start(identity)
	assert.equal(await session.next(), false)
	const state = session.getSnapshot()
	assert.equal(state.restartRequired, true)
	assert.equal(state.error!.code, 'incomplete')
	assert.equal(
		Array.isArray(state.error!.details!.partial!.originalData.medias),
		true,
	)
	assert.equal(state.pages.length, 1)
	assert.equal(state.directory, null)
	assert.equal(await session.next(), false)
	assert.equal(calls, 2)
	assert.equal(await session.start({ ...identity, taskVersion: 2 }), true)
	assert.equal(session.getSnapshot().pages.length, 1)
	assert.equal(session.getSnapshot().restartRequired, false)
})

void test('wrong favorite identity and contradictory page count require restart rather than stitching', async () => {
	for (const bad of [
		response(2, 41, { favoriteId: '456' }),
		response(2, 41, { items: [] }),
	]) {
		const session = new BilibiliFavoriteCollectionSession(async ({ page }) =>
			encode(page === 1 ? response() : bad),
		)
		await session.start(identity)
		assert.equal(await session.next(), false)
		assert.equal(session.getSnapshot().restartRequired, true)
		assert.equal(session.getSnapshot().pages.length, 1)
		assert.equal(session.getSnapshot().directory, null)
		assert.equal(await session.next(), false)
	}
})

void test('ordinary failures can explicitly retry same page; invalid start retains previous valid session', async () => {
	const calls: number[] = []
	let fail = true
	const session = new BilibiliFavoriteCollectionSession(async ({ page }) => {
		calls.push(page)
		if (page === 2 && fail) {
			fail = false
			throw new Error('offline')
		}
		return encode(response(page))
	})
	await session.start(identity)
	assert.equal(await session.next(), false)
	assert.equal(session.getSnapshot().error!.code, 'network')
	assert.equal(session.getSnapshot().restartRequired, false)
	assert.equal(session.getSnapshot().pages.length, 1)
	assert.equal(await session.start({ ...identity, favoriteId: '00123' }), false)
	assert.equal(session.getSnapshot().identity!.favoriteId, '123')
	assert.equal(session.getSnapshot().pages.length, 1)
	assert.equal(await session.next(), true)
	assert.deepEqual(calls, [1, 2, 2])
})

void test('cancel releases waiter but not real transport gate; late success cannot populate a new task', async () => {
	const slow = deferred<Uint8Array>()
	let calls = 0
	const session = new BilibiliFavoriteCollectionSession(
		async ({ favoriteId }) => {
			calls++
			return calls === 1 ? slow.promise : encode(response(1, 1, { favoriteId }))
		},
	)
	const pending = session.start(identity)
	await tick()
	session.cancel()
	assert.equal(await pending, false)
	assert.equal(session.getSnapshot().loading, false)
	assert.equal(session.getSnapshot().transportBusy, true)
	assert.equal(
		await session.start({ ...identity, favoriteId: '456', taskVersion: 2 }),
		false,
	)
	assert.equal(await session.next(), false)
	assert.equal(calls, 1)
	slow.resolve(encode(response()))
	await tick()
	assert.equal(session.getSnapshot().pages.length, 0)
	assert.equal(session.getSnapshot().transportBusy, false)
	assert.equal(
		await session.start({ ...identity, favoriteId: '456', taskVersion: 2 }),
		true,
	)
	assert.equal(session.getSnapshot().identity!.favoriteId, '456')
	assert.equal(session.getSnapshot().directory!.entries.length, 1)
	assert.equal(calls, 2)
})

void test('cancelled next page keeps prior page; late rejection drains without an unhandled failure', async () => {
	const slow = deferred<Uint8Array>()
	let calls = 0
	const session = new BilibiliFavoriteCollectionSession(async ({ page }) => {
		calls++
		return calls === 2 ? slow.promise : encode(response(page))
	})
	await session.start(identity)
	const pending = session.next()
	await tick()
	session.cancel()
	assert.equal(await pending, false)
	assert.equal(session.getSnapshot().pages.length, 1)
	slow.reject(new Error('late failure'))
	await tick()
	assert.equal(session.getSnapshot().phase, 'cancelled')
	assert.equal(session.getSnapshot().error, null)
	assert.equal(await session.next(), true)
	assert.equal(session.getSnapshot().directory!.entries.length, 41)
})

void test('timeout also keeps raw gate until settlement, then explicit next retries same first page', async (context) => {
	context.mock.timers.enable({ apis: ['setTimeout'] })
	try {
		const slow = deferred<Uint8Array>()
		let calls = 0
		const session = new BilibiliFavoriteCollectionSession(async () =>
			++calls === 1 ? slow.promise : encode(response(1, 0)),
		)
		const pending = session.start(identity)
		await tick()
		context.mock.timers.tick(bilibiliFavoriteLimits.timeoutMs)
		assert.equal(await pending, false)
		assert.equal(session.getSnapshot().error!.code, 'timeout')
		assert.equal(session.getSnapshot().transportBusy, true)
		assert.equal(await session.next(), false)
		slow.resolve(encode(response()))
		await tick()
		assert.equal(session.getSnapshot().pages.length, 0)
		assert.equal(await session.next(), true)
		assert.equal(calls, 2)
	} finally {
		context.mock.timers.reset()
	}
})

void test('busy repeated actions and reentrant listeners never admit a second transport', async () => {
	const slow = deferred<Uint8Array>()
	let calls = 0,
		notified = false
	const session = new BilibiliFavoriteCollectionSession(async () => {
		calls++
		return slow.promise
	})
	session.subscribe(() => {
		if (!notified && session.getSnapshot().loading) {
			notified = true
			void session.next()
		}
	})
	const pending = session.start(identity)
	await tick()
	assert.equal(await session.start(identity), false)
	assert.equal(await session.next(), false)
	assert.equal(calls, 1)
	slow.resolve(encode(response(1, 0)))
	assert.equal(await pending, true)
})

void test('cumulative raw page headers cannot exceed 1MiB and old accepted state survives', async () => {
	const session = new BilibiliFavoriteCollectionSession(async ({ page }) =>
		encode(response(page, 41, { header: 'h'.repeat(600_000) })),
	)
	await session.start(identity)
	const first = session.getSnapshot().pages[0]
	assert.equal(await session.next(), false)
	assert.equal(session.getSnapshot().error!.code, 'limit')
	assert.equal(session.getSnapshot().pages.length, 1)
	assert.equal(session.getSnapshot().pages[0], first)
	assert.equal(session.getSnapshot().loadedCount, 40)
	assert.equal(session.getSnapshot().directory, null)
})

void test('wrapped entry bytes and depth obey original ImportStore budgets with no field trimming', async () => {
	let deep: unknown = 0
	for (let i = 0; i < 7; i++) deep = { x: deep }
	for (const item of [
		media(1, { payload: 'x'.repeat(16_180) }),
		media(1, { deep }),
	]) {
		// The single-page contract accepts these; only the final persistence wrapper exceeds budget.
		await readBilibiliFavoritePage({ favoriteId: '123', page: 1 }, async () =>
			encode(response(1, 1, { items: [item] })),
		)
		const session = new BilibiliFavoriteCollectionSession(async () =>
			encode(response(1, 1, { items: [item] })),
		)
		assert.equal(await session.start(identity), false)
		assert.equal(session.getSnapshot().error!.code, 'limit')
		assert.equal(session.getSnapshot().pages.length, 0)
		assert.equal(session.getSnapshot().directory, null)
	}
})

void test('8MiB aggregate budget rejects new page without losing earlier occurrences', async () => {
	const session = new BilibiliFavoriteCollectionSession(async ({ page }) =>
		encode(
			response(page, 600, {
				items: Array.from({ length: 40 }, (_, index) =>
					media(page * 40 + index, { payload: 'x'.repeat(14_200) }),
				),
			}),
		),
	)
	assert.equal(await session.start(identity), true)
	let accepted = 1
	while (await session.next()) accepted++
	assert(accepted > 1 && accepted < 15)
	assert.equal(session.getSnapshot().error!.code, 'limit')
	assert.equal(session.getSnapshot().pages.length, accepted)
	assert.equal(session.getSnapshot().loadedCount, accepted * 40)
	assert.equal(session.getSnapshot().directory, null)
})

void test('complete output creates a real SQLite task and reopens with all original metadata intact', async () => {
	const folder = mkdtempSync(join(tmpdir(), 'melo-favorite-collection-'))
	const file = join(folder, 'imports.sqlite')
	function open() {
		const raw = new DatabaseSync(file)
		const db: Database = {
			execSync: (sql) => raw.exec(sql),
			runSync: (sql, values) => raw.prepare(sql).run(...values),
			getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
				raw.prepare(sql).all(...values) as T[],
			getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
				(raw.prepare(sql).get(...values) as T) ?? null,
		}
		return { raw, db, store: new ImportStore(db) }
	}
	try {
		const session = new BilibiliFavoriteCollectionSession(async ({ page }) =>
			encode(response(page)),
		)
		await session.start({ ...identity, taskId: 'x'.repeat(512) })
		await session.next()
		const snapshot = session.getSnapshot().directory!
		assert(snapshot)
		const first = open()
		migrate(first.db)
		const created = first.store.createDirectory(snapshot)
		first.raw.close()
		const second = open()
		try {
			const restored = second.store.createDirectory(snapshot)
			assert.deepEqual(restored, created)
			assert.deepEqual(restored.originalMetadata, snapshot.originalMetadata)
			assert.deepEqual(
				restored.entries.map((entry) => entry.originalMetadata),
				snapshot.entries.map((entry) => entry.originalMetadata),
			)
			assert.equal(restored.entries.length, 41)
		} finally {
			second.raw.close()
		}
	} finally {
		rmSync(folder, { recursive: true, force: true })
	}
})

void test('83真实索引按39/40/3详情保存全部原位置，缺详情不伪造可播BV，旧40宽任务原样可读', async () => {
	const index = Array.from({ length: 83 }, (_, i) => ({ id: i + 1, type: i === 1 ? 999 : 2, bvid: 'BV1vT411i7ET' }))
	const calls: string[] = []
	const session = new BilibiliFavoriteCollectionSession(async ({ page }) => {
		calls.push(`page:${page}`)
		const rows = index.slice((page - 1) * 40, page * 40)
			.filter((row) => row.id !== 8)
			.map((row) => media(row.id, { ...row, title: '原详情', attr: row.id === 2 ? 9 : 0 }))
		return encode(response(page, 83, { items: rows }))
	})
	assert.equal(await session.start(identity, async ({ favoriteId }) => {
		calls.push(`index:${favoriteId}`)
		return encode({ code: 0, extra: '原索引头', data: index })
	}), true)
	assert.deepEqual(calls, ['index:123', 'page:1'])
	assert.equal(session.getSnapshot().indexCount, 83)
	assert.equal(session.getSnapshot().loadedCount, 40)
	assert.equal(session.getSnapshot().missingDetailCount, 1)
	assert.equal(session.getSnapshot().pages[0].items.length, 39)
	assert.equal(session.getSnapshot().directory, null)
	assert.equal(await session.next(), true)
	assert.equal(session.getSnapshot().directory, null)
	assert.equal(await session.next(), true)
	assert.deepEqual(calls, ['index:123', 'page:1', 'page:2', 'page:3'])
	const snapshot = session.getSnapshot().directory!
	assert.equal(snapshot.entries.length, 83)
	assert.deepEqual(snapshot.entries.map((entry) => entry.originalPosition), Array.from({ length: 83 }, (_, i) => i))
	assert.equal(snapshot.entries[7].entryId, 'index:7')
	assert.equal(snapshot.entries[7].originalEntryId, '2:8')
	assert.equal(snapshot.entries[7].originalMetadata.detailState, 'not-returned')
	assert.deepEqual(snapshot.entries[7].originalMetadata.resourceIndex, index[7])
	assert(!('media' in snapshot.entries[7].originalMetadata))
	assert.equal(originalVideoBvid(snapshot.entries[7]), null)
	assert.equal(snapshot.entries[1].originalEntryId, '999:2')
	assert.equal((snapshot.entries[1].originalMetadata.media as { attr: number }).attr, 9)
	assert.equal(snapshot.originalMetadata.missingDetailCount, 1)
	assert.equal(snapshot.originalMetadata.observedCount, 83)
	assert.equal(snapshot.originalMetadata.completeness, 'complete')
	assert.equal(snapshot.originalMetadata.positionBasis, 'resource-index-order')
	const old = new BilibiliFavoriteCollectionSession(async ({ page }) => encode(response(page)))
	await old.start({ ...identity, taskId: 'legacy-40' })
	await old.next()
	const oldSnapshot = old.getSnapshot().directory!
	assert.equal(oldSnapshot.entries[40].originalPosition, 40)
	assert.equal((oldSnapshot.originalMetadata.pages as { pageSize: number }[])[0].pageSize, 40)
	const raw = new DatabaseSync(':memory:')
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) => raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) => (raw.prepare(sql).get(...values) as T) ?? null,
	}
	try {
		migrate(db)
		const store = new ImportStore(db)
		store.createDirectory(oldSnapshot)
		const saved = store.createDirectory({ ...snapshot, taskVersion: 2 })
		assert(saved.entries.every((entry) => !entry.selected && entry.review.state === 'pending'))
		const reopened = new ImportStore(db)
		assert.deepEqual(reopened.get('legacy-40')?.originalMetadata, oldSnapshot.originalMetadata)
		assert.equal(reopened.get('legacy-40')?.entries[40].originalPosition, 40)
		assert.deepEqual(reopened.get(snapshot.taskId)?.entries[7].originalMetadata, snapshot.entries[7].originalMetadata)
	} finally { raw.close() }
})

void test('index cancellation retains raw request gate and a late index cannot restore private data or start detail requests', async () => {
	const slow = deferred<Uint8Array>()
	let detailCalls = 0
	const session = new BilibiliFavoriteCollectionSession(async () => { detailCalls++; return encode(response()) })
	const reading = session.start(identity, () => slow.promise)
	await tick()
	session.clear()
	assert.equal(await reading, false)
	assert.equal(session.getSnapshot().transportBusy, true)
	assert.equal(session.getSnapshot().indexCount, null)
	assert.equal(await session.start(identity), false)
	slow.resolve(encode({ code: 0, data: [{ id: 1, type: 2 }] }))
	await tick()
	assert.equal(detailCalls, 0)
	assert.equal(session.getSnapshot().transportBusy, false)
	assert.equal(session.getSnapshot().indexCount, null)
	assert.equal(session.getSnapshot().directory, null)
})
