import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import type { PlaybackSnapshot, Track } from '@bbplayer/orpheus'

import { Library, migrate, type Database } from '../core/database'
import {
	exportLibraryBackup,
	replaceLibraryBackup,
	undoLibraryBackupReplacement,
} from '../core/library-backup'
import { ListeningLibrary, type ResumePoint } from '../core/listening'
import type { Source } from '../core/model'
import { SessionStore } from '../core/sessions'
import { readPlaybackMetadata } from '../playback-metadata'
import { PlaybackController, type PlaybackNative } from '../playbackController'

const source: Source = {
	id: 'bilibili:BV1vT411i7ET:123',
	bvid: 'BV1vT411i7ET',
	cid: 123,
	originalTitle: 'Synthetic',
	uploader: 'Fixture',
	uploaderId: 1,
	performer: null,
	artwork: '',
	duration: 300,
	domain: 'unclassified',
	audioAvailability: 'unknown',
}
const point = (positionSeconds: number, updatedAt: number): ResumePoint => ({
	sourceId: source.id,
	positionSeconds,
	durationSeconds: 300,
	completed: false,
	updatedAt,
})
const cover = (name: string) => name
const noop = () => {}
function fixture() {
	const raw = new DatabaseSync(':memory:')
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, args) => raw.prepare(sql).run(...args),
		getFirstSync: <T>(sql: string, args: (string | number | null)[]) =>
			(raw.prepare(sql).get(...args) as T) ?? null,
		getAllSync: <T>(sql: string, args: (string | number | null)[]) =>
			raw.prepare(sql).all(...args) as T[],
	}
	migrate(db)
	const library = new Library(db),
		listening = new ListeningLibrary(db)
	library.save(source)
	listening.saveResumePoint(point(30, 100))
	const backup = exportLibraryBackup(db)
	listening.saveResumePoint(point(90, 200))
	let snapshot: PlaybackSnapshot = {
		mode: 'music',
		tracks: [],
		currentEntryId: null,
		currentSourceId: null,
		positionSeconds: 0,
		durationSeconds: 0,
		speed: 1,
		playing: false,
		updatedAt: 200,
		inactiveSession: null,
		resumePoints: [point(90, 200)],
	}
	let beforeCommit = noop
	let afterRead: (() => Promise<void>) | null = null
	let activated: number | null = null
	let lastOverrides: Record<string, number> = {}
	const native: PlaybackNative = {
		getPlaybackSnapshot: async () => {
			const result = structuredClone(snapshot)
			await afterRead?.()
			return result
		},
		replacePlayback: async (
			tracks,
			currentEntryId,
			positionSeconds,
			speed,
			playing,
			mode,
		) => {
			beforeCommit()
			activated = positionSeconds
			const previous = structuredClone(snapshot)
			const selected = tracks.find((track) => track.id === currentEntryId)!
			snapshot = {
				...snapshot,
				tracks,
				currentEntryId,
				currentSourceId: selected.sourceId ?? selected.id,
				positionSeconds,
				speed,
				playing,
				mode,
				updatedAt: 300,
				resumePoints: [
					...snapshot.resumePoints.filter(
						(p) => p.sourceId !== (selected.sourceId ?? selected.id),
					),
					{
						...point(positionSeconds, 300),
						sourceId: selected.sourceId ?? selected.id,
					},
				],
			}
			return { previous, current: structuredClone(snapshot) }
		},
		cancelPlaybackReplacement: async () => 1,
		isPlaybackReplacementCurrent: async () => true,
		cancelPlaybackReplacementIfCurrent: async () => true,
		finishPlaybackPreparationIfCurrent: async () => true,
		startFm: async () => {
			throw new Error('unused')
		},
		exitFm: async () => {
			throw new Error('unused')
		},
		appendFm: async () => {
			throw new Error('unused')
		},
	}
	native.replaceListeningPlayback = async (
		tracks,
		entryId,
		position,
		speed,
		playing,
		token,
		overrides,
	) => {
		const result = await native.replacePlayback(
			tracks,
			entryId,
			position,
			speed,
			playing,
			'listening',
			token,
		)
		lastOverrides = overrides
		return result
	}
	const controller = new PlaybackController(
		native,
		library,
		listening,
		new SessionStore(db),
	)
	return {
		raw,
		db,
		library,
		listening,
		controller,
		native,
		backup,
		get snapshot() {
			return snapshot
		},
		set snapshot(value: PlaybackSnapshot) {
			snapshot = value
		},
		get overrides() {
			return lastOverrides
		},
		get activated() {
			return activated
		},
		onCommit: (action: () => void) => {
			beforeCommit = action
		},
		onRead: (action: () => Promise<void>) => {
			afterRead = action
		},
	}
}
void test('replacement fences unchanged and advancing old native progress, metadata and undo', async () => {
	const f = fixture()
	try {
		replaceLibraryBackup(f.db, f.backup, cover)
		await f.controller.sync()
		assert.deepEqual(f.listening.getResumePoint(source.id), point(30, 100))
		f.snapshot = { ...f.snapshot, resumePoints: [point(91, 210)] }
		f.controller.reconcile(f.snapshot)
		assert.deepEqual(f.listening.getResumePoint(source.id), point(30, 100))
		assert.equal(
			readPlaybackMetadata(
				f.library,
				f.listening,
				source.id,
				f.snapshot.resumePoints,
			).items[0].point.positionSeconds,
			30,
		)
		undoLibraryBackupReplacement(f.db, cover)
		await f.controller.sync()
		assert.deepEqual(f.listening.getResumePoint(source.id), point(90, 200))
		assert.equal(f.snapshot.playing, false)
	} finally {
		f.raw.close()
	}
})
void test('empty restored resume catalogue blocks native resurrection across a new controller', async () => {
	const f = fixture()
	try {
		const empty = JSON.parse(f.backup)
		empty.tables.resume_points = []
		replaceLibraryBackup(f.db, JSON.stringify(empty), cover)
		const reloaded = new ListeningLibrary(f.db)
		assert.equal(reloaded.canProjectResume(source.id), false)
		const restarted = new PlaybackController(
			f.native,
			f.library,
			reloaded,
			new SessionStore(f.db),
		)
		await restarted.sync()
		assert.equal(reloaded.getResumePoint(source.id), null)
		assert.deepEqual(
			readPlaybackMetadata(
				f.library,
				reloaded,
				source.id,
				f.snapshot.resumePoints,
			).items,
			[],
		)
		undoLibraryBackupReplacement(f.db, cover)
		assert.deepEqual(reloaded.getResumePoint(source.id), point(90, 200))
	} finally {
		f.raw.close()
	}
})
void test('explicit new listening activation uses restored position even on same active source and then owns new progress', async () => {
	const f = fixture()
	try {
		const track: Track = {
			id: source.id,
			sourceId: source.id,
			url: 'synthetic',
			title: 'Synthetic',
		}
		f.snapshot = {
			...f.snapshot,
			mode: 'listening',
			tracks: [track],
			currentEntryId: source.id,
			currentSourceId: source.id,
			positionSeconds: 90,
			durationSeconds: 300,
		}
		replaceLibraryBackup(f.db, f.backup, cover)
		await f.controller.playSource(source, { token: 1 }, 'listening')
		assert.equal(f.activated, 30)
		assert.equal(f.listening.canProjectResume(source.id), true)
		assert.equal(f.listening.getResumePoint(source.id)?.updatedAt, 300)
		f.snapshot = { ...f.snapshot, resumePoints: [point(35, 400)] }
		await f.controller.sync()
		assert.deepEqual(f.listening.getResumePoint(source.id), point(35, 400))
		assert.throws(() => undoLibraryBackupReplacement(f.db, cover), /发生变化/)
	} finally {
		f.raw.close()
	}
})
void test('restore during native commit revokes the older activation without stopping its queue', async () => {
	const f = fixture()
	try {
		f.onCommit(() => replaceLibraryBackup(f.db, f.backup, cover))
		await f.controller.playSource(source, { token: 1 }, 'listening')
		assert.equal(f.listening.canProjectResume(source.id), false)
		assert.deepEqual(f.listening.getResumePoint(source.id), point(30, 100))
		assert.equal(f.snapshot.playing, true)
		undoLibraryBackupReplacement(f.db, cover)
	} finally {
		f.raw.close()
	}
})
void test('a projection read begun before replacement cannot commit after its generation changes', async () => {
	const f = fixture()
	try {
		let finish!: () => void
		f.onRead(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve
				}),
		)
		const pending = f.controller.sync()
		replaceLibraryBackup(f.db, f.backup, cover)
		finish()
		await pending
		assert.deepEqual(f.listening.getResumePoint(source.id), point(30, 100))
		undoLibraryBackupReplacement(f.db, cover)
	} finally {
		f.raw.close()
	}
})

