import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { builtInThemes } from '../core/theme'
import type { FollowingFeedPage } from '../following-feed-ui'

import { feedFixture } from './following-feed-fixture'

interface View {
	type: string
	props: Record<string, unknown>
	children: unknown[]
}
function harness() {
	const f = feedFixture(),
		refs: { current: unknown }[] = [],
		commands: { offset: number; animated: boolean }[] = []
	const frames = new Map<number, () => void>()
	const layoutCommit: { effect?: () => void } = {}
	const callbacks: { value: unknown; deps: unknown[] }[] = []
	const memoValues: { value: unknown; deps: unknown[] }[] = []
	let cursor = 0,
		callbackCursor = 0,
		memoCursor = 0,
		sequence = 0,
		cleanup: (() => void) | undefined,
		dependencies: unknown[] | undefined,
		view: View
	const react = {
		createElement: (
			type: string | ((props: Record<string, unknown>) => unknown),
			props: Record<string, unknown>,
			...children: unknown[]
		) =>
			typeof type === 'function'
				? type({ ...props, children })
				: { type, props: props ?? {}, children },
		Fragment: 'Fragment',
	}
	const output: { FollowingFeedPage?: typeof FollowingFeedPage } = {}
	runInNewContext(
		ts.transpileModule(
			readFileSync(
				new URL('../following-feed-ui.tsx', import.meta.url),
				'utf8',
			),
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
			requestAnimationFrame: (callback: () => void) => {
				const id = ++sequence
				frames.set(id, callback)
				return id
			},
			cancelAnimationFrame: (id: number) => frames.delete(id),
			require: (name: string) => {
				if (name === 'react')
					return {
						__esModule: true,
						default: react,
						...react,
						useState: (value: unknown) => [value, () => {}],
						useMemo: (factory: () => unknown, deps: unknown[]) => {
							const index = memoCursor++,
								previous = memoValues[index]
							if (
								!previous ||
								deps.some((value, at) => value !== previous.deps[at])
							)
								memoValues[index] = { value: factory(), deps }
							return memoValues[index].value
						},
						useCallback: (callback: unknown, deps: unknown[]) => {
							const index = callbackCursor++,
								previous = callbacks[index]
							if (
								!previous ||
								deps.some((value, at) => value !== previous.deps[at])
							)
								callbacks[index] = { value: callback, deps }
							return callbacks[index].value
						},
						useRef: (value: unknown) =>
							refs[cursor++] ?? (refs[cursor - 1] = { current: value }),
						useLayoutEffect: (effect: () => () => void, deps: unknown[]) => {
							if (
								!dependencies ||
								deps.some((value, index) => value !== dependencies![index])
							)
								layoutCommit.effect = () => {
									cleanup?.()
									dependencies = deps
									cleanup = effect()
								}
						},
					}
				if (name === 'react-native')
					return { FlatList: 'FlatList', Pressable: 'Pressable', View: 'View' }
				if (name === './creator-ui')
					return {
						creatorScopeLabel: {
							all: '全部投稿',
							music: '音乐投稿',
							listening: '听视频内容',
						},
					}
				if (name === './library-collection-ui')
					return { CollectionMenu: 'CollectionMenu' }
				if (name === './ui')
					return {
						useTheme: () => builtInThemes.modern,
						useThemeRendering: () => null,
						ControlRow: 'View',
						ControlTarget: 'Pressable',
						shape: () => ({}),
						time: String,
						Artwork: 'Artwork',
						Button: 'Button',
						Card: 'Card',
						IconButton: 'IconButton',
						State: 'State',
						T: 'T',
					}
				throw new Error(name)
			},
		},
	)
	assert.ok(output.FollowingFeedPage)
	const commitLayout = () => layoutCommit.effect?.()
	const render = (commit = true) => {
		cursor = 0
		callbackCursor = 0
		memoCursor = 0
		layoutCommit.effect = undefined
		view = output.FollowingFeedPage!({
			state: f.session.getSnapshot(),
			session: f.session,
			onCreator: () => {},
			onManage: () => {},
			onPlay: () => {},
			onSearch: () => {},
		}) as unknown as View
		const ref = view.props.ref as { current: unknown } | undefined
		if (commit && ref)
			ref.current = {
				scrollToOffset: (command: { offset: number; animated: boolean }) =>
					commands.push(command),
			}
		if (commit) commitLayout()
		return view
	}
	const call = (name: string, ...args: unknown[]) => {
		const callback = view.props[name]
		assert.equal(typeof callback, 'function', `Missing actual ${name}`)
		;(callback as (...values: unknown[]) => void)(...args)
	}
	const scroll = (y: number) =>
		call('onScroll', { nativeEvent: { contentOffset: { y } } })
	const layout = (height: number) =>
		call('onLayout', { nativeEvent: { layout: { height } } })
	const content = (height: number) => call('onContentSizeChange', 400, height)
	const frame = () => {
		const pending = [...frames.values()]
		frames.clear()
		for (const callback of pending) callback()
	}
	return {
		...f,
		render,
		call,
		scroll,
		layout,
		content,
		frame,
		commands,
		frames,
		unmount: () => cleanup?.(),
		replayLayout: () => {
			cleanup?.()
			dependencies = undefined
			return render()
		},
		remount: () => {
			cleanup?.()
			refs.length = 0
			callbacks.length = 0
			memoValues.length = 0
			dependencies = undefined
			cleanup = undefined
			return render()
		},
	}
}

