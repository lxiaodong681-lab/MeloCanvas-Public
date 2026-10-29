import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, type Database } from '../core/database'
import {
	exportLibraryBackup,
	type LibraryBackup,
	hasLibraryBackupUndo,
	replaceLibraryBackup,
	undoLibraryBackupReplacement,
	mergeLibraryBackup,
	parseLibraryBackup,
	stageLibraryBackup,
	summarizeLibraryBackup,
} from '../core/library-backup'
import { LocalAudioStore } from '../core/local-audio'
import { localLibrarySource } from '../core/music-library-source'
import { PlaylistStore } from '../core/playlists'
import {
	LyricsStore,
	lyricsDisplaySettingsKey,
	lyricsStoragePrefix,
	maxLyricsBytes,
	readLyricsDisplayOptions,
	writeLyricsDisplayOptions,
	type SavedLyrics,
} from '../lyrics'
import type { OnlineLyricSource } from '../online-lyrics'
import { cacheOnlineLyrics } from '../online-lyrics-cache'
const resolve = (name: string) => `file:///current/melo-playlist-covers/${name}`

function setup() {
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
	return { raw, db }
}
function fixture() {
	const f = setup()
	const audio = {
		id: 'local:12345678-1234-1234-1234-123456789abc',
		originalName: 'song.flac',
		title: '本地音乐',
		artist: '歌手',
		durationSeconds: 12,
		bytes: 2048,
		importedAt: 1,
	}
	const library = new Library(f.db)
	library.save({
		id: 'bilibili:BV1vT411i7ET:123',
		bvid: 'BV1vT411i7ET',
		cid: 123,
		originalTitle: '合成在线歌曲',
		uploader: '测试UP',
		uploaderId: 1,
		performer: null,
		artwork: '',
		duration: 120,
		domain: 'music',
		audioAvailability: 'unknown',
	})
	f.db.runSync('INSERT INTO resume_points VALUES (?,?,?,?,?)', [
		'bilibili:BV1vT411i7ET:123',
		30,
		120,
		0,
		1,
	])
	f.db.runSync('INSERT INTO creators VALUES (?,?,?,?,?,?)', [
		'bilibili',
		'1',
		'测试UP',
		null,
		null,
		1,
	])
	f.db.runSync('INSERT INTO creator_subscriptions VALUES (?,?,?,?,?,?)', [
		'local',
		'1',
		'all',
		1,
		0,
		'manual',
	])

	new LocalAudioStore(f.db).add(audio)
	library.setLiked(localLibrarySource(audio), true)
	const playlists = new PlaylistStore(f.db)
	playlists.create('p', '我的歌单')
	playlists.append(
		'p',
		[
			{ itemId: 'occurrence-1', source: localLibrarySource(audio) },
			{ itemId: 'occurrence-2', source: localLibrarySource(audio) },
		],
		'keep-all',
	)
	f.db.runSync('INSERT INTO import_tasks VALUES (?,?,?,?,?,?,?,?)', [
		'task',
		'netease',
		'123',
		1,
		JSON.stringify({
			taskId: 'task',
			provider: 'netease',
			originalPlaylistId: '123',
			taskVersion: 1,
			originalMetadata: {},
			entries: [
				{
					entryId: 'unmatched',
					originalEntryId: null,
					originalPosition: 0,
					originalMetadata: {},
				},
			],
		}),
		0,
		1,
		1,
	])
	f.db.runSync('INSERT INTO import_entries VALUES (?,?,?,?,?,?,?,?,?)', [
		'task',
		'unmatched',
		0,
		1,
		'pending',
		'[]',
		null,
		null,
		null,
	])
	f.db.runSync('INSERT INTO playlist_items VALUES (?,?,?,?,?,?,?,?)', [
		'pending',
		'p',
		null,
		2,
		1,
		'task',
		JSON.stringify({
			taskId: 'task',
			provider: 'netease',
			originalPlaylistId: '123',
			taskVersion: 1,
			entryId: 'unmatched',
			originalEntryId: null,
			originalPosition: 0,
			originalMetadata: {},
			reviewAtCommit: { state: 'pending', candidates: [], confirmation: null },
		}),
		'{"state":"pending","candidates":[],"confirmation":null}',
	])
	library.setSetting('reducedMotion', 'true')
	library.setSetting('authorization', 'synthetic-secret-MUST-NOT-EXPORT')
	library.setSetting('theme.state.v1', '{"privateAssetPath":"/synthetic"}')
	return f
}

