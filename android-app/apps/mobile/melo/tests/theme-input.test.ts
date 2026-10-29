import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'
import { cosmosTheme } from '../core/theme-appearance'
import type { ThemeControlRowPolicy } from '../core/theme-layout'
import type { AdaptedPackageTheme } from '../core/theme-package-adapter'
import { createPackageRendering } from '../theme-renderer'

import {
	controlFixture,
	controlNodes,
	legacyControlPackage,
	measureControl,
	type ControlNode,
} from './theme-control-fixture'
import { inputFixture } from './theme-input-fixture'

function rendering(policy?: ThemeControlRowPolicy) {
	const adapted: AdaptedPackageTheme = {
		theme: structuredClone(builtInThemes.modern),
		mode: 'light',
		retained: {
			buttonMinTouchDp: policy?.minTouchDp ?? 48,
			...(policy ? { controlRowLayout: policy } : {}),
			lyricTokens: { active: '#111111', inactive: '#222222' },
		},
		renderingResponsibilities: [
			'local-image-uris',
			'button-min-touch-dp',
			'lyric-tokens',
			'motion-duration-and-reduced-motion',
			'explicit-color-mode',
		],
	}
	return createPackageRendering(adapted, [], false)
}
const regular: ThemeControlRowPolicy = {
	minTouchDp: 96,
	compactMinTouchDp: 72,
	narrowFallback: 'host-single-row',
}
function responsive() {
	const f = inputFixture()
	f.context.rendering = rendering(regular)
	return f
}
function input(f: ReturnType<typeof inputFixture>, tree: unknown) {
	const node = f.find(tree, 'TextInput')[0]
	assert.ok(node)
	return node as typeof node & {
		props: {
			onSubmitEditing: (event: unknown) => void
			onChangeText: (text: string) => void
		}
	}
}
function measure(
	f: ReturnType<typeof inputFixture>,
	tree: unknown,
	width: number,
) {
	const node = f
		.find(tree, 'View')
		.find((value) => typeof value.props.onLayout === 'function')
	assert.ok(node)
	const callback = node.props.onLayout as (event: {
		nativeEvent: { layout: { width: number } }
	}) => void
	callback({ nativeEvent: { layout: { width } } })
	return callback
}
const callerLayout = () => {}

void test('input hint and cursor follow the displayed theme without remounting or changing text selection', () => {
	for (const responsiveLayout of [false, true]) {
		const f = responsiveLayout ? responsive() : inputFixture()
		const props = { value: '草稿', selection: { start: 1, end: 1 }, style: { color: '#E8E8ED' } }
		for (const theme of [cosmosTheme, builtInThemes.modern, cosmosTheme]) {
			f.context.theme = theme
			const field = input(f, f.render(props))
			assert.equal(field.props.placeholderTextColor, theme.tokens.text.secondary)
			assert.equal(field.props.selectionColor, theme.tokens.action.primary)
			assert.equal(field.props.cursorColor, theme.tokens.action.primary)
			assert.equal(field.props.value, props.value)
			assert.equal(field.props.selection, props.selection)
		}
		const custom = input(f, f.render({ ...props, placeholderTextColor: '#ABCDEF', selectionColor: '#123456', cursorColor: '#FEDCBA' }))
		assert.equal(custom.props.placeholderTextColor, '#ABCDEF')
		assert.equal(custom.props.selectionColor, '#123456')
		assert.equal(custom.props.cursorColor, '#FEDCBA')
		assert.equal(f.stats.mounts, 1)
		f.unmount()
	}
})

