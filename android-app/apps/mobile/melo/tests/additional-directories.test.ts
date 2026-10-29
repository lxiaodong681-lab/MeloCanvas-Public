import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { readAdditionalDirectory } from '../additional-directories'
import { migrate, migrations, type Database } from '../core/database'
import { ImportStore } from '../core/imports'
import type { DirectoryFetch } from '../directory-http'
import {
	readExternalDirectory,
	parseExternalDirectoryUrl,
	DirectoryReadError,
} from '../external-directory'

const encode = (data: unknown) =>
	new TextEncoder().encode(
		typeof data === 'string' ? data : JSON.stringify(data),
	)
function transport(
	respond: (url: string, body?: string) => unknown,
): DirectoryFetch {
	return async (url, init) => {
		assert.equal(init.credentials, 'omit')
		assert.equal(init.redirect, 'error')
		const bytes = encode(respond(url, init.body))
		return {
			url,
			status: 200,
			redirected: false,
			headers: { get: () => null },
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(bytes)
					controller.close()
				},
			}),
		}
	}
}
const input = (url: string) => ({
	url,
	taskId: 'public-example',
	taskVersion: 1,
})
const song = (id: number) => ({
	rid: id,
	name: '合成歌曲',
	artist: '合成歌手',
	album: '合成专辑',
	duration: 180,
})
void test('official full routes parse strictly and reject lookalike hosts, credentials and duplicate identities', () => {
	for (const url of [
		'https://m.kuwo.cn/newh5app/playlist_detail/123',
		'https://www.qishui.com/share/playlist?playlist_id=123',
		'https://www.kugou.com/songlist/gcid_example/',
	])
		assert.ok(parseExternalDirectoryUrl(url))
	for (const url of [
		'https://www.kuwo.cn.evil.test/playlist_detail/123',
		'https://x@www.qishui.com/share/playlist?playlist_id=123',
		'https://www.qishui.com/share/playlist?playlist_id=123&playlist_id=456',
		'https://qishui.douyin.com/s/short/',
	])
		assert.throws(() => parseExternalDirectoryUrl(url))
})
void test('Kuwo preserves all page occurrences and rejects repeated pages or changed totals', async () => {
	const run = (respond: (url: string) => unknown) =>
		readExternalDirectory(
			input('https://www.kuwo.cn/playlist_detail/123'),
			(ref, signal) => readAdditionalDirectory(ref, transport(respond), signal),
		)
	const result = await run((url) => ({
		code: 200,
		data: {
			id: 123,
			name: '合成目录',
			total: 2,
			musicList: [song(new URL(url).searchParams.get('pn') === '1' ? 1 : 2)],
		},
	}))
	assert.equal(result.entries.length, 2)
	assert.equal(result.provider, 'kuwo')
	await assert.rejects(
		run(() => ({
			code: 200,
			data: { id: 123, name: '合成目录', total: 3, musicList: [song(1)] },
		})),
		/相同分页/,
	)
})
const payload = (id: string, more: boolean, cursor: string) => ({
	playlist: { id: '7087507348697186339', title: '合成目录', count_tracks: 2 },
	has_more: more ? true : undefined,
	next_cursor: cursor,
	media_resources: [
		{
			id,
			type: 'track',
			entity: {
				track_wrapper: {
					track: {
						id,
						name: '合成曲',
						duration: 180000,
						artists: [{ name: '甲' }],
						album: { name: '乙' },
					},
				},
			},
		},
	],
})
void test('Qishui retains string IDs, follows cursors and verifies the reported song count', async () => {
	const read = (body?: string) =>
		JSON.parse(body!).cursor === '0'
			? payload('7087507348697186001', true, '200')
			: payload('7087507348697186002', false, '400')
	const result = await readExternalDirectory(
		input(
			'https://www.qishui.com/share/playlist?playlist_id=7087507348697186339',
		),
		(ref, signal) =>
			readAdditionalDirectory(
				ref,
				transport((_, body) => read(body)),
				signal,
			),
	)
	assert.deepEqual(
		result.entries.map((entry) => entry.originalEntryId),
		['7087507348697186001', '7087507348697186002'],
	)
})
void test('Kugou preview keeps the real total and returns incomplete evidence instead of claiming success', async () => {
	const data = {
		encode_gic: 'gcid_example',
		info: {
			listinfo: { name: '合成目录', count: 124 },
			songs: [
				{
					mixsongid: 1,
					name: '甲 - 乙',
					singerinfo: [{ name: '甲' }],
					albuminfo: { name: '丙' },
					timelen: 180000,
				},
			],
		},
	}
	await assert.rejects(
		readExternalDirectory(
			input('https://m.kugou.com/songlist/gcid_example/'),
			(ref, signal) =>
				readAdditionalDirectory(
					ref,
					transport(() => `window.$output = ${JSON.stringify(data)};`),
					signal,
				),
		),
		(error) =>
			error instanceof DirectoryReadError &&
			error.code === 'incomplete' &&
			error.diagnostics.expectedCount === 124 &&
			error.snapshot?.entries.length === 1,
	)
})
void test('provider schema upgrade preserves parent and child rows and restores foreign-key enforcement', () => {
	const raw = new DatabaseSync(':memory:')
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
	try {
		migrate(db, migrations.slice(0, -1))
		const store = new ImportStore(db)
		store.createDirectory({
			taskId: 'old',
			provider: 'netease',
			originalPlaylistId: '1',
			taskVersion: 1,
			originalMetadata: {},
			entries: [
				{
					entryId: 'entry',
					originalEntryId: '1',
					originalPosition: 0,
					originalMetadata: { name: 'old' },
				},
			],
		})
		const before = JSON.stringify(store.get('old'))
		assert.throws(
			() =>
				migrate({
					...db,
					execSync(sql) {
						if (sql.includes('CREATE TABLE import_tasks_extended')) {
							db.execSync(sql)
							throw new Error('injected interruption after parent rebuild')
						}
						db.execSync(sql)
					},
				}),
			/injected interruption/,
		)
		assert.equal(JSON.stringify(store.get('old')), before)
		assert.equal(
			raw.prepare('PRAGMA user_version').get()!.user_version,
			migrations.length - 1,
		)
		assert.equal(raw.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1)
		migrate(db)
		assert.equal(JSON.stringify(store.get('old')), before)
		for (const provider of ['kuwo', 'kugou', 'qishui'] as const)
			store.createDirectory({
				taskId: provider,
				provider,
				originalPlaylistId: '1',
				taskVersion: 1,
				originalMetadata: {},
				entries: [],
			})
		assert.equal(raw.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1)
		assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), [])
		assert.throws(() =>
			raw
				.prepare(
					"INSERT INTO import_tasks VALUES ('bad','bad','1',1,'{}',0,0,0)",
				)
				.run(),
		)
	} finally {
		raw.close()
	}
})
