import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import JSZip from 'jszip'

import type { ThemeFilesNativeModule } from '../../../../packages/native/src/ThemeFilesModule'
import { Library, migrate, type Database } from '../core/database'
import {
	createMobileThemeFiles,
	createMobileThemeInstallSession,
	createThemeSettingsDriver,
	readSelectedThemeBytes,
	themeStateKey,
} from '../core/theme-install-mobile'
import { ThemeInstallSession } from '../core/theme-install-session'
import { cosmosTheme, themeAppearance } from '../core/theme-appearance'
import {
	ThemeLayoutRejectedError,
	ThemePresentationTransientError,
	type ThemeFilesDriver,
	type ThemeInstallDependencies,
	type ThemePresentationLease,
	type ThemeStage,
} from '../core/theme-install-types'
import { packageCapabilities } from '../core/theme-package'
import type { ThemeImageDecoder } from '../core/theme-package-types'
import { ThemeLayoutGate, themeLayoutScopes } from '../theme-layout-gate'
import { withCurrentLayoutRestore } from '../useThemeCurrentLayout'

const repo = resolve(__dirname, '../../../../..')
const archive = new Uint8Array(
	readFileSync(join(repo, 'theme-packages/paper-signal.melotheme')),
)
const node = createRequire(join(repo, 'scripts/theme-package.cjs'))(
	'./lib/theme-package-node.cjs',
) as { createNodeImageDecoder(): ThemeImageDecoder }
const decoder = node.createNodeImageDecoder()
const host = { appVersion: '0.4.0', capabilities: [...packageCapabilities] }

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), 'melo-theme-install-'))
	assert.ok(
		resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
			basename(directory).startsWith('melo-theme-install-'),
	)
	const installed = join(directory, 'installed'),
		stages = new Map<string, string>()
	mkdirSync(installed)
	let raw = new DatabaseSync(join(directory, 'library.db'))
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
	let sequence = 0,
		writes = 0,
		publishes = 0
	let beforeWrite: (() => void) | undefined,
		afterPublish: (() => Promise<void> | void) | undefined,
		cleanupFailure: Error | undefined
	function safe(root: string, path: string) {
		// Logical Android URIs are mapped to a real Windows temporary private root.
		// These tests execute real disk writes, not OS URI rendering.
		assert.ok(
			path &&
				!path.includes('\\') &&
				!path.split('/').some((part) => !part || part === '.' || part === '..'),
		)
		const target = join(root, ...path.split('/'))
		assert.ok(target.startsWith(root + sep))
		let cursor = root
		for (const part of relative(root, target).split(sep)) {
			cursor = join(cursor, part)
			if (existsSync(cursor)) {
				assert.ok(!lstatSync(cursor).isSymbolicLink())
				assert.ok(
					realpathSync(cursor).startsWith(realpathSync(directory) + sep),
				)
			}
		}
		return target
	}
	function scope(value: ThemeStage | 'installed') {
		if (value === 'installed') return installed
		const root = stages.get(value.token)
		if (
			!root ||
			value.privateRootUri !==
				`file:///private/staging/${value.token}/packages/`
		)
			throw new Error('Unowned stage')
		return root
	}
	function list(root: string, leaf: string) {
		const target = safe(root, leaf),
			entries: { path: string; bytes: number }[] = []
		function visit(path: string) {
			for (const name of readdirSync(path)) {
				const file = safe(
					target,
					relative(target, join(path, name)).split(sep).join('/'),
				)
				const stat = lstatSync(file)
				if (stat.isDirectory()) visit(file)
				else
					entries.push({
						path: relative(target, file).split(sep).join('/'),
						bytes: stat.size,
					})
			}
		}
		visit(target)
		return entries
	}
	const files: ThemeFilesDriver = {
		installedRootUri: 'file:///private/installed/',
		createStage: async () => {
			const token = `owner-${++sequence}`,
				root = join(directory, token, 'packages')
			mkdirSync(root, { recursive: true })
			stages.set(token, root)
			return {
				token,
				privateRootUri: `file:///private/staging/${token}/packages/`,
			}
		},
		writeStage: async (stage, path, bytes) => {
			beforeWrite?.()
			const target = safe(scope(stage), path)
			mkdirSync(dirname(target), { recursive: true })
			writeFileSync(target, bytes, { flag: 'wx' })
			writes++
		},
		read: async (value, path, cap) => {
			const target = safe(scope(value), path),
				stat = lstatSync(target)
			assert.ok(stat.isFile() && stat.size <= cap)
			return new Uint8Array(readFileSync(target))
		},
		list: async (value, path) => list(scope(value), path),
		publish: async (stage, id, hash) => {
			const leaf = `${id}/${hash}`,
				source = safe(scope(stage), leaf),
				target = safe(installed, leaf)
			if (existsSync(target)) {
				await afterPublish?.()
				return 'exists'
			}
			mkdirSync(dirname(target), { recursive: true })
			renameSync(source, target)
			publishes++
			await afterPublish?.()
			return 'created'
		},
		removeStage: async (stage) => {
			if (cleanupFailure) throw cleanupFailure
			const root = scope(stage)
			rmSync(root, { recursive: true })
			stages.delete(stage.token)
		},
	}
	const settings = createThemeSettingsDriver(library)
	const make = (extra: Partial<ThemeInstallDependencies> = {}) =>
		new ThemeInstallSession({
			files,
			settings,
			host,
			decoder,
			mode: 'light',
			...extra,
		})
	return {
		directory,
		installed,
		stages,
		get raw() {
			return raw
		},
		reopen: () => {
			raw.close()
			raw = new DatabaseSync(join(directory, 'library.db'))
		},
		library,
		files,
		settings,
		make,
		get writes() {
			return writes
		},
		get publishes() {
			return publishes
		},
		set beforeWrite(value: typeof beforeWrite) {
			beforeWrite = value
		},
		set afterPublish(value: typeof afterPublish) {
			afterPublish = value
		},
		set cleanupFailure(value: typeof cleanupFailure) {
			cleanupFailure = value
		},
		close: () => {
			raw.close()
			rmSync(directory, { recursive: true, force: true })
		},
	}
}
async function withFixture(
	run: (f: ReturnType<typeof fixture>) => Promise<void>,
) {
	const f = fixture()
	try {
		await run(f)
	} finally {
		f.close()
	}
}
async function importApply(
	session: ThemeInstallSession,
	bytes: Uint8Array = archive,
) {
	assert.equal(await session.importBytes(bytes), true)
	assert.equal(await session.applyPreview(), true)
}

