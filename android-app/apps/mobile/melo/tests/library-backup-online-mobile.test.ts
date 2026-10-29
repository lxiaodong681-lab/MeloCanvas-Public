import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { runInNewContext } from 'node:vm'

import { Library, migrate, type Database } from '../core/database'
import * as backup from '../core/library-backup'
import { LyricsStore, lyricsStoragePrefix, type SavedLyrics } from '../lyrics'

import { compile } from './search-page-fixture'

const id = 'bilibili:BV1vT411i7ET:123'
const key = lyricsStoragePrefix + id
const legacy: SavedLyrics = {
	version: 1,
	sourceId: id,
	filename: 'controlled.lrc',
	importedAt: 1,
	raw: '[00:01.000]原文',
	offsetMs: 250,
}
const online: SavedLyrics = {
	...legacy,
	online: {
		provider: 'netease',
		remoteId: 123,
		title: '受控歌词',
		artist: '受控歌手',
		lines: [
			{
				text: '原文',
				atMs: 1000,
				endMs: 2000,
				translation: '译文',
				romaji: 'romaji',
			},
		],
	},
}

function connection() {
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

/** Actual mobile JS, catalogue validation and SQLite; only document/native ZIP IO are ports. */
function fixture(t: TestContext) {
	const live = connection()
	t.after(() => live.raw.close())
	const library = new Library(live.db)
	const preflights = new Map<string, ReturnType<typeof connection>>()
	const calls: string[] = []
	let catalogue = ''
	const inspected = () => ({
		token: 'controlled-token',
		catalogueJson: catalogue,
		full: false,
		audioFiles: 0,
		themeFiles: 0,
		coverFiles: 0,
		bytes: catalogue.length,
	})
	const output = {} as typeof import('../library-backup-mobile')
	runInNewContext(
		compile(
			readFileSync(
				new URL('../library-backup-mobile.ts', import.meta.url),
				'utf8',
			),
		),
		{
			exports: output,
			require: (dependency: string): unknown => {
				if (dependency === 'expo-document-picker')
					return {
						getDocumentAsync: async () => ({
							canceled: false,
							assets: [{ uri: 'content://controlled/backup.zip' }],
						}),
					}
				if (dependency === 'expo-file-system') return {}
				if (dependency === 'expo-sqlite')
					return {
						openDatabaseSync: (name: string) => {
							if (name === 'melocanvas.db')
								return { ...live.db, closeSync: () => {} }
							const fresh = connection()
							assert.equal(preflights.has(name), false)
							preflights.set(name, fresh)
							return { ...fresh.db, closeSync: () => fresh.raw.close() }
						},
						deleteDatabaseSync: (name: string) => {
							assert.equal(preflights.delete(name), true)
						},
					}
				if (dependency === './core/database') return { migrate }
				if (dependency === './core/library-backup') return backup
				if (dependency.endsWith('/LibraryBackupModule'))
					return {
						getLibraryBackupModule: () => ({
							saveAsync: async (text: string, full: boolean) => {
								assert.equal(full, false)
								backup.parseLibraryBackup(text)
								catalogue = text
								calls.push('save')
								return true
							},
							inspectAsync: async (uri: string) => {
								assert.equal(uri, 'content://controlled/backup.zip')
								calls.push('inspect')
								return inspected()
							},
							publishFilesAsync: async (token: string) => {
								assert.equal(token, 'controlled-token')
								calls.push('publish')
							},
							discardAsync: async (token: string) => {
								assert.equal(token, 'controlled-token')
								calls.push('discard')
							},
						}),
					}
				throw new Error(`Unexpected backup dependency ${dependency}`)
			},
		},
	)
	return {
		mobile: output,
		library,
		calls,
		inspected,
		replaceCatalogue: (text: string) => {
			catalogue = text
		},
		pendingPreflights: () => preflights.size,
	}
}

void test('actual mobile save reaches its native port for six-key and online seven-key lyrics, then inspects and merges that same catalogue', async (t) => {
	const f = fixture(t),
		lyrics = new LyricsStore(f.library)
	for (const value of [legacy, online]) {
		f.calls.length = 0
		lyrics.save(value)
		const before = f.library.setting(key)
		assert.equal(await f.mobile.saveLibraryBackup(false), true)
		assert.deepEqual(f.calls, ['save'])
		const selected = await f.mobile.chooseLibraryBackup()
		assert.ok(selected)
		assert.deepEqual(f.calls, ['save', 'inspect'])
		assert.equal(
			f.library.setting(key),
			before,
			'inspection never writes live lyrics',
		)
		const result = await f.mobile.restoreLibraryBackup(selected, 'merge')
		assert.equal(result.inserted, 0)
		assert.deepEqual(f.calls, ['save', 'inspect', 'publish', 'discard'])
		assert.deepEqual(lyrics.get(id), value)
		assert.equal(f.pendingPreflights(), 0)
	}
})

void test('invalid online payload never reaches native save or publication; inspect discards staging and restoration keeps current lyrics', async (t) => {
	const f = fixture(t),
		lyrics = new LyricsStore(f.library)
	lyrics.save(online)
	await f.mobile.saveLibraryBackup(false)
	const inspected = f.inspected()
	const archive = JSON.parse(inspected.catalogueJson) as backup.LibraryBackup
	const row = archive.tables.settings.find((entry) => entry.key === key)!
	const payload = JSON.parse(String(row.value)) as {
		online: { lines: Record<string, unknown>[] }
	}
	payload.online.lines[0].extra = 'unsupported'
	row.value = JSON.stringify(payload)
	f.replaceCatalogue(JSON.stringify(archive))
	f.calls.length = 0
	const before = f.library.setting(key)
	await assert.rejects(f.mobile.chooseLibraryBackup())
	assert.deepEqual(f.calls, ['inspect', 'discard'])
	assert.equal(f.library.setting(key), before)
	f.calls.length = 0
	await assert.rejects(f.mobile.restoreLibraryBackup(f.inspected(), 'merge'))
	assert.deepEqual(f.calls, [])
	assert.equal(f.library.setting(key), before)
	assert.equal(f.pendingPreflights(), 0)
	f.library.setSetting(key, row.value)
	await assert.rejects(f.mobile.saveLibraryBackup(false))
	assert.deepEqual(f.calls, [])
	assert.equal(f.library.setting(key), row.value)
})
