import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import type {
	PlaybackSessionSnapshot,
	PlaybackSnapshot,
	Track,
} from '@bbplayer/orpheus'

import { Library, migrate, type Database } from '../core/database'
import { ListeningLibrary, type PlaybackMode } from '../core/listening'
import { LocalAudioStore } from '../core/local-audio'
import { sourceId, sourceUri, type Source } from '../core/model'
import { localLibrarySource } from '../core/music-library-source'
import { playlistEntryId } from '../core/queue'
import { SessionStore } from '../core/sessions'
import { PlaybackController, type PlaybackNative } from '../playbackController'

const source = (cid: number): Source => ({
	id: sourceId('BV1vT411i7ET', cid),
	bvid: 'BV1vT411i7ET',
	cid,
	originalTitle: `P${cid}`,
	uploader: 'UP',
	uploaderId: 1,
	performer: null,
	artwork: '',
	duration: 300,
	domain: 'unclassified',
	audioAvailability: 'unknown',
})
const track = (item: Source): Track => ({
	id: item.id,
	url: sourceUri(item),
	title: item.originalTitle,
	duration: item.duration,
})
const music = source(1)
const p1 = source(2)
const p2 = source(3)
const initial = (): PlaybackSnapshot => ({
	mode: 'music',
	tracks: [track(music)],
	currentEntryId: music.id,
	currentSourceId: music.id,
	positionSeconds: 80,
	durationSeconds: 300,
	speed: 1,
	playing: true,
	updatedAt: 10,
	inactiveSession: null,
	resumePoints: [],
})
class Native implements PlaybackNative {
	snapshot = initial()
	generation = 0
	replacements = 0
	failure: Error | null = null
	prepare: (() => Promise<void>) | null = null
	async getPlaybackSnapshot() {
		return structuredClone(this.snapshot)
	}
	async cancelPlaybackReplacement() {
		return ++this.generation
	}
	async isPlaybackReplacementCurrent(token: number) {
		return token === this.generation
	}
	async finishPlaybackPreparationIfCurrent(token: number) {
		return token === this.generation
	}
	async startFm(): Promise<never> {
		throw new Error('FM is not modeled by this legacy fixture')
	}
	async exitFm(): Promise<never> {
		throw new Error('FM is not modeled by this legacy fixture')
	}
	async appendFm(): Promise<never> {
		throw new Error('FM is not modeled by this legacy fixture')
	}
	async cancelPlaybackReplacementIfCurrent(token: number) {
		if (token !== this.generation) return false
		this.generation++
		return true
	}
	async replacePlayback(
		tracks: Track[],
		id: string,
		position: number,
		speed: number,
		playing: boolean,
		mode: PlaybackMode,
		generation: number,
	) {
		if (generation !== this.generation)
			throw new Error('PlaybackReplacementCancelled')
		this.replacements++
		if (this.prepare) await this.prepare()
		if (this.failure) throw this.failure
		if (generation !== this.generation)
			throw new Error('PlaybackReplacementCancelled')
		const previous: PlaybackSessionSnapshot = structuredClone(this.snapshot)
		const updatedAt =
			Math.max(
				this.snapshot.updatedAt,
				...this.snapshot.resumePoints.map((point) => point.updatedAt),
			) + 10
		this.snapshot = {
			mode,
			tracks,
			currentEntryId: id,
			currentSourceId:
				tracks.find((candidate) => candidate.id === id)!.sourceId ?? id,
			positionSeconds: position,
			speed,
			playing,
			durationSeconds: 300,
			updatedAt,
			inactiveSession:
				previous.mode === mode ? this.snapshot.inactiveSession : previous,
			resumePoints:
				mode === 'listening'
					? [
							...this.snapshot.resumePoints.filter(
								(point) => point.sourceId !== id,
							),
							{
								sourceId: id,
								positionSeconds: position,
								durationSeconds: 300,
								completed: false,
								updatedAt,
							},
						]
					: [...this.snapshot.resumePoints],
		}
		return { previous, current: structuredClone(this.snapshot) }
	}
}
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
	const library = new Library(db)
	for (const item of [music, p1, p2]) library.save(item)
	const listening = new ListeningLibrary(db)
	const sessions = new SessionStore(db)
	const native = new Native()
	const localAudio = new LocalAudioStore(db)
	const controller = new PlaybackController(
		native,
		library,
		listening,
		sessions,
		localAudio,
	)
	return { raw, library, listening, sessions, native, controller, localAudio }
}
function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

void test('预检失败保留音乐队列、位置、声音且保留原错误', async () => {
	const { controller, native, sessions, raw } = setup()
	try {
		const previous = structuredClone(native.snapshot)
		const failure = new Error('AudioOnlyUnavailable: no DASH audio')
		native.failure = failure
		await assert.rejects(
			controller.playSource(
				p1,
				await controller.reservePlayback(),
				'listening',
			),
			(error) => error === failure,
		)
		assert.deepEqual(native.snapshot, previous)
		assert.equal(sessions.getSession('music')?.positionSeconds, 80)
		assert.equal(sessions.getSession('listening'), null)
	} finally {
		raw.close()
	}
})

