import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'

import {
	CreatorPostCache,
	type CreatorPostCacheResponse,
} from '../core/creator-post-cache'
import { CreatorStore, type CreatorScope } from '../core/creators'
import { Library, migrate, type Database } from '../core/database'
import { FollowingFeedStore } from '../core/following-feed'
import type { ContentKind } from '../core/import-mixed-types'
import type { ImportDirectorySnapshot } from '../core/import-types'
import { ImportStore } from '../core/imports'
import { sourceId } from '../core/model'
import type { CreatorPostCandidate } from '../creator-api'

const bv = (index: number) => `BV${index.toString(36).padStart(10, '0')}`
const post = (
	index: number,
	mid = '88',
	publishedAt = 100,
): CreatorPostCandidate => ({
	bvid: bv(index),
	title: `原投稿 ${index}`,
	artwork: 'https://i0.hdslb.com/local.jpg',
	duration: 123,
	publishedAt,
	queryCreatorMid: mid,
})
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
	migrate(db)
	return {
		raw,
		db,
		creators: new CreatorStore(db),
		cache: new CreatorPostCache(db),
		imports: new ImportStore(db),
		library: new Library(db),
		feed: new FollowingFeedStore(db),
	}
}
function fixture(t: TestContext) {
	const f = open()
	t.after(() => f.raw.close())
	return f
}
type Fixture = ReturnType<typeof open>
function follow(
	f: Fixture,
	mid = '88',
	scope: CreatorScope = 'all',
	profileId = 'local',
) {
	f.creators.saveCreator({
		source: 'bilibili',
		mid,
		name: `UP ${mid}`,
		fetchedAt: 0,
	})
	f.creators.follow({ profileId, creatorMid: mid, scope, origin: 'manual' })
}
function save(
	f: Fixture,
	items: CreatorPostCandidate[],
	mid = '88',
	fetchedAt = 100,
) {
	return f.cache.savePage(
		mid,
		{ items, page: 1, more: false, total: items.length },
		fetchedAt,
		f.cache.load(mid)?.revision ?? null,
	)
}
function classify(
	f: Fixture,
	taskId: string,
	kinds: { bvid: string | null; kind: ContentKind }[],
) {
	f.imports.createDirectory({
		taskId,
		provider: 'bilibili',
		originalPlaylistId: taskId,
		taskVersion: 1,
		originalMetadata: {},
		entries: kinds.map((value, index) => ({
			entryId: `e${index}`,
			originalEntryId: value.bvid,
			originalPosition: index,
			originalMetadata: {
				media: { bvid: value.bvid },
				observed: { bvid: value.bvid },
			},
		})),
	})
	for (const [index, value] of kinds.entries())
		f.imports.reviewContent(taskId, `e${index}`, { kind: value.kind }, index)
}
const ids = (f: ReturnType<FollowingFeedStore['load']>) =>
	f.items.map((item) => item.post.bvid)
function bytes(f: Fixture) {
	return f.raw
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all()
		.map((row) => [
			row.name,
			f.raw.prepare(`SELECT * FROM "${String(row.name)}" ORDER BY rowid`).all(),
		])
}

