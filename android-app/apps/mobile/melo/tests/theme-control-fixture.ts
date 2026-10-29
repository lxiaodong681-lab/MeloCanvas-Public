import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve as resolvePath } from 'node:path'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import * as chapters from '../../src/features/player/utils/chapters'
import * as builtinVisuals from '../core/builtin-visuals'
import * as localAudio from '../core/local-audio'
import * as musicLibrarySource from '../core/music-library-source'
import * as theme from '../core/theme'
import * as themeAppearance from '../core/theme-appearance'
import * as layout from '../core/theme-layout'
import {
	packageCapabilities,
	validateThemePackage,
} from '../core/theme-package'
import { adaptPackageTheme } from '../core/theme-package-adapter'
import type { ThemeImageDecoder } from '../core/theme-package-types'
import * as listeningChapters from '../listening-chapters'
import * as bilibiliSubtitles from '../bilibili-subtitles'
import * as lyrics from '../lyrics'
import * as onlineLyricsCache from '../online-lyrics-cache'
import * as onlineLyricsRanking from '../online-lyrics-ranking'
import * as rendering from '../theme-renderer'

export interface ControlNode {
	type:
		| string
		| ((props: Record<string, unknown>) => unknown)
		| { context: object }
	props: Record<string, unknown>
	key: string | number | undefined
	children?: unknown[]
}
type Frame = { slots: unknown[]; index: number; cleanup: (() => void)[] }

const flatten = (style: unknown): Record<string, unknown> =>
	Array.isArray(style)
		? Object.assign({}, ...style.map(flatten))
		: style && typeof style === 'object'
			? (style as Record<string, unknown>)
			: {}
const same = (
	left: readonly unknown[] | undefined,
	right: readonly unknown[],
) =>
	!!left &&
	left.length === right.length &&
	left.every((value, index) => Object.is(value, right[index]))

