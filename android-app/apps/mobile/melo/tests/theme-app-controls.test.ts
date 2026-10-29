import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { readBaselineSource } from './baseline-source'

import { builtInThemes } from '../core/theme'

import {
	controlFixture,
	controlNodes,
	legacyControlPackage,
	measureControl,
	type ControlNode,
} from './theme-control-fixture'

const baseline = readBaselineSource('3599a2de:android-app/apps/mobile/melo/App.tsx')
const file = ts.createSourceFile(
	'App.tsx',
	baseline,
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TSX,
)
const elements: ts.JsxElement[] = []
let nativeSwitch!: ts.JsxSelfClosingElement
function visit(node: ts.Node) {
	if (ts.isJsxElement(node)) elements.push(node)
	if (
		ts.isJsxSelfClosingElement(node) &&
		node.tagName.getText(file) === 'Switch'
	)
		nativeSwitch = node
	ts.forEachChild(node, visit)
}
visit(file)
const label = (node: ts.JsxElement, text: string) =>
	node.openingElement.attributes.properties.some(
		(prop) =>
			ts.isJsxAttribute(prop) &&
			prop.name.getText(file) === 'accessibilityLabel' &&
			prop.initializer &&
			ts.isStringLiteral(prop.initializer) &&
			prop.initializer.text === text,
	)
const byLabel = (text: string) => elements.find((node) => label(node, text))!
const original = {
	HomeHeader: byLabel('打开主题工坊').parent,
	HomeSearchEntry: elements.find(
		(node) =>
			node.openingElement.tagName.getText(file) === 'Pressable' &&
			node.openingElement.attributes
				.getText(file)
				.includes("'搜索听视频或 BV 号'"),
	)!,
	HomeDiscoveryTabs: byLabel('发现音乐').parent,
	HomeMusicHero: byLabel('开始寻找真实音乐'),
	HomeLocalFeatures: byLabel('打开每日推荐').parent,
	ReducedMotionSetting: nativeSwitch.parent.parent,
	AppQueueItem: elements.find(
		(node) =>
			node.openingElement.tagName.getText(file) === 'Pressable' &&
			node.openingElement.attributes.getText(file).includes('key={item.id}'),
	)!,
}
const oldModule = `import React from 'react';import {View,Pressable,Switch,StyleSheet} from 'react-native';import {LinearGradient} from 'expo-linear-gradient';import {Artwork,Card,Icon,T,shape} from './ui';${Object.entries(
	original,
)
	.map(
		([name, node]) =>
			`export function ${name}(p){const {theme,player,item,index,reduced,library,setReduced,setNotice,setSheet,homeChannel,setHomeChannel,navigateSearch,openRecommendations,openFm,listening}=p;const c=theme.tokens,s={row:{flexDirection:'row',alignItems:'center'}};return (${node.getText(file)})}`,
	)
	.join('\n')}`
const component = (value: unknown) => value as ControlNode['type']
const findText = (tree: unknown, text: string) =>
	controlNodes(tree).find(
		(node) =>
			node.type === 'Text' && JSON.stringify(node.children).includes(text),
	)!
const noop = () => {}
const callback = () => Promise.resolve(true)
const queueItem = {
	id: 'entry-A3',
	title: '真实原标题A',
	artist: '原UP',
	artwork: undefined,
}
const props = {
	onThemes: noop,
	onPress: noop,
	onMusic: noop,
	onSearch: noop,
	onListening: noop,
	onRecommendations: noop,
	onFm: noop,
	channel: 'music',
	value: false,
	onValueChange: noop,
	index: 2,
	selected: true,
	label: '队列第3项 真实原标题A',
	title: queueItem.title,
	artist: queueItem.artist,
	artwork: queueItem.artwork,
	mode: 'music',
	player: { mode: 'music', track: queueItem, select: callback },
	item: queueItem,
	reduced: false,
	library: { setSetting: noop },
	setReduced: noop,
	setNotice: noop,
	setSheet: noop,
	homeChannel: 'music',
	setHomeChannel: noop,
	navigateSearch: noop,
	openRecommendations: noop,
	openFm: noop,
	listening: { parts: [] },
}
function fixture() {
	return controlFixture(
		{ 'old-app-controls': oldModule },
		{ 'expo-linear-gradient': { LinearGradient: 'LinearGradient' } },
	)
}
function normalize(f: ReturnType<typeof fixture>, value: unknown): unknown {
	if (Array.isArray(value))
		return Array.from(value, (item) => normalize(f, item))
	if (typeof value === 'function') return '<callback>'
	if (!value || typeof value !== 'object') return value
	if ('type' in value && 'props' in value) {
		const node = value as ControlNode,
			attrs = { ...node.props }
		delete attrs.children
		if (attrs.style)
			attrs.style = f.flatten(
				typeof attrs.style === 'function'
					? attrs.style({ pressed: false })
					: attrs.style,
			)
		return {
			type: node.type,
			props: normalize(f, attrs),
			children: normalize(f, node.children),
		}
	}
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => [key, normalize(f, item)]),
	)
}