void test('明确分P连续队列、逐CID断点、听视频速度和返回音乐继续', async () => {
	const { controller, native, listening, sessions, raw } = setup()
	try {
		listening.saveResumePoint({
			sourceId: p1.id,
			positionSeconds: 123,
			durationSeconds: 300,
			completed: false,
			updatedAt: 20,
		})
		sessions.saveSession({
			mode: 'listening',
			entries: [p1.id, p2.id].map((id) => ({ entryId: id, sourceId: id })),
			currentEntryId: p1.id,
			currentSourceId: p1.id,
			positionSeconds: 123,
			speed: 1.5,
			updatedAt: 20,
		})
		await controller.playSource(
			p1,
			await controller.reservePlayback(),
			'listening',
			[p1, p2, p1],
		)
		assert.deepEqual(
			native.snapshot.tracks.map((item) => item.id),
			[p1.id, p2.id],
		)
		assert.equal(native.snapshot.positionSeconds, 123)
		assert.equal(native.snapshot.speed, 1.5)
		assert.equal(sessions.getSession('music')?.positionSeconds, 80)
		native.snapshot.positionSeconds = 200
		await controller.returnToMusic(await controller.reservePlayback())
		assert.equal(native.snapshot.currentSourceId, music.id)
		assert.equal(native.snapshot.positionSeconds, 80)
		assert.equal(native.snapshot.playing, true)
		assert.equal(native.snapshot.speed, 1)
		assert.equal(sessions.getSession('listening')?.positionSeconds, 200)
	} finally {
		raw.close()
	}
})

void test('未提供明确关系的听视频不会串入旧听视频队列', async () => {
	const { controller, native, raw } = setup()
	try {
		await controller.playSource(
			p1,
			await controller.reservePlayback(),
			'listening',
		)
		await controller.playSource(
			p2,
			await controller.reservePlayback(),
			'listening',
		)
		assert.deepEqual(
			native.snapshot.tracks.map((item) => item.id),
			[p2.id],
		)
	} finally {
		raw.close()
	}
})

void test('取消正在预检的请求不会在完成后接管播放', async () => {
	const { controller, native, raw } = setup()
	try {
		const wait = deferred()
		const started = deferred()
		native.prepare = () => {
			started.resolve()
			return wait.promise
		}
		const pending = controller.playSource(
			p1,
			await controller.reservePlayback(),
			'listening',
		)
		await started.promise
		await controller.cancelPending()
		wait.resolve()
		assert.equal(await pending, null)
		assert.equal(native.snapshot.currentSourceId, music.id)
	} finally {
		raw.close()
	}
})

void test('快速点击新源使旧请求失效，旧请求不能覆盖新队列', async () => {
	const { controller, native, raw } = setup()
	try {
		const wait = deferred()
		const started = deferred()
		native.prepare = () => {
			started.resolve()
			return wait.promise
		}
		const first = controller.playSource(
			p1,
			await controller.reservePlayback(),
			'listening',
		)
		await started.promise
		native.prepare = null
		await controller.playSource(
			p2,
			await controller.reservePlayback(),
			'listening',
		)
		wait.resolve()
		assert.equal(await first, null)
		assert.equal(native.snapshot.currentSourceId, p2.id)
	} finally {
		raw.close()
	}
})

void test('启动从原生活动与暂存快照修复SQLite，不替换或自动播放', async () => {
	const { controller, native, sessions, raw } = setup()
	try {
		native.snapshot = {
			...initial(),
			mode: 'listening',
			tracks: [track(p1)],
			currentEntryId: p1.id,
			currentSourceId: p1.id,
			positionSeconds: 270,
			speed: 2,
			playing: false,
			inactiveSession: initial(),
		}
		sessions.saveSession({
			mode: 'listening',
			entries: [p2.id].map((id) => ({ entryId: id, sourceId: id })),
			currentEntryId: p2.id,
			currentSourceId: p2.id,
			positionSeconds: 1,
			speed: 1,
			updatedAt: 1,
		})
		await controller.sync()
		assert.equal(native.replacements, 0)
		assert.equal(native.snapshot.playing, false)
		assert.equal(sessions.getSession('listening')?.positionSeconds, 270)
		assert.equal(sessions.getSession('listening')?.currentSourceId, p1.id)
		assert.equal(sessions.getSession('music')?.positionSeconds, 80)
	} finally {
		raw.close()
	}
})

