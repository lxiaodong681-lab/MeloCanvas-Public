import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	activeLyric,
	defaultLyricsDisplayOptions,
	lyricsDisplaySettingsKey,
	readLyricsDisplayOptions,
	writeLyricsDisplayOptions,
	lyricsIdentity,
	LyricsStore,
	lyricTimeMs,
	parseLyrics,
	type SavedLyrics,
} from '../lyrics'

const id = 'bilibili:BV1234567890:42'
const saved: SavedLyrics = {
	version: 1,
	sourceId: id,
	filename: '原创测试.lrc',
	importedAt: 1,
	raw: '[00:01.25]今天写一行\n[00:02.500]明天听回声',
	offsetMs: 0,
}

void test('binary lyric lookup preserves duplicate starts, offsets, silence gaps and backward seeks', () => {
	const parsed = parseLyrics('[00:00]开头\n[00:01]甲\n[00:01]乙\n[00:03]丙\n[00:05]结束')
	parsed.lines[3].endMs = 4000
	const linear = (position: number, offset: number) => {
		let index = -1
		for (let i = 0; i < parsed.lines.length; i++) {
			if (lyricTimeMs(parsed.lines[i], parsed, offset)! > position) break
			index = i
		}
		const line = parsed.lines[index]
		return line?.endMs !== undefined && position >= Math.max(0, line.endMs - parsed.fileOffsetMs + offset) ? -1 : index
	}
	for (const offset of [-4000, -100, 0, 1500])
		for (const position of [7000, 5000, 4999, 4000, 3500, 3000, 1000, 999, 0, -1])
			assert.equal(activeLyric(parsed, position, offset), linear(position, offset))
	let reads = 0
	const large = { ...parsed, lines: Array.from({ length: 4096 }, (_, i) => ({ text: `${i}`, get atMs() { reads++; return i * 1000 } })) }
	assert.equal(activeLyric(large, 4_095_500, 0), 4095)
	assert.ok(reads <= 30, `lookup read ${reads} timestamps instead of a bounded binary search`)
})
void test('LRC fractions, repeated tags, ordering and metadata preserve actual timing', () => {
	const parsed = parseLyrics(
		'[ti:原创测试]\n[ar:测试作者]\n[offset:200]\n[00:02.1][00:03.123]回声\n[00:01]起点',
	)
	assert.equal(parsed.timed, true)
	assert.deepEqual(
		parsed.lines.map((line) => line.atMs),
		[1000, 2100, 3123],
	)
	assert.equal(parsed.title, '原创测试')
	assert.equal(lyricTimeMs(parsed.lines[0], parsed, 500), 1300)
	assert.equal(activeLyric(parsed, 1299, 500), -1)
	assert.equal(activeLyric(parsed, 1300, 500), 0)
	assert.equal(activeLyric(parsed, 2400, 500), 1)
})
void test('plain, partially timed, invalid seconds and unsupported precision never invent synchronization', () => {
	for (const raw of [
		'无时间戳的原创文本',
		'[00:01]有时间\n还有一行',
		'[00:99]无效',
		'[00:01.1234]精度不支持',
	]) {
		const parsed = parseLyrics(raw)
		assert.equal(parsed.timed, false)
		assert.equal(activeLyric(parsed, 9000, 0), -1)
	}
	assert.throws(() => parseLyrics('[ti:只有标题]'))
	assert.throws(() => parseLyrics('a'.repeat(262145)))
})
void test('source identity is actual source, not title or queue occurrence; persistence survives a new store', () => {
	const data = new Map<string, string>()
	const storage = {
		setting: (key: string) => data.get(key) ?? null,
		setSetting: (key: string, value: string) => {
			data.set(key, value)
		},
	}
	const store = new LyricsStore(storage)
	store.save(saved)
	assert.deepEqual(new LyricsStore(storage).get(id), saved)
	assert.equal(store.get('bilibili:BV1234567890:43'), null)
	assert.equal(lyricsIdentity('queue-entry-42'), null)
	assert.equal(
		lyricsIdentity('local:12345678-1234-1234-1234-123456789abc'),
		'local:12345678-1234-1234-1234-123456789abc',
	)
	assert.throws(() => store.save({ ...saved, offsetMs: Infinity }))
	assert.throws(() => store.save({ ...saved, sourceId: 'same title' }))
})
void test('persistence errors remain errors, never overwrite unreadable input during read', () => {
	let writes = 0
	const store = new LyricsStore({
		setting: () => '{broken',
		setSetting: () => {
			writes++
		},
	})
	assert.throws(() => store.get(id))
	assert.equal(writes, 0)
	const failed = new LyricsStore({
		setting: () => null,
		setSetting: () => {
			throw new Error('disk full')
		},
	})
	assert.throws(() => failed.save(saved), /disk full/)
})

void test('translation and romanization toggles persist independently without changing cached source lyrics', () => {
	const data = new Map<string, string>()
	const storage = {
		setting: (key: string) => data.get(key) ?? null,
		setSetting: (key: string, value: string) => {
			data.set(key, value)
		},
	}
	new LyricsStore(storage).save(saved)
	assert.deepEqual(readLyricsDisplayOptions(storage), defaultLyricsDisplayOptions)
	writeLyricsDisplayOptions(storage, { translation: false, romaji: true })
	assert.deepEqual(readLyricsDisplayOptions(storage), { translation: false, romaji: true })
	writeLyricsDisplayOptions(storage, { translation: false, romaji: false })
	assert.deepEqual(readLyricsDisplayOptions(storage), { translation: false, romaji: false })
	writeLyricsDisplayOptions(storage, { translation: true, romaji: false })
	assert.deepEqual(readLyricsDisplayOptions(storage), { translation: true, romaji: false })
	assert.deepEqual(new LyricsStore(storage).get(id), saved)
	assert.ok(data.has(lyricsDisplaySettingsKey))
})

void test('missing, invalid or unknown-version display settings fall back to showing available extras', () => {
	let raw: string | null = null
	const storage = { setting: () => raw }
	for (const value of [null, '{broken', 'null', '[]', '{"version":2,"translation":false,"romaji":false}', '{"version":1,"translation":false,"romaji":"false"}']) {
		raw = value
		assert.deepEqual(readLyricsDisplayOptions(storage), defaultLyricsDisplayOptions)
	}
})