void test('unchanged App controls preserve native trees/styles/labels for three defaults and real Verified legacy48 package', async () => {
	const legacy = await legacyControlPackage()
	let comparisons = 0
	for (const theme of [...Object.values(builtInThemes), legacy.adapted.theme]) {
		for (const name of [
			'HomeSearchEntry',
			'ReducedMotionSetting',
			'AppQueueItem',
		])
			for (const alternate of [false, true]) {
				const f = fixture(),
					ui = f.load('ui')
				const next = {
					...props,
					theme,
					channel: alternate ? 'listening' : 'music',
					homeChannel: alternate ? 'listening' : 'music',
					value: alternate,
					reduced: alternate,
					mode: alternate ? 'listening' : 'music',
					player: { ...props.player, mode: alternate ? 'listening' : 'music' },
					listening: {
						parts: alternate
							? [{ source: { id: queueItem.id }, title: '第三P' }]
							: [],
					},
					title: alternate ? '第三P' : queueItem.title,
					label: alternate ? '分 P 3 第三P' : props.label,
				}
				const draw = (module: string) => {
					const child = f.element(component(f.load(module)[name]), next)
					return f.render(
						theme === legacy.adapted.theme
							? f.element(
									component(ui.PackageThemeProvider),
									{ ...legacy, reducedMotion: false },
									child,
								)
							: f.element(component(ui.ThemeProvider), { value: theme }, child),
					)
				}
				const actual = normalize(f, draw('app-controls')),
					expected = normalize(f, draw('old-app-controls'))
				if (theme !== legacy.adapted.theme && name !== 'ReducedMotionSetting') {
					const before = expected as ControlNode,
						after = actual as ControlNode,
						style = before.props.style as Record<string, unknown>
					assert.equal(before.type, 'Pressable')
					assert.equal(style.minWidth, undefined)
					assert.equal(
						style.minHeight,
						name === 'HomeSearchEntry' ? 48 : undefined,
					)
					before.props.style = {
						...style,
						minWidth: name === 'HomeSearchEntry' ? 152 : 180,
						minHeight: 48,
					}
					assert.deepEqual(
						after.props.style,
						before.props.style,
						'exact builtin target bounds',
					)
				}
				if (name === 'ReducedMotionSetting') {
					(expected as ControlNode).props.style = { paddingVertical: 12 }
				}
				assert.deepEqual(actual, expected, `${theme.id}/${name}/${alternate}`)
				comparisons++
			}
	}
	assert.equal(comparisons, 24)
})