/** Actual TSX with deterministic React/RN ports; this does not measure a device. */
export function controlFixture(
	sources: Readonly<Record<string, string>> = {},
	dependencies: Readonly<Record<string, unknown>> = {},
	listWindow?: { start: number; count: number },
) {
	const viewport = { width: 360, height: 800, fontScale: 1 }
	const animationFrames = new Map<number, () => void>()
	let nextFrame = 0
	const contexts = new Map<object, unknown>(),
		frames = new Map<string, Frame>()
	const effectSetups = new WeakMap<
		Frame,
		Map<number, () => void | (() => void)>
	>()
	let active!: Frame,
		seen = new Set<string>(),
		pending: (() => void)[] = []
	let writesAfterUnmount = 0,
		mounted = true
	const modules = new Map<string, Record<string, unknown>>()
	const react = {
		Fragment: 'Fragment',
		isValidElement: (value: unknown) =>
			!!value && typeof value === 'object' && 'type' in value,
		Children: {
			toArray: (value: unknown): unknown[] =>
				(Array.isArray(value) ? value.flat(Infinity) : [value])
					.filter(
						(item) => item !== null && item !== undefined && item !== false,
					)
					.map((item, index) =>
						item && typeof item === 'object' && 'type' in item
							? { ...item, key: (item as ControlNode).key ?? `.${index}` }
							: item,
					),
		},
		createElement(
			this: void,
			type: ControlNode['type'],
			props: Record<string, unknown> | null,
			...children: unknown[]
		): ControlNode {
			const { key, ...rest } = props ?? {}
			return {
				type,
				key:
					typeof key === 'number' || typeof key === 'string' ? key : undefined,
				props: {
					...rest,
					...(children.length
						? { children: children.length === 1 ? children[0] : children }
						: {}),
				},
			}
		},
		createContext(value: unknown) {
			const context = { value, Provider: {} as { context: object } }
			context.Provider = { context }
			return context
		},
		useContext(context: { value: unknown }) {
			return contexts.has(context) ? contexts.get(context) : context.value
		},
		useState(initial: unknown) {
			const frame = active,
				index = frame.index++
			if (!(index in frame.slots))
				frame.slots[index] = typeof initial === 'function' ? initial() : initial
			return [
				frame.slots[index],
				(value: unknown) => {
					if (!mounted) writesAfterUnmount++
					frame.slots[index] =
						typeof value === 'function'
							? (value as (old: unknown) => unknown)(frame.slots[index])
							: value
				},
			]
		},
		useRef(initial: unknown) {
			const frame = active,
				index = frame.index++
			if (!(index in frame.slots)) frame.slots[index] = { current: initial }
			return frame.slots[index]
		},
		useMemo(factory: () => unknown, deps: readonly unknown[]) {
			const frame = active,
				index = frame.index++,
				old = frame.slots[index] as
					| { deps: readonly unknown[]; value: unknown }
					| undefined
			if (!old || !same(old.deps, deps))
				frame.slots[index] = { deps, value: factory() }
			return (frame.slots[index] as { value: unknown }).value
		},
		useCallback(callback: unknown, deps: readonly unknown[]) {
			return react.useMemo(() => callback, deps)
		},
		useEffect(
			this: void,
			effect: () => void | (() => void),
			deps: readonly unknown[],
		) {
			const frame = active,
				index = frame.index++,
				old = frame.slots[index] as readonly unknown[] | undefined
			if (!same(old, deps)) {
				frame.slots[index] = deps
				pending.push(() => {
					frame.cleanup[index]?.()
					let setups = effectSetups.get(frame)
					if (!setups) effectSetups.set(frame, (setups = new Map()))
					setups.set(index, effect)
					frame.cleanup[index] = effect() || (() => {})
				})
			}
		},
		useSyncExternalStore(
			subscribe: (listener: () => void) => () => void,
			getSnapshot: () => unknown,
		) {
			react.useEffect(() => subscribe(() => {}), [subscribe])
			return getSnapshot()
		},
	}
	const native = {
		BackHandler: { addEventListener: () => ({ remove() {} }) },
		View: 'View',
		Text: 'Text',
		Pressable: 'Pressable',
		ScrollView: 'ScrollView',
		FlatList: 'FlatList',
		Modal: 'Modal',
		KeyboardAvoidingView: 'KeyboardAvoidingView',
		Platform: { OS: 'android' },
		TextInput: 'TextInput',
		Switch: 'Switch',
		ActivityIndicator: 'ActivityIndicator',
		StyleSheet: { flatten, create: (value: unknown) => value },
		useWindowDimensions: () => ({ ...viewport }),
	}
	function load(name: string): Record<string, unknown> {
		if (modules.has(name)) return modules.get(name)!
		const output: Record<string, unknown> = {}
		modules.set(name, output)
		const source =
			sources[name] ??
			readFileSync(
				new URL(
					`../${name}.${['playlist-scroll', 'usePlaybackProgress'].includes(name) ? 'ts' : 'tsx'}`,
					import.meta.url,
				),
				'utf8',
			)
		runInNewContext(
			ts.transpileModule(source, {
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					module: ts.ModuleKind.CommonJS,
					jsx: ts.JsxEmit.React,
				},
			}).outputText,
			{
				exports: output,
				Error,
				AbortController,
				setInterval,
				clearInterval,
				requestAnimationFrame: (callback: () => void) => {
					const id = ++nextFrame
					animationFrames.set(id, callback)
					return id
				},
				cancelAnimationFrame: (id: number) => animationFrames.delete(id),
				require: (path: string): unknown => {
					if (Object.hasOwn(dependencies, path)) return dependencies[path]
					if (path === './useAppearance') return { useAppearance: () => ({ preference: 'system', ready: true, saving: false, error: null, mode: 'light', set: async () => {} }) }
					if (path === 'react-native-safe-area-context')
						return {
							useSafeAreaInsets: () => ({
								top: 24,
								bottom: 24,
								left: 0,
								right: 0,
							}),
						}
					if (path === 'react')
						return {
							__esModule: true,
							default: react,
							...react,
							useLayoutEffect: react.useEffect,
						}
					if (path === 'react-native') return native
					if (path === 'expo-image') return { Image: 'Image' }
					if (path === 'expo-system-ui') return { setBackgroundColorAsync: async () => {} }
					if (path === 'expo-linear-gradient')
						return { LinearGradient: 'LinearGradient' }
					if (path === 'react-native-svg')
						return {
							__esModule: true,
							default: 'Svg',
							Path: 'Path',
							Defs: 'Defs',
							LinearGradient: 'LinearGradient',
							Stop: 'Stop',
							Rect: 'Rect',
							Circle: 'Circle',
							Ellipse: 'Ellipse',
							G: 'G',
							Text: 'SvgText',
						}
					if (path === './account-access') return {useAccountAccess:()=>({onlineAllowed:true,sessionGeneration:1}),getAccountAccess:()=>({onlineAllowed:true,sessionGeneration:1})}
					if (path === './lyrics') return lyrics
					if (path === './online-lyrics-cache') return onlineLyricsCache
					if (path === './online-lyrics-ranking') return onlineLyricsRanking
					if (path === './online-lyrics-mobile')
						return {
							onlineLyricsService: {
								match: () => new Promise(() => {}),
								search: async () => ({ candidates: [], unavailable: [] }),
								load: async () => {
									throw new Error('fixture has no selected online lyric')
								},
							},
						}
					if (path === './lyrics-mobile')
						return { pickLyrics: async () => null }
					if (path === './listening-chapters') return listeningChapters
					if (path === './bilibili-subtitles') return bilibiliSubtitles
					if (path === './listening-subtitles') return {
						createListeningSubtitlesSession() {
							throw new Error('Subtitle entry tests must inject the real session with explicit account/transport ports')
						},
					}
					if (path === '../src/features/player/utils/chapters') return chapters
					if (path === './core/local-audio') return localAudio
					if (path === './core/music-library-source') return musicLibrarySource
					if (path === './core/theme') return theme
					if (path === './core/theme-appearance') return themeAppearance
					if (path === './appearance-ui') return load('appearance-ui')
					if (path === './core/builtin-visuals') return builtinVisuals
					if (path === './core/theme-layout') return layout
					if (path === './theme-renderer') return rendering
					if (path.startsWith('./assets/')) return path
					if (
						[
							'./ui',
							'./mascot-art',
							'./startup-ui',
							'./theme-dialog',
							'./theme-subpage',
							'./settings-layout',
							'./account-welcome-art',
							'./playlist-scroll',
							'./usePlaybackProgress',
							'./page-scroll-host',
							'./library-collection-ui',
							'./theme-control-layout',
							'./progress',
							'./music-ui',
							'./lyrics-ui',
							'./music-player-menu',
							'./listening-ui',
							'./listening-chapters-ui',
							'./listening-subtitles-ui',
							'./listening-sleep-ui',
							'./app-controls',
							'./host-controls',
						].includes(path)
					)
						return load(path.slice(2))
					throw new Error(`Unexpected theme control dependency ${path}`)
				},
			},
		)
		return output
	}
	function resolve(value: unknown, path: string): unknown {
		if (Array.isArray(value))
			return value.map((item, index) => resolve(item, `${path}/${index}`))
		if (!value || typeof value !== 'object' || !('type' in value)) return value
		const element = value as ControlNode,
			id = `${path}:${String(element.key ?? '')}`
		if (typeof element.type === 'object') {
			const context = element.type.context,
				previous = contexts.get(context),
				had = contexts.has(context)
			contexts.set(context, element.props.value)
			const result = resolve(element.props.children, `${id}/provider`)
			if (had) contexts.set(context, previous)
			else contexts.delete(context)
			return result
		}
		if (typeof element.type === 'function') {
			const frameId = `${id}/${element.type.name}`
			if (!frames.has(frameId))
				frames.set(frameId, { slots: [], index: 0, cleanup: [] })
			seen.add(frameId)
			active = frames.get(frameId)!
			active.index = 0
			const output = element.type(element.props)
			return resolve(output, frameId)
		}
		const contents =
			element.type === 'FlatList'
				? [
						element.props.ListHeaderComponent,
						...((element.props.data as unknown[])?.length
							? (element.props.data as unknown[])
									.slice(
										listWindow?.start ?? 0,
										listWindow
											? listWindow.start + listWindow.count
											: undefined,
									)
									.map((item, index) =>
										(
											element.props.renderItem as (info: {
												item: unknown
												index: number
											}) => unknown
										)({ item, index: index + (listWindow?.start ?? 0) }),
									)
							: [element.props.ListEmptyComponent]),
						element.props.ListFooterComponent,
					]
				: element.props.children
		return {
			...element,
			children: [resolve(contents, `${id}/children`)],
		}
	}
	return {
		load,
		flushAnimationFrames() {
			const framesToRun = [...animationFrames.values()]
			animationFrames.clear()
			for (const callback of framesToRun) callback()
		},
		get pendingAnimationFrames() {
			return animationFrames.size
		},
		viewport,
		flatten,
		element: react.createElement,
		render(element: unknown) {
			seen = new Set()
			pending = []
			const result = resolve(element, 'root')
			for (const [key, frame] of frames)
				if (!seen.has(key)) {
					for (const cleanup of frame.cleanup) cleanup?.()
					frames.delete(key)
				}
			for (const effect of pending) effect()
			return result
		},
		unmount() {
			mounted = false
			for (const frame of frames.values())
				for (const cleanup of frame.cleanup) cleanup?.()
			frames.clear()
		},
		/** Explicit effect-only replay port; does not inject new native layout events. */
		replayEffects() {
			for (const frame of frames.values())
				for (const cleanup of frame.cleanup) cleanup?.()
			for (const frame of frames.values())
				for (const [index, setup] of effectSetups.get(frame) ?? [])
					frame.cleanup[index] = setup() || (() => {})
		},
		get writesAfterUnmount() {
			return writesAfterUnmount
		},
	}
}

