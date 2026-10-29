import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { builtInThemes, type ThemeKey } from '../core/theme'
import type { ThemePresentation } from '../core/theme-install-types'
import {
	ThemeWorkshopSession,
	themeWorkshopBusy,
} from '../theme-workshop-session'
import {
	projectWidgetTheme,
	WidgetThemeSync,
	type WidgetThemeResult,
} from '../widget-theme'

function current(key: ThemeKey = 'modern'): ThemePresentation {
	return {
		selection: { kind: 'builtin', key },
		theme: builtInThemes[key],
		adapted: null,
		packageMetadata: null,
		allowedImageUris: [],
	}
}
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

void test('three builtin projections retain actual tokens/host variants with exact selection/revision and no resources', () => {
	for (const key of ['modern', 'pastoral', 'anime'] as const) {
		const value = current(key),
			projected = projectWidgetTheme(value, 7)
		assert.deepEqual(projected.selection, { kind: 'builtin', key })
		assert.equal(projected.registryRevision, 7)
		assert.equal(projected.themeVersion, value.theme.version)
		assert.deepEqual(projected.colors, {
			card: value.theme.tokens.surface.card,
			textPrimary: value.theme.tokens.text.primary,
			textSecondary: value.theme.tokens.text.secondary,
			accent: value.theme.tokens.action.primary,
			border: value.theme.tokens.border.subtle,
		})
		assert.equal(projected.variants.card, value.theme.components.card)
		assert.equal(projected.variants.button, value.theme.components.button)
		assert.equal(projected.variants.progress, key)
		assert.equal(
			projected.decoration,
			key === 'modern' ? 'none' : key === 'pastoral' ? 'botanical' : 'stars',
		)
		assert.equal(projected.fallback, 'modern')
		assert.equal(JSON.stringify(projected).includes('assets'), false)
	}
})

void test('package identity and palette survive without third-party URI/artwork/capability claims or shared mutable tokens', () => {
	const value = structuredClone(current('pastoral'))
	value.selection = {
		kind: 'package',
		id: 'author.paper',
		archiveSha256: 'a'.repeat(64),
	}
	value.theme.tokens.action.primary = '#ABCDEF'
	value.allowedImageUris = ['file:///private/author.paper/asset.png']
	value.theme.assets.hero = 'file:///private/author.paper/asset.png'
	const projected = projectWidgetTheme(value, 8)
	assert.deepEqual(projected.selection, value.selection)
	assert.equal(projected.colors.accent, '#abcdef')
	assert.equal(projected.variants.card, 'leaf')
	assert.equal(projected.decoration, 'none')
	assert.doesNotMatch(
		JSON.stringify(projected),
		/file:|asset\.png|capabilities/,
	)
	projected.colors.accent = '#000000'
	assert.equal(value.theme.tokens.action.primary, '#ABCDEF')
	assert.notEqual(builtInThemes.pastoral.tokens.action.primary, '#ABCDEF')
})

