import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, migrations, type Database } from '../core/database'
import { LocalAudioStore, type LocalAudio } from '../core/local-audio'
import type { Source } from '../core/model'
import { localLibrarySource } from '../core/music-library-source'
import { PlaylistStore } from '../core/playlists'
import {
	preparePlaylistPlayback,
	selectPlaylistDetailItems,
} from '../playlist-selection'

const audio: LocalAudio = {
	id: 'local:12345678-1234-1234-1234-123456789abc',
	originalName: 'song.flac',
	title: '离线歌曲',
	artist: '本地歌手',
	durationSeconds: 120,
	bytes: 2048,
	importedAt: 1,
}
const bili: Source = {
	id: 'bilibili:BV1vT411i7ET:123',
	bvid: 'BV1vT411i7ET',
	cid: 123,
	originalTitle: '在线视频',
	uploader: 'UP',
	uploaderId: 1,
	performer: null,
	artwork: '',
	duration: 100,
	domain: 'music',
	audioAvailability: 'unknown',
}
function setup() {
	const raw = new DatabaseSync(':memory:')
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, v) => raw.prepare(sql).run(...v),
		getAllSync: <T>(sql: string, v: (string | number | null)[]) =>
			raw.prepare(sql).all(...v) as T[],
		getFirstSync: <T>(sql: string, v: (string | number | null)[]) =>
			(raw.prepare(sql).get(...v) as T) ?? null,
	}
	return {
		raw,
		db,
		library: new Library(db),
		store: new PlaylistStore(db),
		audioStore: new LocalAudioStore(db),
	}
}
void test('registry migration preserves old likes and playlist rows exactly', () => {
	const f = setup()
	try {
		migrate(f.db, migrations.slice(0, -1))
		f.library.setLiked(bili, true)
		f.store.create('p', '旧歌单')
		f.store.append('p', [{ itemId: 'b', source: bili }], 'keep-all')
		f.audioStore.add(audio)
		const before = f.store.get('p')
		const likes = f.raw.prepare('SELECT * FROM likes').all()
		migrate(f.db)
		assert.deepEqual(f.store.get('p'), before)
		assert.deepEqual(f.raw.prepare('SELECT * FROM likes').all(), likes)
		assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), [])
		f.library.setLiked(localLibrarySource(audio), true)
		assert.deepEqual(
			new Set(f.library.musicLikes().map((s) => s.id)),
			new Set([bili.id, audio.id]),
		)
		assert.equal(f.library.get(audio.id), null)
	} finally {
		f.raw.close()
	}
})
void test('mixed likes, playlist duplicates, copy/remove/undo and search retain real local identity', () => {
	const f = setup()
	try {
		migrate(f.db)
		f.audioStore.add(audio)
		const local = localLibrarySource(audio)
		f.library.setLiked(local, true)
		f.library.setLiked(bili, true)
		f.store.create('p', '混合')
		f.store.append(
			'p',
			[
				{ itemId: 'a', source: local },
				{ itemId: 'b', source: bili },
				{ itemId: 'c', source: local },
			],
			'keep-all',
		)
		const detail = f.store.get('p')!
		assert.deepEqual(
			detail.items.map((i) => i.sourceId),
			[audio.id, bili.id, audio.id],
		)
		const prepared = preparePlaylistPlayback(f.store, f.library, 'p', 'c')
		assert.equal(prepared.startItemId, 'c')
		assert.equal(prepared.entries[2].source.id, audio.id)
		const sources = new Map(
			detail.items.map((i) => [i.sourceId!, f.library.getMusic(i.sourceId!)]),
		)
		assert.deepEqual(
			selectPlaylistDetailItems(detail, sources, '本地歌手', 'all').map(
				(i) => i.index,
			),
			[0, 2],
		)
		assert.equal(
			selectPlaylistDetailItems(detail, sources, '', 'pending').length,
			0,
		)
		const receipt = f.store.remove('p', ['a'])!
		f.store.undoRemove(receipt)
		assert.deepEqual(f.store.get('p')!.items, detail.items)
		assert.deepEqual(
			f.store
				.copy('p', 'copy', '副本', ['d', 'e', 'f'])
				.items.map((i) => i.sourceId),
			[audio.id, bili.id, audio.id],
		)
		let id = 0
		assert.equal(
			f.store.createFromLikes('liked', '喜欢', () => `liked-${++id}`).items
				.length,
			2,
		)
		f.library.setLiked(local, false)
		assert.deepEqual(
			f.library.musicLikes().map((s) => s.id),
			[bili.id],
		)
		assert.equal(f.store.get('p')!.items.length, 3)
		assert.ok(f.audioStore.get(audio.id))
	} finally {
		f.raw.close()
	}
})
void test('unknown local source fails atomically without fabricated source or partial playlist rows', () => {
	const f = setup()
	try {
		migrate(f.db)
		f.store.create('p', '安全')
		assert.throws(
			() =>
				f.store.append(
					'p',
					[
						{ itemId: 'b', source: bili },
						{ itemId: 'a', source: localLibrarySource(audio) },
					],
					'keep-all',
				),
			/本地音频不存在/,
		)
		assert.equal(f.store.get('p')!.items.length, 0)
		assert.equal(f.library.get(bili.id), null)
		assert.throws(
			() => f.library.setLiked(localLibrarySource(audio), true),
			/本地音频不存在/,
		)
		assert.equal(f.library.musicLikes().length, 0)
	} finally {
		f.raw.close()
	}
})

void test('migration copies pending import evidence byte-for-byte and preserves foreign keys', () => {
	const f = setup()
	try {
		migrate(f.db, migrations.slice(0, -1))
		f.store.create('pending', '待匹配')
		f.raw
			.prepare('INSERT INTO import_tasks VALUES (?,?,?,?,?,?,?,?)')
			.run('t', 'netease', 'remote', 1, '{}', 0, 1, 1)
		f.raw
			.prepare('INSERT INTO playlist_items VALUES (?,?,?,?,?,?,?,?)')
			.run(
				'pending-item',
				'pending',
				null,
				0,
				1,
				't',
				'{"original":"原平台信息"}',
				'{"state":"pending"}',
			)
		const before = f.raw.prepare('SELECT * FROM playlist_items').all()
		migrate(f.db)
		assert.deepEqual(
			f.raw.prepare('SELECT * FROM playlist_items').all(),
			before,
		)
		assert.deepEqual(f.raw.prepare('PRAGMA foreign_key_check').all(), [])
	} finally {
		f.raw.close()
	}
})