void test('SQLite保存失败独立告警，已成功原生切换不报播放失败，可从原生重试修复', async () => {
	const { native, library, listening, sessions, raw } = setup()
	try {
		const failure = new Error('disk full')
		let fail = true
		const store = {
			getSession: sessions.getSession.bind(sessions),
			saveSession: (value: Parameters<SessionStore['saveSession']>[0]) => {
				if (fail) throw failure
				sessions.saveSession(value)
			},
		}
		const controller = new PlaybackController(native, library, listening, store)
		await controller.playSource(
			p1,
			await controller.reservePlayback(),
			'listening',
		)
		assert.equal(native.snapshot.currentSourceId, p1.id)
		assert.match(controller.syncError, /记录保存失败/)
		assert.equal(controller.syncCause, failure)
		assert.equal(controller.canReturnMusic(native.snapshot), true)
		fail = false
		await controller.sync()
		assert.equal(controller.syncError, '')
		assert.equal(sessions.getSession('music')?.currentSourceId, music.id)
		assert.equal(sessions.getSession('listening')?.currentSourceId, p1.id)
	} finally {
		raw.close()
	}
})

void test('SQLite写失败且音乐副本陈旧时，选音乐新项仍保留原生暂存队列', async () => {
	const { native, library, listening, sessions, raw } = setup()
	try {
		const storedMusic = { ...initial(), tracks: [track(music), track(p1)] }
		native.snapshot = {
			...initial(),
			mode: 'listening',
			tracks: [track(p2)],
			currentEntryId: p2.id,
			currentSourceId: p2.id,
			inactiveSession: storedMusic,
		}
		sessions.saveSession({
			mode: 'music',
			entries: [music.id].map((id) => ({ entryId: id, sourceId: id })),
			currentEntryId: music.id,
			currentSourceId: music.id,
			positionSeconds: 1,
			speed: 1,
			updatedAt: 1,
		})
		const store = {
			getSession: sessions.getSession.bind(sessions),
			saveSession: () => {
				throw new Error('disk full')
			},
		}
		const controller = new PlaybackController(native, library, listening, store)
		await controller.playSource(p2, await controller.reservePlayback(), 'music')
		assert.deepEqual(
			native.snapshot.tracks.map((item) => item.id),
			[music.id, p1.id, p2.id],
		)
		assert.equal(native.snapshot.mode, 'music')
		assert.match(controller.syncError, /记录保存失败/)
	} finally {
		raw.close()
	}
})

void test('当前项已完成再点击也从头开始，不使用结束处的活动位置', async () => {
	const { native, controller, raw } = setup()
	try {
		native.snapshot = {
			...initial(),
			mode: 'listening',
			tracks: [track(p1)],
			currentEntryId: p1.id,
			currentSourceId: p1.id,
			positionSeconds: 300,
			playing: false,
			resumePoints: [
				{
					sourceId: p1.id,
					positionSeconds: 300,
					durationSeconds: 300,
					completed: true,
					updatedAt: 100,
				},
			],
		}
		await controller.playSource(
			p1,
			await controller.reservePlayback(),
			'listening',
		)
		assert.equal(native.snapshot.positionSeconds, 0)
		assert.equal(native.snapshot.playing, true)
	} finally {
		raw.close()
	}
})

void test('音乐播放与完成不会写入听视频续听列表，同CID音乐也不覆盖听视频断点', async () => {
	const { native, controller, listening, raw } = setup()
	try {
		await controller.playSource(
			music,
			await controller.reservePlayback(),
			'music',
		)
		assert.deepEqual(listening.listResumePoints(), [])
		await controller.playSource(
			p1,
			await controller.reservePlayback(),
			'listening',
		)
		const listeningPoint = listening.getResumePoint(p1.id)
		await controller.playSource(p1, await controller.reservePlayback(), 'music')
		assert.equal(listening.getResumePoint(music.id), null)
		assert.deepEqual(listening.getResumePoint(p1.id), listeningPoint)
		assert.equal(native.snapshot.mode, 'music')
	} finally {
		raw.close()
	}
})

void test('SQLite同步失败时选P仍优先原生逐CID断点与暂存速度', async () => {
	const { native, library, listening, sessions, raw } = setup()
	try {
		for (const item of [p1, p2])
			listening.saveResumePoint({
				sourceId: item.id,
				positionSeconds: 1,
				durationSeconds: 300,
				completed: false,
				updatedAt: 1,
			})
		native.snapshot.inactiveSession = {
			...initial(),
			mode: 'listening',
			tracks: [track(p1), track(p2)],
			currentEntryId: p1.id,
			currentSourceId: p1.id,
			speed: 1.5,
		}
		native.snapshot.resumePoints = [
			{
				sourceId: p1.id,
				positionSeconds: 140,
				durationSeconds: 300,
				completed: false,
				updatedAt: 100,
			},
			{
				sourceId: p2.id,
				positionSeconds: 220,
				durationSeconds: 300,
				completed: false,
				updatedAt: 100,
			},
		]
		const store = {
			getSession: sessions.getSession.bind(sessions),
			saveSession: () => {
				throw new Error('disk full')
			},
		}
		const controller = new PlaybackController(native, library, listening, store)
		await controller.playSource(
			p1,
			await controller.reservePlayback(),
			'listening',
		)
		assert.equal(native.snapshot.positionSeconds, 140)
		assert.equal(native.snapshot.speed, 1.5)
		assert.deepEqual(
			native.snapshot.tracks.map((item) => item.id),
			[p1.id, p2.id],
		)
		await controller.select(1, await controller.reservePlayback())
		assert.equal(native.snapshot.positionSeconds, 220)
		assert.equal(native.snapshot.speed, 1.5)
		assert.equal(listening.getResumePoint(p2.id)?.positionSeconds, 1)
	} finally {
		raw.close()
	}
})