void test('three builtins and true validated legacy48 keep the exact single native TextInput tree and props', async () => {
	const validated = await legacyControlPackage()
	const legacy = createPackageRendering(
		validated.adapted,
		validated.allowedImageUris,
		false,
	)
	for (const { theme, host } of [
		...Object.values(builtInThemes).map((value) => ({
			theme: value,
			host: null,
		})),
		{ theme: validated.adapted.theme, host: legacy },
	]) {
		const f = inputFixture()
		f.context.theme = theme
		f.context.rendering = host
		const style = [
				{
					minHeight: 50,
					paddingHorizontal: 14,
					borderWidth: 1,
					backgroundColor: theme.tokens.surface.card,
					color: theme.tokens.text.primary,
				},
			],
			ref = { current: null }
		const props = {
			ref,
			value: '原稿',
			style,
			onChangeText: () => {},
			onSubmitEditing: () => {},
			onLayout: () => {},
			editable: false,
			readOnly: true,
			returnKeyType: 'done',
			autoFocus: true,
			accessibilityState: { disabled: true },
			selection: { start: 1, end: 1 },
		}
		const tree = f.render({
			...props,
			containerStyle: { flex: 1 },
			minimumWidthDp: 96,
		})
		assert.equal(tree.type, 'TextInput')
		assert.deepEqual(tree.props, {
			...props,
			placeholderTextColor: theme.tokens.text.secondary,
			selectionColor: theme.tokens.action.primary,
			cursorColor: theme.tokens.action.primary,
		})
		assert.equal(tree.props.style, style)
		assert.equal(f.stats.mounts, 1)
		f.unmount()
		assert.equal(ref.current, null)
	}
})

void test('standalone actual slot width decides regular/compact/fallback/rejected, never viewport width or input content width', () => {
	const f = responsive(),
		props = {
			value: '长标题'.repeat(500),
			style: { minHeight: 50, padding: 14, borderWidth: 2 },
		}
	let tree = f.render(props)
	assert.equal(input(f, tree).props.editable, false)
	for (const [width, touch, editable] of [
		[110, 96, true],
		[80, 72, true],
		[55, 50, true],
		[47, 96, false],
	] as const) {
		measure(f, tree, width)
		tree = f.render(props)
		assert.equal(input(f, tree).props.editable, editable)
		assert.equal(f.flatten(input(f, tree).props.style).minHeight, touch)
		assert.equal(f.flatten(input(f, tree).props.style).width, '100%')
		assert.equal(input(f, tree).props.value, props.value)
	}
	assert.equal(f.stats.mounts, 1)
	assert.equal(f.stats.unmounts, 0)
})

void test('ref/focus/draft and real IME event survive keyboard height changes without remount or duplicate submit', () => {
	const f = responsive(),
		ref = { current: null as typeof f.handle | null },
		changes: string[] = [],
		submissions: unknown[] = []
	const props = {
		ref,
		autoFocus: true,
		value: 'draft',
		onChangeText: (text: string) => changes.push(text),
		onSubmitEditing: (event: unknown) => submissions.push(event),
		returnKeyType: 'search',
		submitBehavior: 'submit',
	}
	let tree = f.render(props)
	assert.ok(ref.current)
	assert.equal(
		f.stats.focusCalls,
		0,
		'pending visible input is not autofocus-enabled',
	)
	measure(f, tree, 300)
	tree = f.render(props)
	assert.equal(f.stats.focusCalls, 1)
	assert.equal(ref.current.isFocused(), true)
	const handle = ref.current
	for (const height of [400, 800, 400]) {
		f.viewport.height = height
		tree = f.render(props)
		assert.equal(ref.current, handle)
		assert.equal(input(f, tree).props.editable, true)
	}
	input(f, tree).props.onChangeText('真实文本')
	const event = {
		nativeEvent: { text: 'event text', eventCount: 7, target: 9 },
	}
	input(f, tree).props.onSubmitEditing(event)
	assert.deepEqual(changes, ['真实文本'])
	assert.deepEqual(submissions, [event])
	assert.equal(f.stats.mounts, 1)
	assert.equal(f.stats.unmounts, 0)
	assert.equal(f.stats.focusCalls, 1)
	f.unmount()
	assert.equal(ref.current, null)
})

void test('width/font/new-policy invalidation preserves native node and value, suppresses stale layout and IME callbacks, never refocuses', () => {
	const f = responsive(),
		calls: unknown[] = [],
		props = {
			autoFocus: true,
			value: 'draft',
			onSubmitEditing: (event: unknown) => calls.push(event),
		}
	let tree = f.render(props)
	const oldLayout = measure(f, tree, 300)
	tree = f.render(props)
	const oldSubmit = input(f, tree).props.onSubmitEditing
	for (const change of [
		() => {
			f.viewport.fontScale = 2
		},
		() => {
			f.viewport.width = 300
		},
		() => {
			f.context.rendering = rendering({ ...regular })
		},
	]) {
		change()
		tree = f.render(props)
		assert.equal(input(f, tree).props.editable, false)
		assert.equal(input(f, tree).props.value, 'draft')
		oldLayout({ nativeEvent: { layout: { width: 900 } } })
		oldSubmit({ nativeEvent: { text: 'stale' } })
		tree = f.render(props)
		assert.equal(input(f, tree).props.editable, false)
		measure(f, tree, 120)
		tree = f.render(props)
		assert.equal(input(f, tree).props.editable, true)
	}
	assert.deepEqual(calls, [])
	assert.equal(f.stats.mounts, 1)
	assert.equal(f.stats.focusCalls, 1)
	assert.equal(f.stats.unmounts, 0)
})

