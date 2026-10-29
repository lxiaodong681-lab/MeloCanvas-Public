import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import JSZip from 'jszip'

import type { ThemeFilesNativeModule } from '../../../../packages/native/src/ThemeFilesModule'
import { Library, migrate, type Database } from '../core/database'
import { builtInThemes } from '../core/theme'
import { createMobileThemeInstallSession, readStartupBuiltinTheme, themeStateKey } from '../core/theme-install-mobile'
import * as installTypes from '../core/theme-install-types'
import type {
	ThemeInstallDependencies,
	ThemePresentation,
} from '../core/theme-install-types'
import {
	packageCapabilities,
	validateThemePackage,
} from '../core/theme-package'
import type {
	PackageThemeComponents,
	ThemeImageDecoder,
	ThemePackageManifest,
} from '../core/theme-package-types'
import { ThemePackageError } from '../core/theme-package-types'
import * as gateModule from '../theme-layout-gate'
import { ThemeWorkshopSession } from '../theme-workshop-session'
import type { useThemeCandidateLayout } from '../useThemeCandidateLayout'
import { withCurrentLayoutRestore } from '../useThemeCurrentLayout'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

type Host = ReturnType<typeof useThemeCandidateLayout>
type NativeRoot = { measure: (callback: (...bounds: number[]) => void) => void }
const component = (value: unknown) => value as ControlNode['type']
const readSource = (name: string) =>
	readFileSync(
		name === 'useThemeLayoutHost' && process.env.MELO_THEME_ROOT_HOST_SOURCE
			? process.env.MELO_THEME_ROOT_HOST_SOURCE
			: new URL(`../${name}.ts`, import.meta.url),
		'utf8',
	)
const settle = () => new Promise<void>((done) => setImmediate(done))
const noopPreparation: NonNullable<
	ThemeInstallDependencies['preparePresentation']
> = async () => ({ assertCurrent() {} })

function fixture() {
	const dependencies: Record<string, unknown> = {
		'./theme-layout-gate': gateModule,
		'./core/theme-install-types': installTypes,
	}
	const f = controlFixture(
		{
			useThemeLayoutHost: readSource('useThemeLayoutHost'),
			useThemeCandidateLayout: readSource('useThemeCandidateLayout'),
			'candidate-harness': `import React from 'react'; import {View} from 'react-native'; import {useThemeCandidateLayout} from './useThemeCandidateLayout'; import {ThemeLayoutProbe} from './theme-layout-probe'; export function Candidate(props){const host=useThemeCandidateLayout(props.insets); host.rootRef.current=props.root; props.capture(host); return <View ref={host.rootRef} onLayout={host.onRootLayout}><ThemeLayoutProbe gate={host.gate} request={host.request} bounds={host.bounds} bottomInset={props.insets.bottom} reducedMotion /></View>}`,
		},
		dependencies,
	)
	dependencies['./useThemeLayoutHost'] = f.load('useThemeLayoutHost')
	dependencies['./theme-layout-probe'] = f.load('theme-layout-probe')
	dependencies['./useThemeCandidateLayout'] = f.load('useThemeCandidateLayout')
	let host!: Host
	const calls: ((...bounds: number[]) => void)[] = []
	const root: NativeRoot = { measure: (callback) => calls.push(callback) }
	const draw = (nativeRoot = root) =>
		f.render(
			f.element(component(f.load('candidate-harness').Candidate), {
				root: nativeRoot,
				insets: { top: 20, right: 0, bottom: 12, left: 0 },
				capture: (value: Host) => {
					host = value
				},
			}),
		)
	const measureRoot = (index = calls.length - 1, width = 360) =>
		calls[index](0, 0, width, 800, 0, 0)
	const ready = () => {
		const tree = draw()
		const rows = controlNodes(tree).filter(
			(node) =>
				typeof node.props.onLayout === 'function' &&
				node.props.ref !== host.rootRef &&
				node.props.accessibilityRole !== 'adjustable',
		)
		assert.equal(rows.length, 7)
		for (const row of rows)
			(row.props.onLayout as (event: unknown) => void)({
				nativeEvent: { layout: { width: 340 } },
			})
		draw()
	}
	return {
		...f,
		draw,
		calls,
		root,
		measureRoot,
		ready,
		get host() {
			return host
		},
	}
}

