import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Source } from '../core/model'
import { playMusicIntent } from '../playback-intent'

import { deferred, fmFixture, fmSource } from './fm-test-fixture'
void test('opening is read-only and silent; explicit confirm revalidates the current proof and starts only the real batch', async (t) => {
	const f = fmFixture(t)
	f.store.load()
	const before = f.raw.prepare('SELECT * FROM settings').all()
	f.session.open()
	assert.equal(f.session.getSnapshot().candidates.length, 20)
	assert.equal(f.reserves(), 0)
	assert.equal(f.starts.length, 0)
	assert.deepEqual(f.raw.prepare('SELECT * FROM settings').all(), before)
	const first = f.session.getSnapshot().candidates[0].source.id
	f.store.dismiss(first)
	let opened = 0
	assert.equal(
		await f.session.start(() => {
			opened++
		}),
		true,
	)
	assert.equal(f.starts[0].sources.length, 20)
	assert.ok(!f.starts[0].sources.some((source) => source.id === first))
	assert.equal(opened, 1)
	assert.equal(f.session.getSnapshot().open, false)
	assert.equal(f.reserves(), 1)
})

void test('empty and failed candidate revalidation release the reservation, retain the page and preserve the real error', async (t) => {
	for (const fail of [false, true]) {
		const f = fmFixture(t, 1)
		f.store.load()
		f.session.open()
		if (fail) f.raw.exec('DROP TABLE sources')
		else f.store.dismiss(fmSource(1).id)
		assert.equal(
			await f.session.start(() => {
				assert.fail('Must not open player')
			}),
			false,
		)
		assert.equal(f.starts.length, 0)
		assert.equal(f.session.getSnapshot().open, true)
		assert.ok(f.session.getSnapshot().error)
		assert.equal(f.cancels(), 0)
		assert.equal(f.finishes(), 1)
		assert.equal(f.pendingToken(), null)
		assert.equal(await f.player.isPreparationCurrent({ token: 1 }), true)
	}
})

void test('native false/error never claims FM started; closing during old success/error is silent and cannot reopen', async (t) => {
	const f = fmFixture(t)
	f.session.open()
	f.behavior.start = async () => false
	assert.equal(await f.session.start(() => assert.fail()), false)
	assert.match(f.session.getSnapshot().error, /未能确认开始/)
	for (const fails of [false, true]) {
		const gate = deferred<boolean>()
		f.behavior.start = () => gate.promise
		f.session.open()
		const run = f.session.start(() =>
			assert.fail('Old completion cannot reopen'),
		)
		await new Promise<void>((resolve) => setImmediate(resolve))
		f.session.close()
		if (fails) gate.reject(new Error('old native error'))
		else gate.resolve(true)
		assert.equal(await run, false)
		assert.equal(f.session.getSnapshot().error, '')
		assert.equal(f.session.getSnapshot().busy, false)
	}
})

void test('old FM page cleanup and late finally cannot cancel a newer real music intent or clear newer busy state', async (t) => {
	const f = fmFixture(t),
		old = deferred<boolean>(),
		music = deferred<Source>()
	f.behavior.start = () => old.promise
	f.session.open()
	const run = f.session.start(() => assert.fail())
	await new Promise<void>((resolve) => setImmediate(resolve))
	let active = false
	const newer = playMusicIntent(f.intent, fmSource(99), {
		preparation: f.player,
		resolve: () => music.promise,
		activate: async () => {
			active = true
			return true
		},
		onPending: () => {},
		onStarted: () => {},
	})
	await new Promise<void>((resolve) => setImmediate(resolve))
	const cancels = f.cancels()
	f.session.close()
	old.reject(new Error('late error'))
	assert.equal(await run, false)
	assert.equal(f.cancels(), cancels)
	music.resolve(fmSource(99))
	assert.equal(await newer, true)
	assert.equal(active, true)
	assert.equal(f.session.getSnapshot().error, '')
})

void test('repeat confirmation is ignored while preparing, and exit uses the actual native context without rebuilding return queues', async (t) => {
	const f = fmFixture(t),
		gate = deferred<boolean>()
	f.session.open()
	f.behavior.start = () => gate.promise
	const run = f.session.start(() => {})
	assert.equal(await f.session.start(() => assert.fail()), false)
	gate.resolve(true)
	assert.equal(await run, true)
	f.activateFm()
	f.frame.fmContext!.returnMode = 'listening'
	f.frame.mode = 'listening'
	await f.session.observe()
	f.session.open()
	assert.equal(f.session.getSnapshot().selected, false)
	assert.equal(f.session.getSnapshot().returnMode, 'listening')
	assert.equal(await f.session.start(() => assert.fail()), false)
	assert.equal(await f.session.exit(() => {}), true)
	assert.deepEqual(f.exits, ['fm-context'])
	assert.equal(f.starts.length, 1)
})

void test('delayed preparation finish followed by native-only control suppresses old false and thrown errors', async (t) => {
	for (const fails of [false, true]) {
		const f = fmFixture(t),
			entered = deferred<void>(),
			finish = deferred<void>()
		f.session.open()
		f.behavior.finish = async () => {
			entered.resolve()
			await finish.promise
		}
		f.behavior.start = async () => {
			if (fails) throw new Error('old native failure')
			return false
		}
		const run = f.session.start(() => assert.fail())
		await entered.promise
		// Native pause/notification invalidates the shared preparation token without
		// beginning a new JS PlaybackIntent; its JS request is initially still current.
		await f.player.cancelPreparation({ token: 1 })
		finish.resolve()
		assert.equal(await run, false)
		assert.equal(f.session.getSnapshot().error, '')
		assert.equal(f.reserves(), 1)
	}
})