/** Simulate the native private receipt contract using real disk files. No
 * archive/image buffers cross the installer driver on a validated cache hit. */
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
function cachedFiles(f: ReturnType<typeof fixture>) {
	return {
		...f.files,
		writeVerified: async (id: string, hash: string, context: string, payload: string, entries: { path: string; bytes: number; sha256: string }[]) => {
			for (const item of entries) assert.equal(digest(readFileSync(join(f.installed, id, hash, item.path))), item.sha256)
			writeFileSync(join(f.directory, `receipt-${hash}.json`), JSON.stringify({ context, payload, entries }))
		},
		readVerified: async (id: string, hash: string, context: string) => {
			try {
				const cached = JSON.parse(readFileSync(join(f.directory, `receipt-${hash}.json`), 'utf8')) as { context: string; payload: string; entries: { path: string; bytes: number; sha256: string }[] }
				if (cached.context !== context) return null
				const entries = await f.files.list('installed', `${id}/${hash}`)
				if (entries.length !== cached.entries.length) return null
				for (const item of cached.entries) {
					const data = readFileSync(join(f.installed, id, hash, item.path))
					if (data.length !== item.bytes || digest(data) !== item.sha256) return null
				}
				return cached.payload
			} catch { return null }
		},
		removeInstalled: async (id: string, hash: string, token: string) => {
			assert.match(token, /^[a-z0-9-]{1,100}$/)
			const completed = join(f.directory, `removed-${token}`)
			if (existsSync(completed)) return
			const leaf = resolve(f.installed, id, hash)
			assert.ok(leaf.startsWith(resolve(f.installed) + sep))
			rmSync(leaf, { recursive: true, force: true })
			rmSync(join(f.directory, `receipt-${hash}.json`), { force: true })
			writeFileSync(completed, `${id}/${hash}`)
		},
	} satisfies ThemeFilesDriver
}

void test('durable verified receipts restore and switch offline with zero archive bridge reads or image decodes', async () => withFixture(async f => {
	const files = cachedFiles(f)
	const session = f.make({ files })
	await session.load()
	await importApply(session)
	const selected = session.getSnapshot().current.selection
	assert.equal(selected.kind, 'package')
	if (selected.kind !== 'package') return
	const original = session.getSnapshot().current
	assert.ok(session.getSnapshot().installed[0].storedBytes! > archive.length)
	f.reopen()
	const fastFiles = { ...files, read: async () => assert.fail('no archive or image bytes should cross the bridge') }
	const fastDecoder = { decodeImage: async () => assert.fail('already verified image must not decode again') }
	for (let restart = 0; restart < 3; restart++) {
		const restored = f.make({ files: fastFiles, decoder: fastDecoder })
		assert.equal(await restored.load(), true, restored.getSnapshot().error?.message)
		assert.deepEqual(restored.getSnapshot().current, original)
		assert.equal(await restored.activateBuiltin('anime'), true)
		assert.equal(await restored.activateInstalled(selected.id, selected.archiveSha256), true)
		assert.deepEqual(restored.getSnapshot().current, original)
	}
	let decodes = 0
	const upgraded = f.make({ files, host: { ...host, appVersion: '0.5.0' }, decoder: { decodeImage: async (...args) => { decodes++; return decoder.decodeImage(...args) } } })
	assert.equal(await upgraded.load(), true)
	assert.ok(decodes > 0, 'host upgrades must revalidate and regenerate the receipt')
}))

void test('tampered local image invalidates receipt and full verification rejects it', async () => withFixture(async f => {
	const files = cachedFiles(f), session = f.make({ files })
	await session.load()
	await importApply(session)
	const selected = session.getSnapshot().current.selection
	if (selected.kind !== 'package') throw new Error('expected package')
	const leaf = `${selected.id}/${selected.archiveSha256}`
	const png = (await files.list('installed', leaf)).find(item => item.path.endsWith('.png'))!
	const file = join(f.installed, leaf, png.path), bytes = readFileSync(file)
	bytes[bytes.length - 1] ^= 1
	writeFileSync(file, bytes)
	const restored = f.make({ files })
	await restored.load()
	assert.equal(restored.getSnapshot().current.selection.kind, 'builtin')
	assert.ok(restored.getSnapshot().error)
}))

void test('deleting an active theme clears images and receipt, preserves unrelated files and cannot undo to a deleted theme', async () => withFixture(async f => {
	const files = cachedFiles(f)
	let token = ''
	const session = f.make({ files: { ...files, removeInstalled: async (id, hash, value) => { token = value; await files.removeInstalled(id, hash, value) } } })
	await session.load()
	await importApply(session)
	const selected = session.getSnapshot().current.selection
	if (selected.kind !== 'package') throw new Error('expected package')
	writeFileSync(join(f.directory, 'unrelated.txt'), 'keep')
	assert.equal(await session.removeInstalled(selected.id, selected.archiveSha256), true)
	assert.equal(existsSync(join(f.installed, selected.id, selected.archiveSha256)), false)
	assert.equal(existsSync(join(f.directory, `receipt-${selected.archiveSha256}.json`)), false)
	assert.equal(readFileSync(join(f.directory, 'unrelated.txt'), 'utf8'), 'keep')
	assert.deepEqual(session.getSnapshot().current.selection, { kind: 'builtin', key: 'modern' })
	assert.equal(session.getSnapshot().installed.length, 0)
	const restored = f.make({ files })
	assert.equal(await restored.load(), true)
	await restored.undo()
	assert.equal(restored.getSnapshot().current.selection.kind, 'builtin')
	await importApply(restored)
	assert.equal(restored.getSnapshot().current.selection.kind, 'package', 'removed theme can be imported again')
	await files.removeInstalled(selected.id, selected.archiveSha256, token)
	assert.ok(existsSync(join(f.installed, selected.id, selected.archiveSha256)), 'late completed cleanup cannot remove a later reinstall')
}))

void test('failed deletion persists cleanup intent; restart reclaims files before allowing reinstall', async () => withFixture(async f => {
	const files = cachedFiles(f)
	const failingFiles = { ...files, removeInstalled: async () => { throw new Error('disk busy') } }
	const session = f.make({ files: failingFiles })
	await session.load()
	await importApply(session)
	const selected = session.getSnapshot().current.selection
	if (selected.kind !== 'package') throw new Error('expected package')
	await session.activateBuiltin('anime')
	assert.equal(await session.removeInstalled(selected.id, selected.archiveSha256), false)
	assert.equal(session.getSnapshot().installed.length, 0)
	assert.equal(session.getSnapshot().current.selection.kind, 'builtin')
	assert.equal(existsSync(join(f.installed, selected.id, selected.archiveSha256)), true)
	assert.equal(await session.importBytes(archive), false, 'do not reuse a theme awaiting cleanup')
	f.reopen()
	const stillBusy = f.make({ files: failingFiles })
	assert.equal(await stillBusy.load(), true)
	assert.deepEqual(stillBusy.getSnapshot().current.selection, { kind: 'builtin', key: 'anime' }, 'failed cleanup cannot change another active theme')
	assert.ok(stillBusy.getSnapshot().error)
	const restored = f.make({ files })
	assert.equal(await restored.load(), true)
	assert.equal(existsSync(join(f.installed, selected.id, selected.archiveSha256)), false)
	assert.deepEqual(JSON.parse(f.library.setting(themeStateKey)!).pendingRemoval, [])
	await importApply(restored)
}))

void test('deletion from a stale session does not remove files selected by a newer session', async () => withFixture(async f => {
	const files = cachedFiles(f), first = f.make({ files }), second = f.make({ files })
	await first.load()
	await importApply(first)
	const selected = first.getSnapshot().current.selection
	if (selected.kind !== 'package') throw new Error('expected package')
	await second.load()
	await second.activateBuiltin('anime')
	assert.equal(await first.removeInstalled(selected.id, selected.archiveSha256), false)
	assert.ok(existsSync(join(f.installed, selected.id, selected.archiveSha256)))
	assert.equal(await second.activateInstalled(selected.id, selected.archiveSha256), true)
}))

