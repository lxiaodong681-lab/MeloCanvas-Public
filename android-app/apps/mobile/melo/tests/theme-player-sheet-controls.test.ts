import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readBaselineSource } from './baseline-source'

import { builtInThemes } from '../core/theme'
import type { AdaptedPackageTheme } from '../core/theme-package-adapter'

import { approvedRedesignCopy } from './redesign-copy'
import {
	controlFixture,
	controlNodes,
	legacyControlPackage,
	type ControlNode,
} from './theme-control-fixture'

const baseline = '0c2527fe538f28e929eaaae2794c5fb47d8ca506'
const names = ['music-ui', 'listening-ui', 'theme-workshop'] as const
const component = (value: unknown) => value as ControlNode['type']
const noop = () => {}
const source = {
	id: 'bilibili:BV1234567890:10',
	bvid: 'BV1234567890',
	cid: 10,
	originalTitle: '真实原标题',
	uploader: '真实 UP',
	uploaderId: 123,
	performer: null,
	artwork: '',
	duration: 120,
	domain: 'music',
	audioAvailability: 'unknown',
}
const parts = [
	{ source, page: 1, title: '第一分 P' },
	{
		source: { ...source, id: 'bilibili:BV1234567890:20', cid: 20 },
		page: 2,
		title: '第二分 P',
	},
]
type Fixture = ReturnType<typeof controlFixture>
type Spec = {
	file: (typeof names)[number]
	name: string
	props: Record<string, unknown>
	open?: string
}
function props(events: unknown[] = []) {
	return {
		music: {
			player: {
				track: {
					id: 'entry',
					sourceId: source.id,
					title: source.originalTitle,
					duration: 120,
				},
				queue: [{ id: 'entry' }],
				position: 20,
				duration: 120,
				playing: false,
				buffering: false,
				error: '',
				fmContext: null,
				previous: noop,
				next: noop,
				toggle: noop,
				seek: noop,
			},
			current: source,
			isLiked: () => false,
			busyBv: '',
			onLike: noop,
			onClose: noop,
			onTheme: noop,
			onSource: () => events.push('source'),
			onQueue: noop,
			onNotice: noop,
			onNotificationSettings: noop,
			notifications: true,
			bottomInset: 0,
			onFm: noop,
			fmMessage: '',
		},
		row: {
			item: source,
			liked: true,
			busy: false,
			active: true,
			onPlay: () => events.push('play'),
			onLike: () => events.push('like'),
			onListen: () => events.push('listen'),
			onMore: () => events.push('more'),
			listeningResult: false,
		},
		listening: {
			source,
			parts,
			partsLoading: false,
			partsError: '',
			position: 20,
			duration: 120,
			speed: 1,
			playing: false,
			buffering: false,
			switching: false,
			error: '',
			bottomInset: 0,
			reducedMotion: true,
			canReturnMusic: true,
			onClose: noop,
			onTheme: noop,
			onSource: () => events.push('source'),
			onCreator: () => events.push('creator'),
			onSeek: noop,
			onToggle: noop,
			onSpeed: (value: number) => events.push(value),
			onPart: (value: unknown) => events.push(value),
			onRetryParts: () => events.push('retry-parts'),
			onRetry: noop,
			onReturnMusic: () => events.push('return'),
			onCancel: () => events.push('cancel'),
		},
		resume: {
			items: [
				{
					source,
					point: {
						sourceId: source.id,
						completed: false,
						positionSeconds: 20,
						durationSeconds: 120,
						updatedAt: 1,
					},
					part: { page: 1, title: '第一分 P' },
				},
			],
			busy: false,
			error: '',
			onPlay: (value: unknown) => events.push(value),
		},
		workshop: {
			themeKey: 'modern',
			mode: 'music',
			disabled: false,
			onSelect: (key: string) => events.push(key),
		},
	}
}

void test('both player pages lock native scrolling throughout diagonal seeking and unlock after release or cancellation', () => {
	for (const kind of ['music', 'listening'] as const) {
		const f = controlFixture(), p = props(), seeks: number[] = [], native: unknown[] = []
		const seek = (value: number) => { seeks.push(value) }
		const playerProps = kind === 'music' ? { ...p.music, player: { ...p.music.player, seek } } : { ...p.listening, onSeek: seek }
		const page = f.element(f.load('ui').ThemeProvider as ControlNode['type'], { value: builtInThemes.modern },
			f.element(f.load(kind === 'music' ? 'music-ui' : 'listening-ui')[kind === 'music' ? 'MusicPlayer' : 'ListeningPlayer'] as ControlNode['type'], playerProps))
		const draw = () => f.render(page)
		const scroll = () => controlNodes(draw()).find(n => n.props.testID === (kind === 'music' ? 'player-page' : 'listening-player-page'))!
		;(scroll().props.ref as { current: unknown }).current = { setNativeProps: (value: unknown) => native.push(value) }
		const progress = () => controlNodes(draw()).find(n => n.props.accessibilityRole === 'adjustable')!
		;(progress().props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 200 } } })
		const event = (name: string, x: number, y: number) => (progress().props[name] as (e: unknown) => void)({ nativeEvent: { pageX: x + 40, locationX: x, pageY: y } })
		for (const finish of ['onResponderRelease', 'onResponderTerminate']) {
			event('onResponderGrant', 20, 200)
			assert.equal((native.at(-1) as { scrollEnabled: boolean }).scrollEnabled, false)
			assert.equal(scroll().props.scrollEnabled, false)
			event('onResponderMove', 150, 400)
			assert.equal(scroll().props.scrollEnabled, false)
			assert.equal((progress().props.accessibilityValue as { now: number }).now, 90)
			event(finish, 150, 500)
			assert.equal((native.at(-1) as { scrollEnabled: boolean }).scrollEnabled, true)
			assert.equal(scroll().props.scrollEnabled, true)
		}
		assert.deepEqual(seeks, [90])
		event('onResponderGrant', 20, 200)
		f.unmount()
		assert.equal(f.writesAfterUnmount, 0)
	}
})
function text(value: unknown): string {
	if (Array.isArray(value)) return value.map(text).join('')
	if (value && typeof value === 'object' && 'children' in value)
		return text((value as ControlNode).children)
	return typeof value === 'string' || typeof value === 'number'
		? String(value)
		: ''
}
function controls(tree: unknown) {
	return controlNodes(tree).filter((node) => node.type === 'Pressable')
}
function label(tree: unknown, name: string) {
	const found = controls(tree).find(
		(node) => (node.props.accessibilityLabel ?? text(node.children)) === name,
	)
	assert.ok(found, name)
	return found
}
function press(tree: unknown, name: string) {
	;(label(tree, name).props.onPress as () => void)()
}
function flat(f: Fixture, node: ControlNode) {
	const value = node.props.style
	return f.flatten(
		typeof value === 'function'
			? (value as (state: unknown) => unknown)({ pressed: false })
			: value,
	)
}
const chapterAddition = Symbol('chapter addition')
function normalize(f: Fixture, value: unknown, chaptersAdded = false): unknown {
	if (Array.isArray(value)) {
		const values = Array.from(value, (v) => normalize(f, v, chaptersAdded))
		return chaptersAdded
			? values.filter((v) => v !== chapterAddition && v !== false && v !== null)
			: values
	}
	if (typeof value === 'function') return '<callback>'
	if (!value || typeof value !== 'object') return value
	if ('type' in value) {
		const node = value as ControlNode
		// This feature deliberately replaces the duplicate parts entry and adds
		// chapters/parts tabs. Keep comparing every other historical native node.
		if (
			chaptersAdded &&
			(node.props.testID === 'listening-chapters-entry' ||
				node.props.testID === 'listening-sleep-entry' ||
				node.props.testID === 'listening-chapters-tabs' ||
				(node.type === 'View' &&
					flat(f, node).marginTop === 12 &&
					/^分 P 列表(?: · \d+)?$/.test(text(node))))
		)
			return chapterAddition
		return {
			type: node.type,
			props: normalize(
				f,
				Object.fromEntries(
					Object.entries(node.props)
						.filter(([k, v]) => k !== 'children' && v !== undefined)
						.map(([k, v]) => [k, k === 'style' ? flat(f, node) : v]),
				),
			),
			children: normalize(f, node.children, chaptersAdded),
		}
	}
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => [k, normalize(f, v)]),
	)
}
function adapted(): AdaptedPackageTheme {
	return {
		theme: structuredClone(builtInThemes.modern),
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
	}
}
function element(f: Fixture, spec: Spec) {
	return f.element(component(f.load(spec.file)[spec.name]), spec.props)
}
function root(f: Fixture, spec: Spec, value = adapted()) {
	return f.element(
		component(f.load('ui').PackageThemeProvider),
		{ adapted: value, allowedImageUris: [], reducedMotion: true },
		element(f, spec),
	)
}
function measurements(tree: unknown) {
	return controlNodes(tree).filter(
		(node) =>
			typeof node.props.onLayout === 'function' &&
			String(node.key).includes('['),
	)
}
function measure(node: ControlNode, width: number) {
	;(node.props.onLayout as (event: unknown) => void)({
		nativeEvent: { layout: { width } },
	})
}
function settle(f: Fixture, value: unknown, width = 400) {
	let tree = f.render(value)
	for (let i = 0; i < 3; i++) {
		for (const row of measurements(tree)) measure(row, width)
		tree = f.render(value)
	}
	return tree
}

