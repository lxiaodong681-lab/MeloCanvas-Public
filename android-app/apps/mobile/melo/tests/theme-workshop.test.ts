import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve as resolvePath } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, type Database } from '../core/database'
import { validThemeKey } from '../core/theme'
import { cosmosTheme, themeAppearance } from '../core/theme-appearance'
import {
	createThemeSettingsDriver,
	readStartupBuiltinTheme,
	themeStateKey,
} from '../core/theme-install-mobile'
import { ThemeInstallSession } from '../core/theme-install-session'
import type { ThemeFilesDriver, ThemeStage } from '../core/theme-install-types'
import { packageCapabilities } from '../core/theme-package'
import {
	themePackageLimits,
	type ThemeImageDecoder,
} from '../core/theme-package-types'
import { createThemeImageDecoder } from '../theme-image-decoder'
import {
	ThemeWorkshopSession,
	type ThemeInstallPort,
} from '../theme-workshop-session'
import type {
	WidgetThemeWriter,
	WidgetThemeProjection,
	WidgetThemeResult,
} from '../widget-theme'

const root = resolvePath(__dirname, '../../../../..')
const archive = new Uint8Array(
	readFileSync(join(root, 'theme-packages/paper-signal.melotheme')),
)

void test('cold startup uses the committed builtin before async creation, ignoring obsolete legacy preference', async () => {
	const f = fixture()
	try {
		await f.core.load()
		for (const key of ['modern', 'pastoral', 'anime'] as const) {
			assert.equal(await f.core.activateBuiltin(key), true)
			f.library.setSetting('theme', key === 'modern' ? 'anime' : 'modern')
			const saved = f.library.setting(themeStateKey)
			const factory = deferred<ThemeInstallPort>()
			const ui = new ThemeWorkshopSession({
				fallback: () => readStartupBuiltinTheme(f.library),
				create: () => factory.promise,
				pick: async () => null,
				read: async () => archive,
			})
			const pending = ui.load()
			assert.deepEqual(ui.getSnapshot().current.selection, { kind: 'builtin', key })
			assert.equal(ui.getSnapshot().loading, true)
			factory.resolve(f.core)
			assert.equal(await pending, true)
			assert.equal(ui.getSnapshot().loading, false)
			assert.deepEqual(ui.getSnapshot().current.selection, { kind: 'builtin', key })
			assert.equal(f.library.setting(themeStateKey), saved)
			ui.stop()
		}
	} finally { await f.core.cancel(); f.raw.close() }
})

void test('fresh sessions restore the installed package from local files without rewriting selection or reinstalling', async () => {
	const f = fixture()
	try {
		assert.equal(await f.core.load(), true)
		assert.equal(await f.core.importBytes(archive), true)
		assert.equal(await f.core.applyPreview(), true)
		const saved = f.library.setting(themeStateKey)
		const selected = f.core.getSnapshot().current.selection
		const expectedUris = f.core.getSnapshot().current.allowedImageUris
		assert.equal(selected.kind, 'package')
		f.files.publish = async () => assert.fail('startup must not reinstall')
		const settings = createThemeSettingsDriver(f.library)
		settings.commit = () => assert.fail('startup must not change selection')
		for (let restart = 0; restart < 3; restart++) {
			const core = new ThemeInstallSession({ files: f.files, settings,
				host: { appVersion: '0.5.0', capabilities: [...packageCapabilities] }, decoder, mode: 'light' })
			const factory = deferred<ThemeInstallPort>()
			const ui = new ThemeWorkshopSession({
				fallback: () => readStartupBuiltinTheme(f.library), create: () => factory.promise,
				pick: async () => assert.fail('startup must not ask for import'), read: async () => archive,
			})
			try {
				const pending = ui.load()
				assert.equal(ui.getSnapshot().loading, true)
				factory.resolve(core)
				assert.equal(await pending, true)
				assert.equal(ui.getSnapshot().loading, false)
				assert.deepEqual(ui.getSnapshot().current.selection, selected)
				assert.deepEqual(ui.getSnapshot().current.allowedImageUris, expectedUris)
				assert.equal(f.library.setting(themeStateKey), saved)
			} finally { ui.stop(); await core.cancel() }
		}
	} finally { await f.core.cancel(); f.raw.close() }
})

