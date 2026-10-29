import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { migrate, type Database } from '../core/database'
import type { SearchItem } from '../core/model'
import {
	emptyMusicPreferences,
	MusicPreferencesStore,
	musicPreferencesKey,
	parseMusicPreferences,
	preferenceSeeds,
} from '../core/music-preferences'
import { PreferenceDiscoverySession } from '../preference-discovery-session'

const prefs = {
	...emptyMusicPreferences(),
	artists: ['测试歌手甲', '测试歌手乙'],
	genres: ['爵士', '民谣'],
	welcomeCompleted: true,
}
const item = (id: string, category = '翻唱'): SearchItem => ({
	bvid: id,
	originalTitle: '合成测试内容',
	uploader: '合成上传者',
	uploaderId: 10,
	artwork: '',
	duration: 120,
	category,
})
function fixture() {
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
	return { raw, db, store: new MusicPreferencesStore(db) }
}
void test('local preferences roundtrip, skipped welcome, and invalid records preserve original bytes', () => {
	const f = fixture()
	assert.equal(f.store.load().welcomeCompleted, false)
	f.store.save({ ...emptyMusicPreferences(), welcomeCompleted: true })
	assert.equal(new MusicPreferencesStore(f.db).load().welcomeCompleted, true)
	f.store.save(prefs)
	assert.deepEqual(f.store.load(), prefs)
	assert.deepEqual(preferenceSeeds(prefs), [
		'测试歌手甲',
		'测试歌手乙',
		'爵士',
		'民谣',
	])
	for (const data of [
		{ ...prefs, version: 2 },
		{ ...prefs, artists: ['x', 'x'] },
		{ ...prefs, genres: [' '] },
		{ ...prefs, artists: Array(9).fill('a') },
		{ ...prefs, artists: ['x\n'] },
	])
		assert.throws(() => parseMusicPreferences(JSON.stringify(data)))
	f.db.runSync('UPDATE settings SET value=? WHERE key=?', [
		'broken',
		musicPreferencesKey,
	])
	assert.throws(() => f.store.save(prefs))
	assert.equal(
		f.db.getFirstSync<{ value: string }>(
			'SELECT value FROM settings WHERE key=?',
			[musicPreferencesKey],
		)?.value,
		'broken',
	)
	f.raw.close()
})
void test('explicit recall uses saved seeds, is bounded, filters music categories and deduplicates BV', async () => {
	const calls: string[] = []
	const session = new PreferenceDiscoverySession(
		async (seed, page, signal, order) => {
			calls.push(seed)
			assert.equal(page, 1)
			assert.equal(order, 'relevance')
			assert.equal(signal?.aborted, false)
			return {
				items: [item('BV1vT411i7ET'), item('BV1Z9pb6MEwT', '知识')],
				more: true,
			}
		},
	)
	assert.equal(calls.length, 0)
	await session.load(prefs)
	assert.deepEqual(calls, ['测试歌手甲', '测试歌手乙', '爵士'])
	assert.equal(session.getSnapshot().items.length, 1)
	assert.equal(session.getSnapshot().items[0].seed, '测试歌手甲')
	assert.equal(session.getSnapshot().loading, false)
})
void test('cancellation and replacement cannot publish late results', async () => {
	let resolve!: (value: { items: SearchItem[]; more: boolean }) => void
	const session = new PreferenceDiscoverySession(
		() =>
			new Promise((done) => {
				resolve = done
			}),
	)
	const request = session.load({ ...prefs, artists: ['测试甲'], genres: [] })
	session.reset()
	resolve({ items: [item('BV1vT411i7ET')], more: false })
	await request
	assert.deepEqual(session.getSnapshot(), {
		items: [],
		loading: false,
		error: '',
		searched: false,
		pendingSeeds: [],
	})
})
void test('partial failure keeps useful results and permits retry; empty preferences never fetch', async () => {
	let count = 0
	const session = new PreferenceDiscoverySession(async () => {
		count++
		if (count === 1) throw new Error('synthetic offline')
		return { items: [item('BV1vT411i7ET')], more: false }
	})
	await session.load(emptyMusicPreferences())
	assert.equal(count, 0)
	await session.load(prefs)
	assert.equal(session.getSnapshot().items.length, 1)
	assert.match(session.getSnapshot().error, /测试歌手甲/)
	await session.load(prefs)
	assert.equal(session.getSnapshot().error, '')
})

void test('restore invalidates older editor snapshots and prevents stale preference overwrite', () => {
	const f = fixture()
	const opened = f.store.load()
	const restored = { ...prefs, artists: ['恢复后的合成歌手'] }
	f.store.save(restored)
	assert.throws(
		() =>
			f.store.save(
				{ ...opened, welcomeCompleted: true, genres: ['摇滚'] },
				opened,
			),
		/已更新/,
	)
	assert.deepEqual(f.store.load(), restored)
	f.store.save({ ...restored, genres: ['古典'] }, restored)
	assert.deepEqual(f.store.load().genres, ['古典'])
	f.raw.close()
})