void test('creator dark config survives preview, install and restore; toggles do not reread/decode files or write selection', async () =>
	withFixture(async (f) => {
		let reads = 0, decodes = 0
		const dependencies: Partial<ThemeInstallDependencies> = {
			host: { ...host, appVersion: '0.18.0' },
			files: { ...f.files, read: async (...args) => { reads++; return f.files.read(...args) } },
			decoder: { decodeImage: async (...args) => { decodes++; return decoder.decodeImage(...args) } },
		}
		const dual = new Uint8Array(readFileSync(join(repo, 'theme-packages/starter-examples/cosmos-dual.melotheme')))
		const session = f.make(dependencies)
		await session.load()
		assert.equal(await session.importBytes(dual), true)
		const preview = session.getSnapshot().preview!
		assert.ok(preview.darkAdapted)
		assert.notEqual(themeAppearance(preview, 'dark').theme, cosmosTheme)
		assert.equal(themeAppearance(preview, 'dark').adapted, preview.darkAdapted)
		assert.equal(await session.applyPreview(), true)
		f.reopen()
		const restored = f.make(dependencies)
		assert.equal(await restored.load(), true)
		const current = restored.getSnapshot().current
		assert.ok(current.darkAdapted)
		const dark = themeAppearance(current, 'dark')
		assert.equal(dark.theme, current.darkAdapted.theme)
		assert.deepEqual(dark.adapted!.retained.progress!.colors, { track: '#666674', fill: '#B9B5F5', thumb: '#E8E8ED' })
		const counts = { reads, decodes, writes: f.writes, registry: f.settings.read() }
		for (let i = 0; i < 1000; i++) {
			assert.equal(themeAppearance(current, 'dark'), dark)
			assert.equal(themeAppearance(current, 'light'), current)
		}
		assert.deepEqual({ reads, decodes, writes: f.writes, registry: f.settings.read() }, counts)
		// Incomplete dark configurations are rejected instead of silently applied.
		const zip = await JSZip.loadAsync(dual)
		const tokens = JSON.parse(await zip.file('tokens.json')!.async('string'))
		delete tokens.dark.text
		zip.file('tokens.json', JSON.stringify(tokens))
		assert.equal(await restored.importBytes(await zip.generateAsync({ type: 'uint8array' })), false)
		assert.equal(restored.getSnapshot().current, current)
		assert.equal(f.settings.read(), counts.registry)
	}))
