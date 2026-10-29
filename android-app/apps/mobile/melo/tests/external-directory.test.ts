import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { migrate, type Database } from '../core/database'
import { importTaskLimits } from '../core/import-types'
import { ImportStore } from '../core/imports'
import {
	DirectoryReadError,
	externalDirectoryLimits,
	parseExternalDirectoryUrl,
	readExternalDirectory,
	type ExternalDirectoryInput,
} from '../external-directory'
import {
	createExternalDirectoryTransport,
	externalDirectoryRequest,
	type DirectoryFetch,
	type DirectoryHttpResponse,
} from '../external-directory-transport'

const input: ExternalDirectoryInput = {
	url: 'https://music.163.com/playlist?id=123',
	taskId: 'directory-1',
	taskVersion: 1,
}
const encode = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value))
const song = (id: number, name = `原曲${id}`) => ({
	id,
	name,
	ar: [{ id: 9, name: '原表演者', alias: ['别名'] }],
	al: { id: 7, name: '原专辑', picUrl: 'https://example.invalid/cover' },
	dt: 300001,
	alia: ['原别名'],
	tns: ['译名'],
	custom: { keep: true },
})
function netease(tracks = [song(1), song(2), song(1)]) {
	return {
		code: 200,
		privileges: [{ id: 1, st: -1 }],
		playlist: {
			id: 123,
			name: '原歌单',
			description: '完整原说明',
			trackCount: tracks.length,
			trackIds: tracks.map((track) => ({
				id: (track as { id: number }).id,
				v: 2,
			})),
			tracks,
			creator: { userId: 5, nickname: '原作者' },
			tags: ['原标签'],
		},
	}
}
function qq(
	tracks = [1, 2, 1].map((id) => ({
		id,
		mid: `mid${id}`,
		name: `原曲${id}`,
		title: `原标题${id}`,
		subtitle: '副标题',
		singer: [{ id: 1, mid: 'artist', name: '原歌手' }],
		album: { id: 2, mid: 'album', name: '原专辑' },
		interval: 300,
		custom: { keep: true },
	})),
) {
	return {
		code: 0,
		data: {
			cdlist: [
				{
					disstid: '456',
					dissname: 'QQ 原歌单',
					desc: '原说明',
					songnum: tracks.length,
					songlist: tracks,
					nickname: '原作者',
				},
			],
		},
	}
}
async function decode(
	value: unknown,
	overrides: Partial<ExternalDirectoryInput> = {},
) {
	return readExternalDirectory({ ...input, ...overrides }, async () =>
		encode(value),
	)
}
async function rejects(
	value: unknown,
	code: DirectoryReadError['code'],
	overrides: Partial<ExternalDirectoryInput> = {},
) {
	await assert.rejects(
		decode(value, overrides),
		(error: unknown) =>
			error instanceof DirectoryReadError && error.code === code,
	)
}
function response(
	chunks: Uint8Array[],
	extra: Partial<DirectoryHttpResponse> = {},
) {
	let reads = 0,
		cancelled = 0,
		released = 0
	return {
		get reads() {
			return reads
		},
		get cancelled() {
			return cancelled
		},
		get released() {
			return released
		},
		response: {
			status: 200,
			url: '',
			redirected: false,
			headers: { get: () => null },
			body: {
				getReader: () => ({
					read: async () =>
						reads < chunks.length
							? { done: false, value: chunks[reads++] }
							: { done: true },
					cancel: async () => {
						cancelled++
					},
					releaseLock: () => {
						released++
					},
				}),
			},
			...extra,
		} satisfies DirectoryHttpResponse,
	}
}
function fetchFixture(fixture: ReturnType<typeof response>) {
	const calls: Parameters<DirectoryFetch>[] = []
	const transport = createExternalDirectoryTransport(async (url, init) => {
		calls.push([url, init])
		return { ...fixture.response, url: fixture.response.url || url }
	})
	return { calls, transport }
}