function onlineSavedLyrics(
	sourceId: string,
	provider: OnlineLyricSource = 'netease',
): SavedLyrics {
	return {
		...cacheOnlineLyrics(
			{
				sourceId,
				candidate: {
					source: provider,
					remoteId: provider === 'netease' ? 123 : 'record_123',
					title: '受控歌词',
					artist: '受控歌手',
					duration: 3,
				},
				raw: { lrc: '[00:01.000]原文\n[00:02.000]仅原文' },
				lines: [
					{
						startTime: 1000,
						endTime: 1900,
						content: '原文',
						translation: '译文',
						romaji: 'romaji',
						translations: ['译文'],
						isDynamic: false,
						spans: [],
					},
					{
						startTime: 2000,
						endTime: 3000,
						content: '仅原文',
						translations: [],
						isDynamic: false,
						spans: [],
					},
				],
			},
			123,
		),
		offsetMs: -450,
	}
}

void test('legacy six-key lyrics and current seven-key online lyrics export, inspect, stage and merge losslessly without importing display preferences', () => {
	const source = fixture(),
		staged = setup(),
		target = setup()
	try {
		const library = new Library(source.db),
			destination = new Library(target.db)
		const lyrics = new LyricsStore(library)
		const sourceId = 'bilibili:BV1vT411i7ET:123'
		const saved = onlineSavedLyrics(sourceId)
		const legacyId = 'local:12345678-1234-1234-1234-123456789abc'
		const legacy: SavedLyrics = {
			version: 1,
			sourceId: legacyId,
			filename: 'legacy.lrc',
			importedAt: 1,
			raw: '[00:01.00]旧原文',
			offsetMs: 500,
		}
		lyrics.save(legacy)
		writeLyricsDisplayOptions(library, { translation: false, romaji: true })
		writeLyricsDisplayOptions(destination, { translation: true, romaji: false })
		for (const provider of ['netease', 'qqmusic', 'kugou'] as const) {
			lyrics.save(onlineSavedLyrics(sourceId, provider))
			const text = exportLibraryBackup(source.db, 123)
			const inspected = parseLibraryBackup(text)
			assert.equal(
				inspected.tables.settings.some(
					(row) => row.key === lyricsDisplaySettingsKey,
				),
				false,
			)
			const archived = JSON.parse(
				String(
					inspected.tables.settings.find(
						(row) => row.key === lyricsStoragePrefix + sourceId,
					)!.value,
				),
			) as SavedLyrics
			assert.deepEqual(archived, onlineSavedLyrics(sourceId, provider))
			assert.equal(Object.keys(archived).length, 7)
			assert.equal(
				Object.hasOwn(archived.online!.lines[1], 'translation'),
				false,
			)
			assert.equal(Object.hasOwn(archived.online!.lines[1], 'romaji'), false)
			assert.equal(
				Object.keys(
					JSON.parse(
						String(
							inspected.tables.settings.find(
								(row) => row.key === lyricsStoragePrefix + legacyId,
							)!.value,
						),
					),
				).length,
				6,
			)
			const same = mergeLibraryBackup(source.db, text)
			assert.equal(same.inserted, 0)
			assert.deepEqual(lyrics.get(sourceId), archived)
			assert.deepEqual(lyrics.get(legacyId), legacy)
			assert.deepEqual(readLyricsDisplayOptions(library), {
				translation: false,
				romaji: true,
			})
		}
		lyrics.save(saved)
		const archive = exportLibraryBackup(source.db, 123)
		stageLibraryBackup(staged.db, archive)
		assert.deepEqual(
			new LyricsStore(new Library(staged.db)).get(sourceId),
			saved,
		)
		assert.deepEqual(
			new LyricsStore(new Library(staged.db)).get(legacyId),
			legacy,
		)
		assert.ok(mergeLibraryBackup(target.db, archive).inserted > 0)
		assert.deepEqual(new LyricsStore(destination).get(sourceId), saved)
		assert.deepEqual(new LyricsStore(destination).get(legacyId), legacy)
		assert.deepEqual(readLyricsDisplayOptions(destination), {
			translation: true,
			romaji: false,
		})
		assert.equal(mergeLibraryBackup(target.db, archive).inserted, 0)
		assert.deepEqual(new LyricsStore(destination).get(sourceId), saved)
	} finally {
		source.raw.close()
		staged.raw.close()
		target.raw.close()
	}
})