// MusicPlayer changed its product contract after 0c2527f: PR52 moved
// secondary actions to overflow, PR55 restored builtin decoration, PR57 added
// local lyrics. Other scenarios retain whole-tree comparisons after the named
// builtin controls receive their now-enforced touch minima and the explicit
// stage3 listening header/source-row/copy migration below.
// Keep the normalizer unchanged; compare the unchanged native subtrees directly.
function playerNode(value: unknown): ControlNode {
	assert.ok(value && typeof value === 'object' && 'type' in value)
	return value as ControlNode
}
function playerChild(value: unknown): ControlNode {
	const node = playerNode(value)
	assert.equal(node.children?.length, 1)
	return playerNode(node.children?.[0])
}
function playerChildRow(value: unknown): unknown[] {
	const node = playerNode(value)
	assert.equal(node.children?.length, 1)
	const row = node.children?.[0]
	assert.ok(Array.isArray(row))
	return row
}
function expectBuiltinTouchTarget(
	actual: unknown,
	expected: unknown,
	name: string,
	width: number,
	height: number,
	oldHeight: number | undefined,
) {
	const before = label(expected, name),
		after = label(actual, name),
		style = before.props.style as Record<string, unknown>
	assert.equal(style.minWidth, undefined, `${name}: historical width`)
	assert.equal(style.minHeight, oldHeight, `${name}: historical height`)
	const next = {
		...style,
		minWidth: width,
		minHeight: height,
		...(before.props.disabled && style.opacity === undefined
			? { opacity: 0.4 }
			: {}),
	}
	assert.deepEqual(after.props.style, next, `${name}: exact builtin bounds`)
	before.props.style = next
}
function expectBuiltinScenarioTouchDelta(
	spec: Spec,
	actual: unknown,
	expected: unknown,
) {
	const target = (
		name: string,
		width: number,
		height: number,
		oldHeight: number | undefined = height,
	) =>
		expectBuiltinTouchTarget(actual, expected, name, width, height, oldHeight)
	if (spec.name === 'SongRow') {
		const listening = !!spec.props.listeningResult
		target(
			`${listening ? '收听' : '播放'} ${source.originalTitle}`,
			listening ? 164 : 116,
			62,
		)
		if (!listening && spec.props.busy && !spec.props.onMore) {
			const name = `以听视频开启 ${source.originalTitle}`,
				before = label(expected, name),
				after = label(actual, name),
				style = before.props.style as Record<string, unknown>
			assert.equal(style.opacity, undefined)
			assert.equal(before.props.disabled, true)
			before.props.style = { ...style, opacity: 0.4 }
			assert.deepEqual(after.props.style, before.props.style)
		}
	} else if (spec.name === 'ListeningResumeList') {
		target(`继续收听 ${source.originalTitle} P1 第一分 P`, 164, 88)
	} else if (spec.name === 'ListeningPlayer') {
		target(`查看 UP 主 ${source.uploader}`, 48, 48)
		target('查看听视频音源信息', 68, 48)
		target('打开真实分 P 列表', 74, 58)
		if (spec.open === '收听倍速 1 倍') {
			for (const speed of [0.75, 1, 1.25, 1.5, 2])
				target(`设置收听倍速 ${speed} 倍`, speed === 1 ? 70 : 48, 54)
		} else {
			for (const [index, part] of (spec.props.parts as typeof parts).entries())
				target(
					`播放分 P ${part.page} ${part.title}`,
					index === 0 ? 142 : 108,
					64,
				)
		}
	} else if (spec.name === 'ThemeWorkshop') {
		for (const [index, name] of ['现代', '田园', '动漫'].entries())
			expectBuiltinTouchTarget(
				actual,
				expected,
				`应用${name}主题`,
				index === 0 ? 197 : 161,
				99,
				undefined,
			)
	}
}
function playerRegion(tree: unknown, testID: string) {
	const found = controlNodes(tree).filter((n) => n.props.testID === testID)
	assert.equal(found.length, 1, testID)
	return found[0]
}
function expectListeningPlayerPolish(
	actual: unknown,
	expected: unknown,
	theme: (typeof builtInThemes)[keyof typeof builtInThemes] | null,
	switching: boolean,
) {
	const before = playerChildRow(
			playerRegion(expected, 'listening-player-page'),
		),
		now = playerChildRow(playerRegion(actual, 'listening-player-page')),
		offset = 0,
		oldHeading = playerNode(playerChildRow(before[0])[1]),
		heading = playerNode(playerChildRow(now[offset])[1]),
		oldHeadingTexts = controlNodes(oldHeading).filter((n) => n.type === 'Text')
	assert.deepEqual(
		oldHeadingTexts.map((n) => n.children),
		[['NOW LISTENING'], ['音绘 · 听视频']],
	)
	assert.deepEqual(heading.props, oldHeading.props)
	const muted = (oldHeadingTexts[0].props.style as Record<string, unknown>)
			.color,
		newHeading: Omit<ControlNode, 'key'> = {
			type: 'Text',
			props: { style: { color: muted, fontSize: 13, lineHeight: 13 * 1.45 } },
			children: ['正在收听'],
		}
	assert.deepEqual(heading.children, [newHeading])
	oldHeading.children = [newHeading]
	const title = playerNode(before[2])
	assert.deepEqual(title.children, [source.originalTitle])
	assert.equal(title.props.numberOfLines, undefined)
	title.props.numberOfLines = 3
	const oldUp = playerNode(before[3]),
		oldSource = playerNode(before[4]),
		group = playerNode(now[offset + 3]),
		groupChildren = playerChildRow(group)
	assert.equal(group.type, 'View')
	assert.deepEqual(group.props, {
		style: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	})
	assert.equal(groupChildren.length, 2)
	assert.equal(oldUp.props.accessibilityLabel, `查看 UP 主 ${source.uploader}`)
	oldUp.props.style = { ...(oldUp.props.style as object), flex: 1 }
	const upText = playerChild(oldUp)
	assert.equal(upText.type, 'Text')
	assert.equal(upText.props.numberOfLines, undefined)
	upText.props.numberOfLines = 1
	const sourceTexts = controlNodes(oldSource).filter((n) => n.type === 'Text')
	assert.equal(sourceTexts.length, 1)
	assert.deepEqual(sourceTexts[0].children, [['Bilibili 音源 · ', source.bvid]])
	sourceTexts[0].children = ['音源信息']
	before.splice(3, 2, {
		type: 'View',
		props: group.props,
		children: [[oldUp, oldSource]],
	})
	const partsText = controlNodes(before[4]).filter((n) => n.type === 'Text')
	assert.equal(partsText.length, 2)
	assert.equal(partsText[0].props.numberOfLines, undefined)
	partsText[0].props.numberOfLines = 1
	assert.deepEqual(partsText[1].children, [
		'自动记住进度 · 仅连续播放本视频的明确分 P',
	])
	partsText[1].children = ['自动记住收听进度']
	if (switching) {
		const message = controlNodes(expected).filter(
			(n) => n.type === 'Text' && text(n) === '正在切换收听会话…',
		)
		assert.equal(message.length, 1)
		message[0].children = ['正在切换…']
	}
	const sheetHeading = controlNodes(expected).filter(
		(n) =>
			n !== title &&
			n.type === 'Text' &&
			(n.props.style as Record<string, unknown>).fontSize === 21,
	)
	assert.equal(sheetHeading.length, 1)
	sheetHeading[0].props.style = {
		...(sheetHeading[0].props.style as object),
		flex: 1,
		minWidth: 0,
	}
	if (theme) {
		assert.equal(
			controlNodes(actual).filter((n) => n.type === 'LinearGradient').length,
			0,
		)
	}
}
function assertMusicPlayerMigration(
	current: Fixture,
	old: Fixture,
	newTree: unknown,
	oldTree: unknown,
	builtin: keyof typeof builtInThemes | null,
	fm: boolean,
) {
	const actual = playerNode(normalize(current, newTree)),
		expected = playerNode(normalize(old, oldTree)),
		now = playerChildRow(actual),
		before = playerChildRow(expected)
	assert.equal(actual.type, 'ScrollView')
	assert.equal(expected.type, 'ScrollView')
	assert.deepEqual(actual.props, {
		...expected.props,
		ref: { current: null },
		scrollEnabled: true,
		contentContainerStyle: {
			...(expected.props.contentContainerStyle as object),
			flexGrow: 1,
		},
	})
	assert.equal(
		now.length,
		10,
		'backdrop/header/cover/title/source/progress/error/transport/FM/lyrics only',
	)
	assert.equal(before.length, 11, 'guard the exact historical branch shape')
	// No new normalizer exemption: preserve the complete original title/heart,
	// progress, error/retry and transport native trees in their actual order.
	assert.deepEqual(
		[now[3], now[5], now[6], now[7]],
		[before[2], before[5], before[6], before[7]],
	)
	assert.deepEqual(
		normalize(current, label(newTree, '收起播放器')),
		normalize(old, label(oldTree, '收起播放器')),
	)
	const header = playerNode(now[1]),
		oldHeader = playerNode(before[0])
	assert.deepEqual(header.props, oldHeader.props)
	const headerRow = playerChildRow(header)
	assert.equal(headerRow.length, 3)
	const heading = playerNode(headerRow[1])
	assert.deepEqual(heading.props, { style: { alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, flex: 1 } })
	const headingChildren = playerChildRow(heading)
	assert.equal(headingChildren.length, 2)
	if (fm) {
		assert.equal(playerNode(headingChildren[0]).props.testID, 'mascot-error')
		assert.equal(playerNode(headingChildren[0]).props.pointerEvents, 'none')
	} else assert.equal(headingChildren[0], '')
	const title = playerNode(headingChildren[1])
	assert.equal(title.type, 'Text')
	assert.deepEqual(title.children, [fm ? '私人 FM' : '已暂停'])
	const muted = (playerNode(before[4]).props.style as Record<string, unknown>)
		.color
	assert.deepEqual(title.props, {
		style: { color: muted, fontSize: 13, lineHeight: 13 * 1.45, flexShrink: 1, textAlign: 'center' },
	})
	assert.deepEqual(playerNode(now[4]).children, ['Bilibili'])
	assert.equal(playerNode(now[4]).type, 'Text')
	assert.deepEqual(playerNode(now[4]).props, {
		style: { color: muted, fontSize: 11, lineHeight: 11 * 1.45, marginTop: 10 },
	})
	assert.equal(controls(now[4]).length, 0)
	assert.equal(text(before[3]), 'Bilibili 音源 · 当前分 P独立音轨 · 节流优先')
	assert.equal(text(before[4]), 'BV1234567890 · 歌手 / 录音版本待核对')
	assert.equal(
		text(before[9]),
		'封面保留原始视频信息，喜欢仅保存在本机播放片段缓存不等于完整离线下载',
	)
	// The approved redesign enlarges the real cover and removes decorative backing.
	const cover = playerNode(now[2]),
		box = playerChild(cover),
		shadow = playerChild(box),
		frame = playerChild(shadow)
	assert.deepEqual(cover.props, {
		style: { alignItems: 'center', marginTop: 20, marginBottom: 30 },
	})
	assert.deepEqual(box.props, {
		accessibilityRole: 'button', accessibilityLabel: '点击封面查看歌词', onPress: '<callback>',
		style: { width: 288, height: 288, ...(builtin ? { minWidth: 48, minHeight: 48 } : {}) },
	})
	assert.equal(shadow.props.testID, 'player-cover-shadow')
	assert.equal((shadow.props.style as Record<string, unknown>).width, 288)
	const artwork = controlNodes(frame).find((n) => n.type === 'Image')!
	const previousArtwork = controlNodes(before[1]).find(
		(n) => n.type === 'Image',
	)!
	assert.ok(artwork)
	assert.deepEqual(artwork.props.source, previousArtwork.props.source)
	assert.equal(artwork.props.contentFit, 'cover')
	assert.equal(controls(cover).length, 1)
	assert.equal(now[0], null)
	// The old FM/notification actions move to the single closed menu, not away.
	const modal = sourceMenuModal(newTree)
	assert.equal(modal.props.visible, false)
	assert.equal(sourceMenuVisibleLabel(newTree, '查看音源信息'), undefined)
	const menuLabels = controls(modal).map((n) => n.props.accessibilityLabel)
	assert.deepEqual(menuLabels, [
		'关闭播放选项',
		'查看音源信息',
		'切换主题',
		fm ? '媒体通知不可用 · 前往设置' : '媒体通知设置',
		...(fm ? ['管理与退出私人 FM'] : []),
		'取消播放选项',
	])
	assert.deepEqual(
		controlNodes(modal)
			.filter((n) => n.type === 'Text')
			.map(text),
		[
			'播放选项',
			'查看音源信息',
			'切换主题',
			fm ? '媒体通知不可用 · 前往设置' : '媒体通知设置',
			...(fm ? ['管理与退出私人 FM'] : []),
			'Bilibili · BV1234567890。保留原始视频信息，UP 主不等于歌手，歌曲与录音版本尚未核对。',
			'喜欢仅保存在本机。',
			'使用独立音轨收听；播放片段缓存不等于完整离线下载。',
			'取消',
		],
	)
	assert.equal(controls(now[8]).length, 0)
	if (fm) {
		assert.deepEqual(playerNode(now[8]).props, playerNode(before[8]).props)
		assert.equal(controls(before[8]).length, 1)
		assert.equal(controls(before[8])[0].props.accessibilityLabel, undefined)
		assert.equal(text(controls(before[8])[0]), '管理与退出私人 FM')
		assert.equal(text(now[8]), '')
		assert.equal(text(before[10]), '媒体通知不可用 · 前往设置')
	} else {
		assert.deepEqual(now[8], before[8])
		assert.equal(before[10], false)
	}
	const lyric = playerNode(now[9])
	assert.equal(lyric.type, 'Pressable')
	assert.equal(lyric.props.accessibilityLabel, '展开歌词')
	assert.equal(lyric.props.accessibilityRole, 'button')
	assert.equal(text(lyric), '歌词　›')
	assert.deepEqual(lyric.props.style, {
		minHeight: 48,
		...(builtin ? { minWidth: 48 } : {}),
		alignItems: 'center',
		justifyContent: 'center',
		marginTop: 12,
	})
}