void test('strict platform playlist links use exact hosts/routes and preserve string IDs', () => {
	for (const url of [
		'https://music.163.com/playlist?id=123',
		'https://music.163.com/#/playlist?id=123&userid=9',
		'https://music.163.com/m/playlist?id=123',
		'网易云 https://y.music.163.com/m/playlist?id=123 (来自@网易云音乐)',
	])
		assert.deepEqual(parseExternalDirectoryUrl(url), {
			provider: 'netease',
			originalPlaylistId: '123',
		})
	for (const url of [
		'https://y.qq.com/n/ryqq/playlist/900719925474099312345',
		'https://y.qq.com/n/m/detail/taoge/index.html?id=900719925474099312345',
	])
		assert.deepEqual(parseExternalDirectoryUrl(url), {
			provider: 'qq',
			originalPlaylistId: '900719925474099312345',
		})
	for (const url of [
		'https://music.163.com.evil/playlist?id=123',
		'https://evil/music.163.com/playlist?id=123',
		'https://music.163.com@evil/playlist?id=123',
		'https://u:secret@music.163.com/playlist?id=123',
		'https://music.163.com:444/playlist?id=123',
		'https://music.163.com/song?id=123',
		'https://y.qq.com/evil?id=123',
		'https://c.y.qq.com/playlist?id=123',
		'https://163cn.tv/short',
		'https://c6.y.qq.com/short',
		'https://music.163.com/playlist?id=1&id=1',
		'https://music.163.com/playlist?id=1&id=2',
		'https://music.163.com/playlist?id=01',
		'https://music.163.com/playlist?id=1#other',
		'https://y.qq.com/n/ryqq/playlist/123?id=123',
		'http://music.163.com/playlist?id=123',
		'https://music.163.com\\@evil/playlist?id=123',
	])
		assert.throws(() => parseExternalDirectoryUrl(url), DirectoryReadError, url)
})

void test('both platforms preserve ordered A/B/A occurrences and complete original metadata', async () => {
	for (const [raw, url, expectedIds] of [
		[netease(), input.url, ['1', '2', '1']],
		[qq(), 'https://y.qq.com/n/ryqq/playlist/456', ['mid1', 'mid2', 'mid1']],
	] as const) {
		const snapshot = await decode(raw, { url })
		assert.deepEqual(
			snapshot.entries.map((entry) => entry.originalEntryId),
			expectedIds,
		)
		assert.deepEqual(
			snapshot.entries.map((entry) => entry.originalPosition),
			[0, 1, 2],
		)
		assert.equal(
			new Set(snapshot.entries.map((entry) => entry.entryId)).size,
			3,
		)
		assert.equal(snapshot.entries[2].entryId.endsWith(':position:2'), true)
		assert.deepEqual(
			(snapshot.entries[0].originalMetadata.track as Record<string, unknown>)
				.custom,
			{ keep: true },
		)
		assert.equal(snapshot.taskId, input.taskId)
		assert.equal(snapshot.taskVersion, input.taskVersion)
		assert.deepEqual(snapshot, await decode(raw, { url }))
		assert.equal(
			snapshot.originalMetadata.directory &&
				(snapshot.originalMetadata.directory as Record<string, unknown>).status,
			'complete',
		)
		assert(!('candidates' in snapshot.entries[0]))
		assert(!('source' in snapshot.entries[0]))
	}
})

void test('complete snapshots and incomplete evidence both satisfy the real ImportStore contract', async () => {
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
		migrate(db)
		const store = new ImportStore(db)
		const full = await decode(netease())
		assert.equal(store.createDirectory(full).entries.length, 3)
		const partial = netease()
		partial.playlist.tracks = partial.playlist.tracks.slice(0, 2)
		await assert.rejects(
			decode(partial, { taskId: 'partial', taskVersion: 2 }),
			(error: unknown) => {
				assert(
					error instanceof DirectoryReadError &&
						error.code === 'incomplete' &&
						error.snapshot,
				)
				assert.equal(error.diagnostics.knownIdentityCount, 3)
				assert.equal(error.diagnostics.readMetadataCount, 2)
				assert.equal(error.snapshot.entries[2].originalEntryId, '1')
				assert.equal(error.snapshot.entries[2].originalMetadata.track, null)
				assert.equal(
					error.snapshot.entries[2].originalMetadata.metadataStatus,
					'unread',
				)
				assert.equal(store.createDirectory(error.snapshot).entries.length, 3)
				return true
			},
		)
		await assert.rejects(
			decode(netease(), { taskId: 'partial', taskVersion: 2 }).then(
				(snapshot) => store.createDirectory(snapshot),
			),
			/快照|目录|冲突/,
		)
		assert.equal(store.get('partial')?.entries[2].originalMetadata.track, null)
	} finally {
		raw.close()
	}
})

