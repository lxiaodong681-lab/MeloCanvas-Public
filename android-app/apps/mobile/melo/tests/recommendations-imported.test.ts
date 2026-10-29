import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, type Database } from '../core/database'
import type {
	ImportDirectorySnapshot,
	ImportReview,
} from '../core/import-types'
import { ImportStore } from '../core/imports'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import {
	RecommendationStore,
	recommendationSettingKey,
} from '../core/recommendations'

const A = 'BV1vT411i7ET'
const source = (cid = 1, bvid = A): Source => ({
	id: sourceId(bvid, cid),
	bvid,
	cid,
	originalTitle: `人工核对版本${cid}`,
	uploader: '上传者',
	uploaderId: 88,
	performer: null,
	artwork: '',
	duration: 100,
	domain: 'unclassified',
	audioAvailability: 'unknown',
})
function open() {
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
	return {
		raw,
		db,
		library: new Library(db),
		imports: new ImportStore(db),
		playlists: new PlaylistStore(db),
		recommendations: new RecommendationStore(db, () => new Date(2026, 9, 18)),
	}
}
type Fixture = ReturnType<typeof open>
function directory(
	taskId: string,
	provider: 'netease' | 'qq' | 'kuwo' | 'kugou' | 'qishui' = 'netease',
	count = 1,
): ImportDirectorySnapshot {
	return {
		taskId,
		provider,
		originalPlaylistId: `remote-${taskId}`,
		taskVersion: 1,
		originalMetadata: { title: '原歌曲目录' },
		entries: Array.from({ length: count }, (_, index) => ({
			entryId: `e${index}`,
			originalEntryId: `song-${index % 2}`,
			originalPosition: index * 2,
			originalMetadata: {
				track: { id: index % 2, name: '原歌曲', artists: ['原歌手'] },
				evidence: { a: 1, b: [2, 3] },
			},
		})),
	}
}
const confirmed = (value: Source): ImportReview => ({
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
})
function confirm(f: Fixture, taskId: string, entryId = 'e0', value = source()) {
	f.library.save(value)
	return f.imports.review(
		taskId,
		entryId,
		{ review: confirmed(value) },
		f.imports.get(taskId)!.revision,
	)
}
function commit(f: Fixture, taskId: string) {
	const task = f.imports.get(taskId)!
	const selected = f.imports.setSelected(
		taskId,
		task.entries.map((entry) => entry.entryId),
		true,
		task.revision,
	)
	return f.imports.commitSelected(taskId, {
		commitId: `commit-${taskId}`,
		expectedRevision: selected.revision,
		target: { kind: 'create', playlistId: `p-${taskId}`, name: '实际导入歌单' },
		duplicatePolicy: 'keep-all',
		itemIds: task.entries.map((entry) => ({
			entryId: entry.entryId,
			itemId: `${taskId}-${entry.entryId}`,
		})),
	})
}
function saved(f: Fixture) {
	return f.library.setting(recommendationSettingKey)
}
function ids(f: Fixture) {
	return f.recommendations.load().items.map((item) => item.source.id)
}

void test('all external confirmed-and-committed song entries qualify; confirmation alone does not classify', () => {
	for (const provider of ['netease', 'qq', 'kuwo', 'kugou', 'qishui'] as const) {
		const f = open()
		try {
			f.imports.createDirectory(directory('task', provider))
			confirm(f, 'task')
			assert.deepEqual(ids(f), [])
			commit(f, 'task')
			assert.deepEqual(ids(f), [source().id], 'an empty same-day snapshot fills when qualified music arrives')
			const result = f.recommendations.refresh()
			assert.deepEqual(
				result.items.map((item) => item.source.id),
				[source().id],
			)
			assert.deepEqual(result.items[0].reasons, ['playlist', 'imported-song'])
			assert.equal(result.items[0].source.audioAvailability, 'unknown')
			assert.equal(f.library.get(source().id)!.domain, 'unclassified')
		} finally {
			f.raw.close()
		}
	}
})