void test('explicit retry requests only failed seeds, deduplicates BV and preserves version titles', async () => {
	const calls: string[] = []
	let failed = true
	const cover = { ...item('cover'), originalTitle: '同一首歌 翻唱 Live' }
	const session = new PreferenceDiscoverySession(async (seed) => {
		calls.push(seed)
		if (seed === '测试歌手乙' && failed) throw new Error('offline')
		return {
			items: seed === '测试歌手乙' ? [cover, item('live')] : [cover],
			more: true,
		}
	})
	await session.load(prefs)
	assert.equal(calls.length, 3)
	assert.deepEqual(session.getSnapshot().pendingSeeds, ['测试歌手乙'])
	assert.equal(
		session.getSnapshot().items[0].item.originalTitle,
		'同一首歌 翻唱 Live',
	)
	failed = false
	await session.retry()
	assert.deepEqual(calls, ['测试歌手甲', '测试歌手乙', '爵士', '测试歌手乙'])
	assert.deepEqual(
		session.getSnapshot().items.map(({ item: value }) => value.bvid),
		['cover', 'live'],
	)
	assert.equal(session.getSnapshot().error, '')
	assert.deepEqual(session.getSnapshot().pendingSeeds, [])
	await session.retry()
	assert.equal(calls.length, 4, 'no extra network or fourth preference seed')
})

void test('refresh failure retains candidates; successful empty results clear only their seed', async () => {
	let phase = 0
	const session = new PreferenceDiscoverySession(async (seed) => {
		if (phase === 1) throw new Error('offline')
		return {
			items: phase === 2 && seed === '测试歌手乙' ? [] : [item(seed)],
			more: false,
		}
	})
	await session.load(prefs)
	const saved = session.getSnapshot().items
	phase = 1
	const request = session.load(prefs)
	assert.deepEqual(session.getSnapshot().items, saved)
	await request
	assert.deepEqual(session.getSnapshot().items, saved)
	assert.equal(session.getSnapshot().pendingSeeds.length, 3)
	phase = 2
	await session.retry()
	assert.deepEqual(
		session.getSnapshot().items.map(({ seed }) => seed),
		['测试歌手甲', '爵士'],
	)
	assert.equal(session.getSnapshot().error, '')
	assert.deepEqual(session.getSnapshot().pendingSeeds, [])
})

void test('cancel retains completed results, explicitly resumes pending seeds and ignores late responses', async () => {
	let resolve!: (result: { items: SearchItem[]; more: boolean }) => void
	const calls: string[] = []
	const session = new PreferenceDiscoverySession(async (seed) => {
		calls.push(seed)
		if (calls.length === 2)
			return new Promise((done) => {
				resolve = done
			})
		return { items: [item(seed)], more: false }
	})
	const request = session.load(prefs)
	await new Promise((done) => setImmediate(done))
	session.cancel()
	assert.equal(calls.length, 2)
	assert.equal(session.getSnapshot().items.length, 1)
	assert.deepEqual(session.getSnapshot().pendingSeeds, ['测试歌手乙', '爵士'])
	await session.retry()
	resolve({ items: [item('stale')], more: false })
	await request
	assert.deepEqual(calls, ['测试歌手甲', '测试歌手乙', '测试歌手乙', '爵士'])
	assert.deepEqual(
		session.getSnapshot().items.map(({ item: value }) => value.bvid),
		['测试歌手甲', '测试歌手乙', '爵士'],
	)
})

void test('reset and changed preferences discard pending seeds and reject late retry writes', async () => {
	let resolve!: (result: { items: SearchItem[]; more: boolean }) => void
	let waiting = false
	const calls: string[] = []
	const session = new PreferenceDiscoverySession(async (seed) => {
		calls.push(seed)
		if (waiting)
			return new Promise((done) => {
				resolve = done
			})
		if (seed !== '新偏好 翻唱') throw new Error('offline')
		return { items: [item('new')], more: false }
	})
	await session.load(prefs)
	waiting = true
	const retry = session.retry()
	session.reset()
	await session.retry()
	assert.equal(calls.length, 4)
	waiting = false
	await session.load({ ...prefs, artists: ['新偏好 翻唱'], genres: [] })
	resolve({ items: [item('stale')], more: false })
	await retry
	assert.deepEqual(session.getSnapshot().pendingSeeds, [])
	assert.deepEqual(
		session.getSnapshot().items.map(({ seed }) => seed),
		['新偏好 翻唱'],
	)
})

void test('query evidence and acquisition times survive failed refresh and shrink on successful empty retry', async () => {
	let phase = 0
	const session = new PreferenceDiscoverySession(async (seed) => {
		if (phase === 1) throw new Error('offline')
		return {
			items: phase === 2 && seed === '测试歌手甲' ? [] : [item('shared')],
			more: false,
		}
	})
	await session.load(prefs)
	const original = session.getSnapshot().items[0]
	assert.deepEqual(
		original.hits.map((hit) => hit.seed),
		['测试歌手甲', '测试歌手乙', '爵士'],
	)
	assert.ok(original.retrievedAt > 0)
	phase = 1
	await session.load(prefs)
	assert.deepEqual(session.getSnapshot().items[0], original)
	phase = 2
	await session.retry()
	const next = session.getSnapshot().items[0]
	assert.deepEqual(
		next.hits.map((hit) => hit.seed),
		['测试歌手乙', '爵士'],
	)
	assert.equal(next.seed, '测试歌手乙')
	assert.equal(next.retrievedAt, next.hits[0].retrievedAt)
	assert.equal(session.getSnapshot().items.length, 1)
})