void test('actual tabs use constrained row measurements for regular, compact, fallback and rejection; callbacks preserve channel semantics', async () => {
	const legacy = await legacyControlPackage()
	for (const [policy, width, expected] of [
		[{ minTouchDp: 96, narrowFallback: 'reject' }, 240, 96],
		[
			{ minTouchDp: 96, compactMinTouchDp: 72, narrowFallback: 'reject' },
			170,
			72,
		],
		[{ minTouchDp: 96, narrowFallback: 'host-single-row' }, 160, 48],
		[{ minTouchDp: 96, narrowFallback: 'host-single-row' }, 140, null],
	] as const) {
		const f = fixture(),
			events: string[] = [],
			ui = f.load('ui')
		const root = f.element(
			component(ui.PackageThemeProvider),
			{
				...legacy,
				adapted: {
					...legacy.adapted,
					retained: {
						...legacy.adapted.retained,
						buttonMinTouchDp: 96,
						controlRowLayout: policy,
					},
				},
			},
			f.element(component(f.load('app-controls').HomeDiscoveryTabs), {
				channel: 'listening',
				onMusic: () => events.push('music'),
				onSearch: () => events.push('search'),
				onListening: () => events.push('listening'),
			}),
		)
		assert.equal(
			controlNodes(f.render(root)).filter((node) => node.type === 'Pressable')
				.length,
			0,
		)
		measureControl(f.render(root), width)
		const controls = controlNodes(f.render(root)).filter(
			(node) => node.type === 'Pressable',
		)
		if (expected === null) assert.equal(controls.length, 0)
		else {
			assert.equal(controls.length, 2)
			for (const control of controls) {
				const style = control.props.style as (state: unknown) => unknown
				assert.equal(f.flatten(style({ pressed: false })).minHeight, expected)
				;(control.props.onPress as () => void)()
			}
			assert.deepEqual(events, ['music', 'listening'])
			assert.equal(
				(controls[1].props.accessibilityState as { selected: boolean })
					.selected,
				true,
			)
		}
	}
})

void test('actual responsive header/search/hero/features/queue expose no actionable children before measurement and preserve callbacks after fit', async () => {
	const legacy = await legacyControlPackage()
	for (const name of [
		'HomeHeader',
		'HomeSearchEntry',
		'HomeMusicHero',
		'HomeLocalFeatures',
		'AppQueueItem',
	]) {
		const f = fixture(),
			ui = f.load('ui')
		let calls = 0
		const press = () => {
			calls++
		}
		const root = f.element(
			component(ui.PackageThemeProvider),
			{
				...legacy,
				adapted: {
					...legacy.adapted,
					retained: {
						...legacy.adapted.retained,
						buttonMinTouchDp: 96,
						controlRowLayout: { minTouchDp: 96, narrowFallback: 'reject' },
					},
				},
			},
			f.element(component(f.load('app-controls')[name]), {
				...props,
				onThemes: press,
				onPress: press,
				onRecommendations: press,
				onFm: press,
			}),
		)
		let tree = f.render(root)
		assert.equal(
			controlNodes(tree).filter((node) => node.type === 'Pressable').length,
			0,
			name,
		)
		const boundary = controlNodes(tree).filter(
			(node) => typeof node.props.onLayout === 'function',
		)
		assert.equal(boundary.length, 1, name)
		measureControl(tree, 40)
		tree = f.render(root)
		assert.equal(
			controlNodes(tree).filter((node) => node.type === 'Pressable').length,
			0,
			`${name} rejected width`,
		)
		measureControl(tree, 400)
		tree = f.render(root)
		const controls = controlNodes(tree).filter(
			(node) => node.type === 'Pressable',
		)
		assert.equal(controls.length, name === 'HomeLocalFeatures' ? 2 : 1)
		for (const control of controls) (control.props.onPress as () => void)()
		assert.equal(calls, controls.length)
		if (name === 'AppQueueItem')
			assert.equal(
				(controls[0].props.accessibilityState as { selected: boolean })
					.selected,
				true,
			)
	}
})