void test('real dual-mode installation preserves selection/undo and switches without disk reads, decoding or registry writes', async () => {
	let decodes = 0
	const f = fixture({ decodeImage: (...args) => { decodes++; return decoder.decodeImage(...args) } }, '0.18.0')
	try {
		assert.equal(await f.core.load(), true)
		const bytes = readFileSync(join(root, 'theme-packages/starter-examples/cosmos-dual.melotheme'))
		assert.equal(await f.core.importBytes(bytes), true)
		assert.equal(await f.core.applyPreview(), true)
		const before = f.library.setting(themeStateKey)
		const light = f.core.getSnapshot().current
		assert.equal(light.darkAdapted?.mode, 'dark')
		const dark = themeAppearance(light, 'dark')
		assert.equal(dark.theme.tokens.surface.base, '#000000')
		assert.equal(dark.theme, light.darkAdapted?.theme)
		assert.notEqual(dark.theme, cosmosTheme)
		assert.equal(dark.adapted?.retained.progress?.colors?.thumb, '#E8E8ED')
		assert.equal(dark.selection, light.selection)
		let reads = 0
		const originalRead = f.files.read.bind(f.files)
		f.files.read = (...args) => { reads++; return originalRead(...args) }
		const decoded = decodes
		for (let i = 0; i < 1000; i++) {
			assert.equal(themeAppearance(light, 'dark'), dark)
			assert.equal(themeAppearance(light, 'light'), light)
		}
		assert.equal(reads, 0)
		assert.equal(decodes, decoded)
		assert.equal(f.library.setting(themeStateKey), before)
		assert.equal(await f.core.load(), true)
		assert.equal(themeAppearance(f.core.getSnapshot().current, 'dark').theme.tokens.surface.base, '#000000')
		assert.equal(await f.core.undo(), true)
		assert.equal(f.core.getSnapshot().current.selection.kind, 'builtin')
		assert.equal(themeAppearance(f.core.getSnapshot().current, 'dark').theme, cosmosTheme)
	} finally { await f.core.cancel(); f.raw.close() }
})

void test('B站适配包仅预览；取消不会写入安装记录，显式应用后进入列表并可撤销', async () => {
	const f = fixture(), ui = f.ui()
	try {
		assert.equal(await ui.load(), true)
		const before = f.library.setting(themeStateKey)
		assert.equal(await ui.previewBytes(archive), true)
		assert.equal(ui.getSnapshot().current.selection.kind, 'builtin')
		assert.equal(f.library.setting(themeStateKey), before)
		assert.ok(ui.getSnapshot().installer?.preview)
		ui.close(); await f.core.cancel()
		assert.equal(f.library.setting(themeStateKey), before)
		const cancelled = new AbortController(); cancelled.abort()
		assert.equal(await ui.previewBytes(archive, cancelled.signal), false)
		assert.equal(await ui.previewBytes(archive), true)
		assert.equal(await ui.apply(), true)
		assert.equal(ui.getSnapshot().installer?.installed.length, 1)
		assert.equal(await ui.undo(), true)
		assert.equal(ui.getSnapshot().current.selection.kind, 'builtin')
	} finally { ui.stop(); await f.core.cancel(); f.raw.close() }
})

void test('直接保存外观仍经过真实主题校验并可撤销；损坏包不会替换当前主题', async () => {
	const f = fixture(), ui = f.ui()
	try {
		assert.equal(await ui.load(),true)
		const original = ui.getSnapshot().current.theme.id
		assert.equal(await ui.applyAuthored(new Uint8Array([1,2,3])),false)
		assert.equal(ui.getSnapshot().current.theme.id,original)
		assert.equal(await ui.applyAuthored(archive),true)
		assert.equal(ui.getSnapshot().current.selection.kind,'package')
		assert.equal(f.picks,0)
		assert.equal(await ui.undo(),true)
		assert.equal(ui.getSnapshot().current.theme.id,original)
	} finally { f.raw.close() }
})

