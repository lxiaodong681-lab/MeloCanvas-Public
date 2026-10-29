import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import type { PlaybackSnapshot, Track } from '@bbplayer/orpheus'

import { Library, migrate, type Database } from '../core/database'
import { ListeningLibrary } from '../core/listening'
import { sourceId, sourceUri, type Source } from '../core/model'
import { validateQueueEntry } from '../core/queue'
import { SessionStore } from '../core/sessions'
import { PlaybackController, type PlaybackNative } from '../playbackController'

const bv = 'BV1vT411i7ET'
const source = (cid: number): Source => ({
	id: sourceId(bv, cid),
	bvid: bv,
	cid,
	originalTitle: `P${cid}`,
	uploader: 'UP',
	uploaderId: 1,
	performer: null,
	artwork: '',
	duration: 120 + cid,
	domain: 'unclassified',
	audioAvailability: 'unknown',
})
const track = (value: Source, entryId = value.id): Track => ({
	id: entryId,
	sourceId: value.id,
	url: sourceUri(value),
	title: value.originalTitle,
	duration: value.duration,
})
const unexpected = async (): Promise<never> =>
	assert.fail('part switching must not replace the queue or enter another mode')
function fixture() {
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
	const library = new Library(db)
	for (const value of [source(1), source(2), source(3)]) library.save(value)
	const state = {
		generation: 0,
		calls: [] as { target: Track; entryId: string; sourceId: string }[],
		prepare: null as null | (() => Promise<void>),
		failure: null as Error | null,
		snapshot: {
			mode: 'music',
			tracks: [track(source(1))],
			currentEntryId: source(1).id,
			currentSourceId: source(1).id,
			positionSeconds: 47,
			durationSeconds: 121,
			speed: 1,
			playing: false,
			playWhenReady: false,
			updatedAt: 10,
			inactiveSession: null,
			resumePoints: [],
			repeatMode: 2,
			shuffleEntryIds: null,
		} as PlaybackSnapshot,
	}
	const native: PlaybackNative = {
		getPlaybackSnapshot: async () => structuredClone(state.snapshot),
		cancelPlaybackReplacement: async () => ++state.generation,
		isPlaybackReplacementCurrent: async (token) => token === state.generation,
		cancelPlaybackReplacementIfCurrent: async (token) => {
			if (token !== state.generation) return false
			state.generation++
			return true
		},
		finishPlaybackPreparationIfCurrent: async (token) =>
			token === state.generation,
		replacePlayback: unexpected,
		startFm: unexpected,
		exitFm: unexpected,
		appendFm: unexpected,
		switchMusicPart: async (target, entryId, originalSourceId, token) => {
			state.calls.push({ target, entryId, sourceId: originalSourceId })
			if (state.prepare) await state.prepare()
			if (state.failure) throw state.failure
			if (token !== state.generation)
				throw new Error('PlaybackReplacementCancelled')
			if (
				state.snapshot.currentEntryId !== entryId ||
				state.snapshot.currentSourceId !== originalSourceId
			)
				throw new Error('当前播放条目已变化，请重新选择分 P')
			const previous = structuredClone(state.snapshot)
			state.snapshot = {
				...previous,
				tracks: previous.tracks.map((value) =>
					value.id === entryId ? target : value,
				),
				currentSourceId: target.sourceId!,
				positionSeconds: 0,
				durationSeconds: target.duration ?? 0,
				updatedAt: previous.updatedAt + 1,
			}
			return { previous, current: structuredClone(state.snapshot) }
		},
	}
	const sessions = new SessionStore(db)
	const controller = new PlaybackController(
		native,
		library,
		new ListeningLibrary(db),
		sessions,
	)
	return { raw, library, sessions, native, state, controller }
}

void test('switching a music part retains the current occurrence, other tracks and paused native state', async () => {
	const f = fixture()
	try {
		f.state.snapshot.tracks = [
			track(source(1), 'playlist-item:first'),
			track(source(1), 'playlist-item:second'),
			track(source(2), 'playlist-item:third'),
		]
		f.state.snapshot.currentEntryId = 'playlist-item:second'
		f.state.snapshot.shuffleEntryIds = [
			'playlist-item:third',
			'playlist-item:second',
			'playlist-item:first',
		]
		f.state.snapshot.inactiveSession = {
			mode: 'listening',
			tracks: [track(source(2))],
			currentEntryId: source(2).id,
			currentSourceId: source(2).id,
			positionSeconds: 88,
			durationSeconds: 122,
			speed: 1.5,
			playing: false,
			updatedAt: 9,
		}
		const before = structuredClone(f.state.snapshot)
		const prep = await f.controller.reservePlayback()
		const result = await f.controller.switchMusicPart(source(3), prep, {
			entryId: 'playlist-item:second',
			sourceId: source(1).id,
		})
		assert.ok(result)
		assert.equal(result.currentEntryId, 'playlist-item:second')
		assert.equal(result.currentSourceId, source(3).id)
		assert.deepEqual(result.tracks[0], before.tracks[0])
		assert.deepEqual(result.tracks[2], before.tracks[2])
		assert.equal(result.positionSeconds, 0)
		assert.equal(result.playing, false)
		assert.equal(result.playWhenReady, false)
		assert.equal(result.repeatMode, 2)
		assert.deepEqual(result.shuffleEntryIds, before.shuffleEntryIds)
		assert.deepEqual(result.inactiveSession, before.inactiveSession)
		assert.equal(f.state.calls[0].target.id, 'playlist-item:second')
		assert.equal(
			f.sessions.getSession('music')?.currentEntryId,
			'playlist-item:second',
		)
		assert.equal(f.sessions.getSession('music')?.currentSourceId, source(3).id)
		assert.equal(f.library.get(source(3).id)?.domain, 'unclassified')
	} finally {
		f.raw.close()
	}
})