void test('successful exit presents the frozen return target, including an empty silent manual session', async (t) => {
	for (const hasTrack of [false, true]) {
		const f = fmFixture(t)
		f.activateFm()
		if (hasTrack)
			f.frame.fmContext!.manualMusic = {
				mode: 'music',
				tracks: [
					{
						id: 'original-entry',
						sourceId: fmSource(100).id,
						url: 'orpheus://test',
					},
				],
				currentEntryId: 'original-entry',
				currentSourceId: fmSource(100).id,
				positionSeconds: 15,
				durationSeconds: 180,
				speed: 1,
				playing: false,
				updatedAt: 1,
			}
		f.session.open()
		let presented: boolean | undefined
		assert.equal(
			await f.session.exit((value) => {
				presented = value
			}),
			true,
		)
		assert.equal(presented, hasTrack)
	}
})

void test('an old completion cannot clear a reopened page newer preparation busy state', async (t) => {
	const f = fmFixture(t),
		old = deferred<boolean>(),
		newer = deferred<boolean>()
	f.session.open()
	f.behavior.start = () => old.promise
	const first = f.session.start(() => assert.fail())
	await new Promise<void>((resolve) => setImmediate(resolve))
	f.session.close()
	f.session.open()
	f.behavior.start = () => newer.promise
	const second = f.session.start(() => {})
	await new Promise<void>((resolve) => setImmediate(resolve))
	old.reject(new Error('old failure'))
	assert.equal(await first, false)
	assert.equal(f.session.getSnapshot().busy, true)
	assert.equal(f.session.getSnapshot().error, '')
	newer.resolve(true)
	assert.equal(await second, true)
	assert.equal(f.session.getSnapshot().busy, false)
})

void test('refill starts only at <=3 remaining, excludes every queue Source and does not reserve/cancel user work', async (t) => {
	const f = fmFixture(t)
	f.activateFm()
	await f.session.observe()
	assert.equal(f.reads(), 0)
	f.frame.currentIndex = 16
	await f.session.observe()
	assert.equal(f.appends.length, 1)
	assert.equal(f.appends[0].fmId, 'fm-context')
	assert.equal(f.appends[0].tail, 'fm-entry-20')
	assert.equal(f.appends[0].sources.length, 5)
	assert.ok(
		f.appends[0].sources.every(
			(source) => !f.frame.queue.some((track) => track.sourceId === source.id),
		),
	)
	assert.equal(f.reserves(), 0)
	assert.equal(f.cancels(), 0)
	for (let tick = 0; tick < 10; tick++) await f.session.observe()
	assert.equal(f.reads(), 1)
})

void test('empty/failed/conflicted refill has bounded retries: position ticks do nothing, entry advance or explicit retry checks again', async (t) => {
	for (const result of ['empty', 'blocked', 'error'] as const) {
		const f = fmFixture(t, result === 'empty' ? 20 : 25)
		f.activateFm()
		f.frame.currentIndex = 18
		f.behavior.append = async () => {
			if (result === 'error') throw new Error('append failed')
			return false
		}
		await f.session.observe()
		assert.equal(f.session.getSnapshot().refill, result)
		const reads = f.reads()
		for (let tick = 0; tick < 10; tick++) await f.session.observe()
		assert.equal(f.reads(), reads)
		f.frame.currentIndex++
		await f.session.observe()
		assert.equal(f.reads(), reads + 1)
		await f.session.retryRefill()
		assert.equal(f.reads(), reads + 2)
	}
})

void test('refill is inactive in listening/manual/pending and late append failure cannot replace a newer context state', async (t) => {
	const f = fmFixture(t),
		gate = deferred<boolean>()
	f.activateFm(2)
	f.frame.mode = 'listening'
	await f.session.observe()
	f.frame.mode = 'music'
	f.frame.switching = true
	await f.session.observe()
	assert.equal(f.reads(), 0)
	f.frame.switching = false
	f.behavior.append = () => gate.promise
	const pending = f.session.observe()
	await f.session.observe()
	assert.equal(f.appends.length, 1)
	f.frame.fmContext = null
	await f.session.observe()
	gate.reject(new Error('old append'))
	await pending
	assert.equal(f.session.getSnapshot().refill, 'idle')
	assert.equal(f.session.getSnapshot().contextId, null)
	assert.equal(f.reads(), 1)
})

void test('at the native queue bound there is no oversized exclusion query or automatic loop', async (t) => {
	const f = fmFixture(t)
	f.activateFm(5000)
	f.frame.currentIndex = 4999
	await f.session.observe()
	assert.equal(f.session.getSnapshot().refill, 'limit')
	assert.equal(f.reads(), 0)
	assert.equal(f.appends.length, 0)
	await f.session.observe()
	assert.equal(f.reads(), 0)
})

void test('candidate audition preserves FM refill identity and does not refill on return', async (t) => {
	const f = fmFixture(t)
	f.frame.fmContext = {
		id: 'original-fm',
		returnMode: 'music',
		manualMusic: null,
		returnListening: null,
	}
	await f.session.observe()
	const count = f.appends.length
	assert.equal(count, 1)
	const original = structuredClone(f.frame)
	f.frame.auditionId = 'candidate'
	f.frame.fmContext = null
	f.frame.queue = [{ id: fmSource(99).id }]
	await f.session.observe()
	assert.equal(f.session.getSnapshot().contextId, 'original-fm')
	assert.equal(await f.session.retryRefill(), false)
	assert.equal(f.appends.length, count)
	Object.assign(f.frame, original, { auditionId: null })
	await f.session.observe()
	assert.equal(
		f.appends.length,
		count,
		'return must not reset and repeat the refill attempt',
	)
})