void test('actual expanded switch has one accessible role, checked/disabled state and exactly one value callback; native visual cannot trigger a second callback', async () => {
	const legacy = await legacyControlPackage()
	for (const disabled of [false, true]) {
		const f = fixture(),
			ui = f.load('ui'),
			values: boolean[] = []
		const root = f.element(
			component(ui.PackageThemeProvider),
			{
				...legacy,
				adapted: {
					...legacy.adapted,
					retained: {
						...legacy.adapted.retained,
						buttonMinTouchDp: 96,
						controlRowLayout: { minTouchDp: 96, narrowFallback: 'reject' },
					},
				},
			},
			f.element(component(f.load('app-controls').AppMotionSwitch), {
				value: true,
				disabled,
				accessibilityLabel: '减少动态效果',
				onValueChange: (value: boolean) => values.push(value),
			}),
		)
		assert.equal(
			controlNodes(f.render(root)).some(
				(node) => node.props.accessibilityRole === 'switch',
			),
			false,
		)
		measureControl(f.render(root), 96)
		const tree = f.render(root),
			switches = controlNodes(tree).filter(
				(node) => node.props.accessibilityRole === 'switch',
			)
		assert.equal(switches.length, 1)
		const outer = switches[0],
			visual = controlNodes(tree).find((node) => node.type === 'Switch')!
		assert.deepEqual(
			JSON.parse(JSON.stringify(outer.props.accessibilityState)),
			{
				checked: true,
				disabled,
			},
		)
		assert.equal(visual.props.accessible, false)
		assert.equal(visual.props.pointerEvents, 'none')
		assert.equal(visual.props.onValueChange, undefined)
		;(outer.props.onPress as () => void)()
		assert.deepEqual(values, disabled ? [] : [false])
	}
})

void test('actual App callback bindings keep settings failure handling and exact third A selection; failed queue selection keeps sheet open', async () => {
	const current = ts.createSourceFile(
		'App.tsx',
		readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	const expressions = new Map<string, string>()
	function collect(node: ts.Node) {
		if (
			ts.isJsxSelfClosingElement(node) &&
			['ReducedMotionSetting', 'AppQueueItem'].includes(
				node.tagName.getText(current),
			)
		) {
			for (const prop of node.attributes.properties)
				if (
					ts.isJsxAttribute(prop) &&
					prop.initializer &&
					ts.isJsxExpression(prop.initializer) &&
					prop.initializer.expression
				)
					expressions.set(
						`${node.tagName.getText(current)}.${prop.name.getText(current)}`,
						prop.initializer.expression.getText(current),
					)
		}
		ts.forEachChild(node, collect)
	}
	collect(current)
	const evaluate = (key: string, scope: Record<string, unknown>) => {
		assert.ok(expressions.has(key), `actual ${key} binding`)
		const output: Record<string, unknown> = {}
		runInNewContext(
			ts.transpileModule(`exports.value=(${expressions.get(key)})`, {
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					module: ts.ModuleKind.CommonJS,
				},
			}).outputText,
			{ exports: output, ...scope },
		)
		return output.value
	}
	for (const fail of [false, true]) {
		const values: boolean[] = [],
			notices: string[] = [],
			writes: unknown[][] = []
		const save = evaluate('ReducedMotionSetting.onValueChange', {
			library: {
				setSetting: (...args: unknown[]) => {
					if (fail) throw new Error('disk')
					writes.push(args)
				},
			},
			setReduced: (value: boolean) => values.push(value),
			setNotice: (value: string) => notices.push(value),
		}) as (value: boolean) => void
		save(true)
		assert.deepEqual(values, fail ? [] : [true])
		assert.deepEqual(notices, fail ? ['设置保存失败'] : [])
		assert.deepEqual(writes, fail ? [] : [['reducedMotion', 'true']])
	}
	const queue = [{ id: 'A1' }, { id: 'B2' }, { id: 'A3' }]
	for (const success of [false, true]) {
		const selected: number[] = [],
			sheets: unknown[] = []
		for (const [index, item] of queue.entries()) {
			const scope = {
				index,
				item,
				player: {
					track: queue[2],
					select: async (value: number) => {
						selected.push(value)
						return success
					},
				},
				setSheet: (value: unknown) => sheets.push(value),
			}
			assert.equal(evaluate('AppQueueItem.selected', scope), index === 2)
			;(evaluate('AppQueueItem.onPress', scope) as () => void)()
		}
		await Promise.resolve()
		assert.deepEqual(selected, [0, 1, 2])
		assert.deepEqual(sheets, success ? [null, null, null] : [])
	}
})

function homeNativeStyle(f: ReturnType<typeof fixture>, node: ControlNode) {
	return f.flatten(
		typeof node.props.style === 'function'
			? node.props.style({ pressed: false })
			: node.props.style,
	)
}
const homeTargets = (value: unknown) =>
	controlNodes(value).filter((node) => node.type === 'Pressable')
