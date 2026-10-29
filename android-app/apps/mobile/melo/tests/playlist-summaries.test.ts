import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, migrations, type Database } from '../core/database'
import type { ImportProvider, ImportReview } from '../core/import-types'
import { ImportStore } from '../core/imports'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import { playlistImportSummary } from '../playlist-selection'

function setup(version: number = migrations.length) {
	const raw = new DatabaseSync(':memory:')
	const reads: { sql: string; rows: number }[] = []
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) => {
			const result = raw.prepare(sql).all(...values) as T[]
			reads.push({ sql, rows: result.length })
			return result
		},
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
	migrate(db, migrations.slice(0, version))
	return {
		raw,
		db,
		reads,
		store: new PlaylistStore(db),
		library: new Library(db),
	}
}

const source = (cid: number): Source => ({
	id: sourceId('BV1vT411i7ET', cid),
	bvid: 'BV1vT411i7ET',
	cid,
	originalTitle: `原视频 P${cid}`,
	uploader: '上传者',
	uploaderId: 88,
	performer: null,
	artwork: '',
	duration: 300,
	domain: 'music',
	audioAvailability: 'unknown',
})

function pendingEvidence(db: Database, provider: ImportProvider) {
	const taskId = `task-${provider}`
	const original = {
		entryId: `entry-${provider}`,
		originalEntryId: `original-${provider}`,
		originalPosition: 0,
		originalMetadata: { name: `尚待匹配 ${provider}` },
	}
	new ImportStore(db).createDirectory({
		taskId,
		provider,
		originalPlaylistId: `remote-${provider}`,
		taskVersion: 1,
		originalMetadata: { name: '原平台歌单' },
		entries: [original],
	})
	const review: ImportReview = {
		state: 'not-found',
		candidates: [],
		confirmation: null,
	}
	return {
		taskId,
		origin: JSON.stringify({
			taskId,
			provider,
			originalPlaylistId: `remote-${provider}`,
			taskVersion: 1,
			...original,
			reviewAtCommit: review,
		}),
		review: JSON.stringify(review),
	}
}

void test('歌单摘要从大歌单只返回每张一行，重复音源按条目计数，来源和首个可播项保持顺序', () => {
	const { raw, db, reads, store, library } = setup()
	try {
		const a = source(1),
			b = source(2)
		library.save(a)
		library.save(b)
		const evidence = (['bilibili', 'qq', 'netease'] as const).map((provider) =>
			pendingEvidence(db, provider),
		)
		for (const id of ['large', 'other', 'empty']) store.create(id, id)
		const insert = raw.prepare(
			'INSERT INTO playlist_items(itemId,playlistId,sourceId,position,addedAt,importTaskId,originJson,reviewJson) VALUES (?,?,?,?,?,?,?,?)',
		)
		raw.exec('BEGIN IMMEDIATE')
		for (let index = 0; index < 12000; index++) {
			const pending = index % 1000 === 0 ? evidence[index % 3] : null
			insert.run(
				`large-${index}`,
				'large',
				pending ? null : index === 1 ? b.id : a.id,
				index,
				index,
				pending?.taskId ?? null,
				pending?.origin ?? null,
				pending?.review ?? null,
			)
		}
		for (let index = 0; index < 6000; index++)
			insert.run(
				`other-${index}`,
				'other',
				a.id,
				index,
				index,
				null,
				null,
				null,
			)
		raw.exec('COMMIT')
		store.setDescription('large', '本机说明')
		store.setCoverUri('large', 'file:///private/playlist-cover.png')

		reads.length = 0
		const summaries = store.listSummaries()
		assert.equal(summaries.length, 3)
		assert.equal(reads.length, 1)
		assert.equal(reads[0].rows, 3)
		assert.match(reads[0].sql, /GROUP BY playlist\.id/)
		assert.deepEqual(
			summaries.map(({ playlist }) => playlist),
			store.list(),
		)
		const large = summaries.find(({ playlist }) => playlist.id === 'large')!
		assert.equal(large.count, 12000)
		assert.equal(large.pendingCount, 12)
		assert.equal(large.firstSourceId, b.id)
		assert.equal(large.playlist.description, '本机说明')
		assert.equal(large.playlist.coverUri, 'file:///private/playlist-cover.png')
		assert.deepEqual(large.importProviders, ['netease', 'qq', 'bilibili'])
		assert.equal(
			playlistImportSummary(store.get('large')!.items),
			'导入条目来源：网易云歌单 / QQ 歌单 / B站收藏夹，本地副本',
		)
		const other = summaries.find(({ playlist }) => playlist.id === 'other')!
		assert.equal(other.count, 6000)
		assert.equal(other.pendingCount, 0)
		assert.deepEqual(other.importProviders, [])
		const empty = summaries.find(({ playlist }) => playlist.id === 'empty')!
		assert.equal(empty.count, 0)
		assert.equal(empty.pendingCount, 0)
		assert.equal(empty.firstSourceId, null)
		assert.deepEqual(empty.importProviders, [])
	} finally {
		raw.close()
	}
})