void test('no follows, uncached, successful empty and filtering empty have distinct read-only states', (t) => {
	const f = fixture(t)
	assert.equal(f.feed.load().status, 'no-subscriptions')
	follow(f)
	assert.equal(f.feed.load().status, 'uncached')
	assert.equal(f.feed.load().subscriptions[0].status, 'uncached')
	save(f, [])
	const empty = f.feed.load()
	assert.equal(empty.status, 'empty')
	assert.equal(empty.subscriptions[0].status, 'empty')
	assert.deepEqual(empty.subscriptions[0].cache?.pages, [
		{ page: 1, fetchedAt: 100, itemCount: 0 },
	])
	follow(f, '99')
	assert.equal(f.feed.load().status, 'partial-empty')
	assert.equal(f.feed.load().coverage.uncachedSubscriptions, 1)
	save(f, [post(1)])
	assert.equal(f.feed.load('local', 'music').status, 'filtered-empty')
	assert.equal(f.feed.load().items[0].contentScope, 'unknown')
	const before = bytes(f),
		commands: string[] = []
	const readOnly: Database = {
		...f.db,
		runSync: () => assert.fail('No writes'),
		execSync: (sql) => {
			commands.push(sql)
			assert.ok(['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql))
			f.db.execSync(sql)
		},
	}
	new FollowingFeedStore(readOnly).load()
	assert.deepEqual(commands, ['BEGIN', 'COMMIT'])
	assert.deepEqual(bytes(f), before)
})

void test('profiles are isolated; unfollow and scope edits affect the next read but retain cache/profile data', (t) => {
	const f = fixture(t)
	follow(f)
	follow(f, '99', 'all', 'other')
	save(f, [post(1)])
	save(f, [post(2, '99')], '99')
	assert.deepEqual(ids(f.feed.load()), [bv(1)])
	assert.deepEqual(ids(f.feed.load('other')), [bv(2)])
	f.creators.updateScope('local', '88', 'music')
	assert.equal(f.feed.load().status, 'filtered-empty')
	f.creators.unfollow('local', '88')
	assert.equal(f.feed.load().status, 'no-subscriptions')
	assert.ok(f.cache.load('88'))
	assert.ok(f.creators.getCreator('88'))
	assert.deepEqual(ids(f.feed.load('other')), [bv(2)])
})

void test('BV dedup preserves true query/page provenance and optional owner; real publication time drives stable ordering', (t) => {
	const f = fixture(t)
	follow(f)
	follow(f, '99')
	save(f, [post(1, '88', 300), post(2, '88', 200), post(3, '88', 200)])
	save(
		f,
		[{ ...post(1, '99', 100), title: '较新缓存的原标题', ownerMid: '777' }],
		'99',
		200,
	)
	const value = f.feed.load()
	assert.deepEqual(ids(value), [bv(2), bv(3), bv(1)])
	const duplicate = value.items[2]
	assert.equal(duplicate.post.title, '较新缓存的原标题')
	assert.equal(duplicate.post.ownerMid, '777')
	assert.deepEqual(
		duplicate.origins.map((origin) => [
			origin.subscription.creatorMid,
			origin.post.queryCreatorMid,
			origin.page,
			origin.fetchedAt,
		]),
		[
			['99', '99', 1, 200],
			['88', '88', 1, 100],
		],
	)
	assert.equal(duplicate.origins[1].post.ownerMid, undefined)
	assert.equal(value.items[0].post.ownerMid, undefined)
	assert.equal(f.raw.prepare('SELECT count(*) n FROM sources').get()!.n, 0)
	// Equal observation timestamps use canonical string mid/page, never query-as-owner.
	save(f, [post(1, '99', 300)], '99', 100)
	assert.equal(
		f.feed.load().items.find((item) => item.post.bvid === bv(1))!.post
			.queryCreatorMid,
		'88',
	)
})

void test('only current explicit original-BV Bili kinds qualify; no CID is required and musicCollection stays music', (t) => {
	const f = fixture(t)
	follow(f)
	save(
		f,
		Array.from({ length: 8 }, (_, i) => post(i + 1)),
	)
	classify(f, 'types', [
		{ bvid: bv(1), kind: 'song' },
		{ bvid: bv(2), kind: 'musicCollection' },
		{ bvid: bv(3), kind: 'audioDrama' },
		{ bvid: bv(4), kind: 'audiobook' },
		{ bvid: bv(5), kind: 'knowledge' },
		{ bvid: bv(6), kind: 'commentary' },
		{ bvid: bv(7), kind: 'other' },
		{ bvid: bv(8), kind: 'unknown' },
	])
	assert.deepEqual(ids(f.feed.load('local', 'music')), [bv(1), bv(2)])
	assert.deepEqual(ids(f.feed.load('local', 'listening')), [
		bv(3),
		bv(4),
		bv(5),
		bv(6),
		bv(7),
	])
	assert.equal(f.feed.load().items[7].contentScope, 'unknown')
	assert.equal(f.raw.prepare('SELECT count(*) n FROM sources').get()!.n, 0)
	assert.ok(
		f.imports
			.get('types')!
			.entries.every((entry) => entry.review.confirmation === null),
	)
})

void test('single-CID music and external mapping do not infer a BV-wide music/listening family', (t) => {
	const f = fixture(t)
	follow(f)
	const source = {
		id: sourceId(bv(1), 11),
		bvid: bv(1),
		cid: 11,
		originalTitle: '歌曲标题',
		uploader: '音乐UP',
		uploaderId: 88,
		performer: null,
		artwork: '',
		duration: 180,
		domain: 'music' as const,
		audioAvailability: 'unknown' as const,
	}
	f.library.save(source)
	f.imports.createDirectory({
		taskId: 'external',
		provider: 'netease',
		originalPlaylistId: 'external',
		taskVersion: 1,
		originalMetadata: {},
		entries: [
			{
				entryId: 'e',
				originalEntryId: '1',
				originalPosition: 0,
				originalMetadata: { name: '歌曲' },
			},
		],
	})
	f.imports.review(
		'external',
		'e',
		{
			review: {
				state: 'confirmed',
				candidates: [
					{
						candidateId: 'c',
						bvid: source.bvid,
						cid: 11,
						metadata: {},
						evidence: {},
					},
				],
				confirmation: { candidateId: 'c', sourceId: source.id },
			},
		},
		0,
	)
	classify(f, 'no-bv', [{ bvid: null, kind: 'song' }])
	save(f, [post(1), { ...post(2), title: '音乐合集 / 有声书 / song' }])
	assert.ok(
		f.feed.load().items.every((item) => item.contentScope === 'unknown'),
	)
	assert.equal(f.feed.load('local', 'music').status, 'filtered-empty')
	assert.equal(f.feed.load('local', 'listening').status, 'filtered-empty')
})

void test('conflicts/explicit unknown remain unknown; same-family kinds combine and current edits supersede old classification', (t) => {
	const f = fixture(t)
	follow(f)
	save(f, [post(1), post(2), post(3)])
	classify(f, 'first', [
		{ bvid: bv(1), kind: 'song' },
		{ bvid: bv(2), kind: 'song' },
		{ bvid: bv(3), kind: 'song' },
	])
	classify(f, 'second', [
		{ bvid: bv(1), kind: 'knowledge' },
		{ bvid: bv(2), kind: 'unknown' },
		{ bvid: bv(3), kind: 'musicCollection' },
	])
	assert.deepEqual(ids(f.feed.load('local', 'music')), [bv(3)])
	assert.deepEqual(
		f.feed.load().items.map((item) => item.contentScope),
		['unknown', 'unknown', 'music'],
	)
	f.imports.reviewContent('second', 'e0', { kind: 'musicCollection' }, 3)
	assert.deepEqual(ids(f.feed.load('local', 'music')), [bv(1), bv(3)])
	assert.deepEqual(f.feed.load().items[0].contentKinds, [
		'song',
		'musicCollection',
	])
})

void test('subscription scope and requested filter are both applied per provenance, without inventing a subscription source', (t) => {
	const f = fixture(t)
	follow(f)
	follow(f, '99', 'music')
	save(f, [post(1), post(2), post(3)])
	save(f, [post(1, '99'), post(2, '99'), post(3, '99')], '99')
	classify(f, 'mixed', [
		{ bvid: bv(1), kind: 'song' },
		{ bvid: bv(2), kind: 'knowledge' },
	])
	const all = f.feed.load()
	assert.deepEqual(
		all.items.map((item) =>
			item.origins.map((origin) => origin.subscription.creatorMid),
		),
		[['88', '99'], ['88'], ['88']],
	)
	assert.deepEqual(ids(f.feed.load('local', 'listening')), [bv(2)])
	f.creators.updateScope('local', '88', 'listening')
	assert.deepEqual(ids(f.feed.load()), [bv(1), bv(2)])
	assert.deepEqual(
		f.feed
			.load()
			.items.map((item) =>
				item.origins.map((origin) => origin.subscription.creatorMid),
			),
		[['99'], ['88']],
	)
})

void test('mixed cache coverage retains uncached, successful empty, partial pages and exact per-page timestamps', (t) => {
	const f = fixture(t)
	for (const mid of ['88', '99', '100', '101']) follow(f, mid)
	save(f, [], '99')
	const response: CreatorPostCacheResponse = {
		items: Array.from({ length: 30 }, (_, i) => post(i + 1, '100')),
		page: 1,
		more: true,
		total: 31,
	}
	f.cache.savePage('100', response, 500, null)
	save(f, [post(40, '101')], '101', 600)
	const value = f.feed.load(),
		byMid = new Map(
			value.subscriptions.map((item) => [item.subscription.creatorMid, item]),
		)
	assert.equal(byMid.get('88')!.status, 'uncached')
	assert.equal(byMid.get('99')!.status, 'empty')
	assert.equal(byMid.get('100')!.status, 'partial')
	assert.equal(byMid.get('100')!.cache!.complete, false)
	assert.deepEqual(byMid.get('100')!.cache!.pages, [
		{ page: 1, fetchedAt: 500, itemCount: 30 },
	])
	assert.equal(byMid.get('101')!.status, 'complete')
	assert.deepEqual(value.coverage, {
		cachedSubscriptions: 3,
		uncachedSubscriptions: 1,
		partialSubscriptions: 1,
		cachedPostCount: 31,
	})
	assert.equal(value.status, 'ready')
	const partial = f.cache.load('100')!
	f.cache.savePage(
		'100',
		{ items: [post(31, '100')], page: 2, more: false, total: 31 },
		700,
		partial.revision,
	)
	assert.deepEqual(
		f.feed
			.load()
			.subscriptions.find((item) => item.subscription.creatorMid === '100')!
			.cache!.pages,
		[
			{ page: 1, fetchedAt: 500, itemCount: 30 },
			{ page: 2, fetchedAt: 700, itemCount: 1 },
		],
	)
})

void test('bad/future cache and forged classification evidence throw without altering original bytes or leaving a transaction', (t) => {
	for (const bad of [
		'json',
		'future-cache',
		'task-identity',
		'entry-identity',
		'original-bv',
		'future-kind',
	] as const) {
		const f = fixture(t)
		follow(f)
		save(f, [post(1)])
		classify(f, 'proof', [{ bvid: bv(1), kind: 'song' }])
		if (bad === 'json')
			f.raw.exec(
				"UPDATE creator_post_cache_pages SET itemsJson='{' WHERE mid='88'",
			)
		else if (bad === 'future-cache')
			f.raw.exec(
				"INSERT INTO creator_post_cache_heads VALUES ('bilibili/public/emptykeyword/defaultorder/ps30/format2','88',1,1,0,0)",
			)
		else if (bad === 'task-identity')
			f.raw.exec("UPDATE import_tasks SET taskVersion=2 WHERE taskId='proof'")
		else if (bad === 'entry-identity')
			f.raw.exec(
				"UPDATE import_entries SET originalPosition=9 WHERE taskId='proof'",
			)
		else if (bad === 'original-bv') {
			const row = f.raw
				.prepare("SELECT snapshotJson FROM import_tasks WHERE taskId='proof'")
				.get()!
			const snapshot = JSON.parse(
				String(row.snapshotJson),
			) as ImportDirectorySnapshot
			snapshot.entries[0].originalMetadata.observed = { bvid: bv(2) }
			f.raw
				.prepare("UPDATE import_tasks SET snapshotJson=? WHERE taskId='proof'")
				.run(JSON.stringify(snapshot))
		} else
			f.raw.exec(
				"PRAGMA ignore_check_constraints=ON; UPDATE import_content_reviews SET kind='future-kind'; PRAGMA ignore_check_constraints=OFF",
			)
		const before = bytes(f)
		assert.throws(() => f.feed.load())
		assert.deepEqual(bytes(f), before, bad)
		f.raw.exec('BEGIN')
		f.raw.exec('ROLLBACK')
	}
})

void test('cache read boundary composes with one caller transaction while the existing load transaction contract stays unchanged', (t) => {
	const f = fixture(t)
	save(f, [post(1)])
	f.db.execSync('BEGIN')
	assert.equal(f.cache.readInSnapshot('88')!.pages[0].items[0].bvid, bv(1))
	assert.throws(() => f.cache.load('88'), /transaction/)
	assert.equal(f.cache.readInSnapshot('88')!.revision, 1)
	f.db.execSync('ROLLBACK')
	const before = bytes(f)
	assert.throws(() => f.feed.load('local', 'future-filter' as CreatorScope))
	assert.throws(() => f.feed.load(' local'))
	assert.deepEqual(bytes(f), before)
})

void test('all follow/scope/cache/profile/classification reads share one real WAL snapshot', (t) => {
	const folder = mkdtempSync(join(tmpdir(), 'melo-following-')),
		file = join(folder, 'feed.sqlite')
	const f = open(file)
	f.raw.exec('PRAGMA journal_mode=WAL')
	const writer = open(file)
	t.after(() => {
		writer.raw.close()
		f.raw.close()
		rmSync(folder, { recursive: true })
	})
	follow(f)
	follow(f, '99')
	save(f, [post(1)])
	save(f, [post(2, '99')], '99')
	classify(f, 'proof', [{ bvid: bv(1), kind: 'knowledge' }])
	let changed = false
	const wrapped: Database = {
		...f.db,
		getAllSync: <T>(sql: string, values: (string | number | null)[]) => {
			const result = f.db.getAllSync<T>(sql, values)
			if (!changed && sql.includes('FROM creator_subscriptions')) {
				changed = true
				writer.creators.updateScope('local', '88', 'music')
				writer.creators.unfollow('local', '99')
				writer.creators.saveCreator({
					source: 'bilibili',
					mid: '88',
					name: '较新昵称',
					fetchedAt: 300,
				})
				writer.cache.savePage(
					'88',
					{
						items: [{ ...post(1), title: '新投稿缓存' }],
						page: 1,
						more: false,
						total: 1,
					},
					300,
					1,
				)
				writer.imports.reviewContent('proof', 'e0', { kind: 'song' }, 1)
			}
			return result
		},
	}
	const old = new FollowingFeedStore(wrapped).load()
	assert.equal(old.subscriptions.length, 2)
	assert.equal(old.items[0].post.title, '原投稿 1')
	assert.equal(old.items[0].origins[0].creator.name, 'UP 88')
	assert.equal(old.items[0].origins[0].subscription.scope, 'all')
	assert.equal(old.items[0].contentScope, 'listening')
	const latest = f.feed.load()
	assert.equal(latest.subscriptions.length, 1)
	assert.equal(latest.items[0].post.title, '新投稿缓存')
	assert.equal(latest.items[0].origins[0].creator.name, '较新昵称')
	assert.equal(latest.items[0].origins[0].subscription.scope, 'music')
	assert.equal(latest.items[0].contentScope, 'music')
})

void test('SQL read and COMMIT failures preserve the original error and all rows even if rollback itself reports a failure', (t) => {
	for (const phase of ['read', 'COMMIT'] as const) {
		const f = fixture(t)
		follow(f)
		save(f, [post(1)])
		const failure = new Error(`injected ${phase}`),
			before = bytes(f)
		const wrapped: Database = {
			...f.db,
			getAllSync: <T>(sql: string, values: (string | number | null)[]) => {
				if (phase === 'read' && sql.includes('creator_post_cache_pages'))
					throw failure
				return f.db.getAllSync<T>(sql, values)
			},
			execSync: (sql) => {
				if (sql === 'COMMIT' && phase === 'COMMIT') throw failure
				f.db.execSync(sql)
				if (sql === 'ROLLBACK') throw new Error('secondary rollback')
			},
		}
		assert.throws(
			() => new FollowingFeedStore(wrapped).load(),
			(error) => error === failure,
		)
		assert.deepEqual(bytes(f), before)
		assert.equal(f.feed.load().items.length, 1)
	}
})

void test('one thousand current reviews read each immutable task snapshot only once per call', (t) => {
	const f = fixture(t)
	follow(f)
	save(
		f,
		Array.from({ length: 30 }, (_, index) => post(index + 1)),
	)
	f.imports.createDirectory({
		taskId: 'large',
		provider: 'bilibili',
		originalPlaylistId: 'large',
		taskVersion: 1,
		originalMetadata: {},
		entries: Array.from({ length: 1000 }, (_, index) => ({
			entryId: `e${index}`,
			originalEntryId: bv((index % 30) + 1),
			originalPosition: index,
			originalMetadata: { media: { bvid: bv((index % 30) + 1) } },
		})),
	})
	f.raw.exec('BEGIN')
	for (let index = 0; index < 1000; index++)
		f.raw
			.prepare("INSERT INTO import_content_reviews VALUES ('large',?,'song',0)")
			.run(`e${index}`)
	f.raw.exec('COMMIT')
	let tasks = 0,
		reviews = 0
	const wrapped: Database = {
		...f.db,
		getFirstSync: (sql, values) => {
			if (sql.includes('snapshotJson FROM import_tasks')) tasks++
			return f.db.getFirstSync(sql, values)
		},
		getAllSync: <T>(sql: string, values: (string | number | null)[]) => {
			if (sql.startsWith('SELECT entryId,kind,reviewedAt')) reviews++
			return f.db.getAllSync<T>(sql, values)
		},
	}
	const value = new FollowingFeedStore(wrapped).load('local', 'music')
	assert.equal(value.items.length, 30)
	assert.equal(tasks, 1)
	assert.equal(reviews, 1)
})
