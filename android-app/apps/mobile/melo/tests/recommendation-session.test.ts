import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, type Database } from '../core/database'
import { sourceId, type Source } from '../core/model'
import {
	RecommendationStore,
	type RecommendationSnapshot,
} from '../core/recommendations'
import { PlaybackIntent } from '../playback-intent'
import { RecommendationSession } from '../recommendation-session'

const source = (cid = 11): Source => ({
	id: sourceId('BV1vT411i7ET', cid),
	bvid: 'BV1vT411i7ET',
	cid,
	originalTitle: `音源${cid}`,
	uploader: 'UP',
	uploaderId: 88,
	performer: null,
	artwork: '',
	duration: 200,
	domain: 'music',
	audioAvailability: 'unknown',
})
const snapshot = (
	sources = [source(), source(22)],
): RecommendationSnapshot => ({
	localDate: '2026-10-18',
	revision: 0,
	items: sources.map((value) => ({ source: value, reasons: ['liked'] })),
	canUndo: false,
})
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
function fixture() {
	let value = snapshot(),
		reads = 0
	const store = {
		load: () => {
			reads++
			return value
		},
		refresh: () => ({ ...value, revision: value.revision + 1 }),
		dismiss: (id: string) => {
			value = {
				...value,
				canUndo: true,
				items: value.items.filter((item) => item.source.id !== id),
			}
			return value
		},
		undo: () => {
			value = snapshot()
			return value
		},
		listDismissed: () => ({
			items: [],
			page: 1,
			pageSize: 20,
			total: 0,
			totalPages: 0,
		}),
		restoreSource: () => value,
		resetLocalRecommendations: () => value,
	}
	const session = new RecommendationSession(store),
		intent = new PlaybackIntent()
	let cancels = 0,
		opened = 0
	const pending = (id = source().id) => {
		const activation = deferred<boolean>()
		const result = session.play(
			id,
			async (_, own) => {
				const request = intent.begin()
				own({
					...request,
					cancel: () => {
						const owned = request.cancel()
						if (owned) cancels++
						return owned
					},
				})
				return activation.promise
			},
			() => {
				opened++
			},
		)
		return { activation, result }
	}
	return {
		store,
		session,
		intent,
		pending,
		reads: () => reads,
		cancels: () => cancels,
		opened: () => opened,
	}
}

void test('open and local operations never start playback; empty and failed reads stay distinguishable and retryable', () => {
	const f = fixture()
	f.store.load = () => {
		throw new Error('database busy')
	}
	assert.equal(f.session.open(), false)
	assert.equal(f.session.getSnapshot().snapshot, null)
	assert.equal(f.session.getSnapshot().error, 'database busy')
	f.store.load = () => snapshot([])
	assert.equal(f.session.load(), true)
	assert.equal(f.session.getSnapshot().error, '')
	assert.deepEqual(f.session.getSnapshot().snapshot!.items, [])
	assert.equal(f.opened(), 0)
	assert.equal(f.cancels(), 0)
})

void test('successful feedback consumes committed result without rereading; later read failure preserves success and snapshot', () => {
	const f = fixture()
	f.session.open()
	f.store.load = () => {
		throw new Error('later local read failed')
	}
	assert.equal(f.session.dismiss(source().id), true)
	assert.equal(f.reads(), 1)
	assert.equal(f.session.getSnapshot().snapshot!.canUndo, true)
	assert.match(f.session.getSnapshot().notice, /已减少推荐此音源/)
	const committed = f.session.getSnapshot().snapshot
	assert.equal(f.session.load(), false)
	assert.equal(f.session.getSnapshot().snapshot, committed)
	assert.match(f.session.getSnapshot().notice, /已减少推荐此音源/)
	assert.equal(f.session.getSnapshot().error, 'later local read failed')
	f.store.refresh = () => {
		throw new Error('later refresh failed')
	}
	assert.equal(f.session.refresh(), false)
	assert.equal(f.session.getSnapshot().snapshot, committed)
	assert.match(f.session.getSnapshot().notice, /已减少推荐此音源/)
	assert.equal(f.session.getSnapshot().error, 'later refresh failed')
	assert.equal(f.session.undo(), true)
	assert.equal(f.session.getSnapshot().snapshot!.canUndo, false)
})

void test('failed refresh retains last snapshot without false success; successful repeated batch is explicit', () => {
	const f = fixture()
	f.session.open()
	const before = f.session.getSnapshot().snapshot
	f.store.refresh = () => {
		throw new Error('write failed')
	}
	assert.equal(f.session.refresh(), false)
	assert.equal(f.session.getSnapshot().snapshot, before)
	assert.equal(f.session.getSnapshot().notice, '')
	f.store.refresh = () => ({ ...snapshot(), revision: 1 })
	assert.equal(f.session.refresh(), true)
	assert.equal(f.session.getSnapshot().snapshot!.revision, 1)
	assert.match(f.session.getSnapshot().notice, /可能重复/)
})

