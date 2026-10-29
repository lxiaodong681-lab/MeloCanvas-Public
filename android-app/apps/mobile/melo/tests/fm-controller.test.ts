import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import type {
	PlaybackSessionSnapshot,
	PlaybackSnapshot,
	Track,
} from '@bbplayer/orpheus'
import ts from 'typescript'

import { Library, migrate, type Database } from '../core/database'
import { ListeningLibrary } from '../core/listening'
import { sourceId, sourceUri, type Source } from '../core/model'
import { SessionStore } from '../core/sessions'
import { PlaybackIntent } from '../playback-intent'
import { PlaybackController, type PlaybackNative } from '../playbackController'

const source = (cid: number): Source => ({
	id: sourceId('BV1vT411i7ET', cid),
	bvid: 'BV1vT411i7ET',
	cid,
	originalTitle: `原音源${cid}`,
	uploader: 'UP',
	uploaderId: 1,
	performer: null,
	artwork: '',
	duration: 300,
	domain: 'unclassified',
	audioAvailability: 'unknown',
})
const track = (value: Source, id = value.id): Track => ({
	id,
	sourceId: value.id,
	url: sourceUri(value),
	title: value.originalTitle,
	duration: 300,
})
const clone = <T>(value: T): T => structuredClone(value)
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (cause: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const settle = async () => {
	for (let i = 0; i < 40; i++) await Promise.resolve()
}
const manual = (): PlaybackSessionSnapshot => ({
	mode: 'music',
	tracks: [
		track(source(1), 'playlist-item:a1'),
		track(source(2), 'playlist-item:b'),
		track(source(1), 'playlist-item:a2'),
	],
	currentEntryId: 'playlist-item:a2',
	currentSourceId: source(1).id,
	positionSeconds: 80,
	durationSeconds: 300,
	speed: 1,
	playing: true,
	playWhenReady: true,
	repeatMode: 2,
	shuffleEntryIds: ['playlist-item:b', 'playlist-item:a1', 'playlist-item:a2'],
	updatedAt: 10,
})
const listening = (): PlaybackSessionSnapshot => ({
	mode: 'listening',
	tracks: [track(source(11)), track(source(12))],
	currentEntryId: source(12).id,
	currentSourceId: source(12).id,
	positionSeconds: 150,
	durationSeconds: 300,
	speed: 1.5,
	playing: false,
	playWhenReady: false,
	updatedAt: 20,
})

/** Contract double only. Android persistence/preflight/Main atomicity are checked by the native author. */
class Native implements PlaybackNative {
	snapshot: PlaybackSnapshot = {
		...manual(),
		inactiveSession: listening(),
		resumePoints: [],
		fm: null,
	}
	generation = 0
	pending: number | null = null
	sequence = 0
	replacements = 0
	starts = 0
	reads = 0
	lastContext: string | null = null
	beforeStart: (() => Promise<void>) | null = null
	read: (() => Promise<PlaybackSnapshot>) | null = null
	appendReply:
		| ((value: {
				applied: boolean
				current: PlaybackSnapshot
		  }) => Promise<{ applied: boolean; current: PlaybackSnapshot }>)
		| null = null
	async getPlaybackSnapshot() {
		this.reads++
		return this.read ? this.read() : clone(this.snapshot)
	}
	async cancelPlaybackReplacement() {
		this.pending = ++this.generation
		return this.generation
	}
	async isPlaybackReplacementCurrent(token: number) {
		return token === this.generation
	}
	async cancelPlaybackReplacementIfCurrent(token: number) {
		if (token !== this.generation) return false
		this.generation++
		this.pending = null
		return true
	}
	async finishPlaybackPreparationIfCurrent(token: number) {
		if (token !== this.generation || this.pending !== token) return false
		this.pending = null
		return true
	}
	private check(token: number) {
		if (token !== this.generation)
			throw new Error('PlaybackReplacementCancelled')
	}
	async startFm(tracks: Track[], token: number) {
		try {
			this.starts++
			if (this.beforeStart) await this.beforeStart()
			this.check(token)
			if (this.snapshot.fm) throw new Error('FM context already exists')
			const previous = clone(this.snapshot)
			const manualMusic =
				previous.mode === 'music'
					? previous
					: previous.inactiveSession?.mode === 'music'
						? previous.inactiveSession
						: null
			this.snapshot = {
				...previous,
				mode: 'music',
				tracks,
				currentEntryId: tracks[0].id,
				currentSourceId: tracks[0].sourceId!,
				positionSeconds: 0,
				speed: 1,
				playing: true,
				playWhenReady: true,
				repeatMode: 0,
				shuffleEntryIds: null,
				inactiveSession:
					previous.mode === 'listening' ? previous : previous.inactiveSession,
				fm: {
					id: `fm-${++this.sequence}`,
					returnMode: previous.mode,
					manualMusic,
					returnListening: previous.mode === 'listening' ? previous : null,
				},
			}
			return { previous, current: clone(this.snapshot) }
		} finally {
			await this.finishPlaybackPreparationIfCurrent(token)
		}
	}
	async replacePlayback(
		tracks: Track[],
		id: string,
		position: number,
		speed: number,
		playing: boolean,
		mode: 'music' | 'listening',
		token: number,
		fmId: string | null = null,
	) {
		try {
			this.check(token)
			this.lastContext = fmId
			if (mode === 'music' && fmId) {
				const side =
					this.snapshot.mode === 'music'
						? this.snapshot
						: this.snapshot.inactiveSession
				if (
					this.snapshot.fm?.id !== fmId ||
					JSON.stringify(side?.tracks) !== JSON.stringify(tracks)
				)
					throw new Error('FM queue changed')
			}
			this.replacements++
			const previous = clone(this.snapshot)
			this.snapshot = {
				...previous,
				mode,
				tracks,
				currentEntryId: id,
				currentSourceId: tracks.find((item) => item.id === id)!.sourceId!,
				positionSeconds: position,
				speed,
				playing,
				inactiveSession:
					previous.mode === mode ? previous.inactiveSession : previous,
				fm: mode === 'music' && !fmId ? null : previous.fm,
			}
			return { previous, current: clone(this.snapshot) }
		} finally {
			await this.finishPlaybackPreparationIfCurrent(token)
		}
	}
	async exitFm(id: string, token: number) {
		try {
			this.check(token)
			const previous = clone(this.snapshot),
				fm = previous.fm
			if (!fm || fm.id !== id) throw new Error('FM context changed')
			const empty: PlaybackSessionSnapshot = {
				mode: 'music',
				tracks: [],
				currentEntryId: null,
				currentSourceId: null,
				positionSeconds: 0,
				durationSeconds: 0,
				speed: 1,
				playing: false,
				updatedAt: 30,
			}
			const target =
				fm.returnMode === 'listening'
					? fm.returnListening!
					: (fm.manualMusic ?? empty)
			const other =
				fm.returnMode === 'listening'
					? fm.manualMusic
					: previous.mode === 'listening'
						? previous
						: previous.inactiveSession
			this.snapshot = {
				...target,
				playing: target.playWhenReady ?? target.playing,
				inactiveSession: other,
				resumePoints: previous.resumePoints,
				fm: null,
			}
			return { previous, current: clone(this.snapshot) }
		} finally {
			await this.finishPlaybackPreparationIfCurrent(token)
		}
	}
	async appendFm(tracks: Track[], id: string, tail: string) {
		const side =
			this.snapshot.mode === 'music'
				? this.snapshot
				: this.snapshot.inactiveSession
		let applied = false
		if (
			this.snapshot.fm?.id === id &&
			side?.tracks.at(-1)?.id === tail &&
			this.pending === null
		) {
			if (tracks.some((item) => side.tracks.some((old) => old.id === item.id)))
				throw new Error('duplicate FM source')
			side.tracks.push(...tracks)
			applied = true
		}
		const result = { applied, current: clone(this.snapshot) }
		return this.appendReply ? this.appendReply(result) : result
	}
}
function fixture(filename = ':memory:') {
	const raw = new DatabaseSync(filename)
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
	}
	migrate(db)
	const library = new Library(db),
		sessions = new SessionStore(db),
		points = new ListeningLibrary(db),
		native = new Native()
	for (const cid of [1, 2, 11, 12, 21, 22, 23]) library.save(source(cid))
	const controller = new PlaybackController(native, library, points, sessions)
	return { raw, library, sessions, points, native, controller }
}