void test('online lyric archives retain strict field, identity, provider, time and size guards in export, inspection and restoration', () => {
	const source = fixture(),
		staged = setup(),
		target = fixture()
	try {
		const library = new Library(source.db)
		const id = 'bilibili:BV1vT411i7ET:123',
			key = lyricsStoragePrefix + id
		const valid = onlineSavedLyrics(id)
		new LyricsStore(library).save(valid)
		const original = exportLibraryBackup(source.db, 123)
		const targetBefore = exportLibraryBackup(target.db, 123)
		type Payload = Record<string, unknown> & {
			online: Record<string, unknown> & { lines: Record<string, unknown>[] }
		}
		const corruptions: [string, (value: Payload) => void][] = [
			[
				'unknown top key',
				(value) => {
					value.extra = true
				},
			],
			[
				'missing base key',
				(value) => {
					delete value.offsetMs
				},
			],
			[
				'different source',
				(value) => {
					value.sourceId = 'bilibili:BV1vT411i7ET:124'
				},
			],
			[
				'unknown online key',
				(value) => {
					value.online.extra = true
				},
			],
			[
				'credential online key',
				(value) => {
					value.online.authorization = 'controlled-secret'
				},
			],
			[
				'unknown line key',
				(value) => {
					value.online.lines[0].extra = true
				},
			],
			[
				'credential URL',
				(value) => {
					value.online.title = 'https://example.invalid/?token=controlled'
				},
			],
			[
				'provider',
				(value) => {
					value.online.provider = 'unsupported'
				},
			],
			[
				'remote identity',
				(value) => {
					value.online.remoteId = 'invalid/id'
				},
			],
			[
				'missing line end',
				(value) => {
					delete value.online.lines[0].endMs
				},
			],
			[
				'end before start',
				(value) => {
					value.online.lines[0].endMs = 0
				},
			],
			[
				'unordered lines',
				(value) => {
					value.online.lines[1].atMs = 0
				},
			],
			[
				'translation type',
				(value) => {
					value.online.lines[0].translation = true
				},
			],
			[
				'translation size',
				(value) => {
					value.online.lines[0].translation = 'a'.repeat(4097)
				},
			],
			[
				'romaji size',
				(value) => {
					value.online.lines[0].romaji = 'a'.repeat(4097)
				},
			],
			[
				'raw size',
				(value) => {
					value.raw = 'a'.repeat(maxLyricsBytes + 1)
				},
			],
			[
				'line count',
				(value) => {
					value.online.lines = Array.from({ length: 4001 }, () => ({
						text: 'line',
						atMs: 1,
						endMs: 2,
					}))
				},
			],
		]
		for (const [name, corrupt] of corruptions) {
			const value = JSON.parse(JSON.stringify(valid)) as Payload
			corrupt(value)
			const stored = JSON.stringify(value)
			library.setSetting(key, stored)
			assert.throws(() => exportLibraryBackup(source.db, 123), name)
			assert.equal(
				library.setting(key),
				stored,
				'failed export cannot rewrite stored lyrics',
			)
			const archive = JSON.parse(original) as LibraryBackup
			archive.tables.settings.find((row) => row.key === key)!.value = stored
			const text = JSON.stringify(archive)
			assert.throws(() => parseLibraryBackup(text), name)
			assert.throws(() => stageLibraryBackup(staged.db, text), name)
			assert.equal(staged.db.getAllSync('SELECT * FROM settings', []).length, 0)
			assert.throws(() => mergeLibraryBackup(target.db, text), name)
			assert.equal(exportLibraryBackup(target.db, 123), targetBefore)
		}
		new LyricsStore(library).save(valid)
		assert.equal(exportLibraryBackup(source.db, 123), original)
	} finally {
		source.raw.close()
		staged.raw.close()
		target.raw.close()
	}
})
void test('catalogue round trip preserves local IDs, repeated occurrences and pending imports without account settings', () => {
	const source = fixture(),
		target = setup()
	try {
		const text = exportLibraryBackup(source.db, 123)
		assert.equal(text.includes('synthetic-secret'), false)
		assert.equal(text.includes('privateAssetPath'), false)
		const summary = stageLibraryBackup(target.db, text)
		assert.equal(summary.localReferences, 1)
		assert.equal(summary.pendingItems, 1)
		assert.equal(summary.playlistItems, 3)
		assert.deepEqual(
			JSON.parse(exportLibraryBackup(target.db, 123)),
			JSON.parse(text),
		)
		assert.equal(
			target.db.getAllSync('SELECT * FROM playback_sources', []).length,
			2,
		)
		assert.deepEqual(target.db.getAllSync('PRAGMA foreign_key_check', []), [])
		assert.equal(
			target.db.getAllSync('SELECT * FROM creator_subscriptions', []).length,
			1,
		)
		assert.equal(
			target.db.getFirstSync<{ positionSeconds: number }>(
				'SELECT positionSeconds FROM resume_points',
				[],
			)?.positionSeconds,
			30,
		)
		assert.ok(summary.exclusions.includes('audio-files'))
		assert.ok(summary.exclusions.includes('native-play-history'))
	} finally {
		source.raw.close()
		target.raw.close()
	}
})
void test('staging refuses nonempty destinations including unrelated native projections without changing them', () => {
	const source = fixture(),
		target = setup()
	try {
		new Library(target.db).setSetting('theme', 'anime')
		assert.throws(
			() => stageLibraryBackup(target.db, exportLibraryBackup(source.db)),
			/空白临时/,
		)
		assert.equal(new Library(target.db).setting('theme'), 'anime')
		assert.equal(target.db.getAllSync('SELECT * FROM playlists', []).length, 0)
	} finally {
		source.raw.close()
		target.raw.close()
	}
})
void test('foreign-key failure rolls back every inserted record and allows a subsequent valid staging operation', () => {
	const source = fixture(),
		target = setup()
	try {
		const valid = exportLibraryBackup(source.db)
		const broken = JSON.parse(valid)
		broken.tables.likes[0].sourceId =
			'local:ffffffff-ffff-ffff-ffff-ffffffffffff'
		assert.throws(() => stageLibraryBackup(target.db, JSON.stringify(broken)))
		assert.equal(
			target.db.getAllSync('SELECT * FROM local_audio', []).length,
			0,
		)
		assert.equal(
			target.db.getAllSync('SELECT * FROM playback_sources', []).length,
			0,
		)
		assert.equal(stageLibraryBackup(target.db, valid).liked, 1)
	} finally {
		source.raw.close()
		target.raw.close()
	}
})
void test('unknown versions, columns, duplicate identities, settings and credential-bearing JSON are rejected', () => {
	const f = fixture()
	try {
		const original = exportLibraryBackup(f.db)
		const mutations = [
			(v: { version: number; tables: LibraryBackup['tables'] }) => {
				v.version = 2
			},
			(v: { version: number; tables: LibraryBackup['tables'] }) => {
				v.tables.sources.push({ id: 'BVfake' })
			},
			(v: { version: number; tables: LibraryBackup['tables'] }) => {
				v.tables.local_audio.push(v.tables.local_audio[0])
			},
			(v: { version: number; tables: LibraryBackup['tables'] }) => {
				v.tables.settings.push({ key: 'cookie', value: 'secret' })
			},
			(v: { version: number; tables: LibraryBackup['tables'] }) => {
				v.tables.import_tasks[0].snapshotJson =
					'{"nested":{"access_token":"synthetic"}}'
			},
			(v: { version: number; tables: LibraryBackup['tables'] }) => {
				v.tables.import_tasks[0].snapshotJson =
					'{"url":"https://example.com/?token=synthetic"}'
			},
			(v: { version: number; tables: LibraryBackup['tables'] }) => {
				v.tables.playlists[0].coverUri = 'file:///private-cover'
			},
			(v: { version: number; tables: LibraryBackup['tables'] }) => {
				v.tables.local_audio[0].id = 'bilibili:BV1vT411i7ET:123'
			},
		]
		for (const mutate of mutations) {
			const value = JSON.parse(original)
			mutate(value)
			assert.throws(() => parseLibraryBackup(JSON.stringify(value)))
		}
		assert.throws(() => parseLibraryBackup('{broken'))
		assert.equal(
			summarizeLibraryBackup(parseLibraryBackup(original)).importTasks,
			1,
		)
	} finally {
		f.raw.close()
	}
})
void test('custom cover paths are explicitly excluded, never copied as broken portable files', () => {
	const f = fixture()
	try {
		f.db.runSync('UPDATE playlists SET coverUri = ?', [
			'file:///app-private/cover.png',
		])
		const backup = parseLibraryBackup(exportLibraryBackup(f.db))
		assert.equal(backup.tables.playlists[0].coverUri, null)
		assert.equal(
			f.db.getFirstSync<{ coverUri: string }>(
				'SELECT coverUri FROM playlists',
				[],
			)?.coverUri,
			'file:///app-private/cover.png',
		)
	} finally {
		f.raw.close()
	}
})

