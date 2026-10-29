import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import * as builtinVisuals from '../core/builtin-visuals'
import * as localAudio from '../core/local-audio'
import { builtInThemes } from '../core/theme'
import type { MusicPlayer } from '../music-ui'

import {
	compile,
	nodes,
	react,
	text,
	type ViewNode,
} from './search-page-fixture'

const source = compile(
	readFileSync(new URL('../music-ui.tsx', import.meta.url), 'utf8'),
)
const noop = () => {}
function render(
	fm: boolean,
	theme = builtInThemes.modern,
	local = false,
	extra: Partial<Parameters<typeof MusicPlayer>[0]> = {},
	playerState: Partial<Parameters<typeof MusicPlayer>[0]['player']> = {},
) {
	const output: {
		MusicPlayer?: (props: Parameters<typeof MusicPlayer>[0]) => ViewNode
	} = {}
	const renderer = {
		...react,
		useState: (value: unknown) => [value, () => {}],
		useRef: (value: unknown) => ({ current: value }),
		useCallback: (value: unknown) => value,
		useEffect: () => {},
		createElement: (
			type: string | ((props: Record<string, unknown>) => ViewNode),
			props: Record<string, unknown> | null,
			...items: unknown[]
		) =>
			typeof type === 'function'
				? type({ ...props, children: items })
				: react.createElement(type, props, ...items),
	}
	const dependencies = (name: string): unknown => {
		if (name === './usePlaybackProgress') return { usePlaybackProgress: (_: unknown, position: number, duration: number) => ({ position, duration }) }
		if (name === 'react')
			return { __esModule: true, default: renderer, ...renderer }
		if (name === 'react-native')
			return {
				Pressable: 'Pressable',
				ScrollView: 'ScrollView',
				View: 'View',
				StyleSheet: { create: (value: unknown) => value },
				useWindowDimensions: () => ({ width: 360, height: 640 }),
			}
		if (name === './core/local-audio') return localAudio
		if (name === './lyrics-ui') return { LyricsReader: 'LyricsReader' }
		if (name === './music-player-menu')
			return { MusicPlayerMenu: 'MusicPlayerMenu' }
		if (name === './progress') return { Progress: 'Progress' }
		if (name === 'react-native-svg')
			return { __esModule: true, default: 'Svg', Path: 'Path', Text: 'SvgText' }
		if (name === './host-controls') {
			const controls = {}
			runInNewContext(
				compile(
					readFileSync(
						new URL('../host-controls.tsx', import.meta.url),
						'utf8',
					),
				),
				{ exports: controls, require: dependencies },
			)
			return controls
		}
		if (name === './ui')
			return {
				Artwork: 'Artwork',
				MascotArt: 'MascotArt',
				PlayerBackdrop: 'PlayerBackdrop',
				Button: 'Button',
				Card: 'Card',
				ControlRow: 'View',
				ControlTarget: 'Pressable',
				Icon: 'Icon',
				IconButton: 'IconButton',
				T: 'T',
				useTheme: () => theme,
				useBuiltInVisuals: () => builtinVisuals.builtInVisuals(theme),
				useThemeRendering: () => null,
			}
		throw new Error(`Unexpected dependency ${name}`)
	}
	runInNewContext(source, { exports: output, require: dependencies })
	assert.ok(output.MusicPlayer)
	const track = {
		id: 'entry',
		sourceId: local ? 'local:12345678-1234-1234-1234-123456789abc' : undefined,
		title: '原标题',
		artist: 'UP · 原UP',
		artwork: '',
		duration: 180,
	}
	const player = {
		track,
		queue: [track],
		fmContext: fm ? { id: 'fm' } : null,
		position: 15,
		duration: 180,
		playing: false,
		error: '',
		buffering: false,
		...playerState,
	} as unknown as Parameters<typeof MusicPlayer>[0]['player']
	return output.MusicPlayer({
		library: { setting: () => null, setSetting: () => {} },
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
		bottomInset: 20,
		onFm: noop,
		fmMessage: '暂时没有更多本机候选，当前内容结束后将停止。',
		...extra,
	})
}
function children(view: ViewNode) {
	return view.children
		.flat(Infinity)
		.filter(
			(value): value is ViewNode =>
				!!value && typeof value === 'object' && 'type' in value,
		)
}
const transport = (value: unknown) =>
	nodes(value).some(
		(item) => item.type === 'IconButton' && item.props.label === '继续播放',
	)
const comparable = (value: unknown) =>
	JSON.stringify(value, (_key, item: unknown) =>
		typeof item === 'function' ? '<callback>' : item,
	)