void test('关闭外观工坊后迟到的校验结果不能触发自动应用', async () => {
	const f = fixture(), ui = f.ui(), gate = deferred<boolean>()
	let applied = 0
	try {
		assert.equal(await ui.load(),true)
		f.core.importBytes = () => gate.promise
		f.core.applyPreview = async () => { applied++; return true }
		const pending = ui.applyAuthored(archive)
		ui.close()
		gate.resolve(true)
		assert.equal(await pending,false)
		assert.equal(applied,0)
	} finally { f.raw.close() }
})
const decoder = (
	createRequire(join(root, 'scripts/theme-package.cjs'))(
		'./lib/theme-package-node.cjs',
	) as {
		createNodeImageDecoder(): ThemeImageDecoder
	}
).createNodeImageDecoder()
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
const settle = () => new Promise<void>((done) => setImmediate(done))
function fixture(imageDecoder = decoder, appVersion = '0.5.0') {
	const raw = new DatabaseSync(':memory:')
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
	migrate(db)
	const library = new Library(db)
	library.setSetting('theme', 'anime')
	const installed = new Map<string, Uint8Array>(),
		stages = new Map<string, Map<string, Uint8Array>>()
	let sequence = 0,
		picks = 0
	const scope = (value: ThemeStage | 'installed') =>
		value === 'installed' ? installed : stages.get(value.token)!
	const files: ThemeFilesDriver = {
		installedRootUri: 'file:///private/installed/',
		createStage: async () => {
			const token = `owner-${++sequence}`
			stages.set(token, new Map())
			return {
				token,
				privateRootUri: `file:///private/staging/${token}/packages/`,
			}
		},
		writeStage: async (stage, path, bytes) => {
			scope(stage).set(path, new Uint8Array(bytes))
		},
		read: async (value, path, max) => {
			const bytes = scope(value).get(path)
			assert.ok(bytes && bytes.length <= max)
			return new Uint8Array(bytes)
		},
		list: async (value, prefix) =>
			[...scope(value)]
				.filter(([path]) => path.startsWith(prefix + '/'))
				.map(([path, bytes]) => ({
					path: path.slice(prefix.length + 1),
					bytes: bytes.length,
				})),
		publish: async (stage, id, hash) => {
			const prefix = `${id}/${hash}/`
			if ([...installed.keys()].some((path) => path.startsWith(prefix)))
				return 'exists'
			for (const [path, bytes] of scope(stage))
				if (path.startsWith(prefix)) installed.set(path, new Uint8Array(bytes))
			return 'created'
		},
		removeStage: async (stage) => {
			stages.delete(stage.token)
		},
	}
	const core = new ThemeInstallSession({
		files,
		settings: createThemeSettingsDriver(library),
		host: { appVersion, capabilities: [...packageCapabilities] },
		decoder: imageDecoder,
		mode: 'light',
	})
	const ui = (
		create: () => Promise<ThemeInstallPort> = async () => core,
		widgetTheme?: WidgetThemeWriter,
	) =>
		new ThemeWorkshopSession({
			fallback: () => 'anime',
			create,
			pick: async () => ({
				uri: `content://picker/${++picks}`,
				name: `theme-${picks}.melotheme`,
			}),
			read: async () => archive,
			widgetTheme,
		})
	return {
		raw,
		library,
		core,
		ui,
		stages,
		files,
		get picks() {
			return picks
		},
	}
}

void test('原生root/初始load慢时保持旧动漫主题；关闭工坊不取消全局加载，成功后仅current权威', async () => {
	const f = fixture(),
		factory = deferred<ThemeInstallPort>(),
		ui = f.ui(() => factory.promise)
	try {
		const seen: string[] = []
		ui.subscribe(() => seen.push(ui.getSnapshot().current.theme.id))
		const pending = ui.load()
		assert.equal(ui.getSnapshot().current.selection.kind, 'builtin')
		assert.match(ui.getSnapshot().current.theme.id, /anime/)
		ui.close()
		factory.resolve(f.core)
		assert.equal(await pending, true)
		assert.ok(seen.every((id) => id.endsWith('.anime')))
		assert.equal(await ui.activateBuiltin('pastoral'), true)
		f.library.setSetting('theme', 'modern')
		assert.equal(await ui.load(), true)
		assert.match(ui.getSnapshot().current.theme.id, /pastoral/)
	} finally {
		f.raw.close()
	}
})