void test('additive merge keeps existing preferences and repeats idempotently', () => {
	const source = fixture(),
		target = setup()
	try {
		const text = exportLibraryBackup(source.db)
		new Library(target.db).setSetting('reducedMotion', 'false')
		const result = mergeLibraryBackup(target.db, text)
		assert.ok(result.inserted > 0)
		assert.equal(result.keptExisting, 1)
		assert.equal(new Library(target.db).setting('reducedMotion'), 'false')
		assert.equal(mergeLibraryBackup(target.db, text).inserted, 0)
		assert.equal(
			target.db.getAllSync('SELECT * FROM playlist_items', []).length,
			3,
		)
	} finally {
		source.raw.close()
		target.raw.close()
	}
})
void test('existing playlist preserves its whole import component instead of mixing order', () => {
	const source = fixture(),
		target = setup()
	try {
		new PlaylistStore(target.db).create('p', '当前名称不能覆盖')
		const result = mergeLibraryBackup(target.db, exportLibraryBackup(source.db))
		assert.equal(result.skippedGroups, 2)
		assert.equal(
			target.db.getAllSync('SELECT * FROM import_tasks', []).length,
			0,
		)
		assert.equal(
			target.db.getAllSync('SELECT * FROM playlist_items', []).length,
			0,
		)
		assert.equal(
			new PlaylistStore(target.db).get('p')?.name,
			'当前名称不能覆盖',
		)
	} finally {
		source.raw.close()
		target.raw.close()
	}
})