function homeTextColumn(tree: unknown, child: ControlNode) {
	const column = controlNodes(tree).find(
		(node) =>
			node.type === 'View' &&
			(node.children ?? []).flat(Infinity).includes(child),
	)
	assert.ok(column, 'text must have its own finite-width content column')
	return column
}

void test('fontScale2 current two discovery tabs retain measured regular/compact/host minima, natural height and stale-layout rejection', async () => {
	const legacy = await legacyControlPackage(),
		f = fixture(),
		ui = f.load('ui'),
		events: string[] = []
	f.viewport.fontScale = 2
	const root = f.element(
		component(ui.PackageThemeProvider),
		{
			...legacy,
			adapted: {
				...legacy.adapted,
				retained: {
					...legacy.adapted.retained,
					buttonMinTouchDp: 96,
					controlRowLayout: {
						minTouchDp: 96,
						compactMinTouchDp: 72,
						narrowFallback: 'host-single-row',
					},
				},
			},
		},
		f.element(component(f.load('app-controls').HomeDiscoveryTabs), {
			channel: 'music',
			onMusic: () => events.push('music'),
			onListening: () => events.push('listening'),
		}),
	)
	try {
		let tree = f.render(root)
		assert.equal(homeTargets(tree).length, 0)
		for (const [width, minima, touch] of [
			[316, [96, 96], 96],
			[170, [72, 72], 72],
			[160, [72, 60], 48],
		] as const) {
			measureControl(tree, width)
			tree = f.render(root)
			const targets = homeTargets(tree)
			assert.deepEqual(
				targets.map((target) => target.props.accessibilityLabel),
				['发现音乐', '发现听视频'],
			)
			for (const [index, target] of targets.entries()) {
				const style = homeNativeStyle(f, target)
				assert.equal(style.flex, 1, 'each tab shares finite row width')
				assert.equal(style.minWidth, minima[index])
				assert.equal(style.minHeight, touch)
				assert.equal(style.height, undefined)
				assert.equal(style.maxHeight, undefined)
				assert.equal(target.props.accessibilityRole, 'tab')
				assert.equal(
					(target.props.accessibilityState as { selected: boolean }).selected,
					index === 0,
				)
				const text = controlNodes(target).find((node) => node.type === 'Text')!
				assert.equal(text.props.numberOfLines, undefined)
				if (width === 316) (target.props.onPress as () => void)()
			}
		}
		assert.deepEqual(events, ['music', 'listening'])
		measureControl(tree, 140)
		tree = f.render(root)
		assert.equal(homeTargets(tree).length, 0)
		assert.match(JSON.stringify(tree), /主题控件暂不适合当前宽度/)
		const stale = tree
		f.viewport.fontScale = 1.5
		tree = f.render(root)
		assert.equal(homeTargets(tree).length, 0)
		measureControl(stale, 316)
		assert.equal(homeTargets(f.render(root)).length, 0)
		measureControl(tree, 316)
		tree = f.render(root)
		assert.equal(homeTargets(tree).length, 2)
		assert.deepEqual(
			events,
			['music', 'listening'],
			'layout never activates a tab',
		)
		f.unmount()
		measureControl(tree, 316)
		assert.equal(f.writesAfterUnmount, 0)
	} finally {
		f.unmount()
	}
})