void test('actual player/rows/sheets/theme cards retain three defaults and validated legacy48 native trees and styles', async () => {
	const stage2Listening = approvedRedesignCopy(
		readBaselineSource('128f72705388ec6e2438bccf983769bbeb3d4f3f:android-app/apps/mobile/melo/listening-ui.tsx'),
	).replaceAll('marginTop: 16', 'marginTop: 12')
	const originals = Object.fromEntries(
		names.map((name) => [
			name,
			approvedRedesignCopy(
				readBaselineSource(`${baseline}:android-app/apps/mobile/melo/${name}.tsx`),
			)
				.replaceAll('返回刚才的音乐队列并继续播放', '返回音乐并继续播放')
				.replaceAll("{builtInThemes[key].name} ·", '{builtInThemes[key].name}')
				.replaceAll("title='续听记录暂时无法读取'", "mascot='error' title='续听记录暂时无法读取'")
				.replaceAll("title='暂无收听记录'", "mascot='video' title='暂无收听记录'")
				.replaceAll(
					name === 'listening-ui' ? 'gap: 16' : '__unchanged__',
					'gap: 12',
				)
				.replaceAll(
					name === 'listening-ui' ? 'size={23}' : '__unchanged__',
					'size={21}',
				)
				.replaceAll(
					name === 'listening-ui' ? 'marginTop: 16' : '__unchanged__',
					'marginTop: 12',
				),
		]),
	)
	const p = props(),
		legacy = await legacyControlPackage()
	const cases: Spec[] = [
		{ file: 'music-ui', name: 'MusicPlayer', props: p.music },
		{
			file: 'music-ui',
			name: 'MusicPlayer',
			props: {
				...p.music,
				notifications: false,
				player: {
					...p.music.player,
					error: '播放失败',
					fmContext: { id: 'fm' },
				},
			},
		},
		...[false, true].flatMap((listeningResult) => [
			{
				file: 'music-ui' as const,
				name: 'SongRow',
				props: { ...p.row, listeningResult },
			},
			{
				file: 'music-ui' as const,
				name: 'SongRow',
				props: { ...p.row, listeningResult, busy: true, onMore: undefined },
			},
		]),
		{ file: 'listening-ui', name: 'ListeningResumeList', props: p.resume },
		{
			file: 'listening-ui',
			name: 'ListeningResumeList',
			props: { ...p.resume, busy: true, error: '副本读取失败' },
		},
		{ file: 'listening-ui', name: 'ListeningPlayer', props: p.listening },
		...[
			{},
			{ switching: true },
			{ parts: [], partsError: '分 P 受限' },
			{ parts: [], partsLoading: true },
			{ parts: [] },
		].map((extra) => ({
			file: 'listening-ui' as const,
			name: 'ListeningPlayer',
			props: { ...p.listening, ...extra },
			open: '打开真实分 P 列表',
		})),
		...[false, true].map((switching) => ({
			file: 'listening-ui' as const,
			name: 'ListeningPlayer',
			props: { ...p.listening, switching },
			open: '收听倍速 1 倍',
		})),
		...[false, true].map((disabled) => ({
			file: 'theme-workshop' as const,
			name: 'ThemeWorkshop',
			props: { ...p.workshop, disabled },
		})),
	]
	let historicalComparisons = 0,
		migratedComparisons = 0
	for (const theme of [...Object.values(builtInThemes), null])
		for (const spec of cases) {
			const old = controlFixture(originals),
				current = controlFixture()
			const render = (f: Fixture) =>
				f.element(
					component(
						f.load('ui')[theme ? 'ThemeProvider' : 'PackageThemeProvider'],
					),
					theme ? { value: theme } : { ...legacy, reducedMotion: true },
					element(f, spec),
				)
			const before = render(old),
				after = render(current)
			let oldTree = old.render(before),
				newTree = current.render(after)
			if (spec.open) {
				press(oldTree, spec.open)
				press(newTree, spec.open)
				oldTree = old.render(before)
				newTree = current.render(after)
			}
			if (spec.name === 'MusicPlayer') {
				const builtin = theme
					? (Object.entries(builtInThemes).find(
							([, value]) => value === theme,
						)![0] as keyof typeof builtInThemes)
					: null
				assertMusicPlayerMigration(
					current,
					old,
					newTree,
					oldTree,
					builtin,
					!!(spec.props.player as { fmContext: unknown }).fmContext,
				)
				migratedComparisons++
				if (
					builtin === 'modern' &&
					!(spec.props.player as { fmContext: unknown }).fmContext
				) {
					const corrupted = playerNode(
						structuredClone(normalize(current, newTree)),
					)
					label(corrupted, '继续播放').props.disabled = true
					assert.throws(
						() =>
							assertMusicPlayerMigration(
								current,
								old,
								corrupted,
								oldTree,
								builtin,
								false,
							),
						/deep-equal/,
					)
					const unexpected = playerNode(
						structuredClone(normalize(current, newTree)),
					)
					playerChildRow(unexpected).push({
						type: 'Pressable',
						props: { accessibilityLabel: 'unexpected' },
						children: [],
					})
					assert.throws(
						() =>
							assertMusicPlayerMigration(
								current,
								old,
								unexpected,
								oldTree,
								builtin,
								false,
							),
						/backdrop\/header/,
					)
				}
			} else {
				const actual = normalize(
						current,
						newTree,
						spec.name === 'ListeningPlayer',
					),
					expected = normalize(old, oldTree, spec.name === 'ListeningPlayer')
				if (spec.name === 'ThemeWorkshop') {
					// The dark-only notice is absent in these light-mode historical cases.
					const currentChildren = (actual as ControlNode).children![0] as unknown[]
					const oldChildren = (expected as ControlNode).children![0] as unknown[]
					assert.equal(currentChildren[0], false)
					oldChildren.unshift(false)
				}
				if (spec.name === 'SongRow') {
					const oldMetadata = controlNodes(expected).filter(
							(n) =>
								n.type === 'Text' &&
								text(n) === '02:00 · Bilibili · 版本待核对',
						),
						newMetadata = controlNodes(actual).filter(
							(n) => n.type === 'Text' && text(n) === '02:00',
						)
					assert.equal(oldMetadata.length, 1)
					assert.equal(newMetadata.length, 1)
					assert.deepEqual(oldMetadata[0].children, [
						['02:00', ' · Bilibili ·', ' ', '版本待核对'],
					])
					assert.deepEqual(newMetadata[0].children, ['02:00'])
					oldMetadata[0].children = ['02:00']
				}
				if (spec.name === 'ListeningPlayer') {
					const oldScroll = controlNodes(expected).find(node => node.props.testID === 'listening-player-page')!
					oldScroll.props.ref = { current: null }
					oldScroll.props.scrollEnabled = true
					const previous = controlFixture({ 'listening-ui': stage2Listening })
					const expectedTools = playerNode(
							normalize(
								previous,
								playerRegion(
									previous.render(render(previous)),
									'listening-chapters-entry',
								),
							),
						),
						actualTools = normalize(
							current,
							playerRegion(newTree, 'listening-chapters-entry'),
						),
						oldTools = playerChildRow(expectedTools)
					assert.deepEqual(expectedTools.props.style, { marginTop: 12 })
					assert.equal(oldTools.length, 2)
					assert.equal(text(oldTools[0]), '当前章节与分 P')
					assert.equal(text(oldTools[1]), '视频字幕')
					assert.deepEqual(playerNode(oldTools[1]).props.style, {
						marginTop: 12,
					})
					expectedTools.props.style = {
						marginTop: 12,
						flexDirection: 'row',
						gap: 12,
					}
					expectedTools.children = [
						[
							{
								type: 'View',
								props: { style: { flex: 1 } },
								children: [oldTools[0]],
							},
							{ ...playerNode(oldTools[1]), props: { style: { flex: 1 } } },
						],
					]
					assert.deepEqual(
						actualTools,
						expectedTools,
						'two tool columns retain complete native button trees and disabled state',
					)
					previous.unmount()
					expectListeningPlayerPolish(
						actual,
						expected,
						theme,
						!!spec.props.switching,
					)
				}
				if (theme) expectBuiltinScenarioTouchDelta(spec, actual, expected)
				assert.deepEqual(
					actual,
					expected,
					`${theme?.id ?? 'legacy48'} ${spec.name} ${spec.open ?? ''}`,
				)
				historicalComparisons++
			}
		}
	assert.deepEqual([historicalComparisons, migratedComparisons], [64, 8])
})

