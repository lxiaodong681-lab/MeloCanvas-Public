import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { AppearanceStore } from '../appearance-preference'
import { builtInThemes } from '../core/theme'
import {
	cosmosTheme,
	effectiveColorMode,
	themeAppearance,
} from '../core/theme-appearance'
import type { ThemePresentation } from '../core/theme-install-types'
import {
	ThemeWorkshopSession,
	themeWorkshopBusy,
} from '../theme-workshop-session'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const builtin: ThemePresentation = {
	selection: { kind: 'builtin', key: 'anime' },
	theme: builtInThemes.anime,
	adapted: null,
	packageMetadata: null,
	allowedImageUris: [],
}

void test('default follows the system, explicit choices ignore system changes and unknown system falls back to light', () => {
	assert.equal(effectiveColorMode('system', 'dark'), 'dark')
	assert.equal(effectiveColorMode('system', 'light'), 'light')
	assert.equal(effectiveColorMode('system', null), 'light')
	assert.equal(effectiveColorMode('dark', 'light'), 'dark')
	assert.equal(effectiveColorMode('light', 'dark'), 'light')
})

void test('preference persists across instances; restore is coalesced and never rereads on playback renders', async () => {
	let value: string | null = null,
		reads = 0
	const storage = {
		read: async () => {
			reads++
			return value
		},
		write: async (next: string) => {
			value = next
		},
	}
	const store = new AppearanceStore(storage)
	await Promise.all([store.restore(), store.restore()])
	assert.equal(store.getSnapshot().preference, 'system')
	await store.set('dark')
	for (let i = 0; i < 200; i++) await store.restore()
	assert.equal(reads, 1)
	assert.equal(value, 'dark')
	const next = new AppearanceStore(storage)
	await next.restore()
	assert.equal(next.getSnapshot().preference, 'dark')
})

void test('late initial read cannot replace a new choice; failed writes roll back and can be retried', async () => {
	let resolve!: (v: string) => void,
		fail = true
	const store = new AppearanceStore({
		read: () =>
			new Promise((yes) => {
				resolve = yes
			}),
		write: async () => {
			if (fail) throw new Error('disk full')
		},
	})
	const read = store.restore()
	await store.set('dark')
	assert.equal(store.getSnapshot().preference, 'system')
	assert.match(store.getSnapshot().error!, /未能保存/)
	fail = false
	await store.set('dark')
	resolve('light')
	await read
	assert.equal(store.getSnapshot().preference, 'dark')
	assert.equal(store.getSnapshot().error, null)
})

void test('read failure and invalid stored values are safe without rewriting the original record', async () => {
	let writes = 0
	for (const bad of [false, true]) {
		const store = new AppearanceStore({
			read: async () => {
				if (bad) throw new Error('locked')
				return 'invalid'
			},
			write: async () => {
				writes++
			},
		})
		await store.restore()
		assert.equal(store.getSnapshot().preference, 'system')
		assert.equal(store.getSnapshot().ready, true)
		assert.equal(!!store.getSnapshot().error, bad)
	}
	assert.equal(writes, 0)
})

void test('dark fallback removes light wallpaper and retains the exact durable selection; repeated toggles reuse objects', () => {
	for (const presentation of [
		builtin,
		{
			...builtin,
			selection: {
				kind: 'package' as const,
				id: 'example.wallpaper',
				archiveSha256: 'a'.repeat(64),
			},
			allowedImageUris: ['file:///wallpaper.png'],
		},
	]) {
		const before = JSON.stringify(presentation)
		const dark = themeAppearance(presentation, 'dark')
		assert.equal(dark.theme, cosmosTheme)
		assert.equal(dark.selection, presentation.selection)
		assert.equal(dark.theme.assets.backdrop, null)
		assert.deepEqual(dark.allowedImageUris, [])
		for (let i = 0; i < 1000; i++) {
			assert.equal(themeAppearance(presentation, 'dark'), dark)
			assert.equal(themeAppearance(presentation, 'light'), presentation)
		}
		assert.equal(JSON.stringify(presentation), before)
	}
})