void test('true empty requires explicit zero and list; missing/null/contradictory fields never become empty', async () => {
	assert.equal((await decode(netease([]))).entries.length, 0)
	assert.equal(
		(await decode(qq([]), { url: 'https://y.qq.com/n/ryqq/playlist/456' }))
			.entries.length,
		0,
	)
	for (const value of [
		null,
		[],
		{},
		{ code: 200 },
		{ code: 200, playlist: null },
		{ code: 200, playlist: { id: 123, name: 'x', trackCount: 0 } },
		{
			code: 200,
			playlist: { id: 123, name: 'x', trackCount: 0, tracks: null },
		},
		{ code: 200, playlist: { id: 123, name: 'x', tracks: [] } },
		{ code: 200, playlist: { id: 999, name: 'x', trackCount: 0, tracks: [] } },
		{
			code: 200,
			playlist: { id: 123, name: 'x', trackCount: 0, tracks: [song(1)] },
		},
	])
		await rejects(value, 'response')
	for (const value of [
		{ code: 0 },
		{ code: 0, data: {} },
		{ code: 0, data: { cdlist: [] } },
		{ code: 0, data: { cdlist: [{}, {}] } },
	])
		await rejects(value, 'response', {
			url: 'https://y.qq.com/n/ryqq/playlist/456',
		})
})

void test('platform failure preserves only proven codes and never pretends an absent playlist succeeded', async () => {
	await assert.rejects(
		decode({ code: 301, message: 'platform detail' }),
		(error: unknown) => {
			assert(error instanceof DirectoryReadError)
			assert.equal(error.code, 'platform')
			assert.deepEqual(error.diagnostics, { platformCode: 301 })
			assert.equal(error.snapshot, undefined)
			return true
		},
	)
	await rejects({ code: 1000 }, 'platform', {
		url: 'https://y.qq.com/n/ryqq/playlist/456',
	})
})

void test('preserve a common 287-track directory with a large original privileges envelope', async () => {
	const privileges = Array.from({ length: 287 }, (_, index) => ({
		id: index + 1,
		originalPermissionEvidence: 'x'.repeat(900),
	}))
	const value = {
		...netease(Array.from({ length: 287 }, (_, index) => song(index + 1))),
		privileges,
	}
	const snapshot = await decode(value)
	assert.equal(snapshot.entries.length, 287)
	assert.deepEqual(
		(snapshot.originalMetadata.envelope as Record<string, unknown>).privileges,
		privileges,
	)
	assert(encode(snapshot.originalMetadata).byteLength > 64 * 1024)
	assert(encode(snapshot.originalMetadata).byteLength < 1024 * 1024)
})