void test('unreadable native storage cannot erase or replace real SQLite queue and resume bytes; recovery still mirrors', async () => {
	const folder = mkdtempSync(join(tmpdir(), 'melo-fm-mirror-')),
		filename = join(folder, 'library.sqlite'),
		f = fixture(filename)
	try {
		f.controller.reconcile(f.native.snapshot)
		const point = {
			sourceId: source(12).id,
			positionSeconds: 150,
			durationSeconds: 300,
			completed: false,
			updatedAt: 20,
		}
		f.points.saveResumePoint(point)
		const before = readFileSync(filename)
		const empty: PlaybackSnapshot & { sessionStorageUnreadable: boolean } = {
			...manual(),
			tracks: [],
			currentEntryId: null,
			currentSourceId: null,
			positionSeconds: 0,
			playing: false,
			inactiveSession: null,
			fm: null,
			resumePoints: [{ ...point, positionSeconds: 0, updatedAt: 200 }],
			sessionStorageUnreadable: true,
		}
		for (const suspect of [
			empty,
			{
				...empty,
				tracks: [track(source(21))],
				currentEntryId: source(21).id,
				currentSourceId: source(21).id,
				inactiveSession: listening(),
			},
			{
				...empty,
				fm: {
					id: 'untrusted-fm',
					returnMode: 'music' as const,
					manualMusic: { ...manual(), positionSeconds: 0 },
					returnListening: null,
				},
			},
		]) {
			f.native.snapshot = suspect
			await f.controller.sync()
			assert.deepEqual(readFileSync(filename), before)
			assert.match(f.controller.syncError, /读取|损坏/)
		}
		assert.equal(
			f.sessions.getSession('music')!.currentEntryId,
			'playlist-item:a2',
		)
		assert.deepEqual(f.points.getResumePoint(point.sourceId), point)
		const reopened = new DatabaseSync(filename)
		try {
			assert.equal(
				reopened
					.prepare(
						"SELECT currentEntryId FROM playback_sessions WHERE mode='music'",
					)
					.get()!.currentEntryId,
				'playlist-item:a2',
			)
			assert.equal(
				reopened
					.prepare('SELECT positionSeconds FROM resume_points WHERE sourceId=?')
					.get(point.sourceId)!.positionSeconds,
				150,
			)
		} finally {
			reopened.close()
		}
		// A normal live persistence warning is not an unreadable-storage signal.
		f.native.snapshot = {
			...f.native.snapshot,
			...manual(),
			fm: null,
			inactiveSession: listening(),
			resumePoints: [],
			positionSeconds: 42,
			persistenceError: 'live write warning',
			sessionStorageUnreadable: false,
		}
		await f.controller.sync()
		assert.equal(f.sessions.getSession('music')!.positionSeconds, 42)
		assert.equal(f.controller.syncError, '')
	} finally {
		f.raw.close()
		rmSync(folder, { recursive: true, force: true })
	}
})

