import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'
import {
	component,
	controls,
	flat,
	importHost,
	label,
	measure,
	measurements,
	packageTheme,
	playlistState,
	press,
	responsive,
	settle,
	video,
} from './theme-import-fixture'

function editing(selected = true) {
	return playlistState({
		detail: {
			id: 'p',
			name: '本地歌单',
			description: '',
			coverUri: null,
			createdAt: 1,
			updatedAt: 1,
			items: video.parts.map((part, index) => ({
				itemId: `i${index}`,
				playlistId: 'p',
				sourceId: part.source.id,
				position: index,
				addedAt: 1,
				importOrigin: null,
				review: null,
			})),
		},
		sources: new Map(video.parts.map((part) => [part.source.id, part.source])),
		editing: true,
		selectedItemIds: selected ? ['i1'] : [],
	})
}
type Fixture = ReturnType<typeof controlFixture>
function style(f: Fixture, node: ControlNode) {
	return f.flatten(
		typeof node.props.style === 'function'
			? node.props.style({ pressed: false })
			: node.props.style,
	)
}
function rows(tree: unknown) {
	return controlNodes(tree).filter(
		(node) =>
			typeof node.props.onLayout === 'function' &&
			String(node.key).includes('['),
	)
}
function packaged(f: Fixture, child: unknown) {
	return f.element(
		component(f.load('ui').PackageThemeProvider),
		{ adapted: packageTheme(), allowedImageUris: [], reducedMotion: true },
		child,
	)
}
function target(tree: unknown, name: string) {
	const found = controlNodes(tree).find(
		(node) =>
			node.type === 'Pressable' && node.props.accessibilityLabel === name,
	)
	assert.ok(found, name)
	return found
}
function fit(f: Fixture, value: unknown, width = 400) {
	let tree = f.render(value)
	for (let i = 0; i < 3; i++) {
		for (const row of rows(tree)) measure(row, width)
		tree = f.render(value)
	}
	return tree
}

void test('font2 actual playlist fixed text actions retain resolved width without a fixed height in regular/compact/host rows', () => {
	const h = importHost()
	h.viewport.fontScale = 2
	const page = responsive(h, 'PlaylistDetailPage', editing())
	let tree = settle(h, page)
	// Selection now has three explicit actions, including clearing hidden picks.
	// Keep the same per-target floor; only the required parent budget changes.
	const selectionRow = measurements(tree).find((node) =>
		String(node.key).includes('[48,48,48]'),
	)
	assert.ok(selectionRow)
	const selectionActions = [
		'全选歌单全部条目',
		'清空歌单条目选择',
		'移除所选1项',
	]
	for (const [width, touch] of [
		[288, 96],
		[216, 72],
		[144, 48],
	] as const) {
		measure(selectionRow, width)
		tree = h.render(page)
		for (const name of selectionActions) {
			const action = label(tree, name)
			assert.equal(
				flat(h, action).height,
				undefined,
				`${name}: text action must grow naturally`,
			)
			assert.equal(flat(h, action).width, touch, name)
			assert.equal(flat(h, action).minHeight, touch, name)
		}
	}
	press(tree, '全选歌单全部条目')
	press(tree, '清空歌单条目选择')
	press(tree, '移除所选1项')
	assert.ok(!h.calls.some(call => call[0] === 'removeSelected'))
	press(settle(h, page), '移除')
	assert.deepEqual(h.calls.slice(-3), [
		['selectAll'],
		['clearSelection'],
		['removeSelected'],
	])
	measure(selectionRow, 143)
	tree = h.render(page)
	for (const name of selectionActions)
		assert.equal(
			controls(tree).some((node) => node.props.accessibilityLabel === name),
			false,
			`${name}: all three targets reject a parent narrower than their combined 48dp floors`,
		)
	tree = settle(h, page)
	for (const name of [
		'歌单更多操作',
		'完成歌单管理',
		'上移歌单第2项',
		'下移歌单第1项',
	]) {
		const action = label(tree, name)
		assert.equal(flat(h, action).height, undefined)
		assert.equal(flat(h, action).width, 96)
	}
	press(tree, '上移歌单第2项')
	press(tree, '下移歌单第1项')
	assert.deepEqual(h.calls.slice(-2), [
		['move', 'i1', -1],
		['move', 'i0', 1],
	])
	tree = settle(h, responsive(h, 'PlaylistDetailPage', editing(false)))
	assert.equal(label(tree, '移除所选0项').props.disabled, true)
	assert.equal(label(tree, '上移歌单第1项').props.disabled, true)
	const library = settle(
		h,
		responsive(h, 'PlaylistLibrarySection', playlistState()),
	)
	assert.equal(flat(h, label(library, '新建本地歌单')).height, undefined)
	press(library, '新建本地歌单')
	assert.deepEqual(h.calls.at(-1), ['requestName', 'create'])
	h.unmount()
})

