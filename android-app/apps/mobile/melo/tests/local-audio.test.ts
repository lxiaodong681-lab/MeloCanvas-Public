import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, migrations, type Database } from '../core/database'
import {
	LocalAudioStore,
	localAudioUri,
	type LocalAudio,
} from '../core/local-audio'
import { SessionStore } from '../core/sessions'
import { LocalAudioImport, type LocalAudioFiles } from '../local-audio-import'

const audio: LocalAudio = {
	id: 'local:12345678-1234-1234-1234-123456789abc',
	originalName: 'music.flac',
	title: '音乐',
	artist: '作者',
	durationSeconds: 120,
	bytes: 4096,
	importedAt: 1,
}
function database() {
	const raw = new DatabaseSync(':memory:')
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
void test('升级保留B站会话、喜欢及外键，本地音乐拥有真实独立身份并可冷读', () => {
	const { raw, db } = database()
	try {
		migrate(db, migrations.slice(0, -1))
		const library = new Library(db)
		const source = {
			id: 'bilibili:BV1vT411i7ET:123',
			bvid: 'BV1vT411i7ET',
			cid: 123,
			originalTitle: '原曲',
			uploader: 'UP',
			uploaderId: 1,
			performer: null,
			artwork: '',
			duration: 100,
			domain: 'music' as const,
			audioAvailability: 'unknown' as const,
		}
		library.setLiked(source, true)
		const sessions = new SessionStore(db)
		const original = {
			mode: 'music' as const,
			entries: [{ entryId: source.id, sourceId: source.id }],
			currentEntryId: source.id,
			currentSourceId: source.id,
			positionSeconds: 42,
			speed: 1,
			updatedAt: 1,
		}
		sessions.saveSession(original)
		migrate(db)
		assert.deepEqual(sessions.getSession('music'), original)
		assert.equal(library.likes().length, 1)
		const store = new LocalAudioStore(db)
		store.add(audio)
		sessions.saveSession({
			...original,
			entries: [{ entryId: audio.id, sourceId: audio.id }],
			currentEntryId: audio.id,
			currentSourceId: audio.id,
		})
		assert.equal(
			new SessionStore(db).getSession('music')?.currentSourceId,
			audio.id,
		)
		assert.equal(new LocalAudioStore(db).get(audio.id)?.title, audio.title)
		assert.equal(library.get(audio.id), null)
		assert.throws(() =>
			sessions.saveSession({
				...original,
				mode: 'listening',
				entries: [{ entryId: audio.id, sourceId: audio.id }],
				currentEntryId: audio.id,
				currentSourceId: audio.id,
			}),
		)
		library.save({ ...source, id: 'bilibili:BV1vT411i7ET:456', cid: 456 })
		assert.equal(
			db.getFirstSync<{ kind: string }>(
				'SELECT kind FROM playback_sources WHERE id = ?',
				['bilibili:BV1vT411i7ET:456'],
			)?.kind,
			'bilibili',
		)
		assert.deepEqual(db.getAllSync('PRAGMA foreign_key_check', []), [])
		assert.equal(
			localAudioUri(audio.id),
			'orpheus://local-audio?id=12345678-1234-1234-1234-123456789abc',
		)
	} finally {
		raw.close()
	}
})
void test('数据库失败不留下身份空壳或导入副本，取消迟到结果不入库', async () => {
	const { raw, db } = database()
	try {
		migrate(db)
		const store = new LocalAudioStore(db)
		raw.exec(
			"CREATE TRIGGER reject_local BEFORE INSERT ON local_audio BEGIN SELECT RAISE(ABORT, 'disk full'); END",
		)
		let discarded = 0
		const files: LocalAudioFiles = {
			pick: async () => ({ uri: 'file://picked', name: 'music.flac' }),
			prepare: async () => ({
				audio,
				discard: () => {
					discarded++
				},
			}),
		}
		const session = new LocalAudioImport(store, files, () => {})
		await session.importFile()
		assert.match(session.state.error, /disk full/)
		assert.equal(discarded, 1)
		assert.equal(store.list().length, 0)
		assert.equal(
			db.getFirstSync('SELECT * FROM playback_sources WHERE id = ?', [
				audio.id,
			]),
			null,
		)
		raw.exec('DROP TRIGGER reject_local')
		let release!: (
			value: Awaited<ReturnType<LocalAudioFiles['prepare']>>,
		) => void
		files.prepare = () =>
			new Promise((resolve) => {
				release = resolve
			})
		const pending = session.importFile()
		await Promise.resolve()
		session.cancel()
		release({
			audio,
			discard: () => {
				discarded++
			},
		})
		await pending
		assert.equal(discarded, 2)
		assert.equal(store.list().length, 0)
		files.prepare = async () => ({
			audio,
			discard: () => {
				discarded++
			},
		})
		await session.importFile()
		assert.equal(store.list().length, 1)
		assert.equal(discarded, 2)
	} finally {
		raw.close()
	}
})

void test('取消系统选择后迟到的自有缓存只释放一次且不复制或入库', async () => {
	let resolve!: (value: { uri: string; name: string; release(): void }) => void
	let released = 0
	let prepared = 0
	let saved = 0
	const session = new LocalAudioImport(
		{
			list: () => [],
			add: () => {
				saved++
			},
		},
		{
			pick: () =>
				new Promise((done) => {
					resolve = done
				}),
			prepare: async () => {
				prepared++
				return { audio, discard() {} }
			},
		},
		() => {},
	)
	const pending = session.importFile()
	session.cancel()
	resolve({
		uri: 'file://owned-cache',
		name: 'music.flac',
		release: () => {
			released++
		},
	})
	await pending
	assert.equal(released, 1)
	assert.equal(prepared, 0)
	assert.equal(saved, 0)
	assert.equal(session.state.busy, false)
})