function presentation(minTouch = 48, layout = false): ThemePresentation {
	const theme = structuredClone(builtInThemes.modern)
	return {
		selection: {
			kind: 'package',
			id: 'example.candidate',
			archiveSha256: 'a'.repeat(64),
		},
		theme,
		allowedImageUris: [],
		packageMetadata: null,
		adapted: {
			theme,
			mode: 'light',
			retained: {
				buttonMinTouchDp: minTouch,
				...(layout
					? {
							controlRowLayout: {
								minTouchDp: minTouch,
								narrowFallback: 'reject' as const,
							},
						}
					: {}),
				lyricTokens: { active: '#111111', inactive: '#333333' },
			},
			renderingResponsibilities: [
				'local-image-uris',
				'button-min-touch-dp',
				'lyric-tokens',
				'motion-duration-and-reduced-motion',
				'explicit-color-mode',
			],
		},
	}
}
const context = () => ({
	purpose: 'activate' as const,
	signal: new AbortController().signal,
})

void test('actual candidate hook bypasses builtin/legacy48 only; old96 and explicit48 use actual renderer policy and seven scopes', async () => {
	const f = fixture()
	f.draw()
	f.measureRoot()
	f.draw()
	const prepare = f.host.preparePresentation
	await prepare(
		{
			...presentation(),
			selection: { kind: 'builtin', key: 'modern' },
			adapted: null,
		},
		context(),
	)
	await prepare(presentation(), context())
	assert.equal(f.host.gate.getSnapshot().request, null)
	for (const value of [presentation(96), presentation(48, true)]) {
		const pending = prepare(value, context())
		assert.ok(f.host.gate.getSnapshot().request)
		f.ready()
		if (value.adapted!.retained.buttonMinTouchDp === 96)
			await assert.rejects(pending, /不适合/)
		else (await pending).assertCurrent()
		assert.equal(f.host.preparePresentation, prepare)
	}
	f.unmount()
})

void test('aborted bypass cannot replace a waiting candidate; cancel/late native reports do not publish it', async () => {
	const f = fixture()
	f.draw()
	f.measureRoot()
	f.draw()
	const controller = new AbortController()
	const pending = f.host.preparePresentation(presentation(48, true), {
		...context(),
		signal: controller.signal,
	})
	f.draw()
	const previous = f.host.gate.getSnapshot().request!.id
	const cancelled = new AbortController()
	cancelled.abort()
	assert.throws(
		() =>
			f.host.preparePresentation(presentation(), {
				...context(),
				signal: cancelled.signal,
			}),
		/取消/,
	)
	assert.equal(f.host.gate.getSnapshot().request!.id, previous)
	controller.abort()
	await assert.rejects(pending, /取消/)
	assert.equal(f.host.gate.getSnapshot().phase, 'invalidated')
	f.unmount()
})

void test('actual stable root ref actively remeasures unchanged root after viewport change; old callbacks cannot cross ABA, root owner or unmount', async () => {
	const f = fixture()
	f.draw()
	assert.equal(f.calls.length, 1)
	const ref = f.host.rootRef
	const oldOnLayout = f.host.onRootLayout
	f.host.onRootLayout({
		nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 800 } },
	} as Parameters<Host['onRootLayout']>[0])
	f.measureRoot(0, 9000)
	f.draw()
	assert.equal(
		f.host.bounds?.width,
		360,
		'onLayout supersedes an older in-flight measure result',
	)
	const pending = f.host.preparePresentation(presentation(48, true), context())
	f.ready()
	const lease = await pending
	f.viewport.width = 412
	f.draw()
	assert.equal(f.host.rootRef, ref)
	assert.equal(f.host.bounds, null)
	assert.throws(() => lease.assertCurrent(), /变化|失效|过期/)
	oldOnLayout({
		nativeEvent: { layout: { x: 0, y: 0, width: 9000, height: 800 } },
	} as Parameters<Host['onRootLayout']>[0])
	f.measureRoot(1)
	f.draw()
	assert.equal(
		(f.host.bounds as { width: number } | null)?.width,
		360,
		'old A onLayout must not revoke the pending B measure',
	)
	f.viewport.width = 360
	f.draw()
	f.measureRoot(0, 9000)
	f.measureRoot(1, 9000)
	f.draw()
	assert.equal(f.host.bounds, null)
	oldOnLayout({
		nativeEvent: { layout: { x: 0, y: 0, width: 9000, height: 800 } },
	} as Parameters<Host['onRootLayout']>[0])
	f.measureRoot(2)
	f.draw()
	assert.equal((f.host.bounds as { width: number } | null)?.width, 360)
	f.viewport.height = 900
	f.draw()
	f.draw({ measure: () => {} })
	f.measureRoot(3, 9000)
	f.draw({ measure: () => {} })
	assert.equal(f.host.bounds, null)
	f.unmount()
	f.measureRoot(3)
	assert.equal(f.writesAfterUnmount, 0)
})