void test('initial zero/clamped scroll cannot overwrite a saved offset on actual component remount', () => {
	const h = harness()
	try {
		h.session.open()
		h.session.setFilter('music')
		h.session.rememberScroll(96)
		h.render()
		h.scroll(0)
		h.scroll(16)
		assert.equal(h.session.getScrollOffset(), 96)
		h.layout(600)
		h.frame()
		assert.equal(h.commands.length, 0)
		h.content(696)
		h.frame()
		assert.equal(h.commands.at(-1)!.offset, 96)
		assert.equal(h.commands.at(-1)!.animated, false)
		h.scroll(96)
		h.scroll(75) // No drag: normal accessibility/keyboard scroll must still save.
		assert.equal(h.session.getScrollOffset(), 75)
	} finally {
		h.unmount()
		h.raw.close()
	}
})

void test('content-first readiness and growing content restore the original target after an initial clamp', () => {
	const h = harness()
	try {
		h.session.open()
		h.session.rememberScroll(96)
		h.render()
		h.content(616)
		h.frame()
		assert.equal(h.commands.length, 0)
		h.layout(600)
		h.frame()
		assert.equal(h.commands.at(-1)!.offset, 16)
		h.scroll(16)
		assert.equal(h.session.getScrollOffset(), 96)
		h.content(750)
		h.scroll(0)
		h.frame()
		assert.equal(h.commands.at(-1)!.offset, 96)
		h.scroll(96)
		h.scroll(110)
		assert.equal(h.session.getScrollOffset(), 110)
	} finally {
		h.unmount()
		h.raw.close()
	}
})

void test('user drag can take over before restore; old-filter and unmounted callbacks cannot write a new filter', () => {
	const h = harness()
	try {
		h.session.open()
		h.session.rememberScroll(96)
		const previous = h.render()
		h.layout(600)
		h.content(800)
		h.call('onScrollBeginDrag', { nativeEvent: { contentOffset: { y: 20 } } })
		h.frame()
		assert.equal(h.commands.length, 0)
		h.scroll(35)
		assert.equal(h.session.getScrollOffset(), 35)
		h.session.setFilter('music')
		h.session.rememberScroll(60)
		h.render()
		;(previous.props.onScroll as (event: unknown) => void)({
			nativeEvent: { contentOffset: { y: 500 } },
		})
		assert.equal(h.session.getScrollOffset(), 60)
		h.layout(600)
		h.content(800)
		h.unmount()
		h.frame()
		assert.equal(h.commands.length, 0)
		h.scroll(0)
		assert.equal(h.session.getScrollOffset(), 60)
		h.session.setFilter('all')
		assert.equal(h.session.getScrollOffset(), 35)
	} finally {
		h.raw.close()
	}
})

void test('zero target does not wait for an impossible zero-to-zero acknowledgement', () => {
	const h = harness()
	try {
		h.session.open()
		h.render()
		h.layout(600)
		h.content(800)
		h.frame()
		h.scroll(45)
		assert.equal(h.session.getScrollOffset(), 45)
	} finally {
		h.unmount()
		h.raw.close()
	}
})

