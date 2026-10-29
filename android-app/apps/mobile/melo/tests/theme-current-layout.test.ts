import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'
import { cosmosTheme, type ColorMode } from '../core/theme-appearance'
import * as installTypes from '../core/theme-install-types'
import type { ThemePresentation } from '../core/theme-install-types'
import * as gateModule from '../theme-layout-gate'
import * as renderingModule from '../theme-renderer'
import type { useThemeCandidateLayout } from '../useThemeCandidateLayout'
import {
	requiresCurrentLayout,
	withCurrentLayoutRestore,
	type useThemeCurrentLayout,
} from '../useThemeCurrentLayout'

import {
	controlFixture,
	controlNodes,
	legacyControlPackage,
	type ControlNode,
} from './theme-control-fixture'

type Current = ReturnType<typeof useThemeCurrentLayout>
type Candidate = ReturnType<typeof useThemeCandidateLayout>
type Frame = { display: Current; candidate: Candidate }
const component = (value: unknown) => value as ControlNode['type']
const readSource = (name: string) =>
	readFileSync(new URL(`../${name}.ts`, import.meta.url), 'utf8')
function presentation(minTouch = 96): ThemePresentation {
	const theme = structuredClone(builtInThemes.anime)
	return {
		selection: {
			kind: 'package',
			id: 'example.current',
			archiveSha256: 'a'.repeat(64),
		},
		theme,
		packageMetadata: null,
		allowedImageUris: [],
		adapted: {
			theme,
			mode: 'light',
			retained: {
				buttonMinTouchDp: minTouch,
				controlRowLayout: { minTouchDp: minTouch, narrowFallback: 'reject' },
				lyricTokens: { active: '#111111', inactive: '#333333' },
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
function fixture(startup = false) {
	const currentGate = new gateModule.ThemeLayoutGate()
	let renderingBuilds = 0
	const deps: Record<string, unknown> = {
		'./theme-renderer': { ...renderingModule, createPackageRendering: (...args: Parameters<typeof renderingModule.createPackageRendering>) => {
			renderingBuilds++
			return renderingModule.createPackageRendering(...args)
		} },
		'./theme-layout-gate': gateModule,
		'./core/theme-install-types': installTypes,
	}
	const h = controlFixture(
		{
			useThemeLayoutHost: readSource('useThemeLayoutHost'),
			useThemeCandidateLayout: readSource('useThemeCandidateLayout'),
			useThemeCurrentLayout: readSource('useThemeCurrentLayout'),
			'current-harness': `import React,{useEffect,useState} from 'react'; import {View} from 'react-native'; import {useThemeCandidateLayout} from './useThemeCandidateLayout';import {useThemeCurrentLayout} from './useThemeCurrentLayout';import {ThemeLayoutProbe} from './theme-layout-probe';import {ThemeRendererProvider} from './ui';import {StartupContent} from './startup-ui';
export function Harness(p){const candidate=useThemeCandidateLayout(p.insets,p.gate);candidate.rootRef.current=p.root;const display=useThemeCurrentLayout(p.presentation,p.gate,candidate.environmentIdentity,p.mode);p.capture({display,candidate});return <ThemeRendererProvider theme={display.presentation.theme} adapted={display.presentation.adapted} allowedImageUris={display.presentation.allowedImageUris} reducedMotion><View ref={candidate.rootRef} onLayout={candidate.onRootLayout}><StartupContent ready={!p.startup || (!display.pending && p.restored)} mode={p.mode}><Business capture={p.business}/></StartupContent><ThemeLayoutProbe gate={candidate.gate} request={candidate.request} bounds={candidate.bounds} bottomInset={p.insets.bottom} reducedMotion/><ThemeLayoutProbe gate={p.gate} request={display.request} bounds={candidate.bounds} bottomInset={p.insets.bottom} reducedMotion/></View></ThemeRendererProvider>}
function Business(p){const [draft,setDraft]=useState('kept draft');useEffect(()=>{p.capture('mount');return ()=>p.capture('unmount')},[]);return <View testID='business-state' draft={draft} change={setDraft}/>}`,
		},
		deps,
	)
	deps['./useThemeLayoutHost'] = h.load('useThemeLayoutHost')
	deps['./useThemeCandidateLayout'] = h.load('useThemeCandidateLayout')
	deps['./useThemeCurrentLayout'] = h.load('useThemeCurrentLayout')
	deps['./theme-layout-probe'] = h.load('theme-layout-probe')
	let frame!: Frame
	const reads: ((...bounds: number[]) => void)[] = []
	const root = {
		measure: (callback: (...bounds: number[]) => void) => reads.push(callback),
	}
	const lifecycle: string[] = []
	const insets = { top: 20, right: 0, bottom: 12, left: 0 }
	const draw = (value: ThemePresentation, mode: ColorMode = 'light', restored = true) =>
		h.render(
			h.element(component(h.load('current-harness').Harness), {
				presentation: value,
				startup,
				restored,
				mode,
				gate: currentGate,
				insets,
				root,
				capture: (next: Frame) => {
					frame = next
				},
				business: (event: string) => lifecycle.push(event),
			}),
		)
	const measureRoot = (index = reads.length - 1, width = 500) =>
		reads[index](0, 0, width, 800, 0, 0)
	const rows = (tree: unknown) =>
		controlNodes(tree).filter(
			(node) =>
				typeof node.props.onLayout === 'function' &&
				node.props.ref !== frame.candidate.rootRef &&
				node.props.accessibilityRole !== 'adjustable',
		)
	const measureRows = (tree: unknown, width: number) => {
		const nodes = rows(tree)
		for (const node of nodes)
			(node.props.onLayout as (event: unknown) => void)({
				nativeEvent: { layout: { width } },
			})
		return nodes
	}
	return {
		...h,
		currentGate,
		reads,
		insets,
		lifecycle,
		draw,
		measureRoot,
		rows,
		measureRows,
		get frame() {
			return frame
		},
		get renderingBuilds() { return renderingBuilds },
	}
}

void test('unrelated page renders reuse verified theme resource mappings; a changed presentation is rechecked', () => {
	const f = fixture(), value = presentation()
	try {
		f.draw(value)
		f.measureRoot()
		f.draw(value)
		f.measureRows(f.draw(value), 500)
		f.draw(value); f.draw(value)
		const builds = f.renderingBuilds
		for (let i = 0; i < 100; i++) f.draw(value)
		assert.equal(f.renderingBuilds, builds)
		f.draw({ ...value })
		assert.ok(f.renderingBuilds > builds)
	} finally { f.unmount() }
})

void test('cold package startup hides business UI until restoration and real layout proof finish, without blocking probes', () => {
	for (const mode of ['light', 'dark'] as const) {
		const f = fixture(true), value = presentation()
		try {
			let tree = f.draw(value, mode, false)
			assert.equal(f.frame.display.pending, true)
			assert.deepEqual(f.lifecycle, [])
			assert.ok(controlNodes(tree).some((n) => n.props.testID === 'app-startup'))
			f.measureRoot()
			f.draw(value, mode, false)
			tree = f.draw(value, mode, false)
			assert.equal(f.rows(tree).length, 7)
			f.measureRows(tree, 500)
			f.draw(value, mode, false)
			f.draw(value, mode, false)
			assert.equal(f.frame.display.pending, false)
			assert.deepEqual(f.lifecycle, [], 'successful layout alone cannot expose a still-loading theme')
			tree = f.draw(value, mode)
			assert.equal(f.frame.display.presentation, value)
			assert.deepEqual(f.lifecycle, ['mount'])
			assert.ok(!controlNodes(tree).some((n) => n.props.testID === 'app-startup'))
			f.viewport.width = 300
			tree = f.draw(value, mode)
			assert.equal(f.frame.display.pending, true)
			assert.deepEqual(f.lifecycle, ['mount'], 'runtime resize must preserve page state')
			assert.ok(!controlNodes(tree).some((n) => n.props.testID === 'app-startup'))
		} finally { f.unmount() }
	}
})

void test('an incompatible package ends startup with recoverable fallback rather than waiting indefinitely', async () => {
	const f = fixture(true), value = presentation()
	try {
		f.draw(value)
		f.measureRoot(undefined, 220)
		f.draw(value)
		f.measureRows(f.draw(value), 220)
		f.draw(value)
		assert.equal(f.currentGate.getSnapshot().phase, 'rejected')
		await new Promise((resolve) => setImmediate(resolve))
		const tree = f.draw(value)
		assert.equal(f.frame.display.pending, false)
		assert.equal(f.frame.display.temporaryModern, true)
		assert.deepEqual(f.lifecycle, ['mount'])
		assert.ok(!controlNodes(tree).some((n) => n.props.testID === 'app-startup'))
	} finally { f.unmount() }
})

void test('builtin three defaults and verified legacy48 display immediately without modern checking flash or current probes', async () => {
	const old = await legacyControlPackage()
	for (const value of [
		...Object.entries(builtInThemes).map(
			([key, theme]) =>
				({
					selection: { kind: 'builtin', key },
					theme,
					adapted: null,
					allowedImageUris: [],
					packageMetadata: null,
				}) as ThemePresentation,
		),
		{
			selection: {
				kind: 'package',
				id: 'example.legacy',
				archiveSha256: 'a'.repeat(64),
			},
			theme: old.adapted.theme,
			adapted: old.adapted,
			allowedImageUris: old.allowedImageUris,
			packageMetadata: null,
		} as ThemePresentation,
	]) {
		const f = fixture()
		try {
			f.draw(value)
			assert.equal(f.frame.display.presentation, value)
			assert.equal(f.frame.display.temporaryModern, false)
			assert.equal(f.currentGate.getSnapshot().request, null)
			assert.equal(requiresCurrentLayout(value), false)
		} finally {
			f.unmount()
		}
	}
})

void test('pending dark layout uses cosmos instead of flashing modern; accepted layout restores selected dark presentation', () => {
	const f = fixture(), value = presentation()
	value.theme = cosmosTheme
	value.adapted = { ...value.adapted!, theme: cosmosTheme, mode: 'dark' }
	try {
		f.draw(value, 'dark')
		assert.equal(f.frame.display.temporaryModern, true)
		assert.equal(f.frame.display.presentation.theme, cosmosTheme)
		assert.match(f.frame.display.reason!, /宇宙/)
		f.measureRoot()
		f.draw(value, 'dark')
		f.measureRows(f.draw(value, 'dark'), 500)
		f.draw(value, 'dark'); f.draw(value, 'dark')
		assert.equal(f.frame.display.presentation, value)
	} finally { f.unmount() }
})

void test('warm runtime checks before first render and automatically restores after new actual seven-scope proof, preserving provider business state', () => {
	const f = fixture(),
		value = presentation()
	try {
		f.draw(value)
		assert.equal(f.frame.display.temporaryModern, true)
		assert.equal(f.frame.display.presentation.theme.id, builtInThemes.modern.id)
		f.measureRoot()
		f.draw(value)
		const tree = f.draw(value)
		assert.equal(f.rows(tree).length, 7)
		f.measureRows(tree, 500)
		f.draw(value)
		f.draw(value)
		assert.equal(f.frame.display.presentation, value)
		const business = controlNodes(f.draw(value)).find(
			(node) => node.props.testID === 'business-state',
		)!
		;(business.props.change as (value: string) => void)('edited while playing')
		const oldRows = f.rows(f.draw(value)),
			oldId = f.currentGate.getSnapshot().request!.id
		f.viewport.width = 300
		f.draw(value)
		assert.equal(
			f.frame.display.temporaryModern,
			true,
			'old ready cannot authorize a changed render environment',
		)
		f.measureRoot(undefined, 300)
		f.draw(value)
		f.measureRows(f.draw(value), 220)
		f.draw(value)
		f.draw(value)
		assert.equal(f.frame.display.temporaryModern, true)
		assert.match(f.frame.display.reason!, /暂不适合/)
		f.viewport.width = 360
		f.draw(value)
		f.measureRoot()
		f.draw(value)
		assert.notEqual(f.currentGate.getSnapshot().request!.id, oldId)
		for (const row of oldRows)
			(row.props.onLayout as (event: unknown) => void)({
				nativeEvent: { layout: { width: 500 } },
			})
		f.draw(value)
		assert.equal(f.frame.display.temporaryModern, true)
		f.measureRows(f.draw(value), 500)
		f.draw(value)
		const restored = f.draw(value)
		assert.equal(f.frame.display.presentation, value)
		assert.equal(
			controlNodes(restored).find(
				(node) => node.props.testID === 'business-state',
			)!.props.draft,
			'edited while playing',
		)
		assert.deepEqual(f.lifecycle, ['mount'])
	} finally {
		f.unmount()
	}
})

void test('font/inset and current-selection ABA invalidate old proofs; separate candidate rejection cannot poison current and late events after unmount are inert', async () => {
	const f = fixture(),
		a = presentation(),
		b = {
			...presentation(),
			selection: {
				kind: 'package' as const,
				id: 'example.other',
				archiveSha256: 'b'.repeat(64),
			},
		}
	try {
		f.draw(a)
		f.measureRoot()
		f.draw(a)
		f.measureRows(f.draw(a), 500)
		f.draw(a)
		f.draw(a)
		const oldRows = f.rows(f.draw(a))
		f.draw(b)
		assert.equal(f.frame.display.temporaryModern, true)
		f.draw(a)
		assert.equal(f.frame.display.temporaryModern, true)
		for (const row of oldRows)
			(row.props.onLayout as (event: unknown) => void)({
				nativeEvent: { layout: { width: 500 } },
			})
		f.draw(a)
		assert.equal(f.frame.display.temporaryModern, true)
		f.measureRows(f.draw(a), 500)
		f.draw(a)
		f.draw(a)
		assert.equal(f.frame.display.presentation, a)
		const signal = new AbortController().signal
		const rejected = f.frame.candidate.preparePresentation(b, {
			purpose: 'preview',
			signal,
		})
		f.draw(a)
		const request = f.frame.candidate.gate.getSnapshot().request!
		const candidate = f.frame.candidate.gate.attachProbe(request.id)
		candidate.report('navigation', {
			kind: 'rejected',
			resolution: {
				kind: 'rejected',
				reason: 'insufficient-width',
				requiredWidthDp: 384,
				availableWidthDp: 220,
			},
		})
		await assert.rejects(rejected, installTypes.ThemeLayoutRejectedError)
		f.draw(a)
		assert.equal(f.frame.display.presentation, a)
		f.viewport.fontScale = 2
		f.draw(a)
		assert.equal(f.frame.display.temporaryModern, true)
		f.draw(a)
		f.measureRows(f.draw(a), 500)
		f.draw(a)
		f.draw(a)
		assert.equal(f.frame.display.presentation, a)
		f.insets.bottom = 24
		f.draw(a)
		assert.equal(f.frame.display.temporaryModern, true)
		const late = f.rows(f.draw(a))
		f.unmount()
		for (const row of late)
			(row.props.onLayout as (event: unknown) => void)({
				nativeEvent: { layout: { width: 500 } },
			})
		assert.equal(f.currentGate.getSnapshot().request, null)
		assert.equal(f.writesAfterUnmount, 0)
	} finally {
		f.unmount()
	}
})

void test('effect-only StrictMode replay uses a fresh round and fresh root read rather than resurrecting the old lease', () => {
	const f = fixture(),
		value = presentation()
	try {
		f.draw(value)
		f.measureRoot()
		f.draw(value)
		f.measureRows(f.draw(value), 500)
		f.draw(value)
		f.draw(value)
		assert.equal(f.frame.display.presentation, value)
		const oldId = f.currentGate.getSnapshot().request!.id
		f.replayEffects()
		f.draw(value)
		assert.equal(f.frame.display.temporaryModern, true)
		f.measureRoot()
		f.draw(value)
		f.measureRows(f.draw(value), 500)
		f.draw(value)
		f.draw(value)
		assert.equal(f.frame.display.presentation, value)
		assert.notEqual(f.currentGate.getSnapshot().request!.id, oldId)
	} finally {
		f.unmount()
	}
})

void test('actual restore wrapper keeps preview/activate strict and only delegates verified responsive restoration with a live cancellation lease', async () => {
	const candidate = new gateModule.ThemeLayoutGate(),
		controller = new AbortController()
	const prepare = withCurrentLayoutRestore(candidate.preparePresentation)
	const lease = await prepare(presentation(), {
		purpose: 'restore',
		signal: controller.signal,
	})
	assert.equal(candidate.getSnapshot().request, null)
	lease.assertCurrent()
	controller.abort()
	assert.throws(
		() => lease.assertCurrent(),
		installTypes.ThemePresentationTransientError,
	)
	for (const purpose of ['preview', 'activate'] as const) {
		const abort = new AbortController()
		const pending = prepare(presentation(), { purpose, signal: abort.signal })
		assert.equal(candidate.getSnapshot().request!.purpose, purpose)
		abort.abort()
		await assert.rejects(pending, installTypes.ThemePresentationTransientError)
	}
})