void test('actual settings expose three accessible choices and recover on storage error without a player dependency', async () => {
	const store = new AppearanceStore({
		read: async () => 'system',
		write: async () => {
			throw new Error('full')
		},
	})
	await store.restore()
	const f = controlFixture(),
		Component = f.load('appearance-ui').AppearanceSetting as ControlNode['type']
	const Provider = f.load('ui').ThemeRendererProvider as ControlNode['type']
	const render = () =>
		f.render(
			f.element(
				Provider,
				{
					theme: cosmosTheme,
					adapted: null,
					allowedImageUris: [],
					reducedMotion: true,
				},
				f.element(Component, {
					appearance: { ...store.getSnapshot(), mode: 'light', set: store.set },
				}),
			),
		)
	const choices = controlNodes(render()).filter(
		(n) => n.props.accessibilityRole === 'radio',
	)
	assert.deepEqual(
		choices.map((n) => n.props.accessibilityLabel),
		['浅色', '深色', '跟随系统'],
	)
	;(choices[1].props.onPress as () => void)()
	assert.equal(store.getSnapshot().preference, 'dark')
	await tick()
	assert.equal(store.getSnapshot().preference, 'system')
	assert.match(JSON.stringify(render()), /外观设置未能保存/)
	f.unmount()
})

void test('actual appearance hook responds to system changes without repeated storage reads', async () => {
	let system = 'light',
		reads = 0
	const f = controlFixture(
		{
			useAppearance: readFileSync(
				new URL('../useAppearance.ts', import.meta.url),
				'utf8',
			),
		},
		{
			'./appearance-preference': { AppearanceStore },
			'react-native': { useColorScheme: () => system },
			'expo-secure-store': {
				getItemAsync: async () => {
					reads++
					return null
				},
				setItemAsync: async () => {},
			},
		},
	)
	const hook = f.load('useAppearance') as {
		useAppearance: () => { mode: string }
		appearanceStore: AppearanceStore
	}
	let mode = ''
	const component = () => {
		mode = hook.useAppearance().mode
		return null
	}
	const render = () => f.render(f.element(component, {}))
	render()
	await tick()
	render()
	assert.equal(mode, 'light')
	system = 'dark'
	render()
	assert.equal(mode, 'dark')
	await hook.appearanceStore.set('light')
	render()
	assert.equal(mode, 'light')
	await hook.appearanceStore.set('system')
	render()
	assert.equal(mode, 'dark')
	assert.equal(reads, 1)
	f.unmount()
})

void test('workshop preview explains the dark fallback, keeps the package selected and renders every reference page on black', () => {
	const dependencies: Record<string, unknown> = {
		'./theme-workshop-session': { themeWorkshopBusy },
		'./theme-author-ui': { ThemeAuthorEntry: 'AuthorEntry' },
		'./bilibili-theme-ui': { BilibiliThemeEntry: 'BilibiliEntry' },
	}
	const f = controlFixture({}, dependencies)
	dependencies['./theme-preview'] = f.load('theme-preview')
	const Panel = f.load('theme-package-panel')
		.ThemePackagePanel as ControlNode['type']
	const Provider = f.load('ui').ThemeRendererProvider as ControlNode['type']
	const session = new ThemeWorkshopSession({
		fallback: () => 'modern',
		create: async () => {
			throw new Error('must not load while rendering')
		},
		pick: async () => null,
		read: async () => new Uint8Array(),
	})
	const chosen: ThemePresentation = {
		...builtin,
		theme: { ...builtin.theme, name: '我的壁纸' },
		selection: {
			kind: 'package',
			id: 'example.wallpaper',
			archiveSha256: 'a'.repeat(64),
		},
	}
	const state = {
		...session.getSnapshot(),
		loading: false,
		current: chosen,
		installer: {
			phase: 'preview',
			current: chosen,
			preview: chosen,
			installed: [],
			revision: 1,
			canUndo: false,
			readOnly: false,
			error: null,
			cleanupErrors: [],
		},
	}
	const render = () =>
		f.render(
			f.element(
				Provider,
				{
					theme: cosmosTheme,
					adapted: null,
					allowedImageUris: [],
					reducedMotion: true,
				},
				f.element(Panel, {
					state,
					session,
					colorMode: 'dark',
					reducedMotion: true,
				}),
			),
		)
	try {
		assert.match(JSON.stringify(render()), /此主题没有深色配置/)
		assert.match(JSON.stringify(render()), /我的壁纸/)
		for (const [page, label] of [
			['home', '首页'],
			['player', '播放器'],
			['search', '搜索'],
			['error', '错误'],
		]) {
			const button = controlNodes(render()).find(
				(n) =>
					n.props.accessibilityRole === 'tab' &&
					n.props.accessibilityLabel === `预览${label}`,
			)!
			assert.ok(button)
			;(button.props.onPress as () => void)()
			const canvas = controlNodes(render()).find(
				(n) => n.props.testID === `theme-preview-${page}`,
			)!
			assert.equal(f.flatten(canvas.props.style).backgroundColor, '#000000')
		}
		assert.equal(state.current, chosen)
		assert.equal(state.installer.revision, 1)
	} finally {
		f.unmount()
		session.stop()
	}
})