void test('old filter callbacks cannot write or command after a synchronous filter change before render', () => {
	const h = harness()
	try {
		h.session.open()
		h.session.rememberScroll(96)
		h.render()
		h.layout(600)
		h.content(1000)
		h.frame()
		h.scroll(96)
		h.session.setFilter('music')
		h.session.rememberScroll(60)
		h.scroll(500)
		assert.equal(h.session.getScrollOffset(), 60)
		h.call('onScrollBeginDrag', { nativeEvent: { contentOffset: { y: 501 } } })
		assert.equal(h.session.getScrollOffset(), 60)
		h.layout(650)
		h.content(1200)
		h.frame()
		assert.equal(h.commands.length, 1)
		h.render()
		h.layout(600)
		h.content(1000)
		h.frame()
		assert.equal(h.commands.at(-1)!.offset, 60)
	} finally {
		h.unmount()
		h.raw.close()
	}
})

void test('uncommitted render does not clean an owner; queued frames recheck live filter and closed state', () => {
	const h = harness()
	try {
		h.session.open()
		h.session.rememberScroll(96)
		h.render()
		h.layout(600)
		h.content(1000)
		assert.equal(h.frames.size, 1)
		h.session.setFilter('music')
		h.session.rememberScroll(60)
		h.render(false) // A concurrent render which never commits must not clean the old effect.
		assert.equal(h.frames.size, 1)
		h.frame()
		assert.equal(h.commands.length, 0)
		h.scroll(500)
		assert.equal(h.session.getScrollOffset(), 60)
		h.render()
		h.layout(600)
		h.content(1000)
		h.session.close()
		h.frame()
		assert.equal(h.commands.length, 0)
		h.scroll(500)
		assert.equal(h.session.getScrollOffset(), 60)
	} finally {
		h.unmount()
		h.raw.close()
	}
})

void test('layout effect replay cleans old frames and installs a usable owner without render ref access', () => {
	const h = harness()
	try {
		h.session.open()
		h.session.rememberScroll(96)
		h.render()
		h.layout(600)
		h.content(1000)
		assert.equal(h.frames.size, 1)
		h.replayLayout()
		assert.equal(h.frames.size, 1)
		h.scroll(0)
		assert.equal(h.session.getScrollOffset(), 96)
		// StrictMode effect-only replay does not guarantee another native size event.
		h.frame()
		assert.equal(h.commands.length, 1)
		h.scroll(96)
		h.scroll(80)
		assert.equal(h.session.getScrollOffset(), 80)
	} finally {
		h.unmount()
		h.raw.close()
	}
})

void test('old all-filter callbacks cannot regain ownership after all to music to all', () => {
	const h = harness()
	try {
		h.session.open()
		h.session.rememberScroll(96)
		const old = h.render()
		h.layout(600)
		h.content(1000)
		h.frame()
		h.scroll(96)
		h.session.setFilter('music')
		h.render()
		h.session.setFilter('all')
		h.render()
		h.layout(600)
		h.content(1000)
		h.frame()
		h.scroll(96)
		;(old.props.onScrollBeginDrag as (event: unknown) => void)({
			nativeEvent: { contentOffset: { y: 500 } },
		})
		assert.equal(h.session.getScrollOffset(), 96)
		;(old.props.onScroll as (event: unknown) => void)({
			nativeEvent: { contentOffset: { y: 501 } },
		})
		assert.equal(h.session.getScrollOffset(), 96)
		h.scroll(80)
		assert.equal(h.session.getScrollOffset(), 80)
	} finally {
		h.unmount()
		h.raw.close()
	}
})