void test('actual SongRow allocates main and action column together; measured compact/host/reject preserve the selected callback domain', () => {
	for (const listeningResult of [false, true]) {
		const f = controlFixture(),
			events: unknown[] = [],
			p = props(events)
		const spec: Spec = {
				file: 'music-ui',
				name: 'SongRow',
				props: { ...p.row, listeningResult },
			},
			value = root(f, spec)
		let tree = f.render(value)
		assert.equal(controls(tree).length, 0)
		const row = measurements(tree)[0]
		for (const [width, touch] of [
			[400, 96],
			[listeningResult ? 250 : 210, 72],
			[listeningResult ? 225 : 180, 48],
		] as const) {
			measure(row, width)
			tree = f.render(value)
			const main = label(
				tree,
				`${listeningResult ? '收听' : '播放'} ${source.originalTitle}`,
			)
			assert.equal(flat(f, main).minHeight, Math.max(62, touch))
			assert.equal(
				flat(f, label(tree, `更多音源操作 ${source.originalTitle}`)).width,
				touch,
			)
		}
		press(tree, `${listeningResult ? '收听' : '播放'} ${source.originalTitle}`)
		press(tree, `更多音源操作 ${source.originalTitle}`)
		press(
			tree,
			`${listeningResult ? '以听视频收听' : '取消喜欢'} ${source.originalTitle}`,
		)
		assert.deepEqual(events, [
			listeningResult ? 'listen' : 'play',
			'more',
			listeningResult ? 'listen' : 'like',
		])
		measure(row, 100)
		tree = f.render(value)
		assert.equal(controls(tree).length, 0)
		assert.match(text(tree), /主题控件暂不适合当前宽度/)
	}
})