void test('a direct music entry retains its legacy ID across same-BV parts and SQLite re-read', async () => {
	const f = fixture()
	try {
		const prep = await f.controller.reservePlayback()
		const result = await f.controller.switchMusicPart(source(2), prep)
		assert.equal(result?.currentEntryId, source(1).id)
		assert.equal(result?.currentSourceId, source(2).id)
		assert.equal(
			f.sessions.getSession('music')?.entries[0].entryId,
			source(1).id,
		)
		assert.equal(
			f.sessions.getSession('music')?.entries[0].sourceId,
			source(2).id,
		)
		await f.controller.sync()
		assert.equal(f.sessions.getSession('music')?.currentSourceId, source(2).id)
	} finally {
		f.raw.close()
	}
})

void test('music-only same-BV occurrence relaxation does not admit crossed BV, local or listening identities', () => {
	const entry = { entryId: source(1).id, sourceId: source(2).id }
	assert.doesNotThrow(() => validateQueueEntry(entry, 'music'))
	assert.throws(() => validateQueueEntry(entry, 'listening'))
	assert.throws(() =>
		validateQueueEntry(
			{ ...entry, sourceId: 'bilibili:BV1Q541167Qg:2' },
			'music',
		),
	)
	assert.throws(() =>
		validateQueueEntry(
			{ ...entry, entryId: 'bilibili:BV1vT411i7ET:0' },
			'music',
		),
	)
	assert.throws(() =>
		validateQueueEntry({ ...entry, entryId: 'arbitrary' }, 'music'),
	)
	assert.throws(() =>
		validateQueueEntry(
			{ ...entry, sourceId: 'local:12345678-90ab-4cde-8fab-123456789abc' },
			'music',
		),
	)
})

void test('stale UI occurrence, changed mode, cross-BV source and audition reject before native switching', async () => {
	const f = fixture()
	try {
		const prep = await f.controller.reservePlayback()
		await assert.rejects(
			f.controller.switchMusicPart(source(2), prep, {
				entryId: 'playlist-item:old',
				sourceId: source(1).id,
			}),
			/已变化|重新/,
		)
		await assert.rejects(
			f.controller.switchMusicPart(
				{ ...source(2), bvid: 'BV1Q541167Qg', id: 'bilibili:BV1Q541167Qg:2' },
				prep,
			),
			/同一|当前视频/,
		)
		f.state.snapshot.mode = 'listening'
		await assert.rejects(f.controller.switchMusicPart(source(2), prep), /音乐/)
		f.state.snapshot.mode = 'music'
		f.state.snapshot.fm = {
			id: 'active-fm',
			returnMode: 'music',
			manualMusic: null,
			returnListening: null,
		}
		await assert.rejects(
			f.controller.switchMusicPart(source(2), prep),
			/退出 FM/,
		)
		f.state.snapshot.fm = null
		f.state.snapshot.auditionId = 'active-audition'
		await assert.rejects(f.controller.switchMusicPart(source(2), prep), /试听/)
		assert.equal(f.state.calls.length, 0)
	} finally {
		f.raw.close()
	}
})

void test('same part is a no-op; cache-only routing is retained for a different part', async () => {
	const f = fixture()
	try {
		const prep = await f.controller.reservePlayback()
		const result = await f.controller.switchMusicPart(source(1), prep)
		assert.equal(result?.positionSeconds, 47)
		assert.equal(f.state.calls.length, 0)
		f.state.snapshot.tracks[0].url += '&meloOffline=1'
		await f.controller.switchMusicPart(source(2), prep)
		assert.equal(
			f.state.calls[0].target.url,
			sourceUri(source(2)) + '&meloOffline=1',
		)
	} finally {
		f.raw.close()
	}
})

void test('preflight failure and cancelled preparation leave the original music session intact', async () => {
	const f = fixture()
	try {
		const before = structuredClone(f.state.snapshot)
		const prep = await f.controller.reservePlayback()
		f.state.failure = new Error('AudioOnlyUnavailable')
		await assert.rejects(
			f.controller.switchMusicPart(source(2), prep),
			/AudioOnlyUnavailable/,
		)
		assert.deepEqual(f.state.snapshot, before)
		f.state.failure = null
		let release!: () => void
		f.state.prepare = () =>
			new Promise<void>((resolve) => {
				release = resolve
			})
		const pending = f.controller.switchMusicPart(source(2), prep)
		await new Promise((resolve) => setImmediate(resolve))
		await f.controller.cancelPending()
		release()
		assert.equal(await pending, null)
		assert.deepEqual(f.state.snapshot, before)
	} finally {
		f.raw.close()
	}
})
