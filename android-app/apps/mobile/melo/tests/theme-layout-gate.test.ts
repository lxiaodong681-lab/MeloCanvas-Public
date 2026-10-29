import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'
import {
	ThemeLayoutRejectedError,
	ThemePresentationTransientError,
	type ThemePresentation,
	type ThemePresentationPurpose,
} from '../core/theme-install-types'
import {
	resolveThemeControlRow,
	resolveThemeNavigation,
} from '../core/theme-layout'
import type { ThemeControlRowStatus } from '../theme-control-layout'
import {
	ThemeLayoutGate,
	themeLayoutScopes,
	type ThemeLayoutProbe,
} from '../theme-layout-gate'

function presentation(): ThemePresentation {
	// Gate inputs are host-owned presentations; it does not select package/builtin bypass.
	return {
		selection: { kind: 'builtin', key: 'modern' },
		theme: structuredClone(builtInThemes.modern),
		packageMetadata: null,
		adapted: null,
		allowedImageUris: [],
	}
}
function observation(width = 400, navigation = false): ThemeControlRowStatus {
	const policy = {
		minTouchDp: 96,
		compactMinTouchDp: 72,
		narrowFallback: 'host-single-row' as const,
	}
	const measurements = {
		availableWidthDp: width,
		controlMinWidthsDp: [48, 48, 48, 48],
	}
	const resolution = navigation
		? resolveThemeNavigation(policy, measurements)
		: resolveThemeControlRow(policy, { ...measurements, gapDp: 4 })
	return resolution.kind === 'rejected'
		? { kind: 'rejected', resolution }
		: { kind: 'ready', resolution }
}
function ready(probe: ThemeLayoutProbe) {
	for (const scope of themeLayoutScopes)
		probe.report(scope, observation(400, scope === 'navigation'))
}
function begin(
	gate = new ThemeLayoutGate(),
	purpose: ThemePresentationPurpose = 'preview',
) {
	gate.setEnvironmentRevision(1)
	const controller = new AbortController(),
		value = presentation()
	const promise = gate.preparePresentation(value, {
		purpose,
		signal: controller.signal,
	})
	const request = gate.getSnapshot().request!
	return {
		gate,
		controller,
		value,
		promise,
		request,
		probe: gate.attachProbe(request.id),
	}
}
const reason =
	(expected: ThemePresentationTransientError['reason']) => (error: unknown) =>
		error instanceof ThemePresentationTransientError &&
		error.reason === expected
async function pending(promise: Promise<unknown>) {
	let settled = false
	void promise.then(
		() => {
			settled = true
		},
		() => {
			settled = true
		},
	)
	await Promise.resolve()
	assert.equal(settled, false)
}

void test('all seven actual resolver reports in one probe round grant a lease with exact presentation/purpose', async () => {
	const f = begin(undefined, 'activate')
	assert.equal(f.request.presentation, f.value)
	assert.equal(f.request.purpose, 'activate')
	assert.equal(f.request.environmentRevision, 1)
	for (const scope of themeLayoutScopes.slice(0, -1))
		f.probe.report(scope, observation(400, scope === 'navigation'))
	assert.equal(f.gate.getSnapshot().phase, 'pending')
	await pending(f.promise)
	f.probe.report('progress', { kind: 'pending' })
	await pending(f.promise)
	f.probe.report('progress', observation())
	const lease = await f.promise
	lease.assertCurrent()
	assert.equal(f.gate.getSnapshot().phase, 'ready')
	assert.equal(Object.keys(f.gate.getSnapshot().reports).length, 7)
	f.gate.stop()
	assert.throws(() => lease.assertCurrent(), reason('stale'))
})

void test('unknown initial environment waits; first known environment remounts request and old unknown probe cannot report', async () => {
	const gate = new ThemeLayoutGate(),
		controller = new AbortController()
	const promise = gate.preparePresentation(presentation(), {
		purpose: 'restore',
		signal: controller.signal,
	})
	const unknown = gate.getSnapshot().request!
	ready(gate.attachProbe(unknown.id))
	await pending(promise)
	gate.setEnvironmentRevision(0)
	const known = gate.getSnapshot().request!
	assert.notEqual(known.id, unknown.id)
	assert.equal(known.purpose, 'restore')
	ready(gate.attachProbe(unknown.id))
	await pending(promise)
	ready(gate.attachProbe(known.id))
	;(await promise).assertCurrent()
	gate.stop()
})