void test('unreadable storage refuses native and SQLite queue fallback before replacement, while a normal snapshot remains usable', async () => {
	const f = fixture()
	try {
		f.controller.reconcile(f.native.snapshot)
		const suspect: PlaybackSnapshot & { sessionStorageUnreadable: boolean } = {
			...listening(),
			inactiveSession: null,
			fm: null,
			resumePoints: [],
			sessionStorageUnreadable: true,
		}
		f.native.snapshot = suspect
		let fallbackReads = 0
		const controller = new PlaybackController(f.native, f.library, f.points, {
			saveSession: (value) => f.sessions.saveSession(value),
			getSession: (mode) => {
				fallbackReads++
				return f.sessions.getSession(mode)
			},
		})
		assert.equal(controller.canReturnMusic(suspect), false)
		assert.equal(controller.canReturnMusic({ ...suspect, ...manual() }), false)
		for (const action of [
			() => controller.playSource(source(1), { token: f.native.generation }),
			() =>
				controller.playPlaylist([{ itemId: 'a', source: source(1) }], 'a', {
					token: f.native.generation,
				}),
			() => controller.returnToMusic({ token: f.native.generation }),
			() => controller.select(0, { token: f.native.generation }),
		])
			await assert.rejects(action, /读取|损坏/)
		assert.equal(fallbackReads, 0)
		assert.equal(f.native.replacements, 0)
		assert.equal(
			controller.canReturnMusic({
				...suspect,
				sessionStorageUnreadable: false,
			}),
			true,
		)
		assert.equal(fallbackReads, 1)
	} finally {
		f.raw.close()
	}
})

