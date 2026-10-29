import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'
import {
	ThemePresentationTransientError,
	type ThemePresentation,
} from '../core/theme-install-types'
import { resolveThemeControlRow } from '../core/theme-layout'
import * as gateModule from '../theme-layout-gate'
import { ThemeLayoutGate, themeLayoutScopes } from '../theme-layout-gate'
import type {
	ThemeLayoutInsets,
	ThemeLayoutRootBounds,
} from '../useThemeLayoutHost'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const component = (value: unknown) => value as ControlNode['type']
const source = readFileSync(
	new URL('../useThemeLayoutHost.ts', import.meta.url),
	'utf8',
)
function presentation(): ThemePresentation {
	const theme = structuredClone(builtInThemes.modern)
	return {
		selection: {
			kind: 'package',
			id: 'example.local-probe',
			archiveSha256: 'a'.repeat(64),
		},
		theme,
		packageMetadata: null,
		allowedImageUris: [],
		adapted: {
			theme,
			mode: 'light',
			retained: {
				buttonMinTouchDp: 96,
				controlRowLayout: {
					minTouchDp: 96,
					compactMinTouchDp: 72,
					narrowFallback: 'host-single-row',
				},
				lyricTokens: { active: '#111111', inactive: '#444444' },
			},
			renderingResponsibilities: [
				'local-image-uris',
				'button-min-touch-dp',
				'lyric-tokens',
				'motion-duration-and-reduced-motion',
				'explicit-color-mode',
			],
		},
	}
}
function fixture() {
	const dependencies: Record<string, unknown> = {
		'./theme-layout-gate': gateModule,
	}
	const f = controlFixture(
		{
			useThemeLayoutHost: source,
			'theme-layout-probe': `${readFileSync(new URL('../theme-layout-probe.tsx', import.meta.url), 'utf8')}\nexport { ProbeScope as ReviewProbeScope }`,
			'layout-host-test': `import React from 'react'; import {View} from 'react-native'; import {useThemeLayoutHost} from './useThemeLayoutHost'; import {ThemeLayoutProbe} from './theme-layout-probe';
			export function Host(props) { const host=useThemeLayoutHost(props.gate,props.insets); props.capture(host); return <View testID='actual-root-port' onLayout={host.onRootLayout}><ThemeLayoutProbe gate={props.gate} request={props.request} bounds={host.bounds} bottomInset={props.insets.bottom} reducedMotion /></View> }`,
		},
		dependencies,
	)
	dependencies['./useThemeLayoutHost'] = f.load('useThemeLayoutHost')
	dependencies['./theme-layout-probe'] = f.load('theme-layout-probe')
	let captured!: {
		bounds: ThemeLayoutRootBounds | null
		onRootLayout: (event: unknown) => void
	}
	const insets = { top: 20, right: 0, bottom: 12, left: 0 }
	const drawHost = (
		gate: ThemeLayoutGate,
		nextInsets: ThemeLayoutInsets = insets,
	) =>
		f.render(
			f.element(component(f.load('layout-host-test').Host), {
				gate,
				insets: nextInsets,
				request: gate.getSnapshot().request,
				capture: (host: typeof captured) => {
					captured = host
				},
			}),
		)
	const drawProbe = (
		gate: ThemeLayoutGate,
		bounds: ThemeLayoutRootBounds | null = { width: 360, height: 800 },
	) =>
		f.render(
			f.element(component(f.load('theme-layout-probe').ThemeLayoutProbe), {
				gate,
				request: gate.getSnapshot().request,
				bounds,
				bottomInset: 12,
				reducedMotion: true,
			}),
		)
	return {
		...f,
		drawHost,
		drawProbe,
		insets,
		get captured() {
			return captured
		},
	}
}
function rows(view: unknown) {
	return controlNodes(view).filter(
		(node) =>
			typeof node.props.onLayout === 'function' &&
			node.props.accessibilityRole !== 'adjustable' &&
			node.props.testID !== 'actual-root-port',
	)
}
function measure(view: unknown, widths = [340, 326, 326, 306, 306, 306, 306]) {
	const measured = rows(view)
	assert.equal(measured.length, 7)
	measured.forEach((node, index) =>
		(node.props.onLayout as (event: unknown) => void)({
			nativeEvent: { layout: { width: widths[index] } },
		}),
	)
}
function start(gate: ThemeLayoutGate) {
	const controller = new AbortController()
	return {
		controller,
		promise: gate.preparePresentation(presentation(), {
			purpose: 'activate',
			signal: controller.signal,
		}),
	}
}
const stale = (error: unknown) =>
	error instanceof ThemePresentationTransientError && error.reason === 'stale'