void test('unknown environment remains cancellable and no incomplete scope is a stable rejection', async () => {
	const gate = new ThemeLayoutGate(),
		controller = new AbortController()
	const promise = gate.preparePresentation(presentation(), {
		purpose: 'preview',
		signal: controller.signal,
	})
	controller.abort()
	await assert.rejects(promise, reason('cancelled'))
	assert.equal(gate.getSnapshot().request, null)
	assert.equal(
		gate.getSnapshot().failure instanceof ThemeLayoutRejectedError,
		false,
	)
})

void test('a real rejected resolution rejects pending preparation with stable error and late ready cannot revive it', async () => {
	const f = begin()
	f.probe.report('navigation', observation(190, true))
	await assert.rejects(f.promise, ThemeLayoutRejectedError)
	assert.equal(f.gate.getSnapshot().phase, 'rejected')
	const rejected = f.gate.getSnapshot()
	ready(f.probe)
	f.probe.dispose()
	assert.equal(f.gate.getSnapshot(), rejected)
})

void test('probe replacement starts empty; stale round report and dispose cannot complete or unmount current round', async () => {
	const f = begin()
	f.probe.report('navigation', observation(400, true))
	const next = f.gate.attachProbe(f.request.id)
	ready(f.probe)
	f.probe.dispose()
	for (const scope of themeLayoutScopes.filter(
		(item) => item !== 'navigation',
	))
		next.report(scope, observation())
	await pending(f.promise)
	next.report('navigation', observation(400, true))
	;(await f.promise).assertCurrent()
	f.gate.stop()
})

void test('pending probe cleanup permits StrictMode remount but requires all fresh observations', async () => {
	const f = begin()
	f.probe.report('navigation', observation(400, true))
	f.probe.dispose()
	assert.equal(f.gate.getSnapshot().probeRound, null)
	assert.deepEqual(f.gate.getSnapshot().reports, {})
	ready(f.probe)
	await pending(f.promise)
	const remount = f.gate.attachProbe(f.request.id)
	ready(remount)
	;(await f.promise).assertCurrent()
	f.gate.stop()
})

void test('environment A to B to A never revives a pending request or an issued lease', async () => {
	const f = begin()
	f.gate.setEnvironmentRevision(2)
	await assert.rejects(f.promise, reason('stale'))
	f.gate.setEnvironmentRevision(1)
	ready(f.probe)
	assert.equal(f.gate.getSnapshot().request, null)
	const next = begin(f.gate)
	ready(next.probe)
	const lease = await next.promise
	f.gate.setEnvironmentRevision(null)
	f.gate.setEnvironmentRevision(1)
	assert.throws(() => lease.assertCurrent(), reason('stale'))
	ready(next.probe)
	assert.throws(() => lease.assertCurrent(), reason('stale'))
})

void test('same presentation A to B to A cannot reuse request identity, attach or old abort', async () => {
	const f = begin()
	const second = begin(f.gate),
		thirdController = new AbortController()
	await assert.rejects(f.promise, reason('stale'))
	const third = f.gate.preparePresentation(f.value, {
		purpose: 'preview',
		signal: thirdController.signal,
	})
	await assert.rejects(second.promise, reason('stale'))
	const request = f.gate.getSnapshot().request!
	assert.equal(request.presentation, f.value)
	assert.notEqual(request.id, f.request.id)
	ready(f.gate.attachProbe({ value: request.id.value }))
	ready(f.gate.attachProbe(f.request.id))
	ready(f.probe)
	f.controller.abort()
	second.controller.abort()
	await pending(third)
	ready(f.gate.attachProbe(request.id))
	;(await third).assertCurrent()
	f.gate.stop()
})