void test('FM→listening→return music retains FM identity while SQLite always mirrors the manual A/B/A third occurrence', async () => {
	const f = fixture()
	try {
		const backup = manual()
		const fm = await f.controller.startFm(
			[source(21), source(22)],
			await f.controller.reservePlayback(),
		)
		assert.ok(fm?.fm)
		assert.equal(f.native.pending, null)
		assert.deepEqual(
			f.sessions.getSession('music')!.entries.map((item) => item.entryId),
			backup.tracks.map((item) => item.id),
		)
		assert.equal(
			f.sessions.getSession('music')!.currentEntryId,
			'playlist-item:a2',
		)
		await f.controller.playSource(
			source(11),
			await f.controller.reservePlayback(),
			'listening',
			[source(11), source(12)],
		)
		const returned = await f.controller.returnToMusic(
			await f.controller.reservePlayback(),
		)
		assert.equal(f.native.lastContext, fm.fm.id)
		assert.deepEqual(
			returned!.tracks.map((item) => item.id),
			[source(21).id, source(22).id],
		)
		assert.equal(returned!.fm!.id, fm.fm.id)
		assert.equal(
			f.sessions.getSession('music')!.currentEntryId,
			'playlist-item:a2',
		)
		assert.equal(f.library.get(source(21).id)!.domain, 'unclassified')
		assert.equal(f.library.get(source(21).id)!.audioAvailability, 'unknown')
	} finally {
		f.raw.close()
	}
})

void test('listening-origin FM exit delegates its frozen pause/position/speed return to native; cold FM sync never reconstructs from SQLite', async () => {
	const f = fixture()
	try {
		f.native.snapshot = {
			...listening(),
			inactiveSession: manual(),
			resumePoints: [],
			fm: null,
		}
		const fm = await f.controller.startFm(
			[source(21)],
			await f.controller.reservePlayback(),
		)
		assert.ok(fm?.fm)
		f.native.snapshot.playing = false
		const cold = await f.controller.sync()
		assert.equal(cold.fm!.id, fm.fm.id)
		assert.equal(cold.playing, false)
		assert.equal(f.native.starts, 1)
		const restored = await f.controller.exitFm(
			fm.fm.id,
			await f.controller.reservePlayback(),
		)
		assert.equal(restored!.fm, null)
		assert.equal(restored!.mode, 'listening')
		assert.equal(restored!.positionSeconds, 150)
		assert.equal(restored!.speed, 1.5)
		assert.equal(restored!.playing, false)
		assert.equal(
			f.sessions.getSession('music')!.currentEntryId,
			'playlist-item:a2',
		)
	} finally {
		f.raw.close()
	}
})

void test('explicit music Source uses the manual backup and playlist uses the explicit occurrence queue, clearing FM without appending its tracks', async () => {
	const f = fixture()
	try {
		await f.controller.startFm(
			[source(21)],
			await f.controller.reservePlayback(),
		)
		const clicked = await f.controller.playSource(
			source(1),
			await f.controller.reservePlayback(),
		)
		assert.equal(clicked!.fm, null)
		assert.deepEqual(
			clicked!.tracks.map((item) => item.id),
			manual().tracks.map((item) => item.id),
		)
		assert.equal(clicked!.currentEntryId, 'playlist-item:a2')
		await f.controller.startFm(
			[source(21)],
			await f.controller.reservePlayback(),
		)
		const playlist = await f.controller.playPlaylist(
			[
				{ itemId: 'a1', source: source(1) },
				{ itemId: 'b', source: source(2) },
				{ itemId: 'a2', source: source(1) },
			],
			'a2',
			await f.controller.reservePlayback(),
		)
		assert.equal(playlist!.fm, null)
		assert.deepEqual(
			playlist!.tracks.map((item) => item.id),
			manual().tracks.map((item) => item.id),
		)
		assert.equal(playlist!.currentEntryId, 'playlist-item:a2')
	} finally {
		f.raw.close()
	}
})