void test('fontScale2 current compact search shortcut keeps a shrinkable text column, content-driven height and explicit search action', async () => {
	const legacy = await legacyControlPackage(),
		f = fixture(),
		ui = f.load('ui'),
		events: string[] = []
	f.viewport.fontScale = 2
	const root = f.element(
		component(ui.PackageThemeProvider),
		{
			...legacy,
			adapted: {
				...legacy.adapted,
				retained: {
					...legacy.adapted.retained,
					buttonMinTouchDp: 96,
					controlRowLayout: { minTouchDp: 96, narrowFallback: 'reject' },
				},
			},
		},
		f.element(component(f.load('app-controls').HomeMusicHero), {
			onPress: () => events.push('search'),
		}),
	)
	try {
		let tree = f.render(root)
		assert.equal(homeTargets(tree).length, 0)
		measureControl(tree, 179)
		tree = f.render(root)
		assert.equal(
			homeTargets(tree).length,
			0,
			'180dp host minimum is not clamped',
		)
		measureControl(tree, 316)
		tree = f.render(root)
		const targets = homeTargets(tree)
		assert.equal(targets.length, 1)
		const target = targets[0],
			style = homeNativeStyle(f, target),
			title = findText(target, '搜索音乐'),
			caption = findText(target, '搜索歌曲、歌手或 BV 号')
		assert.equal(target.props.accessibilityRole, 'button')
		assert.equal(target.props.accessibilityLabel, '搜索更多音乐')
		assert.equal(style.minWidth, 180)
		assert.equal(
			style.minHeight,
			96,
			'96dp package touch policy exceeds 72dp host floor',
		)
		assert.equal(style.height, undefined)
		assert.equal(style.maxHeight, undefined)
		assert.equal(style.flexDirection, 'row')
		const content = homeTextColumn(target, title)
		assert.equal(homeNativeStyle(f, content).flex, 1)
		assert.equal(homeNativeStyle(f, content).minWidth, 0)
		assert.equal(homeNativeStyle(f, content).height, undefined)
		assert.equal(homeNativeStyle(f, content).maxHeight, undefined)
		assert.ok((content.children ?? []).flat(Infinity).includes(caption))
		assert.equal(title.props.numberOfLines, undefined)
		assert.equal(caption.props.numberOfLines, undefined)
		assert.equal(homeNativeStyle(f, title).fontSize, 14)
		assert.equal(homeNativeStyle(f, caption).fontSize, 11)
		assert.doesNotMatch(
			JSON.stringify(target),
			/立即播放|把日子|找到喜欢的声音/,
		)
		assert.deepEqual(events, [], 'rendering and layout must not search or play')
		;(target.props.onPress as () => void)()
		assert.deepEqual(events, ['search'])
		const stale = tree
		f.viewport.width = 320
		tree = f.render(root)
		assert.equal(homeTargets(tree).length, 0)
		measureControl(stale, 316)
		assert.equal(homeTargets(f.render(root)).length, 0)
		measureControl(tree, 276)
		tree = f.render(root)
		assert.equal(homeTargets(tree).length, 1)
		assert.deepEqual(events, ['search'])
		f.unmount()
		measureControl(tree, 276)
		assert.equal(f.writesAfterUnmount, 0)
	} finally {
		f.unmount()
	}
})