/** Current source-menu test helpers; not used by historical normalization. */
// Native hidden Modals do not contribute hittable nodes or onLayout events.
// Keep this traversal local: the five raw historical-tree contracts are unchanged.
const sourceMenuVisibleNodes = (value: unknown): ControlNode[] => {
	if (Array.isArray(value)) return value.flatMap(sourceMenuVisibleNodes)
	if (!value || typeof value !== 'object' || !('type' in value)) return []
	const node = value as ControlNode
	if (node.type === 'Modal' && node.props.visible === false) return []
	return [node, ...sourceMenuVisibleNodes(node.children)]
}
const sourceMenuVisibleControls = (tree: unknown) =>
	sourceMenuVisibleNodes(tree).filter((node) => node.type === 'Pressable')
const sourceMenuVisibleLabel = (tree: unknown, name: string) =>
	sourceMenuVisibleControls(tree).find(
		(node) => node.props.accessibilityLabel === name,
	)
const sourceMenuModal = (tree: unknown) => {
	const found = controlNodes(tree).filter(
		(node) =>
			node.type === 'Modal' &&
			controlNodes(node.children).some(
				(child) => child.props.accessibilityLabel === '关闭播放选项',
			),
	)
	assert.equal(
		found.length,
		1,
		'the actual player owns exactly one overflow menu',
	)
	return found[0]
}
const sourceMenuVisibleMeasurements = (tree: unknown) =>
	sourceMenuVisibleNodes(tree).filter(
		(node) =>
			typeof node.props.onLayout === 'function' &&
			String(node.key).includes('['),
	)