void test('font2 actual SongRow fallback and more keep parent width but no fixed text height, with unchanged callback/disabled', () => {
	for (const more of [false, true]) {
		const f = controlFixture()
		f.viewport.fontScale = 2
		const calls: string[] = []
		const props = {
			item: video.parts[0].source,
			liked: false,
			busy: false,
			active: false,
			listeningResult: false,
			onPlay: () => calls.push('play'),
			onLike: () => calls.push('like'),
			onListen: () => calls.push('listen'),
			...(more ? { onMore: () => calls.push('more') } : {}),
		}
		const value = packaged(
			f,
			f.element(component(f.load('music-ui').SongRow), props),
		)
		let tree = f.render(value)
		assert.equal(
			controlNodes(tree).filter((node) => node.type === 'Pressable').length,
			0,
		)
		const row = rows(tree)[0]
		for (const [width, touch] of [
			[240, 96],
			[200, 72],
			[174, 48],
		] as const) {
			measure(row, width)
			tree = f.render(value)
			const action = target(
				tree,
				`${more ? '更多音源操作' : '以听视频开启'} ${props.item.originalTitle}`,
			)
			assert.equal(style(f, action).height, undefined)
			assert.equal(style(f, action).width, touch)
			assert.equal(style(f, action).minHeight, touch)
			assert.equal(
				style(f, target(tree, `喜欢 ${props.item.originalTitle}`)).height,
				touch,
				'icon stays fixed',
			)
		}
		;(
			target(
				tree,
				`${more ? '更多音源操作' : '以听视频开启'} ${props.item.originalTitle}`,
			).props.onPress as () => void
		)()
		assert.deepEqual(calls, [more ? 'more' : 'listen'])
		const busy = packaged(
			f,
			f.element(component(f.load('music-ui').SongRow), {
				...props,
				busy: true,
			}),
		)
		tree = fit(f, busy)
		assert.equal(
			target(
				tree,
				`${more ? '更多音源操作' : '以听视频开启'} ${props.item.originalTitle}`,
			).props.disabled,
			true,
		)
		f.unmount()
	}
})