void test('actual workshop hook forwards stable preparation into mobile factory without changing advertised capabilities', async () => {
	let options:
		| Pick<ThemeInstallDependencies, 'host' | 'preparePresentation'>
		| undefined
	const dependencies: Record<string, unknown> = {
		'@bbplayer/orpheus': {
			Orpheus: {
				setWidgetThemeProjection: async () => ({ status: 'applied' }),
			},
		},
		'expo-constants': { expoConfig: { version: '0.15.1' } },
		'expo-document-picker': {},
		'./theme-image-decoder': { themeImageDecoder: {} },
		'./theme-workshop-session': { ThemeWorkshopSession },
		'./core/theme-install-mobile': {
			readStartupBuiltinTheme,
			createMobileThemeInstallSession: async (
				_library: unknown,
				value: typeof options,
			) => {
				options = value
				throw new Error('factory reached')
			},
			readSelectedThemeBytes: async () => new Uint8Array(),
		},
	}
	const f = controlFixture(
		{ useThemeWorkshop: readSource('useThemeWorkshop') },
		dependencies,
	)
	let session: ThemeWorkshopSession | undefined
	const library = { setting: (key: string) => key === themeStateKey
		? JSON.stringify({ schemaVersion: 1, revision: 4, installed: [], active: { kind: 'builtin', key: 'anime' }, previous: null })
		: 'modern' }
	const Hook = () => {
		const result = (
			f.load('useThemeWorkshop').useThemeWorkshop as (
				library: unknown,
				prepare: ThemeInstallDependencies['preparePresentation'],
			) => { session: ThemeWorkshopSession }
		)(library, noopPreparation)
		session = result.session
		return null
	}
	f.render(f.element(Hook, {}))
	await settle()
	assert.equal(options?.preparePresentation, noopPreparation)
	assert.equal(
		options?.host.capabilities.includes('responsive-touch-layout-v1'),
		false,
	)
	assert.equal(session?.getSnapshot().current.theme.id, builtInThemes.anime.id)
	f.unmount()
})

void test('actual workshop advertises responsive capability only with explicit host opt-in and preparation', async () => {
	for (const [enabled, prepare, expected] of [
		[true, noopPreparation, true],
		[false, noopPreparation, false],
		[true, undefined, false],
	] as const) {
		let options:
			| Parameters<typeof createMobileThemeInstallSession>[1]
			| undefined
		const f = controlFixture(
			{ useThemeWorkshop: readSource('useThemeWorkshop') },
			{
				'@bbplayer/orpheus': {
					Orpheus: { setWidgetThemeProjection: async () => 'applied' },
				},
				'expo-constants': { expoConfig: { version: '0.17.0' } },
				'expo-document-picker': {},
				'./theme-image-decoder': { themeImageDecoder: {} },
				'./theme-workshop-session': { ThemeWorkshopSession },
				'./core/theme-install-mobile': {
					readStartupBuiltinTheme,
					createMobileThemeInstallSession: async (
						_library: unknown,
						value: typeof options,
					) => {
						options = value
						throw new Error('factory reached')
					},
					readSelectedThemeBytes: async () => new Uint8Array(),
				},
			},
		)
		const library = { setting: (key: string) => key === 'theme' ? 'modern' : null }
		const Hook = () => {
			;(
				f.load('useThemeWorkshop').useThemeWorkshop as (
					value: unknown,
					preparation: ThemeInstallDependencies['preparePresentation'],
					responsiveLayoutHost: boolean,
				) => unknown
			)(library, prepare, enabled)
			return null
		}
		try {
			f.render(f.element(Hook, {}))
			await settle()
			assert.ok(options)
			assert.equal(options.responsiveLayoutHost, enabled)
			assert.equal(options.preparePresentation, prepare)
			assert.equal(
				options.host.capabilities.includes('responsive-touch-layout-v1'),
				expected,
			)
			assert.equal(options.host.capabilities.includes('dark-tokens'), true)
		} finally {
			f.unmount()
		}
	}
})