const pressSourceMenuVisible = (tree: unknown, name: string) => {
	const target = sourceMenuVisibleLabel(tree, name)
	assert.ok(target, `missing visible target: ${name}`)
	;(target.props.onPress as () => void)()
}
const sourceMenuVisibilityProbe = (visible: boolean): ControlNode => ({
	key: undefined,
	type: 'Modal',
	props: { visible },
	children: [{ type: 'Pressable', props: { accessibilityLabel: 'inside' } }],
})

void test('actual source info opens in the measured player menu; font2 and viewport changes reject stale bounds while close and unmount remain safe', () => {
	const f = controlFixture(),
		events: unknown[] = []
	let value: unknown
	value = root(f, {
		file: 'music-ui',
		name: 'MusicPlayer',
		props: {
			...props().music,
			onSource: () => {
				assert.equal(
					sourceMenuModal(f.render(value)).props.visible,
					false,
					'close is requested before the source callback',
				)
				events.push('source')
			},
		},
	})
	const draw = () => f.render(value)
	const settleVisible = (width = 316) => {
		let tree = draw()
		for (let i = 0; i < 3; i++) {
			for (const row of sourceMenuVisibleMeasurements(tree)) measure(row, width)
			tree = draw()
		}
		return tree
	}
	const sourceBounds = (tree: unknown) => {
		const panel = sourceMenuModal(tree)
		assert.equal(panel.props.visible, true)
		const scroll = controlNodes(panel.children).find(
			(node) => node.type === 'ScrollView',
		)!
		assert.ok(scroll)
		assert.equal(scroll.props.keyboardShouldPersistTaps, 'handled')
		const rows = measurements(scroll)
		assert.equal(
			rows.length,
			3,
			'source/theme/notification each owns a standalone measured row',
		)
		assert.equal(flat(f, rows[0]).flex, 1)
		return rows[0]
	}
	const assertSource = (tree: unknown) => {
		const target = sourceMenuVisibleLabel(tree, '查看音源信息')
		assert.ok(target)
		assert.equal(flat(f, target).minWidth, 96)
		assert.equal(flat(f, target).minHeight, 96)
		assert.equal(
			flat(f, target).flexGrow,
			1,
			'standalone source target fills its actual measured row',
		)
		for (const name of ['width', 'height', 'maxHeight'])
			assert.equal(flat(f, target)[name], undefined)
		const texts = controlNodes(target.children).filter(
			(node) => node.type === 'Text',
		)
		assert.equal(texts.length, 1)
		assert.equal(text(texts[0]), '查看音源信息')
		assert.equal(texts[0].props.numberOfLines, undefined)
		return target
	}
	// The visibility model must not hide ordinary controls or an explicitly open modal.
	assert.deepEqual(
		sourceMenuVisibleControls([
			{ type: 'Pressable', props: { accessibilityLabel: 'outside' } },
			sourceMenuVisibilityProbe(false),
			sourceMenuVisibilityProbe(true),
		]).map((node) => node.props.accessibilityLabel),
		['outside', 'inside'],
	)
	try {
		let tree = draw()
		assert.equal(sourceMenuModal(tree).props.visible, false)
		assert.equal(sourceMenuVisibleControls(tree).length, 0)
		tree = settleVisible()
		assert.equal(
			sourceMenuVisibleLabel(tree, '查看音源信息'),
			undefined,
			'closed source menu cannot be pressed',
		)
		pressSourceMenuVisible(tree, '更多播放选项')
		tree = draw()
		assert.equal(sourceMenuModal(tree).props.visible, true)
		assert.equal(
			sourceMenuVisibleLabel(tree, '查看音源信息'),
			undefined,
			'opening alone must not invent native layout',
		)
		assert.ok(
			controlNodes(sourceMenuModal(tree)).some(
				(node) => node.props.accessibilityViewIsModal === true,
			),
		)
		measure(sourceBounds(tree), 316)
		tree = draw()
		const initialSource = normalize(f, assertSource(tree))
		pressSourceMenuVisible(tree, '查看音源信息')
		tree = draw()
		assert.equal(sourceMenuModal(tree).props.visible, false)
		assert.equal(sourceMenuVisibleLabel(tree, '查看音源信息'), undefined)
		assert.deepEqual(events, ['source'])
		pressSourceMenuVisible(tree, '更多播放选项')
		tree = draw()
		const old = sourceMenuVisibleMeasurements(tree)
		f.viewport.fontScale = 2
		tree = draw()
		assert.deepEqual(
			sourceMenuVisibleControls(tree).map(
				(node) => node.props.accessibilityLabel,
			),
			['关闭播放选项'],
		)
		for (const row of old) measure(row, 316)
		tree = draw()
		assert.deepEqual(
			sourceMenuVisibleControls(tree).map(
				(node) => node.props.accessibilityLabel,
			),
			['关闭播放选项'],
			'stale font1 bounds cannot unlock font2 targets',
		)
		measure(sourceBounds(tree), 40)
		tree = draw()
		assert.equal(sourceMenuVisibleLabel(tree, '查看音源信息'), undefined)
		assert.match(text(sourceMenuModal(tree)), /主题控件暂不适合当前宽度/)
		measure(sourceBounds(tree), 316)
		tree = draw()
		assertSource(tree)
		assert.deepEqual(
			sourceMenuVisibleControls(tree).map(
				(node) => node.props.accessibilityLabel,
			),
			['关闭播放选项', '查看音源信息'],
		)
		const oldViewport = sourceBounds(tree)
		f.viewport.width = 320
		tree = draw()
		assert.equal(sourceMenuVisibleLabel(tree, '查看音源信息'), undefined)
		measure(oldViewport, 316)
		tree = draw()
		assert.equal(
			sourceMenuVisibleLabel(tree, '查看音源信息'),
			undefined,
			'prior viewport cannot unlock the new menu allocation',
		)
		measure(sourceBounds(tree), 276)
		tree = draw()
		assertSource(tree)
		f.viewport.width = 360
		f.viewport.fontScale = 1
		tree = draw()
		assert.equal(sourceMenuVisibleLabel(tree, '查看音源信息'), undefined)
		measure(sourceBounds(tree), 316)
		tree = draw()
		assert.deepEqual(
			normalize(f, assertSource(tree)),
			initialSource,
			'font1 restores the current source target exactly',
		)
		pressSourceMenuVisible(tree, '查看音源信息')
		assert.deepEqual(
			events,
			['source', 'source'],
			'one source callback per explicit press',
		)
		tree = settleVisible()
		pressSourceMenuVisible(tree, '更多播放选项')
		tree = draw()
		f.viewport.fontScale = 2
		tree = draw()
		pressSourceMenuVisible(tree, '关闭播放选项')
		tree = draw()
		assert.equal(
			sourceMenuModal(tree).props.visible,
			false,
			'unmeasured menu retains its full-screen dismiss layer',
		)
		tree = settleVisible()
		pressSourceMenuVisible(tree, '更多播放选项')
		tree = draw()
		;(sourceMenuModal(tree).props.onRequestClose as () => void)()
		tree = draw()
		assert.equal(sourceMenuModal(tree).props.visible, false)
		assert.deepEqual(
			events,
			['source', 'source'],
			'dismiss and Android Back never invoke the source action',
		)
		const late = measurements(tree)
		f.unmount()
		for (const row of late) measure(row, 400)
		assert.equal(f.writesAfterUnmount, 0)
	} finally {
		f.unmount()
	}
})