void test('explicit replacement checkpoints atomically, preserves excluded settings and allows safe undo', () => {
	const source = fixture(),
		target = setup()
	try {
		new PlaylistStore(target.db).create('old', '替换前歌单')
		new Library(target.db).setSetting('authorization', 'synthetic-keep-local')
		replaceLibraryBackup(target.db, exportLibraryBackup(source.db), resolve)
		assert.equal(new PlaylistStore(target.db).get('old'), null)
		assert.equal(new PlaylistStore(target.db).get('p')?.items.length, 3)
		assert.equal(
			new Library(target.db).setting('authorization'),
			'synthetic-keep-local',
		)
		assert.equal(hasLibraryBackupUndo(target.db), true)
		undoLibraryBackupReplacement(target.db, resolve)
		assert.equal(new PlaylistStore(target.db).get('old')?.name, '替换前歌单')
		assert.equal(new PlaylistStore(target.db).get('p'), null)
		assert.equal(hasLibraryBackupUndo(target.db), false)
		assert.equal(
			target.db.getAllSync('SELECT * FROM local_audio', []).length,
			1,
		)
	} finally {
		source.raw.close()
		target.raw.close()
	}
})
void test('replacement failure restores prior contents and a newer user edit blocks automatic undo', () => {
	const source = fixture(),
		target = setup()
	try {
		new PlaylistStore(target.db).create('old', '原样')
		const valid = exportLibraryBackup(source.db)
		const broken = JSON.parse(valid)
		broken.tables.likes[0].sourceId =
			'local:ffffffff-ffff-ffff-ffff-ffffffffffff'
		assert.throws(() =>
			replaceLibraryBackup(target.db, JSON.stringify(broken), resolve),
		)
		assert.equal(new PlaylistStore(target.db).get('old')?.name, '原样')
		assert.equal(hasLibraryBackupUndo(target.db), false)
		replaceLibraryBackup(target.db, valid, resolve)
		new PlaylistStore(target.db).create('new', '后来编辑')
		assert.throws(
			() => undoLibraryBackupReplacement(target.db, resolve),
			/资料已发生变化/,
		)
		assert.equal(new PlaylistStore(target.db).get('new')?.name, '后来编辑')
		assert.equal(hasLibraryBackupUndo(target.db), true)
	} finally {
		source.raw.close()
		target.raw.close()
	}
})
void test('full catalogue relocates private covers while lightweight clears references', () => {
	const source = fixture(),
		target = setup()
	try {
		source.db.runSync("DELETE FROM settings WHERE key = 'theme.state.v1'", [])
		source.db.runSync('UPDATE playlists SET coverUri = ?', [
			'file:///old-device/melo-playlist-covers/cover-abc-123',
		])
		assert.equal(
			parseLibraryBackup(exportLibraryBackup(source.db)).tables.playlists[0]
				.coverUri,
			null,
		)
		const full = exportLibraryBackup(source.db, 123, true)
		assert.equal(
			parseLibraryBackup(full).tables.playlists[0].coverUri,
			'melo-backup-cover:cover-abc-123',
		)
		assert.throws(() => mergeLibraryBackup(target.db, full), /尚未绑定/)
		mergeLibraryBackup(
			target.db,
			full,
			(name) => `file:///new-device/melo-playlist-covers/${name}`,
		)
		assert.equal(
			new PlaylistStore(target.db).get('p')?.coverUri,
			'file:///new-device/melo-playlist-covers/cover-abc-123',
		)
	} finally {
		source.raw.close()
		target.raw.close()
	}
})
void test('approved history, music preferences and source-bound lyrics survive the settings whitelist', () => {
	const source = fixture(),
		target = setup()
	try {
		const library = new Library(source.db)
		library.setSetting(
			'searchHistory.v1',
			JSON.stringify([
				{ query: 'synthetic song', kind: 'music', order: 'relevance' },
			]),
		)
		library.setSetting(
			'music.preferences.v1',
			JSON.stringify({
				version: 1,
				welcomeCompleted: true,
				genres: ['流行'],
				artists: [],
			}),
		)
		const id = 'local:12345678-1234-1234-1234-123456789abc'
		library.setSetting(
			`melo.lyrics.v1:${id}`,
			JSON.stringify({
				version: 1,
				sourceId: id,
				filename: 'test.lrc',
				importedAt: 1,
				raw: '[00:01.00]合成歌词',
				offsetMs: 0,
			}),
		)
		const backup = exportLibraryBackup(source.db)
		stageLibraryBackup(target.db, backup)
		assert.equal(
			new Library(target.db).setting('searchHistory.v1'),
			library.setting('searchHistory.v1'),
		)
		assert.equal(
			new Library(target.db).setting(`melo.lyrics.v1:${id}`),
			library.setting(`melo.lyrics.v1:${id}`),
		)
	} finally {
		source.raw.close()
		target.raw.close()
	}
})

void test('backup preferences reject control characters using the production preference parser', () => {
	const f = fixture()
	try {
		new Library(f.db).setSetting(
			'music.preferences.v1',
			JSON.stringify({
				version: 1,
				welcomeCompleted: true,
				genres: ['rock\u0001'],
				artists: [],
			}),
		)
		assert.throws(() => parseLibraryBackup(exportLibraryBackup(f.db)), /偏好/)
	} finally {
		f.raw.close()
	}
})