void test('legacy同步读失败不会在UI构造抛出，现代回退可见且受控load保留原错误并可重试', async () => {
	const f = fixture(),
		failure = new Error('database busy reading settings')
	const read = f.library.setting.bind(f.library)
	f.library.setting = () => {
		throw failure
	}
	let ui!: ThemeWorkshopSession
	try {
		assert.doesNotThrow(() => {
			ui = new ThemeWorkshopSession({
				fallback: () => validThemeKey(f.library.setting('theme')),
				create: async () => f.core,
				pick: async () => null,
				read: async () => archive,
			})
		})
		assert.match(ui.getSnapshot().current.theme.id, /modern/)
		assert.equal(ui.getSnapshot().error, failure)
		assert.equal(await ui.load(), false)
		assert.equal(ui.getSnapshot().installer?.error, failure)
		assert.equal(ui.getSnapshot().installer?.readOnly, true)
		f.library.setting = read
		assert.equal(await ui.load(), true)
		assert.match(ui.getSnapshot().current.theme.id, /anime/)
	} finally {
		f.raw.close()
	}
})

void test('factory失败保留旧主题和原错误；重试成功前不写legacy或registry', async () => {
	const f = fixture(),
		failure = new Error('native root unavailable')
	let attempts = 0
	const ui = f.ui(async () => {
		if (++attempts === 1) throw failure
		return f.core
	})
	try {
		assert.equal(await ui.load(), false)
		assert.equal(ui.getSnapshot().error, failure)
		assert.match(ui.getSnapshot().current.theme.id, /anime/)
		assert.equal(f.library.setting(themeStateKey), null)
		assert.equal(f.library.setting('theme'), 'anime')
		assert.equal(await ui.load(), true)
		assert.equal(ui.getSnapshot().error, null)
	} finally {
		f.raw.close()
	}
})

void test('损坏registry保持只读与旧主题fallback，UI不能用内置选择覆盖原数据', async () => {
	const f = fixture(),
		ui = f.ui()
	try {
		f.library.setSetting(themeStateKey, '{broken')
		assert.equal(await ui.load(), false)
		assert.equal(ui.getSnapshot().installer?.readOnly, true)
		assert.match(ui.getSnapshot().current.theme.id, /anime/)
		assert.equal(await ui.activateBuiltin('modern'), false)
		assert.equal(f.library.setting(themeStateKey), '{broken')
		assert.equal(f.library.setting('theme'), 'anime')
	} finally {
		f.raw.close()
	}
})

void test('真实ZIP预览不切活动主题；SQLite提交失败保旧，重选应用成功并可撤销', async () => {
	const f = fixture(),
		ui = f.ui()
	try {
		assert.equal(await ui.load(), true)
		const before = f.library.setting(themeStateKey)
		assert.equal(await ui.choose(), true)
		assert.equal(f.library.setting(themeStateKey), before)
		assert.equal(ui.getSnapshot().current.selection.kind, 'builtin')
		assert.equal(ui.getSnapshot().installer?.preview?.selection.kind, 'package')
		f.raw.exec(
			"CREATE TRIGGER fail_theme BEFORE UPDATE ON settings WHEN NEW.key = 'theme.state.v1' BEGIN SELECT RAISE(ABORT, 'theme write denied'); END",
		)
		assert.equal(await ui.apply(), false)
		assert.match(
			ui.getSnapshot().installer!.error!.message,
			/theme write denied/,
		)
		assert.equal(f.library.setting(themeStateKey), before)
		assert.match(ui.getSnapshot().current.theme.id, /anime/)
		f.raw.exec('DROP TRIGGER fail_theme')
		assert.equal(await ui.choose(), true)
		assert.equal(await ui.apply(), true)
		assert.equal(ui.getSnapshot().current.selection.kind, 'package')
		assert.equal(ui.getSnapshot().installer?.canUndo, true)
		assert.equal(f.library.setting('theme'), 'anime')
		ui.close()
		assert.equal(await ui.undo(), true)
		assert.match(ui.getSnapshot().current.theme.id, /anime/)
	} finally {
		f.raw.close()
	}
})