void test('摘要每次读取真实现状；重复条目的添加、移除、撤销与首个可播源一致', () => {
	const { raw, store } = setup()
	try {
		const a = source(1),
			b = source(2)
		store.create('p', '歌单')
		store.append(
			'p',
			[
				{ itemId: 'b-first', source: b },
				{ itemId: 'a', source: a },
				{ itemId: 'b-repeat', source: b },
			],
			'keep-all',
		)
		assert.equal(store.listSummaries()[0].count, 3)
		assert.equal(store.listSummaries()[0].firstSourceId, b.id)
		const receipt = store.remove('p', ['b-first'])!
		assert.equal(store.listSummaries()[0].count, 2)
		assert.equal(store.listSummaries()[0].firstSourceId, a.id)
		store.undoRemove(receipt)
		assert.equal(store.listSummaries()[0].count, 3)
		assert.equal(store.listSummaries()[0].firstSourceId, b.id)
		store.delete('p')
		assert.deepEqual(store.listSummaries(), [])
	} finally {
		raw.close()
	}
})

void test('旧版无导入列的歌单仍能读摘要，读取不触发迁移或更改数据库', () => {
	const { raw, store } = setup(4)
	try {
		store.create('p', '旧版本')
		store.append('p', [{ itemId: 'a', source: source(1) }], 'keep-all')
		const before = raw.prepare('PRAGMA user_version').get()
		const summary = store.listSummaries()[0]
		assert.equal(summary.count, 1)
		assert.equal(summary.pendingCount, 0)
		assert.deepEqual(summary.importProviders, [])
		assert.deepEqual(raw.prepare('PRAGMA user_version').get(), before)
	} finally {
		raw.close()
	}
})

void test('摘要不静默接受损坏的来源 JSON 或未知导入平台；完整条目校验仍由 get 执行', () => {
	const { raw, db, store } = setup()
	try {
		const pending = pendingEvidence(db, 'netease')
		store.create('p', '导入')
		raw
			.prepare(
				'INSERT INTO playlist_items(itemId,playlistId,sourceId,position,addedAt,importTaskId,originJson,reviewJson) VALUES (?,?,?,?,?,?,?,?)',
			)
			.run(
				'pending',
				'p',
				null,
				0,
				0,
				pending.taskId,
				pending.origin,
				pending.review,
			)
		assert.equal(store.listSummaries()[0].pendingCount, 1)
		raw
			.prepare('UPDATE playlist_items SET originJson = ? WHERE itemId = ?')
			.run('{', 'pending')
		assert.throws(() => store.listSummaries(), /malformed JSON/)
		for (const invalidOrigin of ['{"provider":"unknown"}', '{}']) {
			raw
				.prepare('UPDATE playlist_items SET originJson = ? WHERE itemId = ?')
				.run(invalidOrigin, 'pending')
			assert.throws(() => store.listSummaries(), /歌单导入来源无效/)
		}
		raw
			.prepare(
				'UPDATE playlist_items SET originJson = ?, reviewJson = ? WHERE itemId = ?',
			)
			.run(pending.origin, '{"state":"confirmed"}', 'pending')
		assert.throws(() => store.get('p'))
	} finally {
		raw.close()
	}
})