void test('null manual backup never revives stale SQLite during FM; explicit empty exit mirrors the real empty manual side', async () => {
	const f = fixture()
	try {
		f.controller.reconcile(f.native.snapshot)
		const stale = f.sessions.getSession('music')!
		f.native.snapshot = {
			mode: 'music',
			tracks: [],
			currentEntryId: null,
			currentSourceId: null,
			positionSeconds: 0,
			durationSeconds: 0,
			speed: 1,
			playing: false,
			updatedAt: 20,
			inactiveSession: listening(),
			resumePoints: [],
			fm: null,
		}
		const fm = await f.controller.startFm(
			[source(21)],
			await f.controller.reservePlayback(),
		)
		assert.equal(fm!.fm!.manualMusic!.tracks.length, 0)
		f.native.snapshot.fm!.manualMusic = null
		f.sessions.saveSession(stale)
		f.controller.reconcile(f.native.snapshot)
		assert.equal(
			f.sessions.getSession('music')!.currentEntryId,
			'playlist-item:a2',
		)
		const brokenReturn = {
			...listening(),
			inactiveSession: null,
			resumePoints: [],
			fm: f.native.snapshot.fm,
		}
		assert.equal(f.controller.canReturnMusic(brokenReturn), false)
		const result = await f.controller.playSource(
			source(2),
			await f.controller.reservePlayback(),
		)
		assert.deepEqual(
			result!.tracks.map((item) => item.id),
			[source(2).id],
		)
		await f.controller.startFm(
			[source(21)],
			await f.controller.reservePlayback(),
		)
		f.native.snapshot.fm!.manualMusic = null
		const exited = await f.controller.exitFm(
			f.native.snapshot.fm!.id,
			await f.controller.reservePlayback(),
		)
		assert.equal(exited!.tracks.length, 0)
		assert.equal(f.sessions.getSession('music')!.entries.length, 0)
	} finally {
		f.raw.close()
	}
})

void test('JS empty/duplicate/invalid metadata fails before native start and owned finish releases pending without changing token or original error', async () => {
	for (const sources of [
		[],
		[source(21), source(21)],
		[{ ...source(21), id: source(22).id }],
		[
			{
				...source(21),
				bvid: source(21).bvid + '\n',
				id: sourceId(source(21).bvid + '\n', 21),
			},
		],
	]) {
		const f = fixture()
		try {
			const before = clone(f.native.snapshot),
				prep = await f.controller.reservePlayback()
			await assert.rejects(f.controller.startFm(sources, prep), /候选|身份/)
			assert.equal(f.native.pending, null)
			assert.equal(await f.controller.isPreparationCurrent(prep), true)
			assert.equal(f.native.starts, 0)
			assert.deepEqual(f.native.snapshot, before)
		} finally {
			f.raw.close()
		}
	}
})

void test('append success preserves current state, conflicts do not reserve/cancel or reconcile, and stale FM selection cannot drop an appended tail', async () => {
	const f = fixture()
	try {
		const started = await f.controller.startFm(
				[source(21), source(22)],
				await f.controller.reservePlayback(),
			),
			fm = started!.fm!.id
		f.native.snapshot.positionSeconds = 123
		const token = f.native.generation
		assert.equal(
			await f.controller.appendFm([source(23)], fm, source(22).id),
			true,
		)
		assert.equal(f.native.snapshot.positionSeconds, 123)
		assert.equal(f.native.generation, token)
		assert.equal(
			await f.controller.appendFm([source(11)], fm, source(22).id),
			false,
		)
		assert.equal(f.native.generation, token)
		const old = clone(started!)
		f.native.read = async () => old
		await assert.rejects(
			f.controller.select(0, await f.controller.reservePlayback()),
			/FM queue changed/,
		)
		assert.deepEqual(
			f.native.snapshot.tracks.map((item) => item.id),
			[source(21).id, source(22).id, source(23).id],
		)
		assert.equal(f.native.lastContext, fm)
	} finally {
		f.raw.close()
	}
})

