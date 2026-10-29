import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { builtInThemes } from '../core/theme'
import type { ThemeControlRowPolicy } from '../core/theme-layout'
import type { AdaptedPackageTheme } from '../core/theme-package-adapter'

import {
	controlFixture,
	controlNodes,
	measureControl,
	legacyControlPackage,
	type ControlNode,
} from './theme-control-fixture'

const policy: ThemeControlRowPolicy = {
	minTouchDp: 96,
	compactMinTouchDp: 72,
	narrowFallback: 'host-single-row',
}
function adapted(value = policy): AdaptedPackageTheme {
	return {
		theme: structuredClone(builtInThemes.modern),
		mode: 'light',
		retained: {
			buttonMinTouchDp: value.minTouchDp,
			controlRowLayout: { ...value },
			lyricTokens: { active: '#111111', inactive: '#444444' },
		},
		renderingResponsibilities: [
			'local-image-uris',
			'button-min-touch-dp',
			'lyric-tokens',
			'motion-duration-and-reduced-motion',
			'explicit-color-mode',
		],
	}
}
const component = (value: unknown) => value as ControlNode['type']
const noop = () => {}
function pressables(view: unknown) {
	return controlNodes(view).filter((node) => node.type === 'Pressable')
}
function style(f: ReturnType<typeof controlFixture>, node: ControlNode) {
	return f.flatten(
		typeof node.props.style === 'function'
			? node.props.style({ pressed: false })
			: node.props.style,
	)
}

void test('actual row renders no interactive controls before measured, uses real content width, and reports compact/fallback/reject/recovery', () => {
	const f = controlFixture(),
		ui = f.load('ui'),
		measured = f.load('theme-control-layout')
	const reports: string[] = [],
		clicks: number[] = []
	const children = Array.from({ length: 4 }, (_, index) =>
		f.element(component(ui.IconButton), {
			name: 'play',
			label: `nav${index}`,
			onPress: () => clicks.push(index),
		}),
	)
	const row = f.element(
		component(measured.MeasuredThemeControlRow),
		{
			policy,
			controlMinWidthsDp: [48, 48, 48, 48],
			navigation: true,
			style: { paddingHorizontal: 10 },
			onStatusChange: (state: { kind: string }) => reports.push(state.kind),
		},
		children,
	)
	const root = f.element(
		component(ui.PackageThemeProvider),
		{ adapted: adapted(), allowedImageUris: [], reducedMotion: false },
		row,
	)
	let tree = f.render(root)
	assert.equal(pressables(tree).length, 0)
	assert.equal(reports.at(-1), 'pending')
	measureControl(tree, 340)
	tree = f.render(root)
	assert.equal(pressables(tree).length, 4)
	assert.equal(style(f, pressables(tree)[0]).width, 72)
	;(pressables(tree)[1].props.onPress as () => void)()
	assert.deepEqual(clicks, [1])
	assert.equal(reports.at(-1), 'ready')
	measureControl(tree, 287)
	tree = f.render(root)
	assert.equal(style(f, pressables(tree)[0]).width, 48)
	measureControl(tree, 191)
	tree = f.render(root)
	assert.equal(pressables(tree).length, 0)
	assert.equal(reports.at(-1), 'rejected')
	measureControl(tree, 392)
	tree = f.render(root)
	assert.equal(style(f, pressables(tree)[0]).width, 96)
	assert.equal(reports.at(-1), 'ready')
})

void test('actual row invalidates on font/container revision, drops old A→B→A layout events and cannot write after unmount', () => {
	const f = controlFixture(),
		row = f.load('theme-control-layout').MeasuredThemeControlRow
	let revision = 'A'
	let activePolicy = { ...policy }
	const root = () =>
		f.element(
			component(row),
			{
				policy: activePolicy,
				controlMinWidthsDp: [48],
				layoutRevision: revision,
			},
			f.element('Pressable', { onPress: () => {} }),
		)
	let tree = f.render(root())
	const old = controlNodes(tree).find(
		(node) => typeof node.props.onLayout === 'function',
	)!.props.onLayout as (event: unknown) => void
	measureControl(tree, 200)
	assert.equal(pressables(f.render(root())).length, 1)
	f.viewport.fontScale = 2
	tree = f.render(root())
	assert.equal(pressables(tree).length, 0)
	old({ nativeEvent: { layout: { width: 200 } } })
	assert.equal(pressables(f.render(root())).length, 0)
	measureControl(tree, 160)
	assert.equal(pressables(f.render(root())).length, 1)
	revision = 'B'
	tree = f.render(root())
	assert.equal(pressables(tree).length, 0)
	revision = 'A'
	tree = f.render(root())
	old({ nativeEvent: { layout: { width: 200 } } })
	assert.equal(pressables(f.render(root())).length, 0)
	measureControl(tree, 160)
	tree = f.render(root())
	const late = controlNodes(tree).find(
		(node) => typeof node.props.onLayout === 'function',
	)!.props.onLayout as (event: unknown) => void
	activePolicy = { ...policy }
	tree = f.render(root())
	assert.equal(
		pressables(tree).length,
		0,
		'a new presentation needs fresh measurement even with identical numeric policy',
	)
	late({ nativeEvent: { layout: { width: 200 } } })
	assert.equal(pressables(f.render(root())).length, 0)
	measureControl(tree, 160)
	tree = f.render(root())
	const afterChange = controlNodes(tree).find(
		(node) => typeof node.props.onLayout === 'function',
	)!.props.onLayout as (event: unknown) => void
	f.unmount()
	afterChange({ nativeEvent: { layout: { width: 180 } } })
	assert.equal(f.writesAfterUnmount, 0)
})