void test('invalid revisions, identity, color and variants are refused rather than exported to native', () => {
	for (const revision of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
		assert.throws(() => projectWidgetTheme(current(), revision))
	const badColor = structuredClone(current())
	badColor.theme.tokens.surface.card = '#fff'
	assert.throws(() => projectWidgetTheme(badColor, 0), /颜色/)
	const badVariant = structuredClone(current())
	Object.assign(badVariant.theme.components, { card: 'unsupported' })
	assert.throws(() => projectWidgetTheme(badVariant, 0), /样式/)
	const badIdentity = current()
	badIdentity.selection = {
		kind: 'package',
		id: 'https://foreign',
		archiveSha256: 'a'.repeat(64),
	}
	assert.throws(() => projectWidgetTheme(badIdentity, 0), /身份/)
})

void test('A→B→A still sends three revisions; old successful/rejected native replies cannot overwrite the newest state', async () => {
	const requests: ReturnType<typeof deferred<WidgetThemeResult>>[] = [],
		payloads: string[] = []
	const sync = new WidgetThemeSync((json) => {
		payloads.push(json)
		const request = deferred<WidgetThemeResult>()
		requests.push(request)
		return request.promise
	})
	const a = sync.submit(current(), 1),
		b = sync.submit(current('pastoral'), 2),
		again = sync.submit(current(), 3)
	assert.deepEqual(
		payloads.map((json) => JSON.parse(json).registryRevision),
		[1, 2, 3],
	)
	requests[2].resolve('applied')
	await again
	requests[0].reject(new Error('late old failure'))
	requests[1].resolve('stale')
	await Promise.all([a, b])
	assert.equal(sync.getSnapshot().status, 'synced')
	assert.equal(sync.getSnapshot().error, null)
})

void test('native failure is separate, not automatically retried; explicit retry sends exactly the same committed projection', async () => {
	let calls = 0
	const payloads: string[] = []
	const sync = new WidgetThemeSync(async (json) => {
		payloads.push(json)
		if (++calls === 1) throw new Error('native mirror unavailable')
		return 'unchanged'
	})
	await sync.submit(current('anime'), 4)
	assert.equal(sync.getSnapshot().status, 'error')
	assert.equal(sync.getSnapshot().canRetry, true)
	await sync.submit(current('anime'), 4)
	assert.equal(calls, 1)
	await sync.retry()
	assert.equal(calls, 2)
	assert.equal(payloads[0], payloads[1])
	assert.equal(sync.getSnapshot().status, 'synced')
})

void test('stale and unexpected replies are not reported as synchronized; same revision changed contents reach native conflict validation', async () => {
	const stale = new WidgetThemeSync(async () => 'stale')
	await stale.submit(current(), 1)
	assert.equal(stale.getSnapshot().status, 'error')
	assert.equal(stale.getSnapshot().canRetry, false)
	assert.equal(stale.getSnapshot().needsReload, true)
	let calls = 0
	const conflict = new WidgetThemeSync(async () => {
		if (++calls === 1) return 'applied'
		throw new Error('same revision conflict')
	})
	await conflict.submit(current(), 2)
	await conflict.submit(current('anime'), 2)
	assert.equal(calls, 2)
	assert.match(conflict.getSnapshot().error!.message, /conflict/)
	const unexpected = new WidgetThemeSync(
		async () => 'invalid' as WidgetThemeResult,
	)
	await unexpected.submit(current(), 0)
	assert.match(unexpected.getSnapshot().error!.message, /响应异常/)
})

void test('stop ignores late results and resume reprojects rather than restoring a discarded response', async () => {
	const waiting = deferred<WidgetThemeResult>()
	let calls = 0,
		updates = 0
	const sync = new WidgetThemeSync(() =>
		++calls === 1 ? waiting.promise : Promise.resolve('unchanged'),
	)
	sync.subscribe(() => {
		updates++
	})
	const first = sync.submit(current(), 1)
	sync.stop()
	const before = updates
	waiting.reject(new Error('after unmount'))
	await first
	assert.equal(updates, before)
	sync.resume()
	await sync.submit(current('anime'), 2)
	assert.equal(sync.getSnapshot().status, 'synced')
})

void test('UTF-8 projection budget is bounded before the bridge without a Node-only encoder', async () => {
	const value = structuredClone(current())
	value.theme.version = '界'.repeat(3000)
	let calls = 0
	const sync = new WidgetThemeSync(async () => {
		calls++
		return 'applied'
	})
	await sync.submit(value, 0)
	assert.equal(calls, 0)
	assert.match(sync.getSnapshot().error!.message, /限额/)
	assert.equal(sync.getSnapshot().canRetry, false)
})

void test('actual theme panel presents independent Widget failure/retry without claiming the applied app theme failed', () => {
	const session = new ThemeWorkshopSession({
		fallback: () => 'modern',
		create: async () => {
			throw new Error('unused')
		},
		pick: async () => null,
		read: async () => new Uint8Array(),
	})
	const state = {
		...session.getSnapshot(),
		loading: false,
		widgetTheme: {
			status: 'error',
			error: new Error('native mirror unavailable'),
			canRetry: true,
			needsReload: false,
		},
		installer: {
			phase: 'ready',
			readOnly: false,
			error: null,
			preview: null,
			installed: [],
			cleanupErrors: [],
			canUndo: false,
		},
	}
	type Node = {
		type: string
		props: Record<string, unknown>
		children: unknown[]
	}
	const react = {
		createElement: (
			type: string,
			props: Record<string, unknown>,
			...children: unknown[]
		): Node => ({ type, props: props ?? {}, children }),
	}
	const output: { ThemePackagePanel?: (props: unknown) => Node } = {}
	runInNewContext(
		ts.transpileModule(
			readFileSync(
				new URL('../theme-package-panel.tsx', import.meta.url),
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
			require: (name: string) =>
				name === 'react'
					? { __esModule: true, default: react, useState: (initial: unknown) => [initial, () => {}] }
					: name === 'react-native'
						? { View: 'View' }
						: name === './theme-workshop-session'
							? { themeWorkshopBusy }
							: {
									ThemeReferencePreview: 'Preview',
									Button: 'Button',
									Card: 'Card',
									State: 'State',
									T: 'T',
									useTheme: () => builtInThemes.modern,
								},
		},
	)
	let retries = 0
	const view = output.ThemePackagePanel!({
		state,
		session: {
			retryWidgetTheme: () => {
				retries++
			},
		},
		reducedMotion: true,
	})
	function text(value: unknown): string {
		if (Array.isArray(value)) return value.map(text).join('')
		return value && typeof value === 'object' && 'children' in value
			? text((value as Node).children)
			: typeof value === 'string'
				? value
				: ''
	}
	function nodes(value: unknown): Node[] {
		if (Array.isArray(value)) return value.flatMap(nodes)
		return value && typeof value === 'object' && 'children' in value
			? [value as Node, ...nodes((value as Node).children)]
			: []
	}
	assert.match(text(view), /小组件主题同步失败，应用主题已保留/)
	assert.doesNotMatch(text(view), /主题操作未完成/)
	const retry = nodes(view).find(
		(node) =>
			node.type === 'Button' && text(node).includes('重试同步小组件主题'),
	)!
	assert.equal(retry.props.disabled, false)
	;(retry.props.onPress as () => void)()
	assert.equal(retries, 1)
	state.widgetTheme.canRetry = false
	state.widgetTheme.needsReload = true
	state.widgetTheme.error = new Error('请重新读取主题后再同步')
	let loads = 0
	const staleView = output.ThemePackagePanel!({
		state,
		session: {
			load: async () => {
				loads++
				return true
			},
		},
		reducedMotion: true,
	})
	assert.doesNotMatch(text(staleView), /重试同步小组件主题/)
	const reload = nodes(staleView).filter(
		(node) => node.type === 'Button' && text(node) === '重新读取主题记录',
	)
	assert.equal(
		reload.length,
		1,
		'stale in a writable panel must have a reload action',
	)
	assert.equal(reload[0].props.disabled, false)
	;(reload[0].props.onPress as () => void)()
	assert.equal(loads, 1)
})