// Same native-byte port and real SQLite fixture for mobile capability checks.
function mobileFilesFixture(bytes: Uint8Array) {
	const raw = new DatabaseSync(':memory:')
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, args) => raw.prepare(sql).run(...args),
		getAllSync: <T>(sql: string, args: (string | number | null)[]) =>
			raw.prepare(sql).all(...args) as T[],
		getFirstSync: <T>(sql: string, args: (string | number | null)[]) =>
			(raw.prepare(sql).get(...args) as T) ?? null,
	}
	migrate(db)
	const library = new Library(db)
	const stages = new Map<string, Map<string, Uint8Array>>(),
		installed = new Map<string, Uint8Array>()
	let sequence = 0
	const files = (scope: string) =>
		scope === 'installed' ? installed : stages.get(scope)!
	const native: ThemeFilesNativeModule = {
		rootAsync: async () => 'file:///private/installed/',
		createStageAsync: async () => {
			const token = `stage-${++sequence}`
			stages.set(token, new Map())
			return {
				token,
				privateRootUri: `file:///private/staging/${token}/packages/`,
			}
		},
		writeStageAsync: async (scope, path, value) => {
			files(scope).set(path, value)
		},
		readAsync: async (scope, path) => {
			const value = files(scope).get(path)
			assert.ok(value)
			return value
		},
		listAsync: async (scope, prefix) =>
			[...files(scope)]
				.filter(([path]) => path.startsWith(prefix + '/'))
				.map(([path, value]) => ({
					path: path.slice(prefix.length + 1),
					bytes: value.length,
				})),
		publishAsync: async (scope) => {
			for (const [path, value] of files(scope)) installed.set(path, value)
			return 'created'
		},
		removeStageAsync: async (scope) => {
			stages.delete(scope)
		},
		readSelectedAsync: async () => bytes,
	}
	return { raw, library, native }
}