void test('issued lease permanently expires on pending, unmount, reattach, abort, stop or new preparation', async () => {
	for (const invalidate of [
		'pending',
		'unmount',
		'reattach',
		'abort',
		'stop',
		'prepare',
	] as const) {
		const f = begin()
		ready(f.probe)
		const lease = await f.promise
		if (invalidate === 'pending')
			f.probe.report('progress', { kind: 'pending' })
		if (invalidate === 'unmount') f.probe.dispose()
		if (invalidate === 'reattach') f.gate.attachProbe(f.request.id)
		if (invalidate === 'abort') f.controller.abort()
		if (invalidate === 'stop') f.gate.stop()
		if (invalidate === 'prepare') {
			const replacement = begin(f.gate)
			ready(replacement.probe)
			;(await replacement.promise).assertCurrent()
		}
		assert.throws(() => lease.assertCurrent(), reason('stale'), invalidate)
		ready(f.probe)
		assert.throws(() => lease.assertCurrent(), reason('stale'), invalidate)
		f.gate.stop()
	}
})

void test('already aborted preparation does not replace a valid current candidate or lease', async () => {
	const f = begin(),
		controller = new AbortController()
	ready(f.probe)
	const lease = await f.promise,
		before = f.gate.getSnapshot()
	controller.abort()
	await assert.rejects(
		f.gate.preparePresentation(presentation(), {
			purpose: 'preview',
			signal: controller.signal,
		}),
		reason('cancelled'),
	)
	assert.equal(f.gate.getSnapshot(), before)
	lease.assertCurrent()
	f.gate.stop()
})

void test('stop releases waiting work and old reports/abort cannot mutate a fresh candidate', async () => {
	const f = begin()
	f.gate.stop()
	await assert.rejects(f.promise, reason('cancelled'))
	const next = begin(f.gate),
		before = f.gate.getSnapshot()
	ready(f.probe)
	f.probe.dispose()
	f.controller.abort()
	assert.equal(f.gate.getSnapshot(), before)
	ready(next.probe)
	;(await next.promise).assertCurrent()
	f.gate.stop()
})

void test('malformed/unknown reports are transient unavailable rather than a stable layout verdict', async () => {
	for (const scope of ['progress', 'not-a-scope']) {
		const f = begin()
		f.probe.report(scope as 'progress', {
			kind: 'ready',
			resolution: {
				kind: 'regular',
				touchDp: 0,
				requiredWidthDp: 48,
				minWidthsDp: [48],
			},
		})
		await assert.rejects(f.promise, reason('unavailable'))
		assert.equal(
			f.gate.getSnapshot().failure instanceof ThemeLayoutRejectedError,
			false,
		)
	}
})

void test('cached snapshots stay stable on no-op observations; unsubscribe and copied reports isolate callers', async () => {
	const f = begin(),
		notifications: string[] = []
	const unsubscribe = f.gate.subscribe(() =>
		notifications.push(f.gate.getSnapshot().phase),
	)
	const report = observation()
	f.probe.report('progress', report)
	const before = f.gate.getSnapshot()
	assert.equal(f.gate.getSnapshot(), before)
	f.probe.report('progress', observation())
	f.gate.setEnvironmentRevision(1)
	assert.equal(f.gate.getSnapshot(), before)
	assert.equal(notifications.length, 1)
	assert.ok(report.kind === 'ready')
	report.resolution.minWidthsDp[0] = 9000
	const copied = before.reports.progress!
	assert.ok(copied.kind === 'ready')
	assert.equal(copied.resolution.minWidthsDp[0], 96)
	copied.resolution.minWidthsDp[0] = 8000
	unsubscribe()
	ready(f.probe)
	const lease = await f.promise
	lease.assertCurrent()
	assert.equal(f.gate.getSnapshot().reports.progress?.kind, 'ready')
	assert.equal(notifications.length, 1)
	f.gate.stop()
})

void test('invalid environment input leaves pending state untouched', async () => {
	const f = begin(),
		before = f.gate.getSnapshot()
	for (const revision of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
		assert.throws(() => f.gate.setEnvironmentRevision(revision), RangeError)
	assert.equal(f.gate.getSnapshot(), before)
	ready(f.probe)
	;(await f.promise).assertCurrent()
	f.gate.stop()
})