void test('known IDs, metadata counts and missing positions remain distinct in partial evidence', async () => {
	const partial = netease()
	partial.playlist.tracks = []
	await assert.rejects(decode(partial), (error: unknown) => {
		assert(error instanceof DirectoryReadError && error.snapshot)
		assert.equal(error.code, 'incomplete')
		assert.equal(error.snapshot.entries.length, 3)
		assert.equal(error.diagnostics.knownIdentityCount, 3)
		assert.equal(error.diagnostics.readMetadataCount, 0)
		assert.equal(error.diagnostics.directoryIdentityPositionCount, 3)
		assert.equal(
			(error.snapshot.originalMetadata.directory as Record<string, unknown>)
				.positionBasis,
			'directory-identities',
		)
		assert.equal(error.diagnostics.unreadMetadataCount, 3)
		return true
	})
	const qqPartial = qq()
	qqPartial.data.cdlist[0].songlist.pop()
	await assert.rejects(
		decode(qqPartial, { url: 'https://y.qq.com/n/ryqq/playlist/456' }),
		(error: unknown) => {
			assert(error instanceof DirectoryReadError && error.snapshot)
			assert.equal(error.snapshot.entries.length, 2)
			assert.equal(error.diagnostics.expectedCount, 3)
			assert.equal(error.diagnostics.returnedEntryCount, 2)
			assert.equal(error.diagnostics.directoryIdentityPositionCount, 0)
			assert.equal(
				(error.snapshot.originalMetadata.directory as Record<string, unknown>)
					.positionBasis,
				'returned-order',
			)
			assert.deepEqual(
				error.snapshot.entries.map((entry) => entry.originalEntryId),
				['mid1', 'mid2'],
			)
			return true
		},
	)
	const noIds = {
		...partial,
		playlist: { ...partial.playlist, trackIds: undefined, tracks: [song(2)] },
	}
	await assert.rejects(decode(noIds), (error: unknown) => {
		assert(error instanceof DirectoryReadError && error.snapshot)
		assert.equal(error.diagnostics.returnedEntryCount, 1)
		assert.equal(error.diagnostics.directoryIdentityPositionCount, 0)
		assert.equal(
			(error.snapshot.originalMetadata.directory as Record<string, unknown>)
				.positionBasis,
			'returned-order',
		)
		assert.deepEqual(
			error.snapshot.entries.map((entry) => [
				entry.originalPosition,
				entry.originalEntryId,
			]),
			[[0, '2']],
		)
		return true
	})
	const missingName = netease()
	delete (missingName.playlist.tracks[1] as Partial<ReturnType<typeof song>>)
		.name
	await assert.rejects(decode(missingName), (error: unknown) => {
		assert(error instanceof DirectoryReadError && error.snapshot)
		assert.equal(error.code, 'incomplete')
		assert.equal(error.diagnostics.readMetadataCount, 2)
		assert(error.snapshot.entries[1].originalMetadata.track)
		return true
	})
})

void test('numeric IDs never lose precision; authoritative order and unknown fields remain preserved', async () => {
	const value = netease()
	value.playlist.trackIds.reverse()
	value.playlist.trackIds = [
		{ id: 2, v: 2 },
		{ id: 1, v: 2 },
		{ id: 1, v: 2 },
	]
	assert.deepEqual(
		(await decode(value)).entries.map((entry) => entry.originalEntryId),
		['2', '1', '1'],
	)
	const invalid = netease()
	invalid.playlist.tracks[1].id = Number.MAX_SAFE_INTEGER + 1
	await rejects(invalid, 'response')
	const outside = netease()
	outside.playlist.tracks[1].id = 99
	await rejects(outside, 'response')
	const strings = {
		code: 200,
		playlist: {
			id: '900719925474099312345',
			name: '原名',
			trackCount: 1,
			tracks: [{ ...song(1), id: '900719925474099398765' }],
		},
	}
	assert.equal(
		(
			await decode(strings, {
				url: 'https://music.163.com/playlist?id=900719925474099312345',
			})
		).entries[0].originalEntryId,
		'900719925474099398765',
	)
})

void test('5000/8MiB, metadata size and nesting failures never attach unbounded snapshots', async () => {
	for (const value of [
		{ code: 200, playlist: { ...netease([]).playlist, trackCount: 5001 } },
		{
			code: 200,
			playlist: {
				...netease().playlist,
				description: 'x'.repeat(importTaskLimits.playlistMetadataBytes),
			},
		},
		{
			code: 200,
			playlist: {
				...netease([song(1)]).playlist,
				tracks: [
					{
						...song(1),
						custom: { text: 'x'.repeat(importTaskLimits.entryMetadataBytes) },
					},
				],
			},
		},
	])
		await assert.rejects(
			decode(value),
			(error: unknown) =>
				error instanceof DirectoryReadError &&
				error.code === 'limit' &&
				!error.snapshot,
		)
	let nested: unknown = 'value'
	for (let n = 0; n < 9; n++) nested = { nested }
	await rejects({ ...netease(), deep: nested }, 'limit')
	await assert.rejects(
		readExternalDirectory(
			input,
			async () => new Uint8Array(externalDirectoryLimits.responseBytes + 1),
		),
		(error: unknown) =>
			error instanceof DirectoryReadError &&
			error.code === 'limit' &&
			!error.snapshot,
	)
})