void test('opted-in mobile factory → candidate hook → seven TSX scopes → real 96dp ZIP/SQLite preview/apply revalidates and cancellation/stale preserve current', async () => {
	const root = resolve(__dirname, '../../../../..')
	const zip = await JSZip.loadAsync(
		readFileSync(resolve(root, 'theme-packages/paper-signal.melotheme')),
	)
	const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
	manifest.requiredCapabilities.push('responsive-touch-layout-v1')
	zip.file('manifest.json', JSON.stringify(manifest))
	const components = JSON.parse(
		await zip.file('components.json')!.async('string'),
	)
	components.components.button.minTouchDp = 96
	components.components.layout = {
		compactMinTouchDp: 48,
		narrowFallback: 'reject',
	}
	zip.file('components.json', JSON.stringify(components))
	const bytes = await zip.generateAsync({ type: 'uint8array' })
	const { raw, library, native } = mobileFilesFixture(bytes)
	const decoder = (
		createRequire(resolve(root, 'scripts/theme-package.cjs'))(
			'./lib/theme-package-node.cjs',
		) as { createNodeImageDecoder(): ThemeImageDecoder }
	).createNodeImageDecoder()
	const f = fixture()
	f.draw()
	f.measureRoot()
	f.draw()
	try {
		const core = await createMobileThemeInstallSession(
			library,
			{
				host: { appVersion: '0.15.1', capabilities: [...packageCapabilities] },
				decoder,
				mode: 'light',
				preparePresentation: f.host.preparePresentation,
				responsiveLayoutHost: true,
			},
			native,
		)
		assert.equal(await core.load(), true)
		const before = core.getSnapshot().current
		const waitForProbe = (previous?: object) =>
			new Promise<void>((yes, no) => {
				const check = () => {
					const request = f.host.gate.getSnapshot().request
					if (request && request.id !== previous) {
						clearTimeout(timer)
						unsubscribe()
						yes()
					}
				}
				const unsubscribe = f.host.gate.subscribe(check)
				const timer = setTimeout(() => {
					unsubscribe()
					no(
						new Error(
							core.getSnapshot().error?.message ??
								'candidate never reached the gate',
						),
					)
				}, 5000)
				check()
			})
		const pending = core.importBytes(bytes)
		await waitForProbe()
		assert.equal(core.getSnapshot().current, before)
		f.ready()
		assert.equal(await pending, true)
		assert.equal(core.getSnapshot().current, before)
		const oldId = f.host.gate.getSnapshot().request!.id
		const apply = core.applyPreview()
		await waitForProbe(oldId)
		assert.notEqual(f.host.gate.getSnapshot().request?.id, oldId)
		f.ready()
		assert.equal(await apply, true)
		assert.equal(core.getSnapshot().current.selection.kind, 'package')
		const committed = library.setting('theme.state.v1')
		const appliedId = f.host.gate.getSnapshot().request!.id
		const cancelled = core.importBytes(bytes)
		await waitForProbe(appliedId)
		await core.cancel()
		assert.equal(await cancelled, false)
		assert.equal(library.setting('theme.state.v1'), committed)
		const selected = core.getSnapshot().current.selection
		assert.equal(selected.kind, 'package')
		if (selected.kind !== 'package')
			throw new Error('expected installed package')
		const previousRequest = f.host.gate.getSnapshot().request?.id
		const stale = core.activateInstalled(selected.id, selected.archiveSha256)
		await waitForProbe(previousRequest)
		f.ready()
		f.host.gate.setEnvironmentRevision(null)
		assert.equal(
			await stale,
			false,
			'ready lease invalidated before publication cannot activate',
		)
		assert.equal(library.setting('theme.state.v1'), committed)
		assert.deepEqual(core.getSnapshot().current.selection, selected)
		const restored = await createMobileThemeInstallSession(
			library,
			{
				host: { appVersion: '0.17.0', capabilities: [...packageCapabilities] },
				decoder,
				mode: 'light',
				responsiveLayoutHost: true,
				preparePresentation: withCurrentLayoutRestore(
					f.host.preparePresentation,
				),
			},
			native,
		)
		assert.equal(await restored.load(), true)
		assert.equal(
			restored.getSnapshot().current.adapted!.retained.buttonMinTouchDp,
			96,
		)
		assert.equal(
			library.setting('theme.state.v1'),
			committed,
			'cold current observation does not rewrite selection',
		)
		const missingHost = await createMobileThemeInstallSession(
			library,
			{
				host: { appVersion: '0.17.0', capabilities: [...packageCapabilities] },
				decoder,
				mode: 'light',
			},
			native,
		)
		assert.equal(await missingHost.load(), false)
		assert.equal(missingHost.getSnapshot().readOnly, true)
		assert.equal(
			library.setting('theme.state.v1'),
			committed,
			'missing responsive host is transient, not package corruption',
		)
		for (const enabledWithoutPrepare of [false, true]) {
			let coldCore:
				| Awaited<ReturnType<typeof createMobileThemeInstallSession>>
				| undefined
			let coldWorkshop: ThemeWorkshopSession | undefined
			const cold = controlFixture(
				{ useThemeWorkshop: readSource('useThemeWorkshop') },
				{
					'@bbplayer/orpheus': {
						Orpheus: { setWidgetThemeProjection: async () => 'applied' },
					},
					'expo-constants': { expoConfig: { version: '0.17.0' } },
					'expo-document-picker': {},
					'./theme-image-decoder': { themeImageDecoder: decoder },
					'./theme-workshop-session': { ThemeWorkshopSession },
					'./core/theme-install-mobile': {
						createMobileThemeInstallSession: async (
							value: Library,
							options: Parameters<typeof createMobileThemeInstallSession>[1],
						) => {
							assert.equal(
								options.host.capabilities.includes(
									'responsive-touch-layout-v1',
								),
								false,
							)
							coldCore = await createMobileThemeInstallSession(
								value,
								options,
								native,
							)
							return coldCore
						},
						readSelectedThemeBytes: async () => bytes,
					},
				},
			)
			const Cold = () => {
				coldWorkshop = (
					cold.load('useThemeWorkshop').useThemeWorkshop as (
						value: Library,
						preparation?: ThemeInstallDependencies['preparePresentation'],
						responsive?: boolean,
					) => {
						session: ThemeWorkshopSession
					}
				)(library, undefined, enabledWithoutPrepare).session
				return null
			}
			try {
				cold.render(cold.element(Cold, {}))
				await new Promise<void>((yes, no) => {
					const check = () => {
						if (coldCore && !coldWorkshop!.getSnapshot().loading) {
							clearTimeout(timer)
							unsubscribe()
							yes()
						}
					}
					const unsubscribe = coldWorkshop!.subscribe(check)
					const timer = setTimeout(() => {
						unsubscribe()
						no(new Error('cold workshop did not settle'))
					}, 5000)
					check()
				})
				assert.equal(
					coldCore!.getSnapshot().readOnly,
					true,
					'actual default workshop must not recover a valid package away',
				)
				assert.equal(
					library.setting('theme.state.v1'),
					committed,
					'actual absent capability preserves the cold registry',
				)
			} finally {
				cold.unmount()
			}
		}
		const badNative = {
			...native,
			readAsync: async (scope: string, path: string, max: number) => {
				const value = await native.readAsync(scope, path, max)
				if (scope !== 'installed' || !path.endsWith('/assets/header.png'))
					return value
				const damaged = value.slice()
				damaged[damaged.length - 1] ^= 1
				return damaged
			},
		}
		const damaged = await createMobileThemeInstallSession(
			library,
			{
				host: { appVersion: '0.17.0', capabilities: [...packageCapabilities] },
				decoder,
				mode: 'light',
				responsiveLayoutHost: true,
				preparePresentation: withCurrentLayoutRestore(
					f.host.preparePresentation,
				),
			},
			badNative,
		)
		assert.equal(
			await damaged.load(),
			true,
			'complete host still runs original damaged-package recovery',
		)
		assert.deepEqual(damaged.getSnapshot().current.selection, {
			kind: 'builtin',
			key: 'modern',
		})
		assert.notEqual(
			library.setting('theme.state.v1'),
			committed,
			'real corruption follows durable fallback, not unavailable',
		)
	} finally {
		f.unmount()
		raw.close()
	}
})