void test('actual listening resume, UP/source, parts and speed sheets retain target minima, selection and close/cancel/return callbacks', () => {
	const f = controlFixture(),
		events: unknown[] = [],
		p = props(events)
	const value = root(f, {
		file: 'listening-ui',
		name: 'ListeningPlayer',
		props: p.listening,
	})
	let tree = settle(f, value)
	press(tree, `查看 UP 主 ${source.uploader}`)
	press(tree, '查看听视频音源信息')
	press(tree, '返回音乐并继续播放')
	press(tree, '打开真实分 P 列表')
	tree = settle(f, value)
	assert.equal(flat(f, label(tree, '播放分 P 1 第一分 P')).minHeight, 96)
	assert.equal(
		(
			label(tree, '播放分 P 1 第一分 P').props.accessibilityState as {
				selected: boolean
			}
		).selected,
		true,
	)
	press(tree, '播放分 P 2 第二分 P')
	tree = settle(f, value)
	assert.equal(
		controlNodes(tree).find((node) => node.type === 'Modal')!.props.visible,
		false,
	)
	press(tree, '收听倍速 1 倍')
	tree = settle(f, value)
	assert.equal(
		(
			label(tree, '设置收听倍速 1 倍').props.accessibilityState as {
				selected: boolean
			}
		).selected,
		true,
	)
	press(tree, '设置收听倍速 1.5 倍')
	tree = settle(f, value)
	assert.deepEqual(events, ['creator', 'source', 'return', parts[1], 1.5])
	const switching = root(f, {
		file: 'listening-ui',
		name: 'ListeningPlayer',
		props: { ...p.listening, switching: true },
	})
	tree = settle(f, switching)
	press(tree, '打开真实分 P 列表')
	tree = settle(f, switching)
	assert.equal(label(tree, '播放分 P 2 第二分 P').props.disabled, true)
	assert.equal(label(tree, '返回音乐并继续播放').props.disabled, true)
	press(tree, '关闭听视频面板')
	tree = settle(f, switching)
	press(tree, '取消切换')
	assert.equal(events.at(-1), 'cancel')
	// Backdrop remains outside touch measurement and available while sheet targets wait.
	press(tree, '打开真实分 P 列表')
	tree = f.render(switching)
	assert.equal(flat(f, label(tree, '关闭听视频面板')).minHeight, undefined)
	const g = controlFixture(),
		resume = root(g, {
			file: 'listening-ui',
			name: 'ListeningResumeList',
			props: p.resume,
		})
	assert.equal(controls(g.render(resume)).length, 0)
	const ready = settle(g, resume)
	const row = controls(ready)[0]
	assert.equal(flat(g, row).minWidth, 164)
	assert.equal(flat(g, row).minHeight, 96)
	;(row.props.onPress as () => void)()
	assert.equal(events.at(-1), source)
})

void test('actual fallback listening action and busy resume keep disabled semantics; failed parts retry keeps its original callback', () => {
	const f = controlFixture(),
		events: unknown[] = [],
		p = props(events)
	let value = root(f, {
		file: 'music-ui',
		name: 'SongRow',
		props: { ...p.row, onMore: undefined },
	})
	let tree = settle(f, value)
	press(tree, `以听视频开启 ${source.originalTitle}`)
	assert.deepEqual(events, ['listen'])
	value = root(f, {
		file: 'music-ui',
		name: 'SongRow',
		props: { ...p.row, onMore: undefined, busy: true },
	})
	tree = settle(f, value)
	assert.equal(
		controls(tree).every((node) => node.props.disabled === true),
		true,
	)
	const g = controlFixture(),
		resume = root(g, {
			file: 'listening-ui',
			name: 'ListeningResumeList',
			props: { ...p.resume, busy: true, error: '副本错误' },
		})
	tree = settle(g, resume)
	assert.equal(controls(tree)[0].props.disabled, true)
	assert.match(text(tree), /副本错误/)
	const h = controlFixture(),
		error = root(h, {
			file: 'listening-ui',
			name: 'ListeningPlayer',
			props: { ...p.listening, partsError: '真实请求受限' },
		})
	tree = settle(h, error)
	press(tree, '打开真实分 P 列表')
	tree = settle(h, error)
	press(tree, '重试')
	assert.deepEqual(events, ['listen', 'retry-parts'])
})

void test('actual builtin theme selection measures active host policy outside preview providers; current selection and disabled stay unchanged', () => {
	const f = controlFixture(),
		events: unknown[] = [],
		p = props(events)
	const value = root(f, {
		file: 'theme-workshop',
		name: 'ThemeWorkshop',
		props: p.workshop,
	})
	let tree = f.render(value)
	assert.equal(controls(tree).length, 0)
	assert.equal(measurements(tree).length, 3)
	tree = settle(f, value)
	const selected = label(tree, '应用现代主题')
	assert.equal(flat(f, selected).minWidth, 197)
	assert.equal(flat(f, selected).minHeight, 99)
	assert.equal(
		(selected.props.accessibilityState as { selected: boolean }).selected,
		true,
	)
	press(tree, '应用田园主题')
	assert.deepEqual(events, ['pastoral'])
	const disabled = root(f, {
		file: 'theme-workshop',
		name: 'ThemeWorkshop',
		props: { ...p.workshop, disabled: true },
	})
	tree = settle(f, disabled)
	assert.equal(
		controls(tree).every((node) => node.props.disabled === true),
		true,
	)
	assert.equal(controls(tree).length, 3)
	const small = controlFixture(),
		rejected = root(small, {
			file: 'theme-workshop',
			name: 'ThemeWorkshop',
			props: p.workshop,
		})
	const narrow = settle(small, rejected, 150)
	assert.equal(controls(narrow).length, 0)
})