void test('actual Button/IconButton keep builtin Pressable trees,48/68 sizes, labels and callbacks for all three defaults', () => {
	for (const theme of Object.values(builtInThemes)) {
		const f = controlFixture(),
			ui = f.load('ui'),
			clicks: string[] = []
		const root = f.element(component(ui.ThemeProvider), { value: theme }, [
			f.element(component(ui.IconButton), {
				name: 'play',
				label: '播放',
				onPress: () => clicks.push('play'),
			}),
			f.element(component(ui.IconButton), {
				name: 'play',
				label: '大播放',
				large: true,
				onPress: () => clicks.push('large'),
			}),
			f.element(
				component(ui.Button),
				{ onPress: () => clicks.push('button') },
				'确定',
			),
		])
		const tree = f.render(root),
			controls = pressables(tree)
		assert.equal(controls.length, 3)
		assert.equal(
			controlNodes(tree).some(
				(node) => typeof node.props.onLayout === 'function',
			),
			false,
		)
		assert.equal(style(f, controls[0]).width, 48)
		assert.equal(style(f, controls[1]).width, 68)
		assert.equal(style(f, controls[2]).minHeight, 48)
		assert.equal(style(f, controls[2]).minWidth, 48)
		for (const control of controls) (control.props.onPress as () => void)()
		assert.deepEqual(clicks, ['play', 'large', 'button'])
	}
})

void test('actual standalone controls wait for constrained measurement; old packages have no implicit permission; Button fills measured container', () => {
	const f = controlFixture(),
		ui = f.load('ui'),
		value = adapted({ minTouchDp: 96, narrowFallback: 'reject' })
	delete value.retained.controlRowLayout
	const root = f.element(
		component(ui.PackageThemeProvider),
		{ adapted: value, allowedImageUris: [], reducedMotion: true },
		f.element(component(ui.Button), { onPress: () => {} }, '确定'),
	)
	let tree = f.render(root)
	assert.equal(pressables(tree).length, 0)
	measureControl(tree, 80)
	assert.equal(pressables(f.render(root)).length, 0)
	measureControl(f.render(root), 200)
	tree = f.render(root)
	assert.equal(style(f, pressables(tree)[0]).minHeight, 96)
	assert.equal(style(f, pressables(tree)[0]).flexGrow, 1)
})

void test('real Verified+adapted legacy48 package uses original controls without measurement or recursive row wrappers', async () => {
	const f = controlFixture(),
		ui = f.load('ui'),
		progress = f.load('progress')
	const actual = await legacyControlPackage()
	let clicks = 0
	const root = f.element(
		component(ui.PackageThemeProvider),
		{ ...actual, reducedMotion: false },
		[
			f.element(component(ui.IconButton), {
				name: 'play',
				label: '旧主题播放',
				onPress: () => clicks++,
			}),
			f.element(component(ui.Button), { onPress: () => clicks++ }, '确定'),
			f.element(component(progress.Progress), {
				position: 30,
				duration: 100,
				onSeek: noop,
			}),
		],
	)
	const tree = f.render(root),
		controls = pressables(tree)
	assert.equal(controls.length, 2)
	assert.equal(
		controlNodes(tree).filter(
			(node) => typeof node.props.onLayout === 'function',
		).length,
		1,
		'only the original Progress onLayout remains',
	)
	assert.equal(style(f, controls[0]).width, 48)
	assert.equal(style(f, controls[1]).minHeight, 48)
	assert.equal(style(f, controls[1]).minWidth, 48)
	assert.equal(
		style(
			f,
			controlNodes(tree).find(
				(node) => node.props.accessibilityRole === 'adjustable',
			)!,
		).height,
		48,
	)
	for (const control of controls) (control.props.onPress as () => void)()
	assert.equal(clicks, 2)
})