void test('actual seven-view probe uses real control rows, stable request identity, local artwork and silent noninteractive containment', async () => {
	const f = fixture(),
		gate = new ThemeLayoutGate()
	gate.setEnvironmentRevision(1)
	const pending = start(gate)
	let attached = 0
	const original = gate.attachProbe
	gate.attachProbe = (id) => {
		attached++
		return original(id)
	}
	let tree = f.drawProbe(gate)
	const container = controlNodes(tree).find(
		(node) => node.props.testID === 'theme-layout-probe',
	)!
	assert.equal(container.props.pointerEvents, 'none')
	assert.equal(container.props.accessible, false)
	assert.equal(container.props.importantForAccessibility, 'no-hide-descendants')
	assert.equal(container.props.accessibilityElementsHidden, true)
	const style = f.flatten(container.props.style)
	assert.equal(style.opacity, 0)
	assert.equal(style.position, 'absolute')
	assert.equal(style.left, 0)
	assert.equal(style.right, 0)
	assert.equal(
		style.width,
		undefined,
		'the native parent owns fit width; no viewport/old numeric width',
	)
	assert.equal(rows(tree).length, 7)
	assert.deepEqual(Object.keys(gate.getSnapshot().reports), [
		...themeLayoutScopes,
	])
	assert.equal(gate.getSnapshot().phase, 'pending')
	measure(tree)
	tree = f.drawProbe(gate)
	const lease = await pending.promise
	lease.assertCurrent()
	const firstRequest = gate.getSnapshot().request
	f.drawProbe(gate)
	assert.equal(
		attached,
		1,
		'ready publication/new snapshot.request wrappers must not reattach the probe',
	)
	assert.equal(gate.getSnapshot().request?.id, firstRequest?.id)
	lease.assertCurrent()
	assert.equal(
		controlNodes(tree).some(
			(node) => node.props.accessibilityLiveRegion === 'polite',
		),
		false,
	)
	assert.equal(
		controlNodes(tree).some((node) =>
			JSON.stringify(node.props.source ?? '').includes('https://'),
		),
		false,
	)
	for (const node of controlNodes(tree))
		if (typeof node.props.onPress === 'function')
			(node.props.onPress as () => void)()
	lease.assertCurrent()
	f.unmount()
	assert.throws(() => lease.assertCurrent(), stale)
})

void test('actual rejected probe has no polite live region; default measured rows keep their announcement', async () => {
	const f = fixture(),
		gate = new ThemeLayoutGate()
	gate.setEnvironmentRevision(1)
	const pending = start(gate)
	let tree = f.drawProbe(gate)
	measure(tree, [40, 40, 40, 40, 40, 40, 40])
	tree = f.drawProbe(gate)
	await assert.rejects(pending.promise)
	assert.equal(
		controlNodes(tree).some(
			(node) => node.props.accessibilityLiveRegion === 'polite',
		),
		false,
	)
	assert.ok(
		controlNodes(tree).filter(
			(node) => node.props.accessibilityLiveRegion === 'none',
		).length >= 1,
	)
	const row = f.load('theme-control-layout').MeasuredThemeControlRow
	const root = f.element(
		component(row),
		{
			policy: { minTouchDp: 96, narrowFallback: 'reject' },
			controlMinWidthsDp: [48],
		},
		f.element('Pressable', {}),
	)
	tree = f.render(root)
	;(rows(tree)[0].props.onLayout as (event: unknown) => void)({
		nativeEvent: { layout: { width: 40 } },
	})
	tree = f.render(root)
	assert.equal(
		controlNodes(tree).some(
			(node) => node.props.accessibilityLiveRegion === 'polite',
		),
		true,
	)
})