void test('完成项再次打开从头，完成与断点逐CID独立', async () => {
	const { native, controller, listening, raw } = setup()
	try {
		native.snapshot.resumePoints = [
			{
				sourceId: p1.id,
				positionSeconds: 300,
				durationSeconds: 300,
				completed: true,
				updatedAt: 100,
			},
			{
				sourceId: p2.id,
				positionSeconds: 90,
				durationSeconds: 300,
				completed: false,
				updatedAt: 100,
			},
		]
		await controller.playSource(
			p1,
			await controller.reservePlayback(),
			'listening',
			[p1, p2],
		)
		assert.equal(native.snapshot.positionSeconds, 0)
		await controller.select(1, await controller.reservePlayback())
		assert.equal(native.snapshot.positionSeconds, 90)
		assert.equal(listening.getResumePoint(p1.id)?.completed, false)
	} finally {
		raw.close()
	}
})

const playlist = () => [
	{ itemId: 'a-first', source: music },
	{ itemId: 'b', source: p1 },
	{ itemId: 'a-second', source: music },
]

void test('[A,B,A]按第二个A起播，队列身份独立且来源和URI不克隆', async () => {
	const { controller, native, sessions, raw } = setup()
	try {
		await controller.playPlaylist(
			playlist(),
			'a-second',
			await controller.reservePlayback(),
		)
		const expected = playlist().map((entry) => playlistEntryId(entry.itemId))
		assert.deepEqual(
			native.snapshot.tracks.map((entry) => entry.id),
			expected,
		)
		assert.deepEqual(
			native.snapshot.tracks.map((entry) => entry.sourceId),
			[music.id, p1.id, music.id],
		)
		assert.equal(native.snapshot.currentEntryId, expected[2])
		assert.equal(native.snapshot.currentSourceId, music.id)
		assert.equal(native.snapshot.positionSeconds, 0)
		assert.equal(native.snapshot.tracks[0].url, native.snapshot.tracks[2].url)
		assert.equal(
			raw.prepare('SELECT count(*) AS count FROM sources').get()?.count,
			3,
		)
		assert.deepEqual(
			sessions.getSession('music')?.entries.map((entry) => entry.entryId),
			expected,
		)
		assert.equal(sessions.getSession('music')?.currentEntryId, expected[2])
		await controller.select(0, await controller.reservePlayback())
		await controller.select(1, await controller.reservePlayback())
		assert.equal(native.snapshot.currentSourceId, p1.id)
		await controller.select(2, await controller.reservePlayback())
		assert.equal(native.snapshot.currentEntryId, expected[2])
		const before = structuredClone(native.snapshot)
		assert.equal(
			await controller.select(3, await controller.reservePlayback()),
			null,
		)
		assert.deepEqual(native.snapshot, before)
	} finally {
		raw.close()
	}
})

void test('重复音乐队列跨听视频和冷启动副本保留第二个A游标与位置', async () => {
	const { controller, native, sessions, library, listening, raw } = setup()
	try {
		await controller.playPlaylist(
			playlist(),
			'a-second',
			await controller.reservePlayback(),
		)
		native.snapshot.positionSeconds = 86
		await controller.playSource(
			p2,
			await controller.reservePlayback(),
			'listening',
		)
		assert.equal(
			native.snapshot.inactiveSession?.currentEntryId,
			playlistEntryId('a-second'),
		)
		// A fresh JS controller reads the native cold-start snapshot; it must not restart it.
		native.snapshot = { ...structuredClone(native.snapshot), playing: false }
		const restored = new PlaybackController(
			native,
			library,
			listening,
			sessions,
		)
		await restored.sync()
		assert.equal(native.snapshot.playing, false)
		await restored.returnToMusic(await restored.reservePlayback())
		assert.equal(native.snapshot.currentEntryId, playlistEntryId('a-second'))
		assert.equal(native.snapshot.positionSeconds, 86)
		assert.equal(native.snapshot.speed, 1)
		assert.equal(native.snapshot.tracks.length, 3)
		await restored.playSource(p2, await restored.reservePlayback(), 'listening')
		// Exercise the SQLite fallback too, without a source-ID-only reconstruction.
		native.snapshot.inactiveSession = null
		await restored.returnToMusic(await restored.reservePlayback())
		assert.deepEqual(
			native.snapshot.tracks.map((entry) => entry.id),
			playlist().map((entry) => playlistEntryId(entry.itemId)),
		)
		assert.equal(native.snapshot.currentEntryId, playlistEntryId('a-second'))
		assert.equal(native.snapshot.positionSeconds, 86)
	} finally {
		raw.close()
	}
})