void test('heart profile includes unmatched originals from every imported music provider without classifying them as playable', () => {
	const f = open()
	try {
		for (const provider of ['netease','qq','kuwo','kugou','qishui'] as const) {
			const snapshot = directory(provider,provider)
			snapshot.entries[0].originalMetadata = {track:{name:'原曲',artists:[provider]}}
			f.imports.createDirectory(snapshot)
			commit(f,provider)
		}
		const profile = f.recommendations.heartProfile([])
		assert.equal(profile.playlistCount,5)
		assert.deepEqual(profile.seeds.map(seed=>seed.query).sort(),['netease','qq','kuwo','kugou','qishui'].sort())
		assert.ok(profile.seeds.every(seed=>seed.weight===2))
		assert.deepEqual(ids(f),[])
	} finally {f.raw.close()}
})

void test('real pending original becomes eligible only after review and resolve; pending copy is not a song', () => {
	const f = open()
	try {
		f.imports.createDirectory(directory('task'))
		f.library.save(source())
		const published = commit(f, 'task')
		f.playlists.copy('p-task', 'pending-copy', '尚未匹配的副本', [
			'pending-copy-item',
		])
		assert.deepEqual(ids(f), [])
		const task = confirm(f, 'task')
		assert.deepEqual(
			ids(f),
			[],
			'review alone does not fill the original pending item',
		)
		f.imports.resolvePending('task', 'e0', {
			playlistId: 'p-task',
			itemId: 'task-e0',
			expectedRevision: task.revision,
			expectedUpdatedAt: published.playlist!.updatedAt,
		})
		assert.deepEqual(
			f.recommendations.refresh().items.map((item) => item.source.id),
			[source().id],
		)
		assert.equal(f.playlists.get('pending-copy')!.items[0].sourceId, null)
		f.playlists.remove('p-task', ['task-e0'])
		assert.deepEqual(
			ids(f),
			[],
			'unresolved pending copy must not retain eligibility',
		)
	} finally {
		f.raw.close()
	}
})

void test('genuine confirmed copies retain read-only evidence after original removal, and last removal clears eligibility', () => {
	const f = open()
	try {
		f.imports.createDirectory(directory('task'))
		confirm(f, 'task')
		commit(f, 'task')
		f.playlists.copy('p-task', 'copy', '合法副本', ['copy-item'])
		assert.deepEqual(ids(f), [source().id])
		f.playlists.remove('p-task', ['task-e0'])
		assert.deepEqual(ids(f), [source().id])
		const task = f.imports.get('task')!
		assert.throws(() =>
			f.imports.resolvePending('task', 'e0', {
				playlistId: 'copy',
				itemId: 'copy-item',
				expectedRevision: task.revision,
				expectedUpdatedAt: f.playlists.get('copy')!.updatedAt,
			}),
		)
		const receipt = f.playlists.remove('copy', ['copy-item'])!
		assert.deepEqual(ids(f), [])
		f.playlists.undoRemove(receipt)
		assert.deepEqual(ids(f), [source().id])
		f.playlists.delete('copy')
		assert.deepEqual(ids(f), [])
		assert.ok(
			f.library.get(source().id),
			'qualification removal never deletes Source',
		)
	} finally {
		f.raw.close()
	}
})

void test('pending resolved original may be copied with genuine resolved ledger proof', () => {
	const f = open()
	try {
		f.imports.createDirectory(directory('task', 'qq'))
		const published = commit(f, 'task')
		const task = confirm(f, 'task')
		f.imports.resolvePending('task', 'e0', {
			playlistId: 'p-task',
			itemId: 'task-e0',
			expectedRevision: task.revision,
			expectedUpdatedAt: published.playlist!.updatedAt,
		})
		f.playlists.copy('p-task', 'resolved-copy', '补全后的副本', [
			'resolved-copy-item',
		])
		f.playlists.delete('p-task')
		assert.deepEqual(ids(f), [source().id])
		assert.equal(
			f.playlists.get('resolved-copy')!.items[0].importOrigin!.reviewAtCommit
				.state,
			'pending',
		)
	} finally {
		f.raw.close()
	}
})