for (const eventName of ['onScrollEndDrag', 'onMomentumScrollEnd']) {
	void test(`${eventName} saves the short music-filter gesture tail before player remount`, () => {
		const h = harness()
		try {
			h.session.open()
			h.session.setFilter('music')
			const view = h.render()
			h.layout(644)
			h.content(867)
			h.frame()
			h.call('onScrollBeginDrag', { nativeEvent: { contentOffset: { y: 0 } } })
			h.scroll(16.5)
			h.scroll(127.5)
			// Actual diagnostic sequence stops ordinary SCROLL at127.5. The native
			// end event carries the final position, independently of SCROLL throttle.
			;(view.props[eventName] as ((event: unknown) => void) | undefined)?.({
				nativeEvent: { contentOffset: { y: 223 } },
			})
			assert.equal(h.session.getScrollOffset(), 223)
			h.remount()
			h.layout(644)
			h.content(867)
			h.frame()
			assert.equal(h.commands.at(-1)!.offset, 223)
		} finally {
			h.unmount()
			h.raw.close()
		}
	})

	void test(`${eventName} preserves active restoration and stale visits cannot write`, () => {
		const h = harness()
		try {
			h.session.open()
			h.session.rememberScroll(96)
			const old = h.render()
			h.layout(600)
			h.content(1000)
			assert.equal(h.frames.size, 1)
			h.call(eventName, { nativeEvent: { contentOffset: { y: 40 } } })
			assert.equal(h.frames.size, 1)
			h.frame()
			assert.equal(h.commands.at(-1)!.offset, 96)
			assert.equal(h.session.getScrollOffset(), 96)
			h.content(616)
			h.frame()
			h.scroll(16)
			h.call(eventName, { nativeEvent: { contentOffset: { y: 16 } } })
			assert.equal(h.session.getScrollOffset(), 96)
			h.content(1000)
			assert.equal(h.frames.size, 1)
			h.call('onScrollBeginDrag', { nativeEvent: { contentOffset: { y: 40 } } })
			assert.equal(h.frames.size, 0)
			h.call(eventName, { nativeEvent: { contentOffset: { y: 45 } } })
			assert.equal(h.session.getScrollOffset(), 45)
			h.session.setFilter('music')
			h.session.rememberScroll(60)
			const end = old.props[eventName] as (event: unknown) => void
			const late = () => end({ nativeEvent: { contentOffset: { y: 500 } } })
			late() // Synchronous filter change, before React render.
			assert.equal(h.session.getScrollOffset(), 60)
			h.render()
			h.session.setFilter('all')
			h.render()
			late() // all -> music -> all: old visit cannot regain authority.
			assert.equal(h.session.getScrollOffset(), 45)
			h.call('onScrollBeginDrag', { nativeEvent: { contentOffset: { y: 45 } } })
			h.call(eventName, { nativeEvent: { contentOffset: { y: 70 } } })
			assert.equal(h.session.getScrollOffset(), 70)
			h.session.pauseForOverlay()
			h.call(eventName, { nativeEvent: { contentOffset: { y: 501 } } })
			assert.equal(h.session.getScrollOffset(), 70)
			h.session.resumeFromOverlay()
			h.session.close()
			h.call(eventName, { nativeEvent: { contentOffset: { y: 502 } } })
			assert.equal(h.session.getScrollOffset(), 70)
			h.unmount()
			h.call(eventName, { nativeEvent: { contentOffset: { y: 501 } } })
			assert.equal(h.session.getScrollOffset(), 70)
		} finally {
			h.unmount()
			h.raw.close()
		}
	})
}

void test('expanded coverage survives player remount but an explicit page close/reopen keeps the old collapsed default', () => {
	const h = harness()
	try {
		h.session.open()
		h.session.setCoverageOpen(true)
		h.session.rememberScroll(300)
		h.render()
		h.layout(600)
		h.content(1000)
		h.frame()
		h.scroll(300)
		assert.equal(h.session.getSnapshot().coverageOpen, true)
		const returned = h.remount()
		assert.match(
			JSON.stringify(returned.props.ListHeaderComponent),
			/收起缓存范围/,
		)
		h.scroll(0)
		assert.equal(h.session.getScrollOffset(), 300)
		h.layout(600)
		h.content(1000)
		h.frame()
		assert.equal(h.commands.at(-1)!.offset, 300)
		h.session.setFilter('music')
		assert.equal(h.session.getSnapshot().coverageOpen, true)
		h.session.pauseForOverlay()
		h.session.resumeFromOverlay()
		assert.equal(h.session.getSnapshot().coverageOpen, true)
		h.session.close()
		h.session.open()
		assert.equal(h.session.getSnapshot().coverageOpen, false)
		assert.match(
			JSON.stringify(h.remount().props.ListHeaderComponent),
			/查看缓存范围与缺页/,
		)
	} finally {
		h.unmount()
		h.raw.close()
	}
})

void test('normal non-drag scrolling after a reachable clamp acknowledgement can take over a permanently shorter page', () => {
	const h = harness()
	try {
		h.session.open()
		h.session.rememberScroll(96)
		h.render()
		h.layout(600)
		h.content(616)
		h.frame()
		h.scroll(16)
		assert.equal(h.session.getScrollOffset(), 96)
		h.scroll(0)
		assert.equal(h.session.getScrollOffset(), 0)
		h.content(1000)
		h.frame()
		assert.equal(
			h.commands.length,
			1,
			'no automatic jump after a subsequent normal scroll took ownership',
		)
	} finally {
		h.unmount()
		h.raw.close()
	}
})