void test('actual Progress keeps builtin track and seek; package measured width sets gesture ratio and control height without changing line or time', () => {
	for (const packaged of [false, true]) {
		const f = controlFixture(),
			ui = f.load('ui'),
			progress = f.load('progress'),
			seeks: number[] = []
		const control = f.element(component(progress.Progress), {
			position: 30,
			duration: 100,
			onSeek: (value: number) => seeks.push(value),
		})
		const root = packaged
			? f.element(
					component(ui.PackageThemeProvider),
					{ adapted: adapted(), allowedImageUris: [], reducedMotion: false },
					control,
				)
			: control
		let tree = f.render(root)
		if (packaged) {
			assert.equal(
				controlNodes(tree).some(
					(node) => node.props.accessibilityRole === 'adjustable',
				),
				false,
			)
			measureControl(tree, 200)
			tree = f.render(root)
		}
		let track = controlNodes(tree).find(
			(node) => node.props.accessibilityRole === 'adjustable',
		)!
		if (!packaged) {
			;(track.props.onLayout as (event: unknown) => void)({
				nativeEvent: { layout: { width: 200 } },
			})
			tree = f.render(root)
			track = controlNodes(tree).find(
				(node) => node.props.accessibilityRole === 'adjustable',
			)!
		}
		assert.equal(style(f, track).height, packaged ? 96 : 48)
		;(track.props.onResponderGrant as (event: unknown) => void)({
			nativeEvent: { pageX: 90, locationX: 50 },
		})
		;(track.props.onResponderRelease as (event: unknown) => void)({
			nativeEvent: { pageX: 90, locationX: 50 },
		})
		;(track.props.onAccessibilityAction as (event: unknown) => void)({
			nativeEvent: { actionName: 'increment' },
		})
		assert.deepEqual(seeks, [25, 45])
		assert.equal(
			controlNodes(tree).some((node) => style(f, node).height === 3),
			true,
		)
	}
})

void test('actual App mini/navigation retain callbacks and four ordered single-row destinations; no playback begins from navigation', () => {
	const f = controlFixture(),
		ui = f.load('ui')
	const source = ts.createSourceFile(
		'App.tsx',
		readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	const expressions: string[] = []
	function visit(node: ts.Node) {
		if (
			ts.isJsxSelfClosingElement(node) &&
			node.tagName.getText(source) === 'HostPlaybackFooter'
		)
			expressions.push(node.getText(source))
		ts.forEachChild(node, visit)
	}
	visit(source)
	assert.equal(expressions.length, 1)
	const events: string[] = []
	const close = (name: string) => ({
		session: {
			close: () => events.push(name),
			cancelPending: () => events.push(`${name}:cancel`),
		},
	})
	const scope = {
		React: { createElement: f.element },
		View: 'View',
		...ui,
		...f.load('host-controls'),
		player: {
			mode: 'listening',
			track: { title: '标题', artist: '上传者' },
			position: 10,
			duration: 100,
			playing: false,
			toggle: () => events.push('toggle'),
		},
		followingFeed: close('feed'),
		imports: close('imports'),
		biliImports: close('bili'),
		videoLibrary: close('videos'),
		recommendations: close('recommendations'),
		fm: close('fm'),
		setFullPlayer: () => events.push('open'),
		setSheet: () => events.push('queue'),
		profileSettingsOpen: false,
		setProfileSettingsOpen: () => {},
		setCollectionOrigin: () => {},
		setLibraryCollection: () => {},
		setTab: (tab: string) => events.push(tab),
		setListeningLibraryOpen: () => {},
		theme: builtInThemes.modern,
		c: builtInThemes.modern.tokens,
		tab: 'home',
		insets: { bottom: 0 },
		s: { row: { flexDirection: 'row', alignItems: 'center' } },
	}
	function expression() {
		const output: { value?: unknown } = {}
		runInNewContext(
			ts.transpileModule(`exports.value = (${expressions[0]})`, {
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					jsx: ts.JsxEmit.React,
				},
			}).outputText,
			{ ...scope, exports: output },
		)
		return output.value
	}
	const footer = f.render(expression())
	const miniControls = pressables(footer).slice(0, 3)
	assert.equal(miniControls.length, 3)
	;(miniControls[0].props.onPress as () => void)()
	;(miniControls[1].props.onPress as () => void)()
	;(miniControls[2].props.onPress as () => void)()
	assert.deepEqual(events, ['feed:cancel', 'open', 'toggle', 'queue'])
	events.length = 0
	const navControls = pressables(footer).slice(3)
	assert.deepEqual(
		navControls.map((item) => item.props.accessibilityLabel),
		['导航发现', '导航搜索', '导航音乐库', '导航我的'],
	)
	assert.equal(
		navControls.every((node) => style(f, node).minHeight === 54),
		true,
	)
	;(navControls[1].props.onPress as () => void)()
	assert.deepEqual(events, [
		'imports',
		'bili',
		'videos',
		'recommendations',
		'fm',
		'feed',
		'search',
	])
	assert.equal(events.includes('toggle'), false)
	const root = f.element(
		component(ui.PackageThemeProvider),
		{ adapted: adapted(), allowedImageUris: [], reducedMotion: false },
		expression(),
	)
	let tree = f.render(root)
	assert.equal(pressables(tree).length, 0)
	for (const row of controlNodes(tree).filter(
		(node) => typeof node.props.onLayout === 'function',
	)) {
		;(row.props.onLayout as (event: unknown) => void)({
			nativeEvent: { layout: { width: 340 } },
		})
	}
	tree = f.render(root)
	assert.equal(pressables(tree).length, 7)
	assert.equal(style(f, pressables(tree)[3]).minWidth, 72)
	assert.equal(
		controlNodes(tree).some((node) => style(f, node).flexWrap === 'wrap'),
		false,
	)
})

