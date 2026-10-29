import { DatabaseSync } from 'node:sqlite'
import type { TestContext } from 'node:test'

import { Library, migrate, type Database } from '../core/database'
import { sourceId, type Source } from '../core/model'
import { RecommendationStore } from '../core/recommendations'
import {
	FmSession,
	type FmPlaybackPort,
	type FmPlayerState,
} from '../fm-session'
import { PlaybackIntent, type PlaybackPreparation } from '../playback-intent'

import { preparationPort } from './playback-preparation-fixture'

export const fmSource = (cid: number): Source => ({
	id: sourceId('BV1vT411i7ET', cid),
	bvid: 'BV1vT411i7ET',
	cid,
	originalTitle: `原音源 ${cid}`,
	uploader: 'UP',
	uploaderId: 88,
	performer: null,
	artwork: '',
	duration: 180,
	domain: 'music',
	audioAvailability: 'unknown',
})
export function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
export function fmFixture(t: TestContext, count = 25) {
	const raw = new DatabaseSync(':memory:')
	t.after(() => raw.close())
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
	migrate(db)
	const library = new Library(db),
		store = new RecommendationStore(db, () => new Date(2026, 9, 19))
	for (let cid = 1; cid <= count; cid++) library.save(fmSource(cid))
	const frame: FmPlayerState = {
		fmContext: null,
		mode: 'music',
		queue: [{ id: 'manual-occurrence', sourceId: fmSource(100).id }],
		currentIndex: 0,
		switching: false,
	}
	let reserves = 0,
		cancels = 0,
		reads = 0,
		finishes = 0
	let pendingToken: number | null = null
	const preparation = preparationPort(
		async () => {
			reserves++
		},
		async () => {
			cancels++
		},
	)
	const starts: { sources: Source[]; preparation: PlaybackPreparation }[] = [],
		exits: string[] = [],
		appends: { sources: Source[]; fmId: string; tail: string }[] = []
	const behavior = {
		start: async () => true,
		exit: async () => true,
		append: async () => true,
		finish: async () => {},
	}
	const player: FmPlaybackPort & {
		finishPreparation: (prepared: PlaybackPreparation) => Promise<void>
	} = {
		...preparation,
		reservePlayback: async () => {
			const reserved = await preparation.reservePlayback()
			pendingToken = reserved.token
			return reserved
		},
		cancelPreparation: async (prepared) => {
			if (await preparation.isPreparationCurrent(prepared)) pendingToken = null
			await preparation.cancelPreparation(prepared)
		},
		finishPreparation: async (prepared: PlaybackPreparation) => {
			await behavior.finish()
			if (pendingToken === prepared.token) {
				pendingToken = null
				finishes++
			}
		},
		read: () => frame,
		startFm: async (sources, prepared) => {
			starts.push({ sources, preparation: prepared })
			return behavior.start()
		},
		exitFm: async (id) => {
			exits.push(id)
			return behavior.exit()
		},
		appendFm: async (sources, fmId, tail) => {
			appends.push({ sources, fmId, tail })
			return behavior.append()
		},
	}
	const intent = new PlaybackIntent()
	const candidates = {
		fmCandidates: (excluded: readonly string[], limit: number) => {
			reads++
			return store.fmCandidates(excluded, limit)
		},
	}
	const session = new FmSession(candidates, intent, player)
	const activateFm = (length = 20, id = 'fm-context') => {
		frame.fmContext = {
			id,
			returnMode: 'music',
			manualMusic: null,
			returnListening: null,
		}
		frame.mode = 'music'
		frame.queue = Array.from({ length }, (_, index) => ({
			id: `fm-entry-${index + 1}`,
			sourceId: fmSource(index + 1).id,
		}))
		frame.currentIndex = 0
	}
	return {
		raw,
		db,
		library,
		store,
		frame,
		player,
		intent,
		session,
		behavior,
		starts,
		exits,
		appends,
		activateFm,
		reserves: () => reserves,
		cancels: () => cancels,
		finishes: () => finishes,
		pendingToken: () => pendingToken,
		reads: () => reads,
	}
}