void test('卸载后迟到factory不能覆盖重新挂载的加载结果', async () => {
	const old = fixture(),
		next = fixture(),
		delayed = deferred<ThemeInstallPort>()
	next.library.setSetting('theme', 'pastoral')
	let calls = 0
	const ui = old.ui(() =>
		++calls === 1 ? delayed.promise : Promise.resolve(next.core),
	)
	try {
		const first = ui.load()
		ui.stop()
		assert.equal(await ui.load(), true)
		delayed.resolve(old.core)
		assert.equal(await first, false)
		assert.match(ui.getSnapshot().current.theme.id, /pastoral/)
	} finally {
		old.raw.close()
		next.raw.close()
	}
})

void test('真实installer取消会drain旧decoder/admission，最新文件继续进入预览而非静默丢失', async () => {
	const entered = deferred<void>(),
		finish = deferred<void>()
	let decodes = 0
	const f = fixture(
			createThemeImageDecoder(async (bytes, limits) => {
				if (++decodes === 1) {
					entered.resolve()
					await finish.promise
				}
				return decoder.decodeImage(bytes, { ...themePackageLimits, ...limits })
			}),
		),
		ui = f.ui()
	try {
		assert.equal(await ui.load(), true)
		const first = ui.choose()
		await entered.promise
		const second = ui.choose()
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(f.picks, 1)
		finish.resolve()
		assert.equal(await first, false)
		assert.equal(await second, true)
		assert.equal(f.picks, 2)
		assert.equal(ui.getSnapshot().file.file?.name, 'theme-2.melotheme')
		assert.equal(ui.getSnapshot().installer?.phase, 'preview')
		assert.equal(ui.getSnapshot().file.error, null)
	} finally {
		finish.resolve()
		await f.core.cancel()
		f.raw.close()
	}
})

void test('widget mirror waits for authoritative load and ignores ZIP preview; native failure cannot undo a committed SQLite theme', async () => {
	const f = fixture(),
		factory = deferred<ThemeInstallPort>(),
		writes: WidgetThemeProjection[] = []
	let failPackage = true
	const ui = f.ui(
		() => factory.promise,
		async (json) => {
			const projection = JSON.parse(json) as WidgetThemeProjection
			writes.push(projection)
			if (projection.selection.kind === 'package' && failPackage)
				throw new Error('widget mirror unavailable')
			return 'applied'
		},
	)
	try {
		const load = ui.load()
		assert.equal(
			writes.length,
			0,
			'legacy bootstrap cannot overwrite cold native theme',
		)
		factory.resolve(f.core)
		assert.equal(await load, true)
		assert.equal(writes.length, 1)
		assert.deepEqual(writes[0].selection, { kind: 'builtin', key: 'anime' })
		assert.equal(await ui.choose(), true)
		assert.equal(writes.length, 1, 'preview cannot become widget current')
		assert.equal(
			await ui.apply(),
			true,
			'SQLite commit is successful despite independent mirror failure',
		)
		await new Promise<void>((done) => setImmediate(done))
		assert.equal(ui.getSnapshot().current.selection.kind, 'package')
		assert.equal(ui.getSnapshot().error, null)
		assert.equal(ui.getSnapshot().installer!.error, null)
		assert.equal(ui.getSnapshot().widgetTheme.status, 'error')
		assert.equal(writes.length, 2)
		const durable = f.library.setting(themeStateKey)
		assert.equal(JSON.parse(durable!).active.kind, 'package')
		assert.equal(writes[1].registryRevision, JSON.parse(durable!).revision)
		assert.equal(writes[1].decoration, 'none')
		failPackage = false
		ui.retryWidgetTheme()
		await new Promise<void>((done) => setImmediate(done))
		assert.equal(ui.getSnapshot().widgetTheme.status, 'synced')
		assert.equal(writes.length, 3)
		assert.deepEqual(writes[2], writes[1])
		assert.equal(f.library.setting(themeStateKey), durable)
	} finally {
		ui.stop()
		await f.core.cancel()
		f.raw.close()
	}
})

