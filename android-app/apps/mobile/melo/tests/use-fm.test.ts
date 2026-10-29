import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { FmSession } from '../fm-session'
import type { useFm } from '../use-fm'

import { deferred, fmFixture, fmSource } from './fm-test-fixture'
import { compile } from './search-page-fixture'

const source = compile(
	readFileSync(new URL('../use-fm.ts', import.meta.url), 'utf8'),
)
type Player = Parameters<typeof useFm>[2]
const equal = (a: unknown[] | undefined, b: unknown[]) =>
	!!a && a.length === b.length && a.every((value, index) => value === b[index])
function hook(f: ReturnType<typeof fmFixture>) {
	const slots: { value?: unknown; deps?: unknown[]; cleanup?: () => void }[] =
		[]
	let cursor = 0
	let effects: (() => void)[] = []
	const output: { useFm?: typeof useFm } = {}
	runInNewContext(source, {
		exports: output,
		require: (name: string) => {
			if (name === './fm-session') return { FmSession }
			if (name === 'react')
				return {
					useState: (init: () => unknown) => {
						const slot = (slots[cursor++] ??= { value: init() })
						return [
							slot.value,
							() =>
								assert.fail('Hook must not replace the stable player holder'),
						]
					},
					useMemo: (create: () => unknown, deps: unknown[]) => {
						const index = cursor++
						if (!equal(slots[index]?.deps, deps))
							slots[index] = { value: create(), deps }
						return slots[index].value
					},
					useEffect: (setup: () => void | (() => void), deps: unknown[]) => {
						const index = cursor++
						if (!equal(slots[index]?.deps, deps))
							effects.push(() => {
								slots[index]?.cleanup?.()
								slots[index] = { deps, cleanup: setup() ?? undefined }
							})
					},
					useSyncExternalStore: (_subscribe: unknown, get: () => unknown) =>
						get(),
				}
			throw new Error(`Unexpected hook dependency ${name}`)
		},
	})
	assert.ok(output.useFm)
	const render = (player: Player = { ...f.player, ...f.frame }) => {
		cursor = 0
		effects = []
		const result = output.useFm!(f.store, f.intent, player)
		for (const effect of effects) effect()
		return result
	}
	return {
		render,
		dispose: () => {
			for (const slot of slots) slot.cleanup?.()
		},
	}
}

void test('actual useFm proxy forwards owned finish after empty/SQL candidate failure without invalidating error ownership', async (t) => {
	for (const failure of ['empty', 'sql'] as const) {
		const f = fmFixture(t, 1),
			h = hook(f)
		const value = h.render()
		assert.equal(f.reserves(), 0)
		assert.equal(f.reads(), 0)
		value.session.open()
		if (failure === 'sql') f.raw.exec('DROP TABLE sources')
		else {
			f.store.load()
			f.store.dismiss(fmSource(1).id)
		}
		assert.equal(await value.session.start(() => assert.fail()), false)
		assert.ok(value.session.getSnapshot().error)
		assert.equal(f.pendingToken(), null)
		assert.equal(f.finishes(), 1)
		assert.equal(f.cancels(), 0)
		assert.equal(await f.player.isPreparationCurrent({ token: 1 }), true)
		h.dispose()
	}
})

void test('actual hook observes current FM entry and latest player callbacks; new position frames cannot cause a retry loop', async (t) => {
	const f = fmFixture(t),
		h = hook(f)
	f.activateFm()
	f.frame.currentIndex = 15
	f.behavior.append = async () => false
	const value = h.render()
	assert.equal(f.appends.length, 0)
	f.frame.currentIndex = 16
	h.render()
	await new Promise<void>((resolve) => setImmediate(resolve))
	assert.equal(f.appends.length, 1)
	for (let tick = 0; tick < 5; tick++) {
		f.frame.queue = [...f.frame.queue]
		h.render()
		await Promise.resolve()
	}
	assert.equal(f.appends.length, 1)
	f.frame.mode = 'listening'
	h.render()
	assert.equal(value.session.getSnapshot().selected, false)
	f.frame.mode = 'music'
	f.frame.currentIndex++
	let latest = 0
	h.render({
		...f.player,
		...f.frame,
		appendFm: async () => {
			latest++
			return false
		},
	})
	await new Promise<void>((resolve) => setImmediate(resolve))
	assert.equal(latest, 1)
	assert.equal(f.appends.length, 1)
	h.dispose()
	assert.equal(f.frame.fmContext?.id, 'fm-context')
	assert.equal(f.reserves(), 0)
})

void test('a newer source intent closes the actual hook confirmation without cancelling the new owner', (t) => {
	const f = fmFixture(t),
		h = hook(f)
	const value = h.render()
	value.session.open()
	const newer = f.intent.begin()
	h.render()
	assert.equal(value.session.getSnapshot().open, false)
	assert.equal(newer.isCurrent(), true)
	assert.equal(f.reserves(), 0)
	assert.equal(f.cancels(), 0)
	h.dispose()
})

void test('actual hook explicit preparation cancel keeps the FM page open for retry, including late old success', async (t) => {
	const f = fmFixture(t),
		h = hook(f),
		waiting = deferred<boolean>()
	const value = h.render()
	value.session.open()
	f.behavior.start = () => waiting.promise
	const run = value.session.start(() =>
		assert.fail('Cancelled start must not open player'),
	)
	await new Promise<void>((resolve) => setImmediate(resolve))
	value.session.cancelPending()
	h.render()
	assert.equal(value.session.getSnapshot().open, true)
	assert.equal(value.session.getSnapshot().busy, false)
	waiting.resolve(true)
	assert.equal(await run, false)
	assert.equal(value.session.getSnapshot().open, true)
	assert.equal(value.session.getSnapshot().error, '')
	f.behavior.start = async () => true
	assert.equal(await value.session.start(() => {}), true)
	h.dispose()
})