void test('actual old probe native callbacks cannot report to a newer candidate or after unmount; unknown bounds attach nothing', async () => {
	const f = fixture(),
		gate = new ThemeLayoutGate()
	gate.setEnvironmentRevision(1)
	const first = start(gate)
	assert.equal(f.drawProbe(gate, null), null)
	assert.equal(gate.getSnapshot().probeRound, null)
	let tree = f.drawProbe(gate)
	const old = rows(tree).map(
		(node) => node.props.onLayout as (event: unknown) => void,
	)
	const second = start(gate)
	await assert.rejects(first.promise, stale)
	tree = f.drawProbe(gate)
	for (const callback of old)
		callback({ nativeEvent: { layout: { width: 400 } } })
	f.drawProbe(gate)
	assert.ok(
		Object.values(gate.getSnapshot().reports).every(
			(status) => status?.kind === 'pending',
		),
	)
	measure(tree)
	f.drawProbe(gate)
	const lease = await second.promise
	lease.assertCurrent()
	f.unmount()
	for (const callback of old)
		callback({ nativeEvent: { layout: { width: 400 } } })
	assert.equal(f.writesAfterUnmount, 0)
	assert.throws(() => lease.assertCurrent(), stale)
})

void test('actual single-scope cleanup revokes an issued lease even while the other six scopes remain ready', async () => {
	const f = fixture(),
		gate = new ThemeLayoutGate()
	gate.setEnvironmentRevision(1)
	const pending = start(gate)
	const port = gate.attachProbe(gate.getSnapshot().request!.id)
	const resolution = resolveThemeControlRow(
		{ minTouchDp: 48, narrowFallback: 'reject' },
		{ availableWidthDp: 300, controlMinWidthsDp: [48], gapDp: 0 },
	)
	assert.notEqual(resolution.kind, 'rejected')
	if (resolution.kind === 'rejected')
		throw new Error('fixture resolution rejected')
	const ready = { kind: 'ready' as const, resolution }
	const observations: Parameters<typeof port.report>[1][] = []
	const report = (status: Parameters<typeof port.report>[1]) => {
		observations.push(status)
		port.report('progress', status)
	}
	f.render(
		f.element(
			component(f.load('theme-layout-probe').ReviewProbeScope),
			{ report },
			f.element('View', {}),
		),
	)
	for (const scope of themeLayoutScopes) port.report(scope, ready)
	const lease = await pending.promise
	lease.assertCurrent()
	f.render(null)
	assert.equal(observations.length, 1)
	assert.equal(observations[0].kind, 'pending')
	assert.equal(gate.getSnapshot().phase, 'invalidated')
	assert.throws(() => lease.assertCurrent(), stale)
})

void test('actual probe cleanup and remount require a new native round; old native callbacks do not satisfy it', async () => {
	const f = fixture(),
		gate = new ThemeLayoutGate()
	gate.setEnvironmentRevision(1)
	const pending = start(gate)
	const tree = f.drawProbe(gate)
	const old = rows(tree).map(
		(node) => node.props.onLayout as (event: unknown) => void,
	)
	const round = gate.getSnapshot().probeRound!
	f.render(null)
	assert.equal(gate.getSnapshot().probeRound, null)
	const fresh = f.drawProbe(gate)
	assert.notEqual(gate.getSnapshot().probeRound, round)
	for (const callback of old)
		callback({ nativeEvent: { layout: { width: 400 } } })
	f.drawProbe(gate)
	assert.ok(
		Object.values(gate.getSnapshot().reports).every(
			(status) => status?.kind === 'pending',
		),
	)
	measure(fresh)
	f.drawProbe(gate)
	;(await pending.promise).assertCurrent()
})