void test('已有重复队列的预检失败、取消和非法歌单输入保留原会话', async () => {
	const { controller, native, raw } = setup()
	try {
		await controller.playPlaylist(
			playlist(),
			'a-second',
			await controller.reservePlayback(),
		)
		const before = structuredClone(native.snapshot)
		for (const [entries, start] of [
			[[], 'missing'],
			[[playlist()[0], playlist()[0]], 'a-first'],
			[playlist(), 'missing'],
		] as const)
			await assert.rejects(
				controller.playPlaylist(
					[...entries],
					start,
					await controller.reservePlayback(),
				),
				/歌单|起播/,
			)
		assert.deepEqual(native.snapshot, before)
		native.failure = new Error('AudioOnlyUnavailable')
		await assert.rejects(
			controller.playPlaylist(
				playlist(),
				'b',
				await controller.reservePlayback(),
			),
			/AudioOnlyUnavailable/,
		)
		assert.deepEqual(native.snapshot, before)
		native.failure = null
		const wait = deferred()
		const started = deferred()
		native.prepare = () => {
			started.resolve()
			return wait.promise
		}
		const pending = controller.playPlaylist(
			playlist(),
			'b',
			await controller.reservePlayback(),
		)
		await started.promise
		await controller.cancelPending()
		wait.resolve()
		assert.equal(await pending, null)
		assert.deepEqual(native.snapshot, before)
	} finally {
		raw.close()
	}
})

void test('按Source重新播放当前第二个A不会切成第一个A，也不折叠队列', async () => {
	const { controller, native, raw } = setup()
	try {
		await controller.playPlaylist(
			playlist(),
			'a-second',
			await controller.reservePlayback(),
		)
		native.snapshot.positionSeconds = 45
		await controller.playSource(music, await controller.reservePlayback())
		assert.equal(native.snapshot.currentEntryId, playlistEntryId('a-second'))
		assert.equal(native.snapshot.positionSeconds, 45)
		assert.equal(native.snapshot.tracks.length, 3)
	} finally {
		raw.close()
	}
})

void test('late old native sync cannot roll SQLite session back after a newer successful sync', async () => {
	const { raw, controller, native, sessions } = setup()
	try {
		const old = structuredClone(native.snapshot)
		let release!: (value: PlaybackSnapshot) => void
		const pending = new Promise<PlaybackSnapshot>((done) => {
			release = done
		})
		let reads = 0
		native.getPlaybackSnapshot = () =>
			++reads === 1
				? pending
				: Promise.resolve({ ...old, positionSeconds: 160, updatedAt: 20 })
		const stale = controller.sync()
		await controller.sync()
		assert.equal(sessions.getSession('music')?.positionSeconds, 160)
		release(old)
		await stale
		assert.equal(sessions.getSession('music')?.positionSeconds, 160)
	} finally {
		raw.close()
	}
})

void test('replacement response waiting on token query cannot roll back newer sync', async () => {
	const { raw, controller, native, sessions } = setup()
	try {
		const preparation = await controller.reservePlayback()
		let heldOnce = false
		let release!: (value: boolean) => void
		let reached!: () => void
		const entered = new Promise<void>((done) => {
			reached = done
		})
		const held = new Promise<boolean>((done) => {
			release = done
		})
		native.isPlaybackReplacementCurrent = async (token) => {
			if (native.replacements === 1 && !heldOnce) {
				heldOnce = true
				reached()
				return held
			}
			return token === native.generation
		}
		const play = controller.playPlaylist(
			[{ itemId: 'item-1', source: music }],
			'item-1',
			preparation,
		)
		await entered
		native.snapshot.positionSeconds = 160
		native.snapshot.updatedAt = 30
		await controller.sync()
		assert.equal(sessions.getSession('music')?.positionSeconds, 160)
		release(true)
		await play
		assert.equal(sessions.getSession('music')?.positionSeconds, 160)
	} finally {
		raw.close()
	}
})

void test('projection order follows reads when the native wall clock moves backwards', async () => {
	const { raw, controller, native, sessions } = setup()
	try {
		await controller.sync()
		native.snapshot.positionSeconds = 160
		native.snapshot.updatedAt = 5
		await controller.sync()
		assert.equal(sessions.getSession('music')?.positionSeconds, 160)
		assert.equal(sessions.getSession('music')?.updatedAt, 5)
	} finally {
		raw.close()
	}
})