void test('font2 actual listening speed has a decided finite width in the shared five-control row without locking text height', () => {
	const f = controlFixture()
	f.viewport.fontScale = 2
	let clicks = 0
	const props = {
		speed: 0.75,
		playing: false,
		switching: false,
		onSpeed: () => clicks++,
		onBackward() {},
		onToggle() {},
		onForward() {},
		onParts() {},
	}
	const value = packaged(
		f,
		f.element(
			component(f.load('host-controls').ListeningTransportControls),
			props,
		),
	)
	let tree = f.render(value)
	assert.equal(
		controlNodes(tree).filter((node) => node.type === 'Pressable').length,
		0,
	)
	const row = rows(tree)[0]
	for (const [width, touch] of [
		[480, 96],
		[360, 72],
		[260, 48],
	] as const) {
		measure(row, width)
		tree = f.render(value)
		const speed = target(tree, '收听倍速 0.75 倍')
		assert.equal(
			style(f, speed).width,
			touch,
			'large speed text cannot request more row width',
		)
		assert.equal(style(f, speed).height, undefined)
		assert.equal(style(f, speed).minHeight, touch)
	}
	;(target(tree, '收听倍速 0.75 倍').props.onPress as () => void)()
	assert.equal(clicks, 1)
	measure(row, 259)
	tree = f.render(value)
	assert.equal(
		controlNodes(tree).filter((node) => node.type === 'Pressable').length,
		0,
	)
	tree = fit(
		f,
		packaged(
			f,
			f.element(component(f.load('host-controls').ListeningTransportControls), {
				...props,
				switching: true,
			}),
		),
	)
	assert.equal(target(tree, '收听倍速 0.75 倍').props.disabled, true)
	f.unmount()
})

void test('actual shared fixedWidth is stripped for legacy, measures its own finite standalone shell, and respects inherited width/minHeight with fixed precedence', () => {
	const f = controlFixture(),
		ui = f.load('ui')
	const props = {
		fixedWidth: true,
		accessibilityLabel: '文字目标',
		minimumWidthDp: 80,
		minimumHeightDp: 60,
		onPress() {},
		style: { padding: 12 },
	}
	let tree = f.render(f.element(component(ui.ControlTarget), props, '多行文字'))
	assert.equal(controlNodes(tree).length, 1)
	assert.equal((tree as ControlNode).type, 'Pressable')
	assert.equal((tree as ControlNode).props.fixedWidth, undefined)
	const standalone = packaged(
		f,
		f.element(component(ui.ControlTarget), props, '多行文字'),
	)
	tree = f.render(standalone)
	assert.equal(
		controlNodes(tree).filter((node) => node.type === 'Pressable').length,
		0,
	)
	assert.ok(
		controlNodes(tree).some(
			(node) =>
				node.type === 'View' &&
				style(f, node).width === 96 &&
				style(f, node).maxWidth === '100%',
		),
		'pending standalone has parent-allocated width',
	)
	measure(rows(tree)[0], 79)
	tree = f.render(standalone)
	assert.equal(
		controlNodes(tree).filter((node) => node.type === 'Pressable').length,
		0,
	)
	measure(rows(tree)[0], 80)
	tree = f.render(standalone)
	assert.equal(style(f, target(tree, '文字目标')).width, 80)
	assert.equal(style(f, target(tree, '文字目标')).minHeight, 72)
	assert.equal(style(f, target(tree, '文字目标')).height, undefined)
	const inherited = packaged(
		f,
		f.element(
			component(ui.ControlRow),
			{
				controlMinWidthsDp: [80, 48],
				gapDp: 8,
				style: { flexDirection: 'row' },
			},
			[
				f.element(
					component(ui.ControlTarget),
					{ ...props, key: 'text' },
					'多行文字',
				),
				f.element(
					component(ui.ControlTarget),
					{
						key: 'icon',
						fixed: true,
						fixedWidth: true,
						accessibilityLabel: '固定图标',
						onPress() {},
					},
					'图标',
				),
			],
		),
	)
	tree = f.render(inherited)
	const row = rows(tree)[0]
	for (const [width, touch] of [
		[200, 96],
		[160, 72],
		[136, 48],
	] as const) {
		measure(row, width)
		tree = f.render(inherited)
		assert.equal(style(f, target(tree, '文字目标')).width, Math.max(80, touch))
		assert.equal(
			style(f, target(tree, '文字目标')).minHeight,
			Math.max(60, touch),
		)
		assert.equal(style(f, target(tree, '文字目标')).height, undefined)
		assert.equal(style(f, target(tree, '固定图标')).height, touch)
	}
	f.unmount()
})