void test('import A/B/A remains three occurrences while recommendation dedups exact Source and preserves real reasons', () => {
	const f = open()
	try {
		f.imports.createDirectory(directory('task', 'netease', 3))
		for (const [index, value] of [source(1), source(2), source(1)].entries())
			confirm(f, 'task', `e${index}`, value)
		commit(f, 'task')
		f.library.setLiked(source(), true)
		const result = f.recommendations.load()
		assert.deepEqual(
			result.items.map((item) => item.source.id),
			[source(1).id, source(2).id],
		)
		assert.deepEqual(result.items[0].reasons, [
			'liked',
			'playlist',
			'imported-song',
		])
		assert.deepEqual(
			f.playlists.get('p-task')!.items.map((item) => item.sourceId),
			[source(1).id, source(2).id, source(1).id],
		)
	} finally {
		f.raw.close()
	}
})

void test('current task mapping changes withdraw old evidence without rewriting saved playlist or Source', () => {
	const f = open()
	try {
		f.imports.createDirectory(directory('task'))
		confirm(f, 'task')
		commit(f, 'task')
		assert.deepEqual(ids(f), [source().id])
		const item = f.playlists.get('p-task')!.items[0]
		confirm(f, 'task', 'e0', source(2))
		assert.deepEqual(ids(f), [])
		assert.deepEqual(f.playlists.get('p-task')!.items[0], item)
		assert.equal(f.library.get(source().id)!.domain, 'unclassified')
		confirm(f, 'task')
		assert.deepEqual(ids(f), [source().id])
		f.imports.review(
			'task',
			'e0',
			{ review: { state: 'pending', candidates: [], confirmation: null } },
			f.imports.get('task')!.revision,
		)
		assert.deepEqual(ids(f), [])
		assert.deepEqual(f.playlists.get('p-task')!.items[0], item)
	} finally {
		f.raw.close()
	}
})

void test('other task long-content classification vetoes imported-song evidence across CIDs', () => {
	const f = open()
	try {
		f.imports.createDirectory(directory('task'))
		confirm(f, 'task')
		commit(f, 'task')
		assert.deepEqual(ids(f), [source().id])
		f.imports.createDirectory({
			taskId: 'bili',
			provider: 'bilibili',
			originalPlaylistId: 'folder',
			taskVersion: 1,
			originalMetadata: {},
			entries: [
				{
					entryId: 'e',
					originalEntryId: A,
					originalPosition: 0,
					originalMetadata: { observed: { bvid: A }, media: { bvid: A } },
				},
			],
		})
		f.imports.reviewContent('bili', 'e', { kind: 'musicCollection' }, 0)
		assert.deepEqual(ids(f), [])
		assert.deepEqual(f.recommendations.refresh().items, [])
		assert.equal(f.playlists.get('p-task')!.items[0].sourceId, source().id)
	} finally {
		f.raw.close()
	}
})

void test('forged origin/task/entry metadata, review/Source mismatch and absent ledger fail without overwriting snapshot', () => {
	for (const corrupt of [
		'metadata',
		'provider',
		'originalPlaylistId',
		'taskVersion',
		'entryId',
		'review',
		'source',
		'no-ledger',
	] as const) {
		const f = open()
		try {
			f.imports.createDirectory(directory('task'))
			confirm(f, 'task')
			commit(f, 'task')
			f.recommendations.load()
			const before = saved(f)
			const row = f.raw
				.prepare(
					'SELECT originJson,reviewJson FROM playlist_items WHERE itemId=?',
				)
				.get('task-e0')!
			const origin = JSON.parse(row.originJson as string)
			if (corrupt === 'metadata')
				origin.originalMetadata.track.name = '伪造标题'
			if (corrupt === 'provider') origin.provider = 'qq'
			if (corrupt === 'originalPlaylistId')
				origin.originalPlaylistId = 'unrelated'
			if (corrupt === 'taskVersion') origin.taskVersion++
			if (corrupt === 'entryId') origin.entryId = 'missing'
			if (corrupt === 'review')
				f.raw
					.prepare('UPDATE playlist_items SET reviewJson=? WHERE itemId=?')
					.run(
						JSON.stringify({
							state: 'pending',
							candidates: [],
							confirmation: null,
						}),
						'task-e0',
					)
			if (corrupt === 'source') {
				f.library.save(source(2))
				f.raw
					.prepare(
						'UPDATE playlist_items SET sourceId=?,reviewJson=? WHERE itemId=?',
					)
					.run(source(2).id, JSON.stringify(confirmed(source(2))), 'task-e0')
			}
			if (corrupt === 'no-ledger')
				f.raw
					.prepare('DELETE FROM import_commit_entries WHERE taskId=?')
					.run('task')
			f.raw
				.prepare('UPDATE playlist_items SET originJson=? WHERE itemId=?')
				.run(JSON.stringify(origin), 'task-e0')
			assert.throws(() => f.recommendations.refresh(), corrupt)
			assert.equal(saved(f), before, corrupt)
		} finally {
			f.raw.close()
		}
	}
})