void test('committed playlist stays successful when its repair read fails and later sync repairs the copy', async () => {
	const { raw, controller, native, sessions } = setup()
	try {
		const preparation = await controller.reservePlayback()
		let reads = 0
		const failure = new Error('bridge read failed after native commit')
		native.getPlaybackSnapshot = async () => {
			if (++reads === 2) throw failure
			return structuredClone(native.snapshot)
		}
		const result = await controller.playPlaylist(
			[{ itemId: 'item-1', source: p1 }],
			'item-1',
			preparation,
		)
		assert.equal(result?.currentSourceId, p1.id)
		assert.equal(native.snapshot.playing, true)
		assert.equal(controller.syncCause, failure)
		assert.match(controller.syncError, /记录保存失败/)
		await controller.sync()
		assert.equal(sessions.getSession('music')?.currentSourceId, p1.id)
		assert.equal(controller.syncError, '')
	} finally {
		raw.close()
	}
})

void test('a newer precommit sync does not prevent the committed playlist copy from advancing', async () => {
	const { raw, controller, native, sessions } = setup()
	try {
		const preparation = await controller.reservePlayback()
		const ready = deferred(),
			proceed = deferred()
		native.prepare = async () => {
			ready.resolve()
			await proceed.promise
		}
		const play = controller.playPlaylist(
			[{ itemId: 'item-1', source: p1 }],
			'item-1',
			preparation,
		)
		await ready.promise
		await controller.sync()
		assert.equal(sessions.getSession('music')?.currentSourceId, music.id)
		proceed.resolve()
		assert.equal((await play)?.currentSourceId, p1.id)
		assert.equal(sessions.getSession('music')?.currentSourceId, p1.id)
	} finally {
		raw.close()
	}
})

void test('late failed commit repair cannot overwrite the cause from a newer projection', async () => {
	const { raw, controller, native, sessions } = setup()
	try {
		const preparation = await controller.reservePlayback()
		const entered = deferred()
		let reject!: (cause: Error) => void
		const pending = new Promise<PlaybackSnapshot>((_, no) => {
			reject = no
		})
		let reads = 0
		native.getPlaybackSnapshot = async () => {
			if (++reads === 2) {
				entered.resolve()
				return pending
			}
			return structuredClone(native.snapshot)
		}
		const play = controller.playPlaylist(
			[{ itemId: 'item-1', source: p1 }],
			'item-1',
			preparation,
		)
		await entered.promise
		const currentFailure = new Error('current SQLite projection failure')
		sessions.saveSession = () => {
			throw currentFailure
		}
		await controller.sync()
		assert.equal(controller.syncCause, currentFailure)
		reject(new Error('obsolete commit read failed'))
		assert.equal((await play)?.currentSourceId, p1.id)
		assert.equal(controller.syncCause, currentFailure)
	} finally {
		raw.close()
	}
})

void test('late older success cannot clear a newer SQLite projection failure', async () => {
	const { raw, controller, native, sessions } = setup()
	try {
		let release!: (value: PlaybackSnapshot) => void
		const pending = new Promise<PlaybackSnapshot>((yes) => {
			release = yes
		})
		let reads = 0
		native.getPlaybackSnapshot = () =>
			++reads === 1
				? pending
				: Promise.resolve(structuredClone(native.snapshot))
		const old = controller.sync()
		const failure = new Error('current SQLite projection failure')
		const save = sessions.saveSession.bind(sessions)
		sessions.saveSession = () => {
			throw failure
		}
		await controller.sync()
		sessions.saveSession = save
		release(structuredClone(native.snapshot))
		await old
		assert.equal(controller.syncCause, failure)
		assert.match(controller.syncError, /记录保存失败/)
	} finally {
		raw.close()
	}
})

void test('review: cancelled repair with SQLite failure preserves newer warning', async () => {
	const { raw, controller, native, sessions } = setup()
	try {
		const prep = await controller.reservePlayback()
		let reads = 0,
			release!: (s: PlaybackSnapshot) => void,
			entered!: () => void
		const hold = new Promise<PlaybackSnapshot>((r) => (release = r))
		const ready = new Promise<void>((r) => (entered = r))
		native.getPlaybackSnapshot = async () => {
			if (++reads === 2) {
				entered()
				return hold
			}
			return structuredClone(native.snapshot)
		}
		const play = controller.playPlaylist(
			[{ itemId: 'one', source: p1 }],
			'one',
			prep,
		)
		await ready
		const next = await controller.reservePlayback()
		const latest = new Error('newer intent cleanup failure')
		native.finishPlaybackPreparationIfCurrent = async () => {
			throw latest
		}
		await controller.finishPreparation(next)
		assert.equal(controller.syncCause, latest)
		sessions.saveSession = () => {
			throw new Error('obsolete repair SQLite failure')
		}
		release(structuredClone(native.snapshot))
		assert.equal(await play, null)
		assert.equal(controller.syncCause, latest)
	} finally {
		raw.close()
	}
})