void test('responsive input stays visible when pending/rejected; caller disabled/readOnly and accessibility data are preserved', () => {
	const f = responsive(),
		changes: string[] = [],
		submits: string[] = []
	const props = {
		autoFocus: true,
		editable: false,
		value: 'retained',
		onChangeText: (text: string) => changes.push(text),
		onSubmitEditing: () => submits.push('submit'),
		accessibilityLabel: '歌单名称',
		accessibilityState: { busy: true, disabled: true },
		multiline: true,
		maxLength: 40,
		selection: { start: 2, end: 2 },
	}
	let tree = f.render(props)
	measure(f, tree, 300)
	tree = f.render(props)
	const node = input(f, tree)
	assert.equal(node.props.editable, false)
	assert.equal(node.props.multiline, true)
	assert.equal(node.props.selection, props.selection)
	assert.deepEqual(
		{ ...(node.props.accessibilityState as object) },
		{
			busy: true,
			disabled: true,
		},
	)
	node.props.onSubmitEditing({})
	assert.deepEqual(submits, [])
	node.props.onChangeText('queued last draft')
	assert.deepEqual(changes, ['queued last draft'])
	assert.equal(f.stats.focusCalls, 0)
	tree = f.render({ ...props, editable: true, readOnly: true })
	assert.equal(input(f, tree).props.editable, false)
	assert.equal(input(f, tree).props.readOnly, true)
	measure(f, tree, 20)
	tree = f.render({ ...props, editable: true })
	assert.equal(input(f, tree).props.value, 'retained')
	assert.equal(f.flatten(input(f, tree).props.style).opacity, undefined)
	assert.equal(f.stats.mounts, 1)
})

void test('horizontal slot layout is explicit; padding/border stay on input and input onLayout stays native', () => {
	const f = responsive(),
		slot = { flex: 1, marginLeft: 8 },
		style = {
			flex: 1,
			paddingHorizontal: 14,
			borderWidth: 1,
			minWidth: 80,
			minHeight: 54,
		}
	const props = { style, containerStyle: slot, onLayout: callerLayout }
	let tree = f.render(props)
	assert.equal(f.flatten(tree.props.style).flex, 1)
	assert.equal(f.flatten(tree.props.style).paddingHorizontal, undefined)
	assert.equal(f.flatten(tree.props.style).borderWidth, undefined)
	measure(f, tree, 79)
	tree = f.render(props)
	assert.equal(input(f, tree).props.editable, false)
	measure(f, tree, 85)
	tree = f.render(props)
	assert.equal(input(f, tree).props.editable, true)
	assert.equal(input(f, tree).props.onLayout, callerLayout)
	assert.equal(f.flatten(input(f, tree).props.style).paddingHorizontal, 14)
	assert.equal(f.flatten(input(f, tree).props.style).minWidth, 80)
})

void test('inherited whole-row width is never used as slot width; actual measured slot must fit host minimum', () => {
	const f = responsive()
	f.context.target = {
		touchDp: 72,
		minimumWidthDp: 72,
		fill: false,
		availableWidthDp: 400,
	}
	let tree = f.render({ minimumWidthDp: 80 })
	assert.equal(input(f, tree).props.editable, false)
	measure(f, tree, 60)
	tree = f.render({ minimumWidthDp: 80 })
	assert.equal(input(f, tree).props.editable, false)
	assert.equal(f.find(tree, 'Text').length, 1)
	measure(f, tree, 90)
	tree = f.render({ minimumWidthDp: 80 })
	assert.equal(input(f, tree).props.editable, true)
	assert.equal(f.flatten(input(f, tree).props.style).minWidth, 80)
	assert.equal(f.flatten(input(f, tree).props.style).minHeight, 72)
	tree = f.render({ minimumWidthDp: 100 })
	assert.equal(input(f, tree).props.editable, false)
	measure(f, tree, 90)
	tree = f.render({ minimumWidthDp: 100 })
	assert.equal(input(f, tree).props.editable, false)
	assert.equal(f.flatten(input(f, tree).props.style).minWidth, undefined)
})