void test('actual host begins unknown; root onLayout owns width and synchronously invalidates a lease before React rerender', async () => {
	const f = fixture(),
		gate = new ThemeLayoutGate()
	f.viewport.width = 9999
	f.drawHost(gate)
	assert.equal(f.captured.bounds, null)
	assert.equal(gate.getSnapshot().environmentRevision, null)
	const pending = start(gate)
	f.drawHost(gate)
	assert.equal(gate.getSnapshot().probeRound, null)
	f.captured.onRootLayout({
		nativeEvent: { layout: { width: 360, height: 700 } },
	})
	let tree = f.drawHost(gate)
	assert.equal((f.captured.bounds as ThemeLayoutRootBounds | null)?.width, 360)
	measure(tree)
	f.drawHost(gate)
	const lease = await pending.promise
	lease.assertCurrent()
	const revision = gate.getSnapshot().environmentRevision
	f.captured.onRootLayout({
		nativeEvent: { layout: { width: 360, height: 700 } },
	})
	assert.equal(gate.getSnapshot().environmentRevision, revision)
	lease.assertCurrent()
	f.captured.onRootLayout({
		nativeEvent: { layout: { width: 320, height: 700 } },
	})
	assert.throws(
		() => lease.assertCurrent(),
		stale,
		'invalidates synchronously before the next render',
	)
	tree = f.drawHost(gate)
	assert.equal((f.captured.bounds as ThemeLayoutRootBounds | null)?.width, 320)
	assert.equal(rows(tree).length, 0)
})

void test('actual font/insets/viewport changes revoke lease at commit; viewport requires fresh root measurement and ignores A→B→A old callbacks', async () => {
	const f = fixture(),
		gate = new ThemeLayoutGate()
	f.drawHost(gate)
	f.captured.onRootLayout({
		nativeEvent: { layout: { width: 360, height: 700 } },
	})
	f.drawHost(gate)
	const obtain = async () => {
		const pending = start(gate)
		const tree = f.drawHost(gate)
		measure(tree)
		f.drawHost(gate)
		return pending.promise
	}
	const fontLease = await obtain()
	f.viewport.fontScale = 1.4
	f.drawHost(gate)
	assert.throws(() => fontLease.assertCurrent(), stale)
	const insetLease = await obtain()
	f.drawHost(gate, { ...f.insets, left: 8 })
	assert.throws(() => insetLease.assertCurrent(), stale)
	f.drawHost(gate)
	const viewportLease = await obtain(),
		oldRoot = f.captured.onRootLayout
	f.viewport.width = 412
	f.drawHost(gate)
	assert.throws(() => viewportLease.assertCurrent(), stale)
	assert.equal(f.captured.bounds, null)
	assert.equal(gate.getSnapshot().environmentRevision, null)
	f.viewport.width = 360
	f.drawHost(gate)
	oldRoot({ nativeEvent: { layout: { width: 9999, height: 700 } } })
	f.drawHost(gate)
	assert.equal(f.captured.bounds, null)
	f.captured.onRootLayout({
		nativeEvent: { layout: { width: 360, height: 700 } },
	})
	f.drawHost(gate)
	assert.equal((f.captured.bounds as ThemeLayoutRootBounds | null)?.width, 360)
	const fresh = await obtain()
	fresh.assertCurrent()
	const latestRoot = f.captured.onRootLayout
	f.unmount()
	latestRoot({ nativeEvent: { layout: { width: 400, height: 700 } } })
	assert.equal(f.writesAfterUnmount, 0)
	assert.throws(() => fresh.assertCurrent(), stale)
})