void test('approved player overflow and lyrics preserve exact actions, hidden-modal safety and cover restoration in four themes', async () => {
	const legacy = await legacyControlPackage()
	for (const theme of [...Object.values(builtInThemes), null]) {
		for (const fm of [false, true]) {
			const f = controlFixture(),
				events: string[] = [],
				reads: string[] = []
			const readingBackRef: { current: (() => boolean) | null } = {
				current: null,
			}
			let value: unknown
			const draw = () => f.render(value)
			const action = (name: string) => () => {
				assert.equal(
					sourceMenuModal(draw()).props.visible,
					false,
					'secondary action closes its menu first',
				)
				events.push(name)
			}
			const p = props().music
			const spec: Spec = {
				file: 'music-ui',
				name: 'MusicPlayer',
				props: {
					...p,
					readingBackRef,
					library: {
						setting: (key: string) => {
							reads.push(key)
							return null
						},
						setSetting: () => events.push('write'),
					},
					player: {
						...p.player,
						fmContext: fm ? { id: 'fm' } : null,
						toggle: () => events.push('toggle'),
					},
					notifications: !fm,
					onSource: action('source'),
					onTheme: action('theme'),
					onNotificationSettings: action('notifications'),
					onFm: action('fm'),
					onClose: () => events.push('close'),
					onQueue: () => events.push('queue'),
				},
			}
			value = f.element(
				component(
					f.load('ui')[theme ? 'ThemeProvider' : 'PackageThemeProvider'],
				),
				theme ? { value: theme } : { ...legacy, reducedMotion: true },
				element(f, spec),
			)
			try {
				let tree = draw()
				assert.equal(sourceMenuModal(tree).props.visible, false)
				assert.equal(sourceMenuVisibleLabel(tree, '查看音源信息'), undefined)
				assert.deepEqual(events, [])
				assert.deepEqual(
					reads,
					[],
					'closed lyrics never read or mutate storage',
				)
				const actions = [
					['查看音源信息', 'source'],
					['切换主题', 'theme'],
					[fm ? '媒体通知不可用 · 前往设置' : '媒体通知设置', 'notifications'],
					...(fm ? [['管理与退出私人 FM', 'fm']] : []),
				]
				for (const [name, event] of actions) {
					pressSourceMenuVisible(tree, '更多播放选项')
					tree = draw()
					assert.equal(sourceMenuModal(tree).props.visible, true)
					const target = sourceMenuVisibleLabel(tree, name)
					assert.ok(target)
					assert.equal(target.props.accessibilityRole, 'button')
					assert.ok(Number(flat(f, target).minHeight) >= 48)
					assert.equal(flat(f, target).height, undefined)
					const previous: number = events.length
					pressSourceMenuVisible(tree, name)
					tree = draw()
					assert.equal(sourceMenuModal(tree).props.visible, false)
					assert.equal(events.length, previous + 1)
					assert.equal(events.at(-1), event)
				}
				const afterActions = [...events]
				for (const close of ['关闭播放选项', '取消播放选项', 'android-back']) {
					pressSourceMenuVisible(tree, '更多播放选项')
					tree = draw()
					if (close === 'android-back')
						(sourceMenuModal(tree).props.onRequestClose as () => void)()
					else pressSourceMenuVisible(tree, close)
					tree = draw()
					assert.equal(sourceMenuModal(tree).props.visible, false)
					assert.deepEqual(events, afterActions)
				}
				const coverTree = normalize(f, tree)
				pressSourceMenuVisible(tree, '展开歌词')
				tree = draw()
				const regions = controlNodes(tree).filter(
					(n) => n.props.testID === 'player-lyrics-region',
				)
				assert.equal(regions.length, 1)
				assert.equal(flat(f, regions[0]).height, theme ? 336 : 288)
				assert.equal(sourceMenuVisibleLabel(tree, '展开歌词'), undefined)
				assert.equal(
					controlNodes(tree).some(
						(n) => n.props.testID === 'player-cover-shadow',
					),
					false,
				)
				assert.equal(
					sourceMenuVisibleLabel(tree, '返回播放器封面')?.props
						.accessibilityRole,
					'button',
				)
				const openingReads = [
					'melo.lyrics.display.v1',
					`melo.lyrics.v1:${source.id}`,
					`melo.lyrics.v1:${source.id}`,
				]
				// The layout effect loads saved lyrics; auto matching rechecks the
				// cache before requesting so reopening never replaces saved lyrics.
				assert.deepEqual(reads, openingReads)
				assert.deepEqual(
					events,
					afterActions,
					'lyrics navigation never plays or writes',
				)
				for (const [width, height, fontScale, regionHeight] of [
					[320, 600, 2, theme ? 520 : 162],
					[320, 640, 1.4, theme ? 376.32 : 172.8],
					[400, 1200, 1, theme ? 420 : 320],
				]) {
					Object.assign(f.viewport, { width, height, fontScale })
					tree = draw()
					const resized = controlNodes(tree).filter(
						(n) => n.props.testID === 'player-lyrics-region',
					)
					assert.equal(resized.length, 1)
					assert.equal(flat(f, resized[0]).height, regionHeight)
					assert.deepEqual(
						reads,
						openingReads,
						'resizing the reading region never reloads lyrics',
					)
					assert.deepEqual(
						events,
						afterActions,
						'resizing never plays or writes',
					)
				}
				Object.assign(f.viewport, { width: 360, height: 800, fontScale: 1 })
				tree = draw()
				assert.equal(readingBackRef.current?.(), true)
				tree = draw()
				assert.equal(readingBackRef.current, null)
				assert.deepEqual(
					normalize(f, tree),
					coverTree,
					'return restores the exact current cover/player tree',
				)
				assert.deepEqual(
					reads,
					openingReads,
					'closing lyrics never reads storage again',
				)
				assert.deepEqual(
					events,
					afterActions,
					'closing lyrics never plays or writes',
				)
				pressSourceMenuVisible(tree, '继续播放')
				pressSourceMenuVisible(tree, '播放队列')
				pressSourceMenuVisible(tree, '收起播放器')
				assert.deepEqual(events, [...afterActions, 'toggle', 'queue', 'close'])
			} finally {
				f.unmount()
				assert.equal(readingBackRef.current, null)
				assert.equal(f.writesAfterUnmount, 0)
			}
		}
	}
})