void test('newly authorized listening queue grants later automatic parts only when they become active', async () => {
	const f = fixture()
	try {
		const second = { ...source, id: 'bilibili:BV1vT411i7ET:456', cid: 456 }
		f.library.save(second)
		f.listening.saveResumePoint(point(30, 100))
		f.listening.saveResumePoint({ ...point(60, 100), sourceId: second.id })
		const backup = exportLibraryBackup(f.db)
		f.snapshot = {
			...f.snapshot,
			resumePoints: [
				point(90, 200),
				{ ...point(180, 200), sourceId: second.id },
			],
		}
		replaceLibraryBackup(f.db, backup, cover)
		await f.controller.playSource(source, { token: 1 }, 'listening', [
			source,
			second,
		])
		assert.equal(f.overrides[second.id], 60)
		assert.equal(f.listening.getResumePoint(second.id)?.positionSeconds, 60)
		assert.equal(f.listening.canProjectResume(second.id), false)
		// Native automatic/notification next, without a second JS replace operation.
		f.snapshot = {
			...f.snapshot,
			currentEntryId: second.id,
			currentSourceId: second.id,
			positionSeconds: 70,
			resumePoints: [
				point(30, 300),
				{ ...point(70, 400), sourceId: second.id },
			],
		}
		await f.controller.sync()
		assert.equal(f.listening.canProjectResume(second.id), true)
		assert.equal(f.listening.getResumePoint(second.id)?.positionSeconds, 70)
	} finally {
		f.raw.close()
	}
})
void test('new playback generation supersedes a restored future clock without rewriting historical timestamps', async () => {
	const f = fixture()
	try {
		f.listening.saveResumePoint(point(30, 999999))
		const futureBackup = exportLibraryBackup(f.db)
		replaceLibraryBackup(f.db, futureBackup, cover)
		await f.controller.sync()
		assert.equal(f.listening.getResumePoint(source.id)?.updatedAt, 999999)
		await f.controller.playSource(source, { token: 1 }, 'listening')
		assert.equal(f.activated, 30)
		assert.equal(f.listening.getResumePoint(source.id)?.updatedAt, 300)
		assert.equal(
			readPlaybackMetadata(f.library, f.listening, source.id, [point(40, 400)])
				.items[0].point.positionSeconds,
			40,
		)
	} finally {
		f.raw.close()
	}
})