void test('actual music/listening player control rows use one scoped decision and preserve previous/next/toggle and±15 callbacks', () => {
	for (const mode of ['music', 'listening']) {
		const f = controlFixture(),
			ui = f.load('ui'),
			events: unknown[] = []
		const source = {
			id: 'source',
			cid: 22,
			bvid: 'BV1vT411i7ET',
			uploader: 'UP',
			originalTitle: '标题',
			duration: 100,
			artwork: 'https://example.invalid/art',
		}
		const player = {
			track: { id: 'B', title: 'B', duration: 100 },
			queue: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
			position: 30,
			duration: 100,
			toggle: () => events.push('toggle'),
			previous: () => events.push('previous'),
			next: () => events.push('next'),
		}
		const control =
			mode === 'music'
				? f.element(component(f.load('music-ui').MusicPlayer), {
						player,
						current: null,
						isLiked: () => false,
						busyBv: '',
						onLike: noop,
						onClose: noop,
						onTheme: noop,
						onSource: noop,
						onQueue: noop,
						onNotice: noop,
						onNotificationSettings: noop,
						notifications: true,
						bottomInset: 0,
						onFm: noop,
						fmMessage: '',
					})
				: f.element(component(f.load('listening-ui').ListeningPlayer), {
						source,
						parts: [{ source, page: 1, title: '第一P' }],
						partsLoading: false,
						partsError: '',
						position: 30,
						duration: 100,
						speed: 1,
						playing: false,
						buffering: false,
						switching: false,
						error: '',
						bottomInset: 0,
						reducedMotion: true,
						canReturnMusic: false,
						onClose: noop,
						onTheme: noop,
						onSource: noop,
						onCreator: noop,
						onSeek: (value: number) => events.push(value),
						onToggle: () => events.push('toggle'),
						onSpeed: noop,
						onPart: noop,
						onRetryParts: noop,
						onRetry: noop,
						onReturnMusic: noop,
						onCancel: noop,
					})
		const root = f.element(
			component(ui.PackageThemeProvider),
			{ adapted: adapted(), allowedImageUris: [], reducedMotion: false },
			control,
		)
		let tree = f.render(root)
		const row = controlNodes(tree).find(
			(node) =>
				String(node.key).includes('[48,48,68,48,48]') &&
				typeof node.props.onLayout === 'function',
		)
		assert.ok(row)
		;(row.props.onLayout as (event: unknown) => void)({
			nativeEvent: { layout: { width: 306 } },
		})
		tree = f.render(root)
		const labels =
			mode === 'music'
				? ['上一首', '继续播放', '下一首']
				: ['后退15秒', '继续收听', '前进15秒']
		for (const label of labels) {
			const item = pressables(tree).find(
				(node) => node.props.accessibilityLabel === label,
			)
			assert.ok(item)
			assert.equal(
				style(f, item).width ?? style(f, item).minWidth,
				label.startsWith('继续') ? 68 : 48,
			)
			;(item.props.onPress as () => void)()
		}
		assert.deepEqual(
			events,
			mode === 'music' ? ['previous', 'toggle', 'next'] : [15, 'toggle', 45],
		)
	}
})