void test('review: cancelled successful repair cannot clear newer warning', async () => {
	const { raw, controller, native } = setup()
	try {
		const prep = await controller.reservePlayback()
		let reads = 0,
			release!: (s: PlaybackSnapshot) => void,
			entered!: () => void
		const hold = new Promise<PlaybackSnapshot>((r) => (release = r))
		const ready = new Promise<void>((r) => (entered = r))
		native.getPlaybackSnapshot = async () => {
			if (++reads === 2) {
				entered()
				return hold
			}
			return structuredClone(native.snapshot)
		}
		const play = controller.playPlaylist(
			[{ itemId: 'one', source: p1 }],
			'one',
			prep,
		)
		await ready
		const next = await controller.reservePlayback()
		const latest = new Error('newer intent cleanup failure')
		native.finishPlaybackPreparationIfCurrent = async () => {
			throw latest
		}
		await controller.finishPreparation(next)
		assert.equal(controller.syncCause, latest)

		release(structuredClone(native.snapshot))
		assert.equal(await play, null)
		assert.equal(controller.syncCause, latest)
	} finally {
		raw.close()
	}
})

void test('identity-bound queue selection follows the displayed entry after reorder and never falls back to an old index', async () => {
	const { raw, native, controller } = setup()
	try {
		native.snapshot.tracks = [track(music), track(p2), track(p1)]
		await controller.select(1, await controller.reservePlayback(), p1.id)
		assert.equal(native.snapshot.currentEntryId, p1.id)
		const replacements = native.replacements
		assert.equal(
			await controller.select(
				1,
				await controller.reservePlayback(),
				'missing-entry',
			),
			null,
		)
		assert.equal(native.replacements, replacements)
	} finally {
		raw.close()
	}
})

void test('本地音频统一播放与音乐会话冷恢复，失败不替换当前音乐', async () => {
	const { controller, native, sessions, localAudio, library, listening, raw } =
		setup()
	const id = 'local:12345678-1234-1234-1234-123456789abc'
	try {
		localAudio.add({
			id,
			originalName: 'song.mp3',
			title: '离线歌曲',
			artist: '作者',
			durationSeconds: 120,
			bytes: 4096,
			importedAt: 1,
		})
		const previous = structuredClone(native.snapshot)
		native.failure = new Error('LocalAudioUnavailable')
		await assert.rejects(
			controller.playLocalAudio(id, await controller.reservePlayback()),
			/LocalAudioUnavailable/,
		)
		assert.deepEqual(native.snapshot, previous)
		native.failure = null
		await controller.playLocalAudio(id, await controller.reservePlayback())
		assert.equal(native.snapshot.currentSourceId, id)
		assert.equal(
			native.snapshot.tracks[0].url,
			'orpheus://local-audio?id=12345678-1234-1234-1234-123456789abc',
		)
		assert.equal(library.get(id), null)
		native.snapshot.positionSeconds = 37
		await controller.playSource(
			p1,
			await controller.reservePlayback(),
			'listening',
		)
		// Simulate native inactive-session loss; SQLite still contains the music snapshot.
		native.snapshot.inactiveSession = null
		const restored = new PlaybackController(
			native,
			library,
			listening,
			sessions,
			localAudio,
		)
		await restored.returnToMusic(await restored.reservePlayback())
		assert.equal(native.snapshot.currentSourceId, id)
		assert.equal(native.snapshot.positionSeconds, 37)
		assert.equal(native.snapshot.tracks[0].title, '离线歌曲')
	} finally {
		raw.close()
	}
})