void test('read-only registry and failed SQLite commit do not mirror fallback or an uncommitted theme', async () => {
	const corrupted = fixture(),
		writes: string[] = [],
		ui = corrupted.ui(undefined, async (json) => {
			writes.push(json)
			return 'applied'
		})
	try {
		corrupted.library.setSetting(themeStateKey, '{broken')
		assert.equal(await ui.load(), false)
		assert.equal(writes.length, 0)
		assert.equal(ui.getSnapshot().installer!.readOnly, true)
	} finally {
		ui.stop()
		await corrupted.core.cancel()
		corrupted.raw.close()
	}
	const f = fixture(),
		mirrored: string[] = [],
		ready = f.ui(undefined, async (json) => {
			mirrored.push(json)
			return 'applied'
		})
	try {
		assert.equal(await ready.load(), true)
		assert.equal(mirrored.length, 1)
		f.raw.exec(
			"CREATE TRIGGER fail_widget_theme BEFORE UPDATE ON settings WHEN NEW.key = 'theme.state.v1' BEGIN SELECT RAISE(ABORT, 'theme write denied'); END",
		)
		assert.equal(await ready.activateBuiltin('pastoral'), false)
		assert.equal(mirrored.length, 1)
		assert.deepEqual(ready.getSnapshot().current.selection, {
			kind: 'builtin',
			key: 'anime',
		})
	} finally {
		ready.stop()
		await f.core.cancel()
		f.raw.close()
	}
})

void test('stale mirror explicitly reloads the newer SQLite revision; late replies from an older reload cannot overwrite recovery', async () => {
	const f = fixture(),
		requests: ReturnType<typeof deferred<WidgetThemeResult>>[] = [],
		writes: WidgetThemeProjection[] = []
	const ui = f.ui(undefined, (json) => {
		writes.push(JSON.parse(json) as WidgetThemeProjection)
		const request = deferred<WidgetThemeResult>()
		requests.push(request)
		return request.promise
	})
	const other = new ThemeInstallSession({
		files: f.files,
		settings: createThemeSettingsDriver(f.library),
		host: { appVersion: '0.5.0', capabilities: [...packageCapabilities] },
		decoder,
		mode: 'light',
	})
	try {
		assert.equal(await ui.load(), true)
		requests[0].resolve('stale')
		await settle()
		assert.equal(ui.getSnapshot().widgetTheme.needsReload, true)
		assert.equal(ui.getSnapshot().widgetTheme.canRetry, false)
		ui.retryWidgetTheme()
		await settle()
		assert.equal(
			writes.length,
			1,
			'stale must not resend the known obsolete payload',
		)
		assert.equal(await other.load(), true)
		assert.equal(await other.activateBuiltin('pastoral'), true)
		assert.deepEqual(ui.getSnapshot().current.selection, {
			kind: 'builtin',
			key: 'anime',
		})
		const durable = f.library.setting(themeStateKey)
		assert.equal(await ui.load(), true)
		assert.deepEqual(ui.getSnapshot().current.selection, {
			kind: 'builtin',
			key: 'pastoral',
		})
		assert.equal(writes[1].registryRevision, JSON.parse(durable!).revision)
		assert.deepEqual(writes[1].selection, { kind: 'builtin', key: 'pastoral' })
		assert.equal(
			f.library.setting(themeStateKey),
			durable,
			'reload reads the newer committed record without rewriting it',
		)
		assert.equal(await other.activateBuiltin('anime'), true)
		assert.equal(await ui.load(), true)
		requests[2].resolve('applied')
		await settle()
		assert.equal(ui.getSnapshot().widgetTheme.status, 'synced')
		assert.equal(ui.getSnapshot().widgetTheme.needsReload, false)
		requests[1].resolve('stale')
		await settle()
		assert.equal(ui.getSnapshot().widgetTheme.status, 'synced')
		assert.equal(ui.getSnapshot().widgetTheme.error, null)
		assert.deepEqual(ui.getSnapshot().current.selection, {
			kind: 'builtin',
			key: 'anime',
		})
	} finally {
		ui.stop()
		for (const request of requests) request.resolve('stale')
		await other.cancel()
		await f.core.cancel()
		f.raw.close()
	}
})
