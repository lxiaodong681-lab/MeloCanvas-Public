import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { builtInThemes, type ResolvedTheme } from '../core/theme'
import * as layout from '../core/theme-layout'
import type { ThemeControlTargetLayout } from '../theme-control-layout'
import type { ThemeRendering } from '../theme-renderer'

interface Node {
	type: string | ((props: Record<string, unknown>) => unknown)
	props: Record<string, unknown>
	key?: unknown
	children?: unknown
}
const flatten = (style: unknown): Record<string, unknown> =>
	Array.isArray(style)
		? Object.assign({}, ...style.map(flatten))
		: style && typeof style === 'object'
			? (style as Record<string, unknown>)
			: {}
const same = (a: readonly unknown[] | undefined, b: readonly unknown[]) =>
	!!a &&
	a.length === b.length &&
	a.every((value, index) => Object.is(value, b[index]))
function bind(ref: unknown, value: unknown): (() => void) | undefined {
	if (typeof ref === 'function') {
		const cleanup = ref(value)
		return typeof cleanup === 'function' ? (cleanup as () => void) : undefined
	}
	if (ref && typeof ref === 'object' && 'current' in ref) ref.current = value
}

/** Actual component; deterministic React/native lifecycle ports, no real keyboard. */
export function inputFixture() {
	const viewport = { width: 400, height: 800, fontScale: 1 }
	const context: {
		theme: ResolvedTheme
		rendering: ThemeRendering | null
		target: ThemeControlTargetLayout | null
	} = { theme: builtInThemes.modern, rendering: null, target: null }
	const slots: unknown[] = []
	const cleanups: (() => void)[] = []
	const effects = new Map<number, () => void | (() => void)>()
	let index = 0,
		pending: (() => void)[] = [],
		alive = true,
		writesAfterUnmount = 0
	let native: {
		path: string
		ref: unknown
		cleanup?: () => void
		handle: ReturnType<typeof createHandle>
	} | null = null
	const stats = { mounts: 0, unmounts: 0, focusCalls: 0, blurCalls: 0 }
	function createHandle() {
		let focused = false
		return {
			focus: () => {
				focused = true
				stats.focusCalls++
			},
			blur: () => {
				focused = false
				stats.blurCalls++
			},
			isFocused: () => focused,
		}
	}
	const react = {
		createElement(
			type: Node['type'],
			props: Node['props'] | null,
			...children: unknown[]
		): Node {
			const { key, ...rest } = props ?? {}
			return {
				type,
				key,
				props: {
					...rest,
					...(children.length
						? { children: children.length === 1 ? children[0] : children }
						: {}),
				},
			}
		},
		useState(initial: unknown) {
			const id = index++
			if (!(id in slots))
				slots[id] = typeof initial === 'function' ? initial() : initial
			return [
				slots[id],
				(next: unknown) => {
					if (!alive) writesAfterUnmount++
					slots[id] = typeof next === 'function' ? next(slots[id]) : next
				},
			]
		},
		useRef(initial: unknown) {
			const id = index++
			if (!(id in slots)) slots[id] = { current: initial }
			return slots[id]
		},
		useMemo(factory: () => unknown, deps: readonly unknown[]) {
			const id = index++,
				old = slots[id] as
					| { deps: readonly unknown[]; value: unknown }
					| undefined
			if (!old || !same(old.deps, deps)) slots[id] = { deps, value: factory() }
			return (slots[id] as { value: unknown }).value
		},
		useLayoutEffect(
			this: void,
			effect: () => void | (() => void),
			deps: readonly unknown[],
		) {
			const id = index++,
				old = slots[id] as readonly unknown[] | undefined
			if (!same(old, deps)) {
				slots[id] = deps
				effects.set(id, effect)
				pending.push(() => {
					cleanups[id]?.()
					cleanups[id] = effect() || (() => {})
				})
			}
		},
	}
	const output: Record<string, unknown> = {}
	runInNewContext(
		ts.transpileModule(
			readFileSync(new URL('../theme-input.tsx', import.meta.url), 'utf8'),
			{
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					module: ts.ModuleKind.CommonJS,
					jsx: ts.JsxEmit.React,
				},
			},
		).outputText,
		{
			exports: output,
			require: (path: string) => {
				if (path === 'react')
					return {
						__esModule: true,
						default: react,
						...react,
						useEffect: react.useLayoutEffect,
						useCallback: (callback: unknown, deps: readonly unknown[]) =>
							react.useMemo(() => callback, deps),
					}
				if (path === 'react-native')
					return {
						TextInput: 'TextInput',
						Text: 'Text',
						View: 'View',
						StyleSheet: {
							flatten,
						},
						useWindowDimensions: () => ({ ...viewport }),
					}
				if (path === './ui')
					return {
						useTheme: () => context.theme,
						useThemeRendering: () => context.rendering,
					}
				if (path === './theme-control-layout')
					return { useThemeControlTarget: () => context.target }
				if (path === './core/theme-layout') return layout
				throw new Error(`Unexpected input dependency ${path}`)
			},
		},
	)
	function unbind() {
		if (!native) return
		if (native.cleanup) native.cleanup()
		else bind(native.ref, null)
	}
	function find(view: unknown, type: string): Node[] {
		if (Array.isArray(view)) return view.flatMap((child) => find(child, type))
		if (!view || typeof view !== 'object' || !('type' in view)) return []
		const node = view as Node
		return [
			...(node.type === type ? [node] : []),
			...find(node.props.children, type),
		]
	}
	function inputPath(view: unknown, path = 'root'): string | null {
		if (Array.isArray(view)) {
			for (const [i, child] of view.entries()) {
				const found = inputPath(child, `${path}/${i}`)
				if (found) return found
			}
			return null
		}
		if (!view || typeof view !== 'object' || !('type' in view)) return null
		const node = view as Node,
			own = `${path}:${String(node.type)}:${String(node.key)}`
		return node.type === 'TextInput' ? own : inputPath(node.props.children, own)
	}
	return {
		viewport,
		context,
		stats,
		flatten,
		find,
		render(props: Record<string, unknown> = {}) {
			index = 0
			pending = []
			const view = (
					output.ThemeTextInput as (value: Record<string, unknown>) => Node
				)(props),
				input = find(view, 'TextInput')[0],
				path = inputPath(view)!
			if (native && (!input || native.path !== path)) {
				unbind()
				native = null
				stats.unmounts++
			}
			if (input) {
				if (!native) {
					native = { path, ref: input.props.ref, handle: createHandle() }
					stats.mounts++
					native.cleanup = bind(native.ref, native.handle)
					if (input.props.autoFocus && input.props.editable !== false)
						native.handle.focus()
				} else if (native.ref !== input.props.ref) {
					unbind()
					native.ref = input.props.ref
					native.cleanup = bind(native.ref, native.handle)
				}
			}
			for (const effect of pending) effect()
			return view
		},
		get handle() {
			return native?.handle
		},
		get writesAfterUnmount() {
			return writesAfterUnmount
		},
		replayEffects() {
			for (const cleanup of cleanups) cleanup?.()
			for (const [id, effect] of effects) cleanups[id] = effect() || (() => {})
		},
		unmount() {
			alive = false
			for (const cleanup of cleanups) cleanup?.()
			if (native) {
				unbind()
				native = null
				stats.unmounts++
			}
		},
	}
}