void test('FM status follows transport while management moves to overflow, preserving all cover layouts', () => {
	for (const theme of Object.values(builtInThemes)) {
		const normal = render(false, theme),
			fm = render(true, theme)
		const normalChildren = children(normal),
			fmChildren = children(fm)
		const controls = normalChildren.findIndex(transport),
			fmControls = fmChildren.findIndex(transport)
		assert.equal(fm.type, 'ScrollView')
		assert.equal(
			fmControls,
			controls,
			'FM content must not push the original transport down',
		)
		assert.match(text(fmChildren[fmControls + 1]), /暂时没有更多本机候选/)
		const fmMenu = nodes(fm).find((n) => n.type === 'MusicPlayerMenu')!
		assert.equal(fmMenu.props.fm, true)
		assert.equal(
			nodes(normal).find((n) => n.type === 'MusicPlayerMenu')!.props.fm,
			false,
		)
		assert.equal(
			fmChildren.findIndex((value) => value.type === 'Progress'),
			normalChildren.findIndex((value) => value.type === 'Progress'),
		)
		// Header's existing FM title is intentionally different; the cover, title,
		// source information, progress and transport remain byte-equivalent props.
		assert.equal(
			comparable(fmChildren.slice(2, fmControls + 1)),
			comparable(normalChildren.slice(2, controls + 1)),
		)
		assert.equal(
			comparable(fm.props.contentContainerStyle),
			comparable(normal.props.contentContainerStyle),
		)
	}
})

void test('player mascot follows error, buffering and playing state without claiming paused playback', () => {
	for (const [playing, buffering, error, mascot, copy] of [
		[false, false, '', undefined, '已暂停'],
		[true, false, '', 'playing', '正在播放'],
		[true, true, '', 'loading', '正在缓冲'],
		[true, true, '音源失败', 'error', '播放遇到问题'],
	] as const) {
		const view = render(false, builtInThemes.modern, false, {}, { playing, buffering, error })
		const art = nodes(view).filter(n => n.type === 'MascotArt')
		assert.equal(art.length, mascot ? 1 : 0)
		assert.equal(art[0]?.props.state, mascot)
		assert.ok(text(view).includes(copy))
	}
})

void test('本地播放器显示离线来源且不开放B站来源动作', () => {
	const view = render(false, builtInThemes.modern, true)
	assert.match(text(view), /本地音乐/)
	assert.doesNotMatch(text(view), /私有副本|缓存|待核对/)
	assert.doesNotMatch(text(view), /Bilibili 音源/)
	const sourceControl = nodes(view).find(
		(node) => node.props.accessibilityLabel === '查看音源信息',
	)
	assert.equal(sourceControl, undefined)
	assert.equal(
		nodes(view).find((node) => node.type === 'MusicPlayerMenu')!.props.local,
		true,
	)
})

void test('local player heart uses real local ID and reflects liked state', () => {
	const ids: string[] = []
	const view = render(false, builtInThemes.modern, true, {
		localLiked: true,
		onLikeLocal: (id) => ids.push(id),
	})
	const heart = nodes(view).find(
		(n) => n.type === 'IconButton' && n.props.name === 'heart',
	)!
	assert.equal(heart.props.disabled, false)
	assert.equal(heart.props.active, true)
	assert.equal(heart.props.label, '取消喜欢当前音源')
	;(heart.props.onPress as () => void)()
	assert.deepEqual(ids, ['local:12345678-1234-1234-1234-123456789abc'])
})

void test('approved spacious cover preserves the real artwork and imported frame', () => {
	for (const theme of [
		...Object.values(builtInThemes),
		{ ...builtInThemes.modern },
	]) {
		const all = nodes(render(false, theme))
		const backing = all.find((n) => n.props.testID === 'player-cover-backing')
		assert.equal(!!backing, false)
		assert.equal(all.filter((n) => n.type === 'Artwork').length, 1)
		const art = all.find((n) => n.type === 'Artwork')!
		assert.equal(art.props.uri, '')
		assert.equal(art.props.fit, 'cover')
		const shadow = all.find((n) => n.props.testID === 'player-cover-shadow')!
		const style = shadow.props.style as Record<string, unknown>
		assert.equal(
			style.overflow,
			undefined,
			'soft shadow must not be clipped with the image',
		)
		assert.equal(style.width, 256)
		assert.equal(
			style.boxShadow,
			builtinVisuals.builtInVisuals(theme)?.softCover
				? `0px 14px 28px ${theme.tokens.text.primary}18`
				: undefined,
		)
	}
})