export function controlNodes(value: unknown): ControlNode[] {
	if (Array.isArray(value)) return value.flatMap(controlNodes)
	if (!value || typeof value !== 'object' || !('type' in value)) return []
	const node = value as ControlNode
	return [node, ...controlNodes(node.children)]
}
export function measureControl(view: unknown, width: number) {
	const measured = controlNodes(view).filter(
		(node) => typeof node.props.onLayout === 'function',
	)
	assert.ok(measured.length)
	;(measured[0].props.onLayout as (event: unknown) => void)({
		nativeEvent: { layout: { width } },
	})
}

/** Existing resource-indexed fixture, fully ZIP/hash/pixel validated before adaptation. */
export async function legacyControlPackage() {
	const root = resolvePath(__dirname, '../../../../..')
	const host = { appVersion: '0.4.0', capabilities: [...packageCapabilities] }
	const decoder = (
		createRequire(join(root, 'scripts/theme-package.cjs'))(
			'./lib/theme-package-node.cjs',
		) as {
			createNodeImageDecoder(): ThemeImageDecoder
		}
	).createNodeImageDecoder()
	const verified = await validateThemePackage(
		readFileSync(join(root, 'theme-packages/paper-signal.melotheme')),
		host,
		decoder,
	)
	const privateThemesRootUri = 'file:///private/themes/'
	const rootUri = `${privateThemesRootUri}${verified.manifest.id}/${verified.snapshot.package.archiveSha256}/`
	const resources = verified.snapshot.resources.map((resource) => ({
		path: resource.path,
		sha256: resource.sha256,
		uri: `${rootUri}${resource.path}`,
	}))
	const adapted = adaptPackageTheme(
		verified,
		{ package: verified.snapshot.package, rootUri, resources },
		{ host, privateThemesRootUri, mode: 'light' },
	)
	assert.equal(adapted.retained.buttonMinTouchDp, 48)
	assert.equal(adapted.retained.controlRowLayout, undefined)
	return {
		adapted,
		allowedImageUris: resources.map((resource) => resource.uri),
	}
}