const hookText = readFileSync(new URL('../player.ts', import.meta.url), 'utf8')
const hookTree = ts.createSourceFile(
	'player.ts',
	hookText,
	ts.ScriptTarget.Latest,
	true,
)
const code = new Map<string, string>()
function visit(node: ts.Node) {
	if (ts.isFunctionDeclaration(node) && node.name)
		code.set(node.name.text, node.getText(hookTree))
	if (
		ts.isVariableDeclaration(node) &&
		['apply', 'sync'].includes(node.name.getText(hookTree)) &&
		node.initializer &&
		ts.isCallExpression(node.initializer)
	)
		code.set(
			node.name.getText(hookTree),
			`const ${node.name.getText(hookTree)} = ${node.initializer.arguments[0].getText(hookTree)}`,
		)
	if (
		ts.isPropertyAssignment(node) &&
		['startFm', 'exitFm'].includes(node.name.getText(hookTree))
	)
		code.set(node.name.getText(hookTree), node.initializer.getText(hookTree))
	ts.forEachChild(node, visit)
}
visit(hookTree)
function hook(f: ReturnType<typeof fixture>) {
	const ui = {
		fmId: null as string | null,
		queue: [] as string[],
		mode: '',
		playing: false,
		error: '',
		cause: null as unknown,
	}
	const alive = { current: true },
		operationVersion = { current: 0 }
	const scope = {
		controller: f.controller,
		alive,
		operationVersion,
		fmContextRef: { current: null },
		syncVersion: { current: 0 },
		lastSynced: { current: 0 },
		Date,
		Error,
		setFmContext: (value: { id: string } | null) => {
			ui.fmId = value?.id ?? null
		},
		setQueue: (value: Track[]) => {
			ui.queue = Array.from(value, (item) => item.id)
		},
		setMode: (value: string) => {
			ui.mode = value
		},
		setPlaying: (value: boolean) => {
			ui.playing = value
		},
		setError: (value: string) => {
			ui.error = value
		},
		setErrorCause: (value: unknown) => {
			ui.cause = value
		},
		setQueueIsSequential() {},
		setRepeatMode() {},
		progress: { update() {} },
		setShuffleEntryIds() {},
		setMusicQueueUndo() {},
		setSleepTimer() {},
		setTrack() {},
		setSpeedState() {},
		setPosition() {},
		setDuration() {},
		setResumePoints() {},
		setCanReturnMusic() {},
		setNativePersistenceError() {},
		setAuditionId() {},
		setSyncError() {},
		setSyncCause() {},
		setSwitching() {},
		playbackError: (message: string) => message,
	}
	const actions = runInNewContext(
		ts.transpileModule(
			[
				code.get('apply'),
				code.get('sync'),
				code.get('operation'),
				code.get('appendFm'),
				`({sync,operation,appendFm,startFm:${code.get('startFm')},exitFm:${code.get('exitFm')}})`,
			].join('\n'),
			{
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					module: ts.ModuleKind.None,
				},
			},
		).outputText,
		scope,
	) as {
		sync(): Promise<unknown>
		operation(
			action: () => Promise<PlaybackSnapshot | null>,
			prep: { token: number },
		): Promise<boolean>
		startFm(sources: Source[], prep: { token: number }): Promise<boolean>
		exitFm(id: string, prep: { token: number }): Promise<boolean>
		appendFm(sources: Source[], id: string, tail: string): Promise<boolean>
	}
	return { ...actions, ui, alive, operationVersion }
}

void test('actual hook start/exit exposes native FM context and empty preparation failure remains a real error while pending is released', async () => {
	const f = fixture(),
		h = hook(f)
	try {
		assert.equal(
			await h.startFm([], await f.controller.reservePlayback()),
			false,
		)
		assert.match(h.ui.error, /候选/)
		assert.equal(f.native.pending, null)
		assert.equal(
			await h.startFm([source(21)], await f.controller.reservePlayback()),
			true,
		)
		assert.equal(h.ui.fmId, f.native.snapshot.fm!.id)
		assert.equal(
			await h.exitFm(h.ui.fmId, await f.controller.reservePlayback()),
			true,
		)
		assert.equal(h.ui.fmId, null)
		assert.deepEqual(
			h.ui.queue,
			manual().tracks.map((item) => item.id),
		)
	} finally {
		f.raw.close()
	}
})

void test('actual hook append conflict and late success never publish its captured old snapshot over a newer explicit playback', async () => {
	const f = fixture(),
		h = hook(f)
	try {
		await h.startFm([source(21)], await f.controller.reservePlayback())
		const id = h.ui.fmId!,
			previous = clone(h.ui),
			reads = f.native.reads
		assert.equal(await h.appendFm([source(22)], id, 'wrong-tail'), false)
		assert.deepEqual(h.ui, previous)
		assert.equal(f.native.reads, reads)
		const reply = deferred<{ applied: boolean; current: PlaybackSnapshot }>()
		f.native.appendReply = () => reply.promise
		const work = h.appendFm([source(22)], id, source(21).id)
		await settle()
		const old = clone(f.native.snapshot)
		assert.equal(
			await h.operation(
				() =>
					f.controller.playSource(source(1), { token: f.native.generation }),
				await f.controller.reservePlayback(),
			),
			true,
		)
		reply.resolve({ applied: true, current: old })
		assert.equal(await work, false)
		assert.equal(h.ui.fmId, null)
		assert.deepEqual(
			h.ui.queue,
			manual().tracks.map((item) => item.id),
		)
	} finally {
		f.raw.close()
	}
})