void test('mobile responsive opt-in still rejects missing preparation/host and legacy large packages without author layout', async () => {
	const root = resolve(__dirname, '../../../../..')
	const base = readFileSync(
		resolve(root, 'theme-packages/paper-signal.melotheme'),
	)
	const decoder = (
		createRequire(resolve(root, 'scripts/theme-package.cjs'))(
			'./lib/theme-package-node.cjs',
		) as { createNodeImageDecoder(): ThemeImageDecoder }
	).createNodeImageDecoder()
	async function pack(
		minTouch: number,
		layout: boolean,
		change?: (manifest: ThemePackageManifest) => void,
	) {
		const zip = await JSZip.loadAsync(base)
		const manifest = JSON.parse(
			await zip.file('manifest.json')!.async('string'),
		)
		const components = JSON.parse(
			await zip.file('components.json')!.async('string'),
		)
		components.components.button.minTouchDp = minTouch
		if (layout) {
			manifest.requiredCapabilities.push('responsive-touch-layout-v1')
			components.components.layout = {
				compactMinTouchDp: 48,
				narrowFallback: 'host-single-row',
			}
		}
		change?.(manifest)
		zip.file('manifest.json', JSON.stringify(manifest))
		zip.file('components.json', JSON.stringify(components))
		return zip.generateAsync({ type: 'uint8array' })
	}
	for (const [label, minTouch, layout, enabled, prepare] of [
		['no opt-in', 96, true, false, noopPreparation],
		['no preparation', 96, true, true, undefined],
		['explicit 48 also needs host', 48, true, false, noopPreparation],
		['legacy large has no policy', 96, false, true, noopPreparation],
	] as const) {
		const bytes = await pack(minTouch, layout)
		const f = mobileFilesFixture(bytes)
		let prepared = 0
		try {
			const session = await createMobileThemeInstallSession(
				f.library,
				{
					host: {
						appVersion: '0.17.0',
						capabilities: [...packageCapabilities],
					},
					decoder,
					mode: 'light',
					responsiveLayoutHost: enabled,
					preparePresentation: prepare
						? async (...args) => {
								prepared++
								return prepare(...args)
							}
						: undefined,
				},
				f.native,
			)
			assert.equal(await session.load(), true)
			const before = f.library.setting('theme.state.v1')
			assert.equal(await session.importBytes(bytes), false, label)
			assert.match(session.getSnapshot().error!.message, /48dp|响应式.*宿主/)
			assert.equal(
				prepared,
				0,
				`${label}: fails before a permissive optional callback`,
			)
			assert.equal(f.library.setting('theme.state.v1'), before)
			assert.equal(session.getSnapshot().preview, null)
		} finally {
			f.raw.close()
		}
	}
	for (const [label, change] of [
		[
			'unknown plus responsive',
			(manifest: ThemePackageManifest) => {
				manifest.requiredCapabilities.push('unknown-native-feature')
			},
		],
		[
			'newer app version',
			(manifest: ThemePackageManifest) => {
				manifest.minAppVersion = '99.0.0'
			},
		],
	] as const) {
		const bytes = await pack(96, true, change)
		const f = mobileFilesFixture(bytes)
		try {
			const session = await createMobileThemeInstallSession(
				f.library,
				{
					host: {
						appVersion: '0.17.0',
						capabilities: packageCapabilities.filter(
							(value) => value !== 'responsive-touch-layout-v1',
						),
					},
					decoder,
					mode: 'light',
				},
				f.native,
			)
			assert.equal(await session.load(), true)
			const before = f.library.setting('theme.state.v1')
			assert.equal(await session.importBytes(bytes), false, label)
			const error = session.getSnapshot().error
			assert.ok(error instanceof ThemePackageError)
			assert.equal(error.code, 'INCOMPATIBLE', label)
			assert.equal(f.library.setting('theme.state.v1'), before)
		} finally {
			f.raw.close()
		}
	}
})