void test('failed explicit activation cannot grant old native points and failed restore rolls back its fence', async () => {
	const f = fixture()
	try {
		f.db.execSync(
			"CREATE TRIGGER fail_epoch BEFORE INSERT ON resume_projection_epoch BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
		)
		assert.throws(
			() => replaceLibraryBackup(f.db, f.backup, cover),
			/synthetic/,
		)
		assert.deepEqual(f.listening.getResumePoint(source.id), point(90, 200))
		assert.equal(f.listening.projectionGeneration(), 0)
		f.db.execSync('DROP TRIGGER fail_epoch')
		replaceLibraryBackup(f.db, f.backup, cover)
		f.onCommit(() => {
			throw new Error('synthetic failed preparation')
		})
		await assert.rejects(
			f.controller.playSource(source, { token: 1 }, 'listening'),
			/synthetic/,
		)
		assert.equal(f.listening.canProjectResume(source.id), false)
		await f.controller.sync()
		assert.deepEqual(f.listening.getResumePoint(source.id), point(30, 100))
		undoLibraryBackupReplacement(f.db, cover)
	} finally {
		f.raw.close()
	}
})

void test('new explicit queues renew all pending mappings and revoke points outside the replacement queue', async () => {
	const f = fixture()
	try {
		const second = { ...source, id: 'bilibili:BV1vT411i7ET:456', cid: 456 }
		f.library.save(second)
		replaceLibraryBackup(f.db, f.backup, cover)
		await f.controller.playSource(source, { token: 1 }, 'listening', [source, second])
		assert.equal(f.listening.canProjectResume(source.id), true)
		// Real native masks this source while duration is unknown or persistence failed.
		f.snapshot = { ...f.snapshot, resumePoints: [] }
		await f.controller.playSource(second, { token: 2 }, 'listening', [source, second])
		assert.equal(f.overrides[source.id], 30)
		assert.equal(f.listening.canProjectResume(source.id), false)
		await f.controller.playSource(second, { token: 3 }, 'listening', [second])
		// A is no longer in the native queue, so native may expose its old point again.
		f.snapshot = { ...f.snapshot, resumePoints: [point(180, 900)] }
		await f.controller.sync()
		assert.equal(f.listening.getResumePoint(source.id)?.positionSeconds, 30)
		await f.controller.playSource(source, { token: 4 }, 'listening', [source])
		assert.equal(f.activated, 30)
		assert.equal(f.overrides[source.id], 30)
	} finally {
		f.raw.close()
	}
})