void test('native cancellation during FM preflight prevents stale hook and PlaybackIntent onSuccess; a subsequent new explicit FM still succeeds', async () => {
	const f = fixture(),
		h = hook(f),
		intent = new PlaybackIntent(),
		entered = deferred<void>(),
		release = deferred<void>()
	let opened = 0
	try {
		f.native.beforeStart = async () => {
			entered.resolve()
			await release.promise
		}
		const work = intent.run({
			preparation: f.controller,
			prepare: async () => [source(21)],
			activate: (sources, prep) => h.startFm(sources, prep),
			onSuccess: () => {
				opened++
			},
		})
		await entered.promise
		await f.native.cancelPlaybackReplacement()
		release.resolve()
		assert.equal(await work, false)
		assert.equal(opened, 0)
		assert.equal(h.ui.fmId, null)
		f.native.beforeStart = null
		assert.equal(
			await h.startFm([source(21)], await f.controller.reservePlayback()),
			true,
		)
	} finally {
		release.resolve()
		f.raw.close()
	}
})

for (const failure of [false, true])
	void test(`new context snapshot arriving before old append ${failure ? 'rejection' : 'success'} suppresses stale FM completion without reserving`, async () => {
		const f = fixture(),
			h = hook(f),
			reply = deferred<{ applied: boolean; current: PlaybackSnapshot }>()
		try {
			await h.startFm([source(21)], await f.controller.reservePlayback())
			const fmId = h.ui.fmId!,
				token = f.native.generation
			f.native.appendReply = () => reply.promise
			const work = h.appendFm([source(22)], fmId, source(21).id)
			await settle()
			const old = clone(f.native.snapshot)
			f.native.snapshot.fm!.id = 'new-native-context'
			f.native.snapshot.tracks = [track(source(23))]
			f.native.snapshot.currentEntryId = source(23).id
			f.native.snapshot.currentSourceId = source(23).id
			await h.sync()
			if (failure) reply.reject(new Error('obsolete append failure'))
			else reply.resolve({ applied: true, current: old })
			assert.equal(await work, false)
			assert.equal(h.ui.fmId, 'new-native-context')
			assert.deepEqual(h.ui.queue, [source(23).id])
			assert.equal(h.ui.error, '')
			assert.equal(f.native.generation, token)
		} finally {
			f.raw.close()
		}
	})

void test('append refresh failure after a newer operation or unmount cannot publish an old error; current refresh error remains visible', async () => {
	for (const takeover of ['none', 'operation', 'unmount'] as const) {
		const f = fixture(),
			h = hook(f),
			refresh = deferred<PlaybackSnapshot>(),
			entered = deferred<void>()
		try {
			await h.startFm([source(21)], await f.controller.reservePlayback())
			f.native.read = () => {
				entered.resolve()
				return refresh.promise
			}
			const work = h.appendFm([source(22)], h.ui.fmId!, source(21).id)
			await entered.promise
			if (takeover === 'operation') h.operationVersion.current++
			if (takeover === 'unmount') h.alive.current = false
			const cause = new Error('append fresh read failed')
			refresh.reject(cause)
			assert.equal(await work, false)
			assert.equal(
				h.ui.error,
				takeover === 'none' ? '播放器连接失败，请重新打开应用' : '',
			)
			assert.equal(h.ui.cause, takeover === 'none' ? cause : null)
		} finally {
			f.raw.close()
		}
	}
})

void test('current preparation-finish failure is a separate warning and cannot mask validation failure or invalidate the token', async () => {
	const f = fixture(),
		cause = new Error('native finish unavailable')
	try {
		f.native.finishPlaybackPreparationIfCurrent = async () => {
			throw cause
		}
		const prep = await f.controller.reservePlayback()
		await assert.rejects(f.controller.startFm([], prep), /候选/)
		assert.equal(await f.controller.isPreparationCurrent(prep), true)
		assert.equal(f.controller.syncCause, cause)
		assert.match(f.controller.syncError, /准备清理失败/)
	} finally {
		f.raw.close()
	}
})

void test('awaiting old preparation finish cannot clear a newer owner or publish the old FM over a completed manual operation', async () => {
	const f = fixture(),
		h = hook(f),
		entered = deferred<void>(),
		release = deferred<void>()
	const finish = f.native.finishPlaybackPreparationIfCurrent.bind(f.native)
	let delayed = false
	try {
		f.native.finishPlaybackPreparationIfCurrent = async (token) => {
			if (token === 1 && !delayed) {
				delayed = true
				entered.resolve()
				await release.promise
			}
			return finish(token)
		}
		const old = h.startFm([source(21)], await f.controller.reservePlayback())
		await entered.promise
		const next = await f.controller.reservePlayback()
		assert.equal(
			await h.operation(() => f.controller.playSource(source(1), next), next),
			true,
		)
		assert.equal(h.ui.fmId, null)
		release.resolve()
		assert.equal(await old, false)
		assert.equal(h.ui.fmId, null)
		assert.deepEqual(
			h.ui.queue,
			manual().tracks.map((item) => item.id),
		)
		assert.equal(await f.controller.isPreparationCurrent(next), true)
	} finally {
		release.resolve()
		f.raw.close()
	}
})