void test('non-opted-in workshop host permits bound 48dp PNG icons and dark tokens but keeps responsive and larger targets closed', async () => {
	const root = resolve(__dirname, '../../../../..')
	const base = readFileSync(
		resolve(root, 'theme-packages/paper-signal.melotheme'),
	)
	async function pack(
		change?: (
			manifest: ThemePackageManifest,
			components: { components: PackageThemeComponents },
		) => void,
	) {
		const zip = await JSZip.loadAsync(base)
		const manifest: ThemePackageManifest = JSON.parse(
			await zip.file('manifest.json')!.async('string'),
		)
		const components: { components: PackageThemeComponents } = JSON.parse(
			await zip.file('components.json')!.async('string'),
		)
		manifest.requiredCapabilities.push('package-icons-v1')
		components.components.icons = {
			play: { light: { normal: 'assets/header.png' } },
		}
		change?.(manifest, components)
		zip.file('manifest.json', JSON.stringify(manifest))
		zip.file('components.json', JSON.stringify(components))
		return zip.generateAsync({ type: 'uint8array' })
	}
	const bytes = await pack()
	const { raw, library, native } = mobileFilesFixture(bytes)
	const decoder = (
		createRequire(resolve(root, 'scripts/theme-package.cjs'))(
			'./lib/theme-package-node.cjs',
		) as { createNodeImageDecoder(): ThemeImageDecoder }
	).createNodeImageDecoder()
	let options:
		| Pick<ThemeInstallDependencies, 'host' | 'preparePresentation'>
		| undefined
	let core:
		| Awaited<ReturnType<typeof createMobileThemeInstallSession>>
		| undefined
	const prepared: string[] = []
	const prepare: NonNullable<
		ThemeInstallDependencies['preparePresentation']
	> = async (_presentation, preparationContext) => {
		prepared.push(preparationContext.purpose)
		return { assertCurrent() {} }
	}
	const f = controlFixture(
		{ useThemeWorkshop: readSource('useThemeWorkshop') },
		{
			'@bbplayer/orpheus': {
				Orpheus: {
					setWidgetThemeProjection: async () => ({ status: 'applied' }),
				},
			},
			'expo-constants': { expoConfig: { version: '0.15.1' } },
			'expo-document-picker': {},
			'./theme-image-decoder': { themeImageDecoder: decoder },
			'./theme-workshop-session': { ThemeWorkshopSession },
			'./core/theme-install-mobile': {
				createMobileThemeInstallSession: async (
					actualLibrary: Library,
					value: Parameters<typeof createMobileThemeInstallSession>[1],
				) => {
					assert.equal(actualLibrary, library)
					options = value
					core = await createMobileThemeInstallSession(
						actualLibrary,
						value,
						native,
					)
					return core
				},
				readSelectedThemeBytes: async () => bytes,
			},
		},
	)
	let session: ThemeWorkshopSession | undefined
	const Hook = () => {
		session = (
			f.load('useThemeWorkshop').useThemeWorkshop as (
				value: Library,
				preparation: ThemeInstallDependencies['preparePresentation'],
			) => { session: ThemeWorkshopSession }
		)(library, prepare).session
		return null
	}
	try {
		f.render(f.element(Hook, {}))
		await settle()
		assert.ok(core && options && session)
		assert.equal(session.getSnapshot().loading, false)
		assert.equal(options.preparePresentation, prepare)
		assert.ok(options.host.capabilities.includes('package-icons-v1'))
		assert.equal(
			options.host.capabilities.includes('responsive-touch-layout-v1'),
			false,
		)
		assert.equal(options.host.capabilities.includes('dark-tokens'), true)
		const stable = session
		f.render(f.element(Hook, {}))
		assert.equal(session, stable)
		const before = library.setting('theme.state.v1')
		assert.equal(await core.importBytes(bytes), true)
		assert.equal(
			library.setting('theme.state.v1'),
			before,
			'preview does not activate',
		)
		const preview = core.getSnapshot().preview!
		const icon = preview.adapted!.retained.iconResources!.play!.light.normal
		assert.equal(icon.path, 'assets/header.png')
		assert.ok(icon.uri.startsWith('file:///private/staging/'))
		assert.equal(await core.applyPreview(), true)
		const current = core.getSnapshot().current
		const bound = current.adapted!.retained.iconResources!.play!.light.normal
		assert.equal(current.selection.kind, 'package')
		assert.equal(bound.sha256, icon.sha256)
		assert.equal(bound.path, icon.path)
		assert.ok(bound.uri.startsWith('file:///private/installed/'))
		assert.ok(current.allowedImageUris.includes(bound.uri))
		assert.ok(prepared.includes('preview') && prepared.includes('activate'))
		const committed = library.setting('theme.state.v1')
		const oldHost = {
			...options.host,
			capabilities: options.host.capabilities.filter(
				(name) => name !== 'package-icons-v1',
			),
		}
		await assert.rejects(validateThemePackage(bytes, oldHost, decoder), {
			code: 'INCOMPATIBLE',
		})
		for (const [label, bad, error] of [
			[
				'optional-only',
				await pack((manifest) => {
					manifest.requiredCapabilities = manifest.requiredCapabilities.filter(
						(name: string) => name !== 'package-icons-v1',
					)
					manifest.optionalCapabilities.push('package-icons-v1')
				}),
				/必需能力/,
			],
			[
				'larger target',
				await pack((_manifest, components) => {
					components.components.button.minTouchDp = 64
				}),
				/大于48dp/,
			],
			[
				'responsive',
				await pack((manifest, components) => {
					manifest.requiredCapabilities.push('responsive-touch-layout-v1')
					components.components.layout = {
						compactMinTouchDp: 48,
						narrowFallback: 'reject',
					}
				}),
				/响应式主题宿主尚未就绪/,
			],
		] as const) {
			assert.equal(await core.importBytes(bad), false, label)
			assert.match(core.getSnapshot().error!.message, error)
			if (label === 'responsive') {
				const unavailable: Error | null = core.getSnapshot().error
				assert.ok(
					unavailable instanceof installTypes.ThemePresentationTransientError,
				)
				assert.equal(unavailable.reason, 'unavailable')
			}
			assert.equal(core.getSnapshot().current, current)
			assert.equal(library.setting('theme.state.v1'), committed)
		}
		assert.equal(await core.importBytes(await pack((manifest) => {
			manifest.requiredCapabilities.push('dark-tokens')
		})), true)
		assert.equal(core.getSnapshot().current, current, 'dark-capable preview does not apply itself')
		assert.equal(library.setting('theme.state.v1'), committed)
		await core.cancel()
		assert.equal(await core.load(), true)
		assert.deepEqual(
			core.getSnapshot().current.adapted!.retained.iconResources,
			current.adapted!.retained.iconResources,
		)
		assert.ok(prepared.includes('restore'))
	} finally {
		f.unmount()
		raw.close()
	}
})