void test('360dp fontScale2 current compatibility home preserves finite text allocation and natural height; font1 restores a fresh current tree', async () => {
	const legacy = await legacyControlPackage()
	for (const theme of [...Object.values(builtInThemes), legacy.adapted.theme]) {
		const events: string[] = []
		for (const name of [
			'HomeHeader',
			'HomeSearchEntry',
			'HomeDiscoveryTabs',
			'HomeMusicHero',
		] as const) {
			const f = fixture(),
				fresh = fixture()
			const draw = (port: ReturnType<typeof fixture>) => {
				const ui = port.load('ui'),
					child = port.element(component(port.load('app-controls')[name]), {
						...props,
						theme,
						onThemes: () => events.push('themes'),
						onPress: () => events.push('search'),
						onMusic: () => events.push('music'),
						onListening: () => events.push('listening'),
					})
				return port.render(
					theme === legacy.adapted.theme
						? port.element(
								component(ui.PackageThemeProvider),
								{ ...legacy, reducedMotion: false },
								child,
							)
						: port.element(
								component(ui.ThemeProvider),
								{ value: theme },
								child,
							),
				)
			}
			try {
				f.viewport.width = fresh.viewport.width = 360
				const initial = normalize(f, draw(f))
				f.viewport.fontScale = 2
				const tree = draw(f)
				if (name === 'HomeHeader') {
					const title = findText(tree, '发现音乐'),
						column = homeTextColumn(tree, title),
						workshop = homeTargets(tree)[0]
					assert.equal(homeNativeStyle(f, column).flex, 1)
					assert.equal(homeNativeStyle(f, column).minWidth, 0)
					assert.equal(homeNativeStyle(f, title).fontSize, 24)
					assert.equal(title.props.numberOfLines, undefined)
					assert.equal(homeTargets(tree).length, 1)
					assert.equal(workshop.props.accessibilityLabel, '打开主题工坊')
					assert.equal(homeNativeStyle(f, workshop).width, 48)
					assert.equal(homeNativeStyle(f, workshop).height, 48)
				} else if (name === 'HomeSearchEntry') {
					const caption = findText(tree, '搜索歌曲'),
						target = homeTargets(tree)[0]
					assert.equal(homeNativeStyle(f, caption).flex, 1)
					assert.equal(homeNativeStyle(f, caption).minWidth, 0)
					assert.equal(caption.props.numberOfLines, undefined)
					assert.equal(homeTargets(tree).length, 1)
					assert.equal(target.props.accessibilityLabel, '搜索歌曲或 BV 号')
					assert.equal(homeNativeStyle(f, target).height, undefined)
					assert.equal(homeNativeStyle(f, target).maxHeight, undefined)
				} else if (name === 'HomeDiscoveryTabs') {
					const row = controlNodes(tree).find((node) => node.type === 'View')!,
						tabs = homeTargets(tree)
					assert.equal(homeNativeStyle(f, row).flexDirection, 'row')
					assert.equal(homeNativeStyle(f, row).flexWrap, undefined)
					assert.deepEqual(
						tabs.map((tab) => tab.props.accessibilityLabel),
						['发现音乐', '发现听视频'],
					)
					for (const [index, tab] of tabs.entries()) {
						assert.equal(homeNativeStyle(f, tab).flex, 1)
						assert.equal(homeNativeStyle(f, tab).minHeight, 48)
						assert.equal(homeNativeStyle(f, tab).height, undefined)
						assert.equal(homeNativeStyle(f, tab).maxHeight, undefined)
						assert.equal(tab.props.accessibilityRole, 'tab')
						assert.equal(
							(tab.props.accessibilityState as { selected: boolean }).selected,
							index === 0,
						)
						assert.equal(
							controlNodes(tab).find((node) => node.type === 'Text')!.props
								.numberOfLines,
							undefined,
						)
					}
				} else {
					const target = homeTargets(tree)[0],
						title = findText(tree, '搜索音乐'),
						caption = findText(tree, '搜索歌曲、歌手或 BV 号'),
						content = homeTextColumn(tree, title)
					assert.equal(homeTargets(tree).length, 1)
					assert.equal(target.props.accessibilityLabel, '搜索更多音乐')
					assert.equal(homeNativeStyle(f, target).height, undefined)
					assert.equal(homeNativeStyle(f, target).maxHeight, undefined)
					assert.equal(homeNativeStyle(f, target).minHeight, 72)
					assert.equal(homeNativeStyle(f, content).flex, 1)
					assert.equal(homeNativeStyle(f, content).minWidth, 0)
					assert.equal(homeNativeStyle(f, content).height, undefined)
					assert.equal(homeNativeStyle(f, content).maxHeight, undefined)
					assert.ok((content.children ?? []).flat(Infinity).includes(caption))
					assert.equal(title.props.numberOfLines, undefined)
					assert.equal(caption.props.numberOfLines, undefined)
					assert.equal(homeNativeStyle(f, title).fontSize, 14)
					assert.equal(homeNativeStyle(f, caption).fontSize, 11)
				}
				for (const target of homeTargets(tree))
					(target.props.onPress as () => void)()
				f.viewport.fontScale = 1
				const restored = normalize(f, draw(f))
				assert.deepEqual(
					restored,
					initial,
					`${theme.id}/${name}: scale round trip`,
				)
				assert.deepEqual(
					restored,
					normalize(fresh, draw(fresh)),
					`${theme.id}/${name}: matches a fresh current font1 component, not the removed design`,
				)
			} finally {
				f.unmount()
				fresh.unmount()
			}
		}
		assert.deepEqual(events, [
			'themes',
			'search',
			'music',
			'listening',
			'search',
		])
	}
})