void test('late FM repair read cannot replace a newer manual playlist projection after cancellation', async () => {
	const f = fixture()
	try {
		const first = await f.controller.reservePlayback()
		const held = deferred<PlaybackSnapshot>(),
			entered = deferred<void>()
		let reads = 0
		f.native.read = async () => {
			if (++reads === 1) {
				entered.resolve()
				return held.promise
			}
			return clone(f.native.snapshot)
		}
		const fm = f.controller.startFm([source(21), source(22)], first)
		await entered.promise
		const oldFm = clone(f.native.snapshot)
		const second = await f.controller.reservePlayback()
		const manualResult = await f.controller.playPlaylist(
			[{ itemId: 'new-item', source: source(2) }],
			'new-item',
			second,
		)
		assert.equal(manualResult?.currentEntryId, 'playlist-item:new-item')
		held.resolve(oldFm)
		assert.equal(await fm, null)
		assert.equal(
			f.sessions.getSession('music')?.currentEntryId,
			'playlist-item:new-item',
		)
	} finally {
		f.raw.close()
	}
})

void test('late playlist repair failure cannot poison a newer FM projection', async () => {
	const f = fixture()
	try {
		const first = await f.controller.reservePlayback()
		const held = deferred<PlaybackSnapshot>(),
			entered = deferred<void>()
		let reads = 0
		f.native.read = async () => {
			if (++reads === 2) {
				entered.resolve()
				return held.promise
			}
			return clone(f.native.snapshot)
		}
		const manualWork = f.controller.playPlaylist(
			[{ itemId: 'new-item', source: source(2) }],
			'new-item',
			first,
		)
		await entered.promise
		const second = await f.controller.reservePlayback()
		const fm = await f.controller.startFm([source(21), source(22)], second)
		assert.ok(fm?.fm)
		held.reject(new Error('old playlist repair failed'))
		assert.equal(await manualWork, null)
		assert.equal(f.controller.syncError, '')
		assert.equal(f.controller.syncCause, null)
		assert.equal(
			f.sessions.getSession('music')?.currentEntryId,
			'playlist-item:new-item',
		)
	} finally {
		f.raw.close()
	}
})

void test('FM exit refresh mirrors current native data but preserves captured manual return after clock rollback', async () => {
	const f = fixture()
	try {
		await f.controller.startFm(
			[source(21), source(22)],
			await f.controller.reservePlayback(),
		)
		assert.equal(
			f.sessions.getSession('music')?.currentEntryId,
			'playlist-item:a2',
		)
		const id = f.native.snapshot.fm!.id
		const original = f.native.exitFm.bind(f.native)
		f.native.exitFm = async (fmId, token) => {
			const result = await original(fmId, token)
			f.native.snapshot.positionSeconds = 90
			f.native.snapshot.updatedAt = 1
			return result
		}
		const result = await f.controller.exitFm(
			id,
			await f.controller.reservePlayback(),
		)
		assert.ok(result)
		assert.equal(
			f.sessions.getSession('music')?.currentEntryId,
			'playlist-item:a2',
		)
		assert.equal(f.sessions.getSession('music')?.positionSeconds, 90)
		assert.equal(f.sessions.getSession('music')?.updatedAt, 1)
	} finally {
		f.raw.close()
	}
})

void test('cancelling FM during the repair read suppresses its late failure without a newer sync', async () => {
	const f = fixture()
	try {
		const first = await f.controller.reservePlayback()
		const held = deferred<PlaybackSnapshot>(),
			entered = deferred<void>()
		f.native.read = async () => {
			entered.resolve()
			return held.promise
		}
		const work = f.controller.startFm([source(21), source(22)], first)
		await entered.promise
		await f.controller.cancelPreparation(first)
		held.reject(new Error('cancelled FM repair failed'))
		assert.equal(await work, null)
		assert.equal(f.controller.syncError, '')
		assert.equal(f.controller.syncCause, null)
	} finally {
		f.raw.close()
	}
})