void test('explicit playback revalidates current local eligibility and cannot use stale contents after a read error', async () => {
	const f = fixture()
	f.session.open()
	let activations = 0
	const action = async () => {
		activations++
		return true
	}
	f.store.load = () => {
		throw new Error('cannot verify current eligibility')
	}
	assert.equal(
		await f.session.play(source().id, action, () =>
			assert.fail('opened stale player'),
		),
		false,
	)
	assert.equal(f.session.getSnapshot().snapshot!.items.length, 2)
	assert.equal(
		f.session.getSnapshot().error,
		'cannot verify current eligibility',
	)
	f.store.load = () => snapshot([source(22)])
	assert.equal(
		await f.session.play(source().id, action, () =>
			assert.fail('opened ineligible source'),
		),
		false,
	)
	assert.match(f.session.getSnapshot().playError, /已不在/)
	assert.equal(activations, 0)
})

void test('close cancels only its owned pending request and cannot open the player from late success', async () => {
	const f = fixture()
	f.session.open()
	const pending = f.pending()
	f.session.close()
	pending.activation.resolve(true)
	assert.equal(await pending.result, false)
	assert.equal(f.cancels(), 1)
	assert.equal(f.opened(), 0)
	assert.equal(f.session.getSnapshot().playingId, null)
	const newer = fixture()
	newer.session.open()
	const old = newer.pending()
	newer.intent.begin()
	newer.session.close()
	old.activation.resolve(true)
	assert.equal(await old.result, false)
	assert.equal(
		newer.cancels(),
		0,
		'closing stale page must not cancel the newer native operation',
	)
})

void test('feedback cancels the removed pending Source only after success, never stops normal completed playback', async () => {
	const f = fixture()
	f.session.open()
	const pending = f.pending()
	f.store.dismiss = () => {
		throw new Error('feedback write failed')
	}
	assert.equal(f.session.dismiss(source().id), false)
	assert.equal(f.cancels(), 0)
	pending.activation.resolve(true)
	assert.equal(await pending.result, true)
	assert.equal(f.opened(), 1)
	f.store.dismiss = () => snapshot([source(22)])
	assert.equal(f.session.dismiss(source().id), true)
	f.session.close()
	assert.equal(f.cancels(), 0)
	const removed = fixture()
	removed.session.open()
	const old = removed.pending()
	assert.equal(removed.session.dismiss(source().id), true)
	old.activation.resolve(true)
	assert.equal(await old.result, false)
	assert.equal(removed.cancels(), 1)
	assert.equal(removed.opened(), 0)
})

void test('feedback for another Source does not interrupt preparation; a late old finally cannot clear a newer pending item', async () => {
	const f = fixture()
	f.session.open()
	const first = f.pending()
	f.session.dismiss(source(22).id)
	assert.equal(f.cancels(), 0)
	f.store.load = () => snapshot()
	f.session.load()
	const second = f.pending(source(22).id)
	first.activation.resolve(true)
	assert.equal(await first.result, false)
	assert.equal(f.session.getSnapshot().playingId, source(22).id)
	second.activation.resolve(true)
	assert.equal(await second.result, true)
	assert.equal(f.opened(), 1)
})

void test('current activation failure is explicit and cannot masquerade as successful playback', async () => {
	const f = fixture()
	f.session.open()
	const pending = f.pending()
	pending.activation.resolve(false)
	assert.equal(await pending.result, false)
	assert.equal(f.opened(), 0)
	assert.match(f.session.getSnapshot().playError, /未能开始播放/)
})

void test('real SQLite feedback stays committed across a later read failure and reopening', () => {
	const folder = mkdtempSync(join(tmpdir(), 'melo-rec-ui-')),
		file = join(folder, 'library.sqlite')
	function open() {
		const raw = new DatabaseSync(file)
		const db: Database = {
			execSync: (sql) => raw.exec(sql),
			runSync: (sql, values) => raw.prepare(sql).run(...values),
			getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
				(raw.prepare(sql).get(...values) as T) ?? null,
			getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
				raw.prepare(sql).all(...values) as T[],
		}
		migrate(db)
		return { raw, db }
	}
	let current = open()
	try {
		new Library(current.db).setLiked(source(), true)
		const store = new RecommendationStore(
			current.db,
			() => new Date(2026, 9, 18),
		)
		let fail = false
		const session = new RecommendationSession({
			load: () => {
				if (fail) throw new Error('temporary read')
				return store.load()
			},
			refresh: () => store.refresh(),
			dismiss: (id) => store.dismiss(id),
			undo: () => store.undo(),
			listDismissed: (page, size) => store.listDismissed(page, size),
			restoreSource: (id) => store.restoreSource(id),
			resetLocalRecommendations: () => store.resetLocalRecommendations(),
		})
		assert.equal(session.open(), true)
		assert.equal(session.dismiss(source().id), true)
		fail = true
		assert.equal(session.load(), false)
		assert.equal(session.getSnapshot().snapshot!.items.length, 0)
		assert.match(session.getSnapshot().notice, /已减少/)
		current.raw.close()
		current = open()
		const reopened = new RecommendationStore(
			current.db,
			() => new Date(2026, 9, 18),
		).load()
		assert.deepEqual(reopened.items, [])
		assert.equal(reopened.canUndo, true)
		assert.equal(new Library(current.db).likes().length, 1)
	} finally {
		current.raw.close()
		rmSync(folder, { recursive: true })
	}
})