void test('malformed UTF-8/JSON is response failure and invalid caller identity makes no request', async () => {
	for (const bytes of [
		new Uint8Array([0xff]),
		new TextEncoder().encode('{"code":200'),
	])
		await assert.rejects(
			readExternalDirectory(input, async () => bytes),
			(error: unknown) =>
				error instanceof DirectoryReadError && error.code === 'response',
		)
	for (const overrides of [
		{ taskId: '' },
		{ taskId: ' bad' },
		{ taskVersion: 0 },
		{ taskVersion: Number.MAX_SAFE_INTEGER + 1 },
		{ url: 'https://evil/playlist?id=1' },
	]) {
		let called = false
		await assert.rejects(
			readExternalDirectory({ ...input, ...overrides }, async () => {
				called = true
				return encode(netease())
			}),
		)
		assert.equal(called, false)
	}
})

void test('literal JSON overflow numbers in unknown fields are rejected, never converted to null', async () => {
	for (const path of ['envelope', 'playlist', 'track', 'partial']) {
		const value = netease()
		if (path === 'partial') value.playlist.tracks.pop()
		const text = JSON.stringify(value)
		const overflow =
			path === 'envelope'
				? text.replace('{"code":200', '{"overflow":1e309,"code":200')
				: path === 'playlist'
					? text.replace(
							'"description":"完整原说明"',
							'"overflow":1e309,"description":"完整原说明"',
						)
					: text.replace(
							'"custom":{"keep":true}',
							'"custom":{"keep":true,"overflow":1e309}',
						)
		assert(overflow.includes('1e309'))
		await assert.rejects(
			readExternalDirectory(input, async () =>
				new TextEncoder().encode(overflow),
			),
			(error: unknown) => {
				assert(error instanceof DirectoryReadError)
				assert.equal(error.code, 'response')
				assert.equal(error.snapshot, undefined)
				assert.match(error.message, /非有限/)
				return true
			},
		)
	}
})

void test('5000 occurrences remain distinct and aggregate snapshot overhead cannot bypass 8MiB', async () => {
	const max = netease(Array.from({ length: 5000 }, () => song(1)))
	const snapshot = await decode(max)
	assert.equal(snapshot.entries.length, 5000)
	assert.equal(
		new Set(snapshot.entries.map((entry) => entry.entryId)).size,
		5000,
	)
	const base = netease(
		Array.from({ length: 2000 }, (_, index) => ({
			...song(index + 1),
			custom: { keep: true, padding: '' },
		})),
	)
	const padding = Math.floor(
		(externalDirectoryLimits.responseBytes - encode(base).byteLength - 1024) /
			2000,
	)
	const large = {
		...base,
		playlist: {
			...base.playlist,
			tracks: base.playlist.tracks.map((track) => ({
				...track,
				custom: { ...track.custom, padding: 'x'.repeat(padding) },
			})),
		},
	}
	assert(encode(large).byteLength < externalDirectoryLimits.responseBytes)
	await assert.rejects(
		decode(large),
		(error: unknown) =>
			error instanceof DirectoryReadError &&
			error.code === 'limit' &&
			!error.snapshot,
	)
})

void test('fixed official endpoints, no credentials, no redirects, one request and incremental UTF-8 read', async () => {
	const bytes = encode(netease()),
		fixture = response([bytes.slice(0, 3), bytes.slice(3, 36), bytes.slice(36)])
	const f = fetchFixture(fixture),
		snapshot = await readExternalDirectory(input, f.transport)
	assert.equal(snapshot.entries.length, 3)
	assert.equal(f.calls.length, 1)
	assert.equal(
		f.calls[0][0],
		'https://interface3.music.163.com/eapi/v6/playlist/detail',
	)
	assert.equal(f.calls[0][1].credentials, 'omit')
	assert.equal(f.calls[0][1].redirect, 'error')
	assert.equal(f.calls[0][1].headers.Cookie, undefined)
	assert.equal(fixture.released, 1)
	const request = externalDirectoryRequest({
		provider: 'qq',
		originalPlaylistId: '456',
	})
	assert.equal(
		request.url,
		'https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg?id=456&format=json&newsong=1&platform=jqspaframe.json',
	)
	assert.equal(request.method, 'GET')
})