void test('equivalent original metadata key order is accepted; a copied origin without any actual added record is not', () => {
	const f = open()
	try {
		f.imports.createDirectory(directory('task'))
		confirm(f, 'task')
		commit(f, 'task')
		const row = f.raw
			.prepare('SELECT originJson FROM playlist_items WHERE itemId=?')
			.get('task-e0')!
		const origin = JSON.parse(row.originJson as string)
		origin.originalMetadata.evidence = { b: [2, 3], a: 1 }
		f.raw
			.prepare('UPDATE playlist_items SET originJson=? WHERE itemId=?')
			.run(JSON.stringify(origin), 'task-e0')
		assert.deepEqual(ids(f), [source().id])
		f.imports.createDirectory(directory('never-saved'))
		confirm(f, 'never-saved')
		origin.taskId = 'never-saved'
		origin.originalPlaylistId = 'remote-never-saved'
		f.raw
			.prepare(
				'UPDATE playlist_items SET importTaskId=?,originJson=? WHERE itemId=?',
			)
			.run('never-saved', JSON.stringify(origin), 'task-e0')
		const before = saved(f)
		assert.throws(() => f.recommendations.refresh(), /缺少真实保存记录/)
		assert.equal(saved(f), before)
	} finally {
		f.raw.close()
	}
})

void test('multiple copies share one snapshot parse and one ledger batch per task within a load', (context) => {
	const f = open()
	const parseJson = JSON.parse
	try {
		for (const [index, provider] of (['netease', 'qq'] as const).entries()) {
			const taskId = `task-${index}`
			f.imports.createDirectory(directory(taskId, provider))
			confirm(f, taskId, 'e0', source(index + 1))
			commit(f, taskId)
			for (let copy = 0; copy < 40; copy++)
				f.playlists.copy(
					`p-${taskId}`,
					`copy-${index}-${copy}`,
					'合法歌曲副本',
					[`copy-item-${index}-${copy}`],
				)
		}
		const snapshots = new Set(
			f.raw
				.prepare('SELECT snapshotJson FROM import_tasks')
				.all()
				.map((row) => row.snapshotJson as string),
		)
		let snapshotReads = 0,
			snapshotParses = 0,
			ledgerReads = 0
		JSON.parse = (text, reviver) => {
			if (snapshots.has(text)) snapshotParses++
			return parseJson(text, reviver)
		}
		const measured: Database = {
			...f.db,
			// The Database caller supplies the SQLite row shape.
			// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
			getFirstSync: <T>(sql: string, values: (string | number | null)[]) => {
				if (sql.includes('snapshotJson')) snapshotReads++
				if (sql.includes('FROM import_commit_entries l')) ledgerReads++
				return f.db.getFirstSync<T>(sql, values)
			},
			getAllSync: <T>(sql: string, values: (string | number | null)[]) => {
				assert.ok(
					!sql.includes('snapshotJson') && !sql.includes('originJson'),
					'do not bulk-read large snapshot/origin payloads',
				)
				if (sql.includes('FROM import_commit_entries l')) ledgerReads++
				return f.db.getAllSync<T>(sql, values)
			},
		}
		const started = performance.now()
		const result = new RecommendationStore(
			measured,
			() => new Date(2026, 9, 18),
		).load()
		context.diagnostic(
			`82 current items across two tasks: ${Math.round(performance.now() - started)}ms, snapshot reads/parses ${snapshotReads}/${snapshotParses}, ledger batches ${ledgerReads}`,
		)
		assert.equal(result.items.length, 2)
		assert.equal(snapshotReads, 2)
		assert.equal(snapshotParses, 2)
		assert.equal(ledgerReads, 2)
	} finally {
		JSON.parse = parseJson
		f.raw.close()
	}
})