async function variant(
	change: (
		manifest: Record<string, unknown>,
		components: Record<string, unknown>,
	) => void,
) {
	const zip = await JSZip.loadAsync(archive),
		manifest = JSON.parse(await zip.file('manifest.json')!.async('string')),
		components = JSON.parse(await zip.file('components.json')!.async('string'))
	change(manifest, components)
	zip.file('manifest.json', JSON.stringify(manifest))
	zip.file('components.json', JSON.stringify(components))
	return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

const currentLayoutArchive = (suffix = '') =>
	variant((manifest, document) => {
		manifest.name = String(manifest.name) + suffix
		;(manifest.requiredCapabilities as string[]).push(
			'responsive-touch-layout-v1',
		)
		;(document.components as Record<string, unknown>).layout = {
			compactMinTouchDp: 48,
			narrowFallback: 'reject',
		}
	})
async function rejectNextLayout(
	gate: ThemeLayoutGate,
	pending: Promise<boolean>,
) {
	if (!gate.getSnapshot().request)
		await new Promise<void>((done, fail) => {
			const timer = setTimeout(() => {
				unsubscribe()
				fail(new Error('candidate did not reach gate'))
			}, 5000)
			const unsubscribe = gate.subscribe(() => {
				if (gate.getSnapshot().request) {
					clearTimeout(timer)
					unsubscribe()
					done()
				}
			})
		})
	const request = gate.getSnapshot().request
	assert.ok(request, 'strict operation must reach the actual candidate gate')
	gate
		.attachProbe(request.id)
		.report(themeLayoutScopes[0], {
			kind: 'rejected',
			resolution: {
				kind: 'rejected',
				reason: 'insufficient-width',
				requiredWidthDp: 320,
				availableWidthDp: 200,
			},
		})
	assert.equal(await pending, false)
}

void test('current-layout host cold restore keeps verified responsive selection/previous/revision/undo byte-for-byte without waiting on fit or writing settings', async () => {
	await withFixture(async (f) => {
		const seed = f.make()
		assert.equal(await seed.load(), true)
		assert.equal(await seed.activateBuiltin('anime'), true)
		await importApply(seed, await currentLayoutArchive())
		const before = f.settings.read(),
			gate = new ThemeLayoutGate()
		let writes = 0
		const restored = f.make({
			preparePresentation: withCurrentLayoutRestore(gate.preparePresentation),
			settings: {
				...f.settings,
				commit() {
					writes++
					throw new Error('unexpected registry write')
				},
			},
		})
		assert.equal(await restored.load(), true)
		assert.equal(restored.getSnapshot().current.selection.kind, 'package')
		assert.equal(restored.getSnapshot().revision, seed.getSnapshot().revision)
		assert.equal(restored.getSnapshot().canUndo, true)
		assert.equal(restored.getSnapshot().readOnly, false)
		assert.equal(
			gate.getSnapshot().request,
			null,
			'only current observer will measure restored layout',
		)
		assert.equal(writes, 0)
		assert.equal(f.settings.read(), before)
		gate.setEnvironmentRevision(1)
		await rejectNextLayout(
			gate,
			restored.activateInstalled(
				(restored.getSnapshot().current.selection as { id: string }).id,
				(restored.getSnapshot().current.selection as { archiveSha256: string })
					.archiveSha256,
			),
		)
		assert.equal(writes, 0, 'explicit activation is still rejected before CAS')
		assert.equal(f.settings.read(), before)
	})
})

void test('current-layout host still rejects an incompatible preview before registration and keeps layout-sensitive undo strict', async () => {
	await withFixture(async (f) => {
		const seed = f.make()
		assert.equal(await seed.load(), true)
		await importApply(seed, await currentLayoutArchive())
		await importApply(seed, await currentLayoutArchive(' alternate'))
		const before = f.settings.read(),
			gate = new ThemeLayoutGate()
		gate.setEnvironmentRevision(1)
		const session = f.make({
			preparePresentation: withCurrentLayoutRestore(gate.preparePresentation),
		})
		assert.equal(await session.load(), true)
		await rejectNextLayout(gate, session.undo())
		assert.equal(f.settings.read(), before)
		await rejectNextLayout(
			gate,
			session.importBytes(await currentLayoutArchive()),
		)
		assert.equal(f.settings.read(), before)
		assert.equal(session.getSnapshot().preview, null)
	})
})

void test('current-layout host does not disguise corrupt installed bytes: valid previous package or builtin still uses original durable recovery', async () => {
	for (const packagePrevious of [false, true])
		await withFixture(async (f) => {
			const seed = f.make()
			assert.equal(await seed.load(), true)
			assert.equal(await seed.activateBuiltin('anime'), true)
			if (packagePrevious) await importApply(seed, await currentLayoutArchive())
			const expected = seed.getSnapshot().current.selection
			await importApply(seed, archive)
			const current = seed.getSnapshot().current.selection
			assert.equal(current.kind, 'package')
			if (current.kind !== 'package') return
			writeFileSync(
				join(
					f.installed,
					current.id,
					current.archiveSha256,
					'archive.melotheme',
				),
				new Uint8Array([1, 2, 3]),
			)
			const before = seed.getSnapshot().revision,
				gate = new ThemeLayoutGate()
			const restored = f.make({
				preparePresentation: withCurrentLayoutRestore(gate.preparePresentation),
			})
			assert.equal(await restored.load(), true)
			assert.deepEqual(restored.getSnapshot().current.selection, expected)
			assert.equal(restored.getSnapshot().revision, before + 1)
			assert.ok(restored.getSnapshot().error)
			assert.deepEqual(JSON.parse(f.settings.read()!).active, expected)
		})
})

function deferred<T>() {
	let complete!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((finish, fail) => {
		complete = finish
		reject = fail
	})
	return { promise, resolve: complete, reject }
}
async function whileHostPending<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_finish, fail) => {
				timer = setTimeout(
					() =>
						fail(
							new Error(
								'cancel/new operation blocked behind an unsettled host lease',
							),
						),
					5000,
				)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

void test('async preparation: 完整落盘后等待lease才发布预览，builtin不等待宿主', async () =>
	withFixture(async (f) => {
		const reached = deferred<void>(),
			lease = deferred<ThemePresentationLease>(),
			purposes: string[] = []
		const session = f.make({
			preparePresentation: async (presentation, context) => {
				assert.equal(presentation.selection.kind, 'package')
				assert.ok(presentation.allowedImageUris.length > 0)
				assert.equal(context.signal.aborted, false)
				purposes.push(context.purpose)
				reached.resolve()
				return lease.promise
			},
		})
		assert.equal(await session.load(), true)
		assert.deepEqual(purposes, [])
		const raw = f.settings.read(),
			pending = session.importBytes(archive)
		try {
			assert.equal(
				await Promise.race([
					reached.promise.then(() => true),
					pending.then(() => false),
				]),
				true,
				'preview must reach the host preparation hook before settling',
			)
			assert.equal(session.getSnapshot().preview, null)
			assert.equal(session.getSnapshot().phase, 'preparing-preview')
			assert.equal(f.settings.read(), raw)
			lease.resolve({ assertCurrent() {} })
			assert.equal(await pending, true)
			assert.deepEqual(purposes, ['preview'])
			assert.equal(session.getSnapshot().preview?.selection.kind, 'package')
		} finally {
			lease.resolve({ assertCurrent() {} })
			await pending
		}
	}))

void test('async preparation: cancel与新操作使晚lease失权，取消排空后可再次导入', async () =>
	withFixture(async (f) => {
		const reached = deferred<void>(),
			lease = deferred<ThemePresentationLease>()
		let first = true,
			oldSignal: AbortSignal | undefined
		const session = f.make({
			preparePresentation: async (_presentation, context) => {
				if (!first) return { assertCurrent() {} }
				first = false
				oldSignal = context.signal
				reached.resolve()
				return lease.promise
			},
		})
		await session.load()
		const old = session.importBytes(archive)
		try {
			assert.equal(
				await Promise.race([
					reached.promise.then(() => true),
					old.then(() => false),
				]),
				true,
			)
			const cancel = session.cancel(),
				newer = session.activateBuiltin('pastoral')
			assert.equal(oldSignal?.aborted, true)
			assert.deepEqual(
				await whileHostPending(Promise.all([old, cancel, newer])),
				[false, false, true],
			)
			lease.resolve({
				assertCurrent() {
					throw new Error('old lease must never be asserted')
				},
			})
			await new Promise<void>((finish) => setImmediate(finish))
			assert.deepEqual(session.getSnapshot().current.selection, {
				kind: 'builtin',
				key: 'pastoral',
			})
			assert.equal(session.getSnapshot().preview, null)
			assert.equal(session.getSnapshot().error, null)
			assert.equal(f.stages.size, 0)
			assert.equal(await session.importBytes(archive), true)
		} finally {
			lease.resolve({ assertCurrent() {} })
			await old
		}
	}))

void test('async preparation: 预览发布前环境失效不发布候选且清理stage', async () =>
	withFixture(async (f) => {
		const stale = new ThemePresentationTransientError('stale', '容器已改变')
		const session = f.make({
			preparePresentation: async () => ({
				assertCurrent() {
					throw stale
				},
			}),
		})
		await session.load()
		const raw = f.settings.read()
		assert.equal(await session.importBytes(archive), false)
		assert.equal(session.getSnapshot().error, stale)
		assert.equal(session.getSnapshot().preview, null)
		assert.equal(f.settings.read(), raw)
		assert.equal(f.stages.size, 0)
	}))

void test('async preparation: 冷恢复cancel后同一包再次load，旧同身份lease不获新归属', async () =>
	withFixture(async (f) => {
		const seed = f.make()
		await seed.load()
		await importApply(seed)
		const raw = f.settings.read(),
			reached = deferred<void>(),
			lease = deferred<ThemePresentationLease>()
		let calls = 0,
			oldSignal: AbortSignal | undefined,
			oldChecks = 0,
			newChecks = 0
		const session = f.make({
			preparePresentation: async (_presentation, context) => {
				if (++calls > 1)
					return {
						assertCurrent() {
							newChecks++
						},
					}
				oldSignal = context.signal
				reached.resolve()
				return lease.promise
			},
		})
		const old = session.load()
		try {
			assert.equal(
				await Promise.race([
					reached.promise.then(() => true),
					old.then(() => false),
				]),
				true,
			)
			const cancelling = session.cancel(),
				fresh = session.load()
			assert.equal(oldSignal?.aborted, true)
			assert.deepEqual(
				await whileHostPending(Promise.all([old, cancelling, fresh])),
				[false, false, true],
			)
			lease.resolve({
				assertCurrent() {
					oldChecks++
				},
			})
			await new Promise<void>((finish) => setImmediate(finish))
			assert.equal(oldChecks, 0)
			assert.equal(newChecks, 1)
			assert.equal(session.getSnapshot().current.selection.kind, 'package')
			assert.equal(session.getSnapshot().error, null)
			assert.equal(f.settings.read(), raw)
		} finally {
			lease.resolve({
				assertCurrent() {
					oldChecks++
				},
			})
			await old
		}
	}))

void test('async preparation: 忽略abort的宿主晚拒绝不阻塞cancel或污染新操作', async () =>
	withFixture(async (f) => {
		const reached = deferred<void>(),
			lease = deferred<ThemePresentationLease>()
		const session = f.make({
			preparePresentation: async () => {
				reached.resolve()
				return lease.promise
			},
		})
		await session.load()
		const old = session.importBytes(archive)
		try {
			assert.equal(
				await Promise.race([
					reached.promise.then(() => true),
					old.then(() => false),
				]),
				true,
			)
			const cancelling = session.cancel()
			assert.deepEqual(await whileHostPending(Promise.all([old, cancelling])), [
				false,
				true,
			])
			assert.equal(await session.activateBuiltin('anime'), true)
			const current = session.getSnapshot().current,
				raw = f.settings.read()
			lease.reject(new Error('late host rejection after cancellation'))
			await new Promise<void>((finish) => setImmediate(finish))
			assert.equal(session.getSnapshot().current, current)
			assert.equal(session.getSnapshot().error, null)
			assert.equal(f.settings.read(), raw)
		} finally {
			lease.resolve({ assertCurrent() {} })
			await old
		}
	}))

void test('async preparation: 冷恢复pending/stale/cancelled及未知宿主失败均保留原注册表', async () =>
	withFixture(async (f) => {
		const seed = f.make()
		await seed.load()
		await importApply(seed)
		const raw = f.settings.read()
		for (const cause of [
			new ThemePresentationTransientError('pending', '尚未测量'),
			new ThemePresentationTransientError('stale', '旧环境'),
			new ThemePresentationTransientError('cancelled', '已取消'),
			new Error('宿主意外失败'),
		]) {
			const session = f.make({
				preparePresentation: async () => {
					throw cause
				},
			})
			assert.equal(await session.load(), false)
			assert.equal(f.settings.read(), raw)
			assert.equal(session.getSnapshot().readOnly, true)
			assert.ok(
				session.getSnapshot().error instanceof ThemePresentationTransientError,
			)
			if (cause instanceof ThemePresentationTransientError)
				assert.equal(session.getSnapshot().error, cause)
			else {
				assert.equal(
					(session.getSnapshot().error as ThemePresentationTransientError)
						.reason,
					'unavailable',
				)
				assert.equal(session.getSnapshot().error?.cause, cause)
			}
		}
		f.reopen()
		assert.equal(f.settings.read(), raw)
	}))

void test('async preparation: active稳定拒绝但previous尚未测量不写modern回退', async () =>
	withFixture(async (f) => {
		const seed = f.make()
		await seed.load()
		await importApply(seed)
		const bytes = await variant((manifest) => {
			manifest.version = '0.1.1'
		})
		await importApply(seed, bytes)
		const raw = f.settings.read(),
			pending = new ThemePresentationTransientError(
				'pending',
				'上一主题尚未测量',
			)
		const session = f.make({
			preparePresentation: async (presentation) => {
				if (presentation.packageMetadata?.version === '0.1.1')
					throw new ThemeLayoutRejectedError('不适配当前容器')
				throw pending
			},
		})
		assert.equal(await session.load(), false)
		assert.equal(session.getSnapshot().error, pending)
		assert.equal(f.settings.read(), raw)
	}))

void test('async preparation: 完整稳定拒绝仍恢复上一内置主题并只提交一次回退', async () =>
	withFixture(async (f) => {
		const seed = f.make()
		await seed.load()
		await seed.activateBuiltin('pastoral')
		await importApply(seed)
		const before = JSON.parse(f.settings.read()!) as { revision: number }
		const rejected = new ThemeLayoutRejectedError('当前容器不适配')
		const session = f.make({
			preparePresentation: async () => {
				throw rejected
			},
		})
		assert.equal(await session.load(), true)
		assert.deepEqual(session.getSnapshot().current.selection, {
			kind: 'builtin',
			key: 'pastoral',
		})
		assert.equal(session.getSnapshot().error, rejected)
		assert.equal(session.getSnapshot().revision, before.revision + 1)
		assert.deepEqual(
			(JSON.parse(f.settings.read()!) as { active: unknown }).active,
			session.getSnapshot().current.selection,
		)
	}))

void test('async preparation: apply/activate/undo提交前都重验lease，失败保留旧current及SQL原字节', async () => {
	for (const operation of ['apply', 'activate', 'undo'] as const)
		await withFixture(async (f) => {
			let enabled = false,
				checks = 0
			const stale = new ThemePresentationTransientError(
				'stale',
				'提交前环境已失效',
			)
			const session = f.make({
				preparePresentation: async (_presentation, context) => ({
					assertCurrent() {
						if (enabled && context.purpose === 'activate') {
							checks++
							throw stale
						}
					},
				}),
			})
			await session.load()
			await importApply(session)
			const installed = session.getSnapshot().installed[0]
			if (operation === 'apply') await session.importBytes(archive)
			else await session.activateBuiltin('pastoral')
			const raw = f.settings.read(),
				current = session.getSnapshot().current
			enabled = true
			const success =
				operation === 'apply'
					? await session.applyPreview()
					: operation === 'activate'
						? await session.activateInstalled(
								installed.id,
								installed.archiveSha256,
							)
						: await session.undo()
			assert.equal(success, false, operation)
			assert.equal(checks, 1)
			assert.equal(session.getSnapshot().error, stale)
			assert.equal(session.getSnapshot().current, current)
			assert.equal(f.settings.read(), raw)
		})
})

void test('async preparation: 恢复最终只读检查间环境变化使lease失效，不写回退', async () =>
	withFixture(async (f) => {
		const seed = f.make()
		await seed.load()
		await importApply(seed)
		const raw = f.settings.read()
		let environment = 0,
			reads = 0,
			checks = 0
		const stale = new ThemePresentationTransientError('stale', '字体测量已失效')
		const session = f.make({
			settings: {
				...f.settings,
				read: () => {
					if (++reads === 2) environment++
					return f.settings.read()
				},
			},
			preparePresentation: async (_presentation, context) => {
				assert.equal(context.purpose, 'restore')
				const captured = environment
				return {
					assertCurrent() {
						checks++
						if (captured !== environment) throw stale
					},
				}
			},
		})
		assert.equal(await session.load(), false)
		assert.ok(checks > 0)
		assert.equal(session.getSnapshot().error, stale)
		assert.equal(session.getSnapshot().readOnly, true)
		assert.equal(f.settings.read(), raw)
	}))

void test('async preparation: lease同步回调撤销操作后必须复查epoch，不能越过取消写入', async () =>
	withFixture(async (f) => {
		let enabled = false,
			cancelling: Promise<boolean> | undefined
		const session = f.make({
			preparePresentation: async (_presentation, context) => ({
				assertCurrent() {
					if (enabled && context.purpose === 'activate') {
						enabled = false
						cancelling = session.cancel()
					}
				},
			}),
		})
		await session.load()
		await session.importBytes(archive)
		const raw = f.settings.read(),
			current = session.getSnapshot().current
		enabled = true
		assert.equal(await session.applyPreview(), false)
		assert.equal(await cancelling, true)
		assert.equal(session.getSnapshot().current, current)
		assert.equal(session.getSnapshot().error, null)
		assert.equal(f.settings.read(), raw)
	}))

void test('真实文件预览不激活/注册；作者资料与exact URI来自完整落盘重验；取消只删owned stage', async () =>
	withFixture(async (f) => {
		f.library.setSetting('theme', 'pastoral')
		const session = f.make(),
			events: string[] = []
		session.subscribe(() => events.push(session.getSnapshot().phase))
		assert.equal(await session.load(), true)
		const before = f.library.setting(themeStateKey)
		assert.equal(await session.importBytes(archive), true)
		assert.equal(
			session.getSnapshot().current.theme.id,
			'melocanvas.builtin.pastoral',
		)
		assert.equal(session.getSnapshot().installed.length, 0)
		assert.equal(f.library.setting(themeStateKey), before)
		assert.equal(f.publishes, 0)
		assert.equal(
			session.getSnapshot().preview?.packageMetadata?.archiveBytes,
			archive.length,
		)
		assert.ok(session.getSnapshot().preview?.packageMetadata?.author)
		assert.equal(session.getSnapshot().preview?.allowedImageUris.length, 3)
		assert.ok(
			session
				.getSnapshot()
				.preview?.allowedImageUris.every((uri) =>
					uri.startsWith('file:///private/staging/owner-1/packages/'),
				),
		)
		assert.ok(
			events.includes('validating') &&
				events.includes('preparing-preview') &&
				events.includes('preview'),
		)
		assert.equal(await session.cancel(), true)
		assert.equal(f.stages.size, 0)
		assert.equal(session.getSnapshot().preview, null)
		assert.equal(f.library.setting(themeStateKey), before)
	}))

void test('文件发布并逐文件复核完成后才写单一SQLite指针；重复hash不覆盖；冷启动重新decode', async () =>
	withFixture(async (f) => {
		const session = f.make()
		await session.load()
		assert.equal(await session.importBytes(archive), true)
		f.afterPublish = () => {
			assert.equal(
				JSON.parse(f.library.setting(themeStateKey)!).active.kind,
				'builtin',
			)
		}
		assert.equal(await session.applyPreview(), true)
		f.afterPublish = undefined
		const active = session.getSnapshot().current.selection
		assert.equal(active.kind, 'package')
		assert.equal(f.stages.size, 0)
		assert.equal(session.getSnapshot().installed.length, 1)
		assert.ok(
			session
				.getSnapshot()
				.current.allowedImageUris.every((uri) =>
					uri.startsWith('file:///private/installed/'),
				),
		)
		await importApply(session)
		assert.equal(f.publishes, 1)
		assert.equal(session.getSnapshot().installed.length, 1)
		assert.equal(await session.undo(), true)
		assert.equal(
			session.getSnapshot().current.theme.id,
			'melocanvas.builtin.modern',
		)
		if (active.kind !== 'package') throw new Error('Expected active package')
		assert.equal(
			await session.activateInstalled(active.id, active.archiveSha256),
			true,
		)
		let decodes = 0
		const cold = f.make({
			decoder: {
				decodeImage: async (...args) => {
					decodes++
					return decoder.decodeImage(...args)
				},
			},
		})
		assert.equal(await cold.load(), true)
		assert.equal(decodes, 3)
		assert.deepEqual(cold.getSnapshot().current.selection, active)
		assert.equal(f.library.setting('theme'), null)
	}))

void test('取消/重入/迟到解码不能覆盖新意图或遗留本次stage；无效新输入同样取消旧任务', async () =>
	withFixture(async (f) => {
		let release!: () => void, reached!: () => void
		const gate = new Promise<void>((finish) => {
				release = finish
			}),
			started = new Promise<void>((finish) => {
				reached = finish
			})
		let first = true
		const session = f.make({
			decoder: {
				decodeImage: async (...args) => {
					if (first) {
						first = false
						reached()
						await gate
					}
					return decoder.decodeImage(...args)
				},
			},
		})
		await session.load()
		const old = session.importBytes(archive)
		await started
		const next = session.activateBuiltin('anime')
		release()
		assert.equal(await old, false)
		assert.equal(await next, true)
		assert.equal(
			session.getSnapshot().current.theme.id,
			'melocanvas.builtin.anime',
		)
		assert.equal(f.stages.size, 0)
		assert.equal(await session.importBytes(archive), true)
		assert.equal(
			await session.importBytes(new Uint8Array(20 * 1024 * 1024 + 1)),
			false,
		)
		assert.equal(f.stages.size, 0)
		assert.equal(session.getSnapshot().preview, null)
	}))

void test('写入中断/清理失败保留原错误且只清理本次stage，旧主题与pointer不变', async () =>
	withFixture(async (f) => {
		const session = f.make()
		await session.load()
		const before = f.library.setting(themeStateKey),
			primary = new Error('disk interrupted'),
			cleanup = new Error('cleanup failed')
		f.beforeWrite = () => {
			if (f.writes === 3) throw primary
		}
		f.cleanupFailure = cleanup
		assert.equal(await session.importBytes(archive), false)
		assert.equal(session.getSnapshot().error, primary)
		assert.equal(session.getSnapshot().cleanupErrors[0], cleanup)
		assert.equal(f.library.setting(themeStateKey), before)
		assert.equal(
			session.getSnapshot().current.theme.id,
			'melocanvas.builtin.modern',
		)
		f.cleanupFailure = undefined
	}))

void test('staging字节被改拒绝apply；final发布后字节被改也拒绝保存，不信先前Verified', async () =>
	withFixture(async (f) => {
		const session = f.make()
		await session.load()
		const before = f.library.setting(themeStateKey)
		assert.equal(await session.importBytes(archive), true)
		const preview = session.getSnapshot().preview!.selection
		assert.equal(preview.kind, 'package')
		if (preview.kind !== 'package') return
		const stageRoot = [...f.stages.values()][0]
		const tokensPath = join(
			stageRoot,
			preview.id,
			preview.archiveSha256,
			'tokens.json',
		)
		const corruptedTokens = readFileSync(tokensPath)
		corruptedTokens[10] ^= 1
		writeFileSync(tokensPath, corruptedTokens)
		assert.equal(await session.applyPreview(), false)
		assert.equal(f.publishes, 0)
		assert.equal(f.stages.size, 0)
		assert.equal(f.library.setting(themeStateKey), before)
		assert.equal(await session.importBytes(archive), true)
		f.afterPublish = () => {
			const file = join(
				f.installed,
				preview.id,
				preview.archiveSha256,
				'assets/header.png',
			)
			const bytes = readFileSync(file)
			bytes[100] ^= 1
			writeFileSync(file, bytes)
		}
		assert.equal(await session.applyPreview(), false)
		assert.equal(f.library.setting(themeStateKey), before)
		assert.equal(session.getSnapshot().installed.length, 0)
	}))

void test('发布后中断仅留下不可见孤儿，下一冷启动仍旧pointer；已有同hash损坏不覆写', async () =>
	withFixture(async (f) => {
		const session = f.make()
		await session.load()
		const before = f.library.setting(themeStateKey)
		assert.equal(await session.importBytes(archive), true)
		const pointer = session.getSnapshot().preview!.selection
		assert.equal(pointer.kind, 'package')
		if (pointer.kind !== 'package') return
		f.afterPublish = () => {
			throw new Error('process interrupted after publish')
		}
		assert.equal(await session.applyPreview(), false)
		assert.equal(f.library.setting(themeStateKey), before)
		f.afterPublish = undefined
		const cold = f.make()
		assert.equal(await cold.load(), true)
		assert.equal(cold.getSnapshot().installed.length, 0)
		await importApply(cold)
		assert.equal(cold.getSnapshot().installed.length, 1)
		assert.equal(
			f.publishes,
			1,
			'complete orphan must be reusable after interruption',
		)
		const png = join(
			f.installed,
			pointer.id,
			pointer.archiveSha256,
			'assets/header.png',
		)
		writeFileSync(png, 'orphan corruption')
		assert.equal(await cold.importBytes(archive), true)
		assert.equal(await cold.applyPreview(), false)
		assert.equal(readFileSync(png, 'utf8'), 'orphan corruption')
		assert.equal(f.publishes, 1)
	}))

void test('真实SQLite FULL保留errcode13、旧registry/current与完整安装记录，重开后可继续写', async () =>
	withFixture(async (f) => {
		const session = f.make()
		await session.load()
		await importApply(session)
		const previous = session.getSnapshot().current.selection
		const before = f.library.setting(themeStateKey)
		const second = await variant((manifest) => {
			manifest.id = 'example.full-target'
			manifest.name = '长'.repeat(256)
		})
		assert.equal(await session.importBytes(second), true)
		f.raw.exec('PRAGMA page_size=512; VACUUM; PRAGMA journal_mode=DELETE;')
		const pages = Number(f.raw.prepare('PRAGMA page_count').get()!.page_count)
		f.raw.exec(`PRAGMA max_page_count=${pages}`)
		// Make the registry update genuinely need new pages while retaining a valid
		// exact previous record. Fill free cells with another real SQLite value.
		let filled = false
		for (let size = 128; size <= 8192; size += 128) {
			try {
				f.library.setSetting('fill', 'x'.repeat(size))
			} catch (error) {
				assert.equal((error as { errcode: number }).errcode, 13)
				filled = true
				break
			}
		}
		assert.equal(filled, true)
		const applied = await session.applyPreview()
		assert.equal(applied, false)
		assert.equal(
			(session.getSnapshot().error as Error & { errcode: number }).errcode,
			13,
		)
		assert.equal(f.library.setting(themeStateKey), before)
		assert.deepEqual(session.getSnapshot().current.selection, previous)
		assert.equal(session.getSnapshot().installed.length, 1)
		f.raw.exec('PRAGMA max_page_count=100000')
		f.reopen()
		assert.equal(f.library.setting(themeStateKey), before)
		const cold = f.make()
		assert.equal(await cold.load(), true)
		assert.deepEqual(cold.getSnapshot().current.selection, previous)
		await importApply(cold, second)
		assert.equal(cold.getSnapshot().installed.length, 2)
	}))

void test('active损坏回退有效previous；previous也损坏回现代，不删除安装记录', async () =>
	withFixture(async (f) => {
		const session = f.make()
		await session.load()
		await importApply(session)
		const first = session.getSnapshot().current.selection
		assert.equal(first.kind, 'package')
		if (first.kind !== 'package') return
		const secondBytes = await variant((manifest) => {
			manifest.id = 'example.second-theme'
		})
		await importApply(session, secondBytes)
		const second = session.getSnapshot().current.selection
		if (second.kind !== 'package') throw new Error('No second package')
		writeFileSync(
			join(f.installed, second.id, second.archiveSha256, 'LICENSE.txt'),
			'tamper',
		)
		const cold = f.make()
		assert.equal(await cold.load(), true)
		assert.deepEqual(cold.getSnapshot().current.selection, first)
		assert.equal(cold.getSnapshot().installed.length, 2)
		assert.ok(cold.getSnapshot().error)
		writeFileSync(
			join(f.installed, first.id, first.archiveSha256, 'archive.melotheme'),
			'bad zip',
		)
		const again = f.make()
		assert.equal(await again.load(), true)
		assert.equal(
			again.getSnapshot().current.theme.id,
			'melocanvas.builtin.modern',
		)
		assert.equal(again.getSnapshot().installed.length, 2)
	}))

void test('activate/undo从原归档重验；保存失败保旧值；损坏registry或读取失败只读不覆盖', async () =>
	withFixture(async (f) => {
		const session = f.make()
		await session.load()
		await importApply(session)
		const pointer = session.getSnapshot().current.selection
		if (pointer.kind !== 'package') throw new Error('No package')
		await session.activateBuiltin('pastoral')
		assert.equal(await session.undo(), true)
		assert.deepEqual(session.getSnapshot().current.selection, pointer)
		const before = f.library.setting(themeStateKey),
			primary = new Error('settings rejected')
		const failed = f.make({
			settings: {
				...f.settings,
				commit: () => {
					throw primary
				},
			},
		})
		await failed.load()
		assert.equal(await failed.activateBuiltin('anime'), false)
		assert.equal(failed.getSnapshot().error, primary)
		assert.equal(f.library.setting(themeStateKey), before)
		writeFileSync(
			join(f.installed, pointer.id, pointer.archiveSha256, 'components.json'),
			'{}',
		)
		assert.equal(
			await session.activateInstalled(pointer.id, pointer.archiveSha256),
			false,
		)
		assert.equal(f.library.setting(themeStateKey), before)
		assert.equal(await failed.load(), false)
		assert.equal(failed.getSnapshot().readOnly, true)
		assert.equal(failed.getSnapshot().error, primary)
		assert.equal(f.library.setting(themeStateKey), before)
		for (const field of ['active', 'previous']) {
			const malformed = JSON.parse(before!)
			malformed[field] = { kind: 'builtin', key: ['anime'] }
			const raw = JSON.stringify(malformed)
			f.library.setSetting(themeStateKey, raw)
			const invalid = f.make()
			assert.equal(await invalid.load(), false)
			assert.equal(invalid.getSnapshot().readOnly, true)
			assert.equal(await invalid.activateBuiltin('modern'), false)
			assert.equal(f.library.setting(themeStateKey), raw)
		}
		f.library.setSetting(themeStateKey, '{broken')
		const broken = f.make()
		assert.equal(await broken.load(), false)
		assert.equal(broken.getSnapshot().readOnly, true)
		assert.equal(await broken.activateBuiltin('modern'), false)
		assert.equal(await broken.importBytes(archive), false)
		assert.equal(f.library.setting(themeStateKey), '{broken')
		const unreadable = f.make({
			settings: {
				...f.settings,
				read: () => {
					throw primary
				},
			},
		})
		assert.equal(await unreadable.load(), false)
		assert.equal(unreadable.getSnapshot().error, primary)
		assert.equal(unreadable.getSnapshot().readOnly, true)
	}))

void test('设置并发会话使用同步expected检查不丢安装记录；legacy仅首次迁移读', async () =>
	withFixture(async (f) => {
		f.library.setSetting('theme', 'anime')
		const first = f.make(),
			second = f.make()
		await first.load()
		await second.load()
		await importApply(first)
		assert.equal(await second.activateBuiltin('pastoral'), false)
		assert.equal(
			JSON.parse(f.library.setting(themeStateKey)!).installed.length,
			1,
		)
		f.library.setSetting('theme', 'modern')
		assert.equal(await second.load(), true)
		assert.equal(second.getSnapshot().current.selection.kind, 'package')
	}))

void test('load慢读期间其他session提交则拒绝发布旧current，保持只读并允许重新load', async () =>
	withFixture(async (f) => {
		const seed = f.make()
		await seed.load()
		await importApply(seed)
		let release!: () => void,
			reached!: () => void,
			first = true
		const gate = new Promise<void>((finish) => {
				release = finish
			}),
			started = new Promise<void>((finish) => {
				reached = finish
			})
		const read = f.files.read.bind(f.files)
		const slow = f.make({
			files: {
				...f.files,
				read: async (...args) => {
					if (first) {
						first = false
						reached()
						await gate
					}
					return read(...args)
				},
			},
		})
		const pending = slow.load()
		await started
		const newer = f.make()
		assert.equal(await newer.load(), true)
		assert.equal(await newer.activateBuiltin('anime'), true)
		const durable = f.library.setting(themeStateKey)
		release()
		assert.equal(await pending, false)
		assert.equal(
			slow.getSnapshot().current.theme.id,
			'melocanvas.builtin.modern',
		)
		assert.equal(slow.getSnapshot().readOnly, true)
		assert.match(slow.getSnapshot().error!.message, /重新加载/)
		assert.equal(f.library.setting(themeStateKey), durable)
		assert.equal(await slow.load(), true)
		assert.equal(
			slow.getSnapshot().current.theme.id,
			'melocanvas.builtin.anime',
		)
		assert.equal(slow.getSnapshot().installed.length, 1)
	}))

void test('统一presentation策略覆盖preview/apply/cold/activate/undo；更大触控不被clamp', async () =>
	withFixture(async (f) => {
		const larger = await variant((_manifest, components) => {
			;(
				(components.components as Record<string, unknown>).button as Record<
					string,
					unknown
				>
			).minTouchDp = 72
		})
		let reject = false,
			calls = 0
		const policy = (
			presentation: Parameters<
				NonNullable<ThemeInstallDependencies['validatePresentation']>
			>[0],
		) => {
			calls++
			if (reject && presentation.adapted)
				throw new Error('unsupported presentation')
		}
		const session = f.make({ validatePresentation: policy })
		await session.load()
		reject = true
		assert.equal(await session.importBytes(larger), false)
		assert.equal(f.stages.size, 0)
		reject = false
		assert.equal(await session.importBytes(larger), true)
		reject = true
		assert.equal(await session.applyPreview(), false)
		assert.equal(session.getSnapshot().installed.length, 0)
		reject = false
		await importApply(session, larger)
		const pointer = session.getSnapshot().current.selection
		if (pointer.kind !== 'package') throw new Error('No package')
		assert.equal(
			session.getSnapshot().current.adapted?.retained.buttonMinTouchDp,
			72,
		)
		await session.activateBuiltin('pastoral')
		reject = true
		assert.equal(
			await session.activateInstalled(pointer.id, pointer.archiveSha256),
			false,
		)
		assert.equal(await session.undo(), false)
		const cold = f.make({ validatePresentation: policy })
		assert.equal(await cold.load(), true)
		assert.equal(
			cold.getSnapshot().current.theme.id,
			'melocanvas.builtin.pastoral',
		)
		assert.ok(calls >= 6)
	}))

void test('移动driver仅走受限native，拒绝伪造stage与越界返回；选择文件入口有界且mobile统一48dp', async () => {
	let calls = 0
	const native: ThemeFilesNativeModule = {
		rootAsync: async () => 'file:///private/installed/',
		createStageAsync: async () => ({
			token: 'owner',
			privateRootUri: 'file:///private/staging/owner/packages/',
		}),
		writeStageAsync: async () => {
			calls++
		},
		readAsync: async () => new TextEncoder().encode('hello'),
		listAsync: async () => [],
		publishAsync: async () => 'created',
		removeStageAsync: async () => {
			calls++
		},
		readSelectedAsync: async () => new TextEncoder().encode('zip'),
	}
	const files = await createMobileThemeFiles(native),
		stage = await files.createStage()
	await files.writeStage(stage, 'a', new Uint8Array([1]))
	assert.equal(calls, 1)
	await assert.rejects(
		files.writeStage(
			{ ...stage, privateRootUri: 'file:///other/' },
			'a',
			new Uint8Array([1]),
		),
		/不属于/,
	)
	await assert.rejects(files.read(stage, 'a', 2), /无效或超限/)
	assert.equal(
		Buffer.from(
			await readSelectedThemeBytes('content://picked', native),
		).toString(),
		'zip',
	)
	await files.removeStage(stage)
	await assert.rejects(
		files.writeStage(stage, 'a', new Uint8Array([1])),
		/不属于/,
	)
	let release!: () => void,
		reads = 0
	const gate = new Promise<void>((finish) => {
		release = finish
	})
	const slow = {
		...native,
		readSelectedAsync: async () => {
			reads++
			await gate
			return archive
		},
	}
	const pending = readSelectedThemeBytes('content://slow-provider', slow)
	await assert.rejects(
		readSelectedThemeBytes('content://another', slow),
		/仍在读取/,
	)
	assert.equal(reads, 1)
	const independent = await createMobileThemeFiles(native)
	assert.equal(independent.installedRootUri, 'file:///private/installed/')
	release()
	assert.equal((await pending).length, archive.length)
	assert.equal(
		(await readSelectedThemeBytes('content://next', native)).length,
		3,
	)
	await withFixture(async (f) => {
		const stages = new Map<string, ThemeStage>()
		const source = (scope: string): ThemeStage | 'installed' =>
			scope === 'installed' ? scope : stages.get(scope)!
		const realFiles: ThemeFilesNativeModule = {
			rootAsync: async () => f.files.installedRootUri,
			createStageAsync: async () => {
				const owned = await f.files.createStage()
				stages.set(owned.token, owned)
				return owned
			},
			writeStageAsync: async (token, path, bytes) =>
				f.files.writeStage(stages.get(token)!, path, bytes),
			readAsync: async (scope, path, max) =>
				f.files.read(source(scope), path, max),
			listAsync: async (scope, path) => f.files.list(source(scope), path),
			publishAsync: async (token, id, hash) =>
				f.files.publish(stages.get(token)!, id, hash),
			removeStageAsync: async (token) => {
				await f.files.removeStage(stages.get(token)!)
				stages.delete(token)
			},
			readSelectedAsync: async () => archive,
		}
		let preparations = 0
		const session = await createMobileThemeInstallSession(
			f.library,
			{
				host,
				decoder,
				mode: 'light',
				preparePresentation: async () => {
					preparations++
					return { assertCurrent() {} }
				},
			},
			realFiles,
		)
		await session.load()
		assert.equal(session.getSnapshot().current.selection.kind, 'builtin')
		const larger = await variant((_manifest, components) => {
			;(
				(components.components as Record<string, unknown>).button as Record<
					string,
					unknown
				>
			).minTouchDp = 72
		})
		assert.equal(await session.importBytes(larger), false)
		assert.match(session.getSnapshot().error!.message, /48dp/)
		assert.equal(
			preparations,
			0,
			'static mobile guard runs before optional asynchronous preparation',
		)
		assert.equal(f.stages.size, 0)
		await importApply(session)
		assert.equal(
			preparations,
			2,
			'mobile factory passes preparation for preview and final activation',
		)
	})
})

void test('忙期间重复导入同步拒绝，不复制或排队多个20MiB归档，也不取消已获准意图', async () =>
	withFixture(async (f) => {
		let release!: () => void,
			reached!: () => void,
			calls = 0
		const gate = new Promise<void>((finish) => {
				release = finish
			}),
			started = new Promise<void>((finish) => {
				reached = finish
			})
		const session = f.make({
			decoder: {
				decodeImage: async (...args) => {
					if (++calls === 1) {
						reached()
						await gate
					}
					return decoder.decodeImage(...args)
				},
			},
		})
		await session.load()
		const admitted = session.importBytes(archive)
		await started
		const large = new Uint8Array(20 * 1024 * 1024)
		assert.deepEqual(
			await Promise.all(
				Array.from({ length: 50 }, () => session.importBytes(large)),
			),
			Array(50).fill(false),
		)
		assert.equal(calls, 1)
		assert.equal(f.stages.size, 0)
		release()
		assert.equal(await admitted, true)
		assert.equal(f.stages.size, 1)
		assert.equal(await session.cancel(), true)
	}))

void test('await cancel排空半写stage与import admission finalizer，下一次导入立即可接纳', async () =>
	withFixture(async (f) => {
		let release!: () => void,
			reached!: () => void,
			first = true
		const gate = new Promise<void>((finish) => {
				release = finish
			}),
			started = new Promise<void>((finish) => {
				reached = finish
			})
		const original = f.files.writeStage.bind(f.files)
		const session = f.make({
			files: {
				...f.files,
				writeStage: async (...args) => {
					await original(...args)
					if (first) {
						first = false
						reached()
						await gate
					}
				},
			},
		})
		await session.load()
		const old = session.importBytes(archive)
		await started
		assert.equal(f.stages.size, 1)
		const cancelling = session.cancel()
		release()
		assert.equal(await cancelling, true)
		assert.equal(await old, false)
		assert.equal(f.stages.size, 0)
		assert.equal(await session.importBytes(archive), true)
		assert.equal(f.stages.size, 1)
		await session.cancel()
	}))