void test('actual byte budget cancels before reading remaining chunks; false length cannot bypass it', async () => {
	const fixture = response(
		[
			new Uint8Array(externalDirectoryLimits.responseBytes),
			new Uint8Array(1),
			encode(netease()),
		],
		{ headers: { get: () => '1' } },
	)
	await assert.rejects(
		readExternalDirectory(input, fetchFixture(fixture).transport),
		(error: unknown) =>
			error instanceof DirectoryReadError && error.code === 'limit',
	)
	assert.equal(fixture.reads, 2)
	assert.equal(fixture.cancelled, 1)
	assert.equal(fixture.released, 1)
	const declared = response([], {
		headers: { get: () => String(externalDirectoryLimits.responseBytes + 1) },
	})
	await assert.rejects(
		readExternalDirectory(input, fetchFixture(declared).transport),
		(error: unknown) =>
			error instanceof DirectoryReadError && error.code === 'limit',
	)
	assert.equal(declared.reads, 0)
	assert.equal(declared.cancelled, 1)
})

void test('HTTP permission, observed redirect, missing streams and generic network errors stay distinct', async () => {
	for (const [extra, code] of [
		[{ status: 403 }, 'permission'],
		[{ status: 429 }, 'platform'],
		[{ status: 302 }, 'redirect'],
		[{ redirected: true }, 'redirect'],
		[{ url: 'https://evil/' }, 'redirect'],
		[{ body: null }, 'response'],
	] as const) {
		const fixture = response([], extra)
		await assert.rejects(
			readExternalDirectory(input, fetchFixture(fixture).transport),
			(error: unknown) =>
				error instanceof DirectoryReadError && error.code === code,
		)
	}
	let calls = 0
	const transport = createExternalDirectoryTransport(async () => {
		calls++
		throw new TypeError('generic failure, possibly redirect')
	})
	await assert.rejects(
		readExternalDirectory(input, transport),
		(error: unknown) =>
			error instanceof DirectoryReadError && error.code === 'network',
	)
	assert.equal(calls, 1)
})

void test('cleanup failures preserve the proven original HTTP failure', async () => {
	const fixture = response([], {
		status: 403,
		body: {
			getReader: () => ({
				read: async () => ({ done: true }),
				cancel: async () => {
					throw new Error('cleanup')
				},
				releaseLock: () => {
					throw new Error('release')
				},
			}),
		},
	})
	await assert.rejects(
		readExternalDirectory(input, fetchFixture(fixture).transport),
		(error: unknown) => {
			assert(error instanceof DirectoryReadError)
			assert.equal(error.code, 'permission')
			assert.equal(error.diagnostics.httpStatus, 403)
			return true
		},
	)
	await Promise.resolve()
})

void test('cancel before request and during ignored/late transport cannot return a stale directory', async () => {
	const already = new AbortController()
	already.abort()
	let called = false
	await assert.rejects(
		readExternalDirectory({ ...input, signal: already.signal }, async () => {
			called = true
			return encode(netease())
		}),
		(error: unknown) =>
			error instanceof DirectoryReadError && error.code === 'cancelled',
	)
	assert.equal(called, false)
	const controller = new AbortController()
	let finish!: (value: Uint8Array) => void
	const pending = readExternalDirectory(
		{ ...input, signal: controller.signal },
		async () =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	controller.abort()
	await assert.rejects(
		pending,
		(error: unknown) =>
			error instanceof DirectoryReadError && error.code === 'cancelled',
	)
	finish(encode(netease()))
	await Promise.resolve()
})

void test('total timeout terminates even when the injected transport ignores cancellation', async (context) => {
	context.mock.timers.enable({ apis: ['setTimeout'] })
	try {
		const pending = readExternalDirectory(
			input,
			async () => new Promise(() => {}),
		)
		context.mock.timers.tick(externalDirectoryLimits.timeoutMs)
		await assert.rejects(
			pending,
			(error: unknown) =>
				error instanceof DirectoryReadError && error.code === 'timeout',
		)
	} finally {
		context.mock.timers.reset()
	}
})