void test('pre-native ownership revocation protects event races and a new controller after interruption', async () => {
	const f = fixture()
	try {
		replaceLibraryBackup(f.db, f.backup, cover)
		await f.controller.playSource(source, { token: 1 }, 'listening')
		f.onCommit(() => {
			assert.equal(f.listening.canProjectResume(source.id), false)
			const cold = new PlaybackController(f.native, f.library, new ListeningLibrary(f.db), new SessionStore(f.db))
			cold.reconcile({ ...f.snapshot, resumePoints: [point(180, 900)] })
			assert.equal(f.listening.getResumePoint(source.id)?.positionSeconds, 30)
			throw new Error('synthetic native interruption')
		})
		await assert.rejects(f.controller.playSource(source, { token: 2 }, 'listening'), /重新选择.*synthetic/)
		assert.equal(f.listening.canProjectResume(source.id), false)
		await f.controller.sync()
		assert.equal(f.listening.getResumePoint(source.id)?.positionSeconds, 30)
	} finally { f.raw.close() }
})

void test('failed durable pre-native revocation never invokes native replacement', async () => {
	const f = fixture()
	try {
		replaceLibraryBackup(f.db, f.backup, cover)
		f.db.execSync("CREATE TRIGGER fail_activation BEFORE UPDATE ON resume_projection_epoch BEGIN SELECT RAISE(ABORT, 'synthetic epoch'); END;")
		let invoked = false
		f.onCommit(() => { invoked = true })
		await assert.rejects(f.controller.playSource(source, { token: 1 }, 'listening'), /synthetic epoch/)
		assert.equal(invoked, false)
		assert.equal(f.listening.getResumePoint(source.id)?.positionSeconds, 30)
	} finally { f.raw.close() }
})