void test('本地和B站混合队列重排后按真实身份持久化、冷恢复并选择', async () => {
	const { controller, native, sessions, localAudio, library, listening, raw } =
		setup()
	const id = 'local:12345678-1234-1234-1234-123456789abc'
	try {
		localAudio.add({
			id,
			originalName: 'mixed.flac',
			title: '离线曲目',
			artist: '本地作者',
			durationSeconds: 120,
			bytes: 4096,
			importedAt: 1,
		})
		await controller.playLocalAudio(id, await controller.reservePlayback())
		await controller.playSource(
			music,
			await controller.reservePlayback(),
			'music',
		)
		await controller.playSource(p1, await controller.reservePlayback(), 'music')
		assert.deepEqual(
			native.snapshot.tracks.map((item) => item.id),
			[id, music.id, p1.id],
		)
		await controller.select(1, await controller.reservePlayback(), music.id)
		native.snapshot.positionSeconds = 29
		// Model the committed native move-next snapshot; native move planning is tested separately.
		const local = native.snapshot.tracks.shift()!
		native.snapshot.tracks.splice(1, 0, local)
		await controller.sync()
		assert.deepEqual(
			sessions.getSession('music')?.entries,
			[music.id, id, p1.id].map((sourceIdentity) => ({
				entryId: sourceIdentity,
				sourceId: sourceIdentity,
			})),
		)
		assert.equal(sessions.getSession('music')?.positionSeconds, 29)
		await controller.playSource(
			p2,
			await controller.reservePlayback(),
			'listening',
		)
		native.snapshot.inactiveSession = null
		const restored = new PlaybackController(
			native,
			library,
			listening,
			sessions,
			localAudio,
		)
		await restored.returnToMusic(await restored.reservePlayback())
		assert.deepEqual(
			native.snapshot.tracks.map((item) => item.id),
			[music.id, id, p1.id],
		)
		assert.equal(native.snapshot.currentEntryId, music.id)
		assert.equal(native.snapshot.positionSeconds, 29)
		assert.equal(native.snapshot.tracks[1].title, '离线曲目')
		assert.equal(
			native.snapshot.tracks[1].url,
			'orpheus://local-audio?id=12345678-1234-1234-1234-123456789abc',
		)
		await restored.select(0, await restored.reservePlayback(), id)
		assert.equal(native.snapshot.currentEntryId, id)
		assert.equal(native.snapshot.currentSourceId, id)
		assert.equal(library.get(id), null)
		assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), [])
	} finally {
		raw.close()
	}
})

void test('next and previous use the fresh native occurrence order after queue move or removal', async () => {
	const { raw, native, controller } = setup()
	try {
		// UI still has [p1, music(current), p2]. Move p1 next changes the live index.
		native.snapshot.tracks = [track(music), track(p1), track(p2)]
		await controller.select('next', await controller.reservePlayback())
		assert.equal(native.snapshot.currentEntryId, p1.id)
		// Removing an earlier entry while projection is pending similarly changes the current index.
		native.snapshot.tracks = [track(music), track(p2)]
		native.snapshot.currentEntryId = p2.id
		await controller.select('previous', await controller.reservePlayback())
		assert.equal(native.snapshot.currentEntryId, music.id)
		const replacements = native.replacements
		assert.equal(
			await controller.select('previous', await controller.reservePlayback()),
			null,
		)
		native.snapshot.currentEntryId = 'missing-entry'
		assert.equal(
			await controller.select('next', await controller.reservePlayback()),
			null,
		)
		assert.equal(native.replacements, replacements)
	} finally {
		raw.close()
	}
})

void test('directional selection cannot commit after a newer playback preparation takes ownership', async () => {
	const { raw, native, controller } = setup()
	try {
		native.snapshot.tracks = [track(music), track(p1), track(p2)]
		const old = await controller.reservePlayback()
		await controller.reservePlayback()
		assert.equal(await controller.select('next', old), null)
		assert.equal(native.replacements, 0)
		assert.equal(native.snapshot.currentEntryId, music.id)
	} finally {
		raw.close()
	}
})

void test('本地重复歌单条目保持独立身份，切听视频后冷恢复第二个 occurrence', async () => {
	const { controller, native, sessions, localAudio, library, listening, raw } =
		setup()
	try {
		const audio = {
			id: 'local:12345678-1234-1234-1234-123456789abc',
			originalName: 'song.flac',
			title: '离线',
			artist: '本地',
			durationSeconds: 120,
			bytes: 2048,
			importedAt: 1,
		}
		localAudio.add(audio)
		const local = localLibrarySource(audio)
		await controller.playPlaylist(
			[
				{ itemId: 'local-first', source: local },
				{ itemId: 'remote', source: music },
				{ itemId: 'local-second', source: local },
			],
			'local-second',
			await controller.reservePlayback(),
		)
		assert.equal(
			native.snapshot.currentEntryId,
			playlistEntryId('local-second'),
		)
		assert.deepEqual(
			native.snapshot.tracks.map((t) => t.sourceId),
			[audio.id, music.id, audio.id],
		)
		assert.equal(sessions.getSession('music')?.entries.length, 3)
		native.snapshot.positionSeconds = 42
		await controller.playSource(
			p1,
			await controller.reservePlayback(),
			'listening',
		)
		native.snapshot.inactiveSession = null
		const restored = new PlaybackController(
			native,
			library,
			listening,
			sessions,
			localAudio,
		)
		await restored.returnToMusic(await restored.reservePlayback())
		assert.equal(
			native.snapshot.currentEntryId,
			playlistEntryId('local-second'),
		)
		assert.equal(native.snapshot.positionSeconds, 42)
		assert.equal(
			native.snapshot.tracks[2].url,
			`orpheus://local-audio?id=${audio.id.slice(6)}`,
		)
	} finally {
		raw.close()
	}
})