void test('callback ref cleanup and unmount guard do not restore focus or submit after disposal', () => {
	const f = responsive(),
		refs: unknown[] = [],
		submitted: unknown[] = []
	const props = {
		ref: (value: unknown) => {
			refs.push(value)
			return () => refs.push('cleanup')
		},
		autoFocus: true,
		onSubmitEditing: (event: unknown) => submitted.push(event),
	}
	let tree = f.render(props)
	const layout = measure(f, tree, 120)
	tree = f.render(props)
	const submit = input(f, tree).props.onSubmitEditing
	f.unmount()
	layout({ nativeEvent: { layout: { width: 120 } } })
	submit({})
	assert.equal(f.writesAfterUnmount, 0)
	assert.deepEqual(submitted, [])
	assert.equal(refs.length, 2)
	assert.equal(refs[1], 'cleanup')
	assert.equal(f.stats.focusCalls, 1)
})

void test('turning autoFocus on after initial mount does not introduce a new native focus command', () => {
	const f = responsive()
	const tree = f.render({ autoFocus: false })
	measure(f, tree, 150)
	f.render({ autoFocus: true })
	assert.equal(f.stats.focusCalls, 0)
	assert.equal(f.stats.mounts, 1)
	f.unmount()
})

void test('current status reaches each receiver; stale layout/submit stay expired across revision ABA and effect replay', () => {
	const f = responsive(),
		a: string[] = [],
		b: string[] = [],
		submitted: unknown[] = []
	const receiveA = (status: { kind: string }) => a.push(status.kind),
		receiveB = (status: { kind: string }) => b.push(status.kind)
	const props = {
		autoFocus: true,
		onStatusChange: receiveA,
		onSubmitEditing: (event: unknown) => submitted.push(event),
		layoutRevision: 'A',
	}
	let tree = f.render(props)
	const oldLayout = measure(f, tree, 150)
	tree = f.render(props)
	const oldSubmit = input(f, tree).props.onSubmitEditing
	f.render({ ...props, onStatusChange: receiveB })
	assert.deepEqual(a, ['pending', 'ready'])
	assert.deepEqual(b, ['ready'])
	f.render({ ...props, layoutRevision: 'B' })
	tree = f.render(props)
	oldLayout({ nativeEvent: { layout: { width: 999 } } })
	oldSubmit({})
	assert.equal(input(f, f.render(props)).props.editable, false)
	measure(f, tree, 150)
	tree = f.render(props)
	f.replayEffects()
	oldSubmit({})
	input(f, tree).props.onSubmitEditing({ nativeEvent: { text: 'fresh' } })
	assert.equal(submitted.length, 1)
	assert.equal(f.stats.mounts, 1)
	assert.equal(f.stats.focusCalls, 1)
	assert.equal(f.stats.unmounts, 0)
	f.unmount()
})

void test('actual shared ControlRow keyboard-height invalidation unmounts its child, motivating independent input slot', () => {
	const f = controlFixture({
		progress: `import React,{useLayoutEffect} from 'react'; export function Progress({mounted,unmounted}) { useLayoutEffect(()=>{mounted();return unmounted},[]);return React.createElement('TextInput',{}); }`,
	})
	let mounts = 0,
		unmounts = 0
	const row = f.load('theme-control-layout')
			.MeasuredThemeControlRow as ControlNode['type'],
		probe = f.load('progress').Progress as ControlNode['type']
	const root = () =>
		f.element(
			row,
			{ policy: regular, controlMinWidthsDp: [48] },
			f.element(probe, {
				mounted: () => mounts++,
				unmounted: () => unmounts++,
			}),
		)
	let tree = f.render(root())
	measureControl(tree, 200)
	tree = f.render(root())
	assert.equal(
		controlNodes(tree).filter((node) => node.type === 'TextInput').length,
		1,
	)
	f.viewport.height = 400
	tree = f.render(root())
	assert.equal(
		controlNodes(tree).filter((node) => node.type === 'TextInput').length,
		0,
	)
	assert.equal(mounts, 1)
	assert.equal(unmounts, 1)
	f.unmount()
})
