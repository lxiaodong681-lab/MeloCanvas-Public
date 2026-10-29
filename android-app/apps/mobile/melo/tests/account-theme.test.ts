import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import type { ThemeKey } from '../core/theme'
import type { ThemeSelection } from '../core/theme-install-types'

type ThemeModule = typeof import('../account-theme')
const builtin = (key: ThemeKey): ThemeSelection => ({ kind: 'builtin', key })
const external: ThemeSelection = {
	kind: 'package',
	id: 'example.external',
	archiveSha256: 'a'.repeat(64),
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
function load(native: Record<string, unknown> = {}) {
	const output: Partial<ThemeModule> = {}
	const imported: string[] = []
	runInNewContext(
		ts.transpileModule(
			readFileSync(new URL('../account-theme.ts', import.meta.url), 'utf8'),
			{ compilerOptions: { module: ts.ModuleKind.CommonJS } },
		).outputText,
		{
			exports: output,
			require: (name: string) => {
				imported.push(name)
				assert.equal(name, 'expo-secure-store')
				return { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device', ...native }
			},
		},
	)
	assert.ok(output.AccountThemePreference)
	assert.ok(output.accountTheme)
	return { ...(output as ThemeModule), imported }
}

void test('module import is appearance-only and missing preference starts modern without touching account storage', async () => {
	const reads: { key: string; options: Record<string, unknown> }[] = []
	const writes: {
		key: string
		value: string
		options: Record<string, unknown>
	}[] = []
	const { accountTheme, imported } = load({
		getItemAsync: async (key: string, options: Record<string, unknown>) => {
			reads.push({ key, options })
			return null
		},
		setItemAsync: async (
			key: string,
			value: string,
			options: Record<string, unknown>,
		) => {
			writes.push({ key, value, options })
		},
	})
	assert.deepEqual(imported, ['expo-secure-store'])
	assert.equal(accountTheme.getSnapshot(), 'modern')
	assert.equal(accountTheme.getReadySnapshot(), false)
	assert.equal(reads.length, 0)
	assert.equal(writes.length, 0)
	await accountTheme.restore()
	assert.equal(accountTheme.getReadySnapshot(), true)
	assert.equal(accountTheme.getSnapshot(), 'modern')
	assert.equal(reads.length, 1)
	assert.equal(reads[0].key, 'melocanvas.account-theme.v1')
	assert.equal(reads[0].options.keychainService, 'melocanvas.account-theme')
	assert.equal(reads[0].options.requireAuthentication, undefined)
	assert.equal(writes.length, 0)
	await accountTheme.remember(builtin('pastoral'))
	assert.equal(writes.length, 1)
	assert.equal(writes[0].key, reads[0].key)
	assert.equal(
		writes[0].options.keychainService,
		reads[0].options.keychainService,
	)
	assert.equal(writes[0].value, 'pastoral')
})

void test('only three exact builtin values restore; invalid and external values fall back without rewriting storage', async () => {
	const { AccountThemePreference } = load()
	for (const stored of [
		null,
		'',
		' modern ',
		'ANIME',
		'package:example.external',
		'https://example.invalid/theme',
		'{"key":"pastoral"}',
	]) {
		let writes = 0
		const preference = new AccountThemePreference({
			read: async () => stored,
			write: async () => {
				writes++
			},
		})
		await preference.restore()
		assert.equal(preference.getSnapshot(), 'modern')
		assert.equal(writes, 0)
	}
	for (const stored of ['modern', 'pastoral', 'anime'] as const) {
		const preference = new AccountThemePreference({
			read: async () => stored,
			write: async () => assert.fail('restoring is read only'),
		})
		await preference.restore()
		assert.equal(preference.getSnapshot(), stored)
	}
})

void test('a delayed previous restore cannot overwrite a newer explicit selection', async () => {
	const { AccountThemePreference } = load()
	const pending = deferred<string | null>()
	const writes: ThemeKey[] = []
	const preference = new AccountThemePreference({
		read: () => pending.promise,
		write: async (key) => {
			writes.push(key)
		},
	})
	const observed: ThemeKey[] = []
	const stop = preference.subscribe(() =>
		observed.push(preference.getSnapshot()),
	)
	const old = preference.restore()
	assert.equal(preference.restore(), old)
	await tick()
	await preference.remember(builtin('anime'))
	pending.resolve('pastoral')
	await old
	assert.equal(preference.getSnapshot(), 'anime')
	assert.deepEqual(writes, ['anime'])
	assert.deepEqual(observed, ['anime'])
	stop()
	await preference.remember(builtin('modern'))
	assert.deepEqual(observed, ['anime'])
})

void test('rapid choices persist in request order; an external choice stores only modern', async () => {
	const { AccountThemePreference } = load()
	const pending: ReturnType<typeof deferred<void>>[] = []
	const started: ThemeKey[] = []
	let stored = 'modern'
	const preference = new AccountThemePreference({
		read: async () => stored,
		write: async (key) => {
			started.push(key)
			const step = deferred<void>()
			pending.push(step)
			await step.promise
			stored = key
		},
	})
	const first = preference.remember(builtin('pastoral'))
	const second = preference.remember(builtin('anime'))
	const last = preference.remember(external)
	assert.equal(preference.getSnapshot(), 'modern')
	await tick()
	assert.deepEqual(started, ['pastoral'])
	pending[0].resolve()
	await tick()
	assert.deepEqual(started, ['pastoral', 'anime'])
	pending[1].resolve()
	await tick()
	assert.deepEqual(started, ['pastoral', 'anime', 'modern'])
	pending[2].resolve()
	await Promise.all([first, second, last])
	assert.equal(stored, 'modern')
	await preference.restore()
	assert.equal(preference.getSnapshot(), 'modern')
})

void test('restore waits for an in-flight save instead of reading the previous durable value', async () => {
	const { AccountThemePreference } = load()
	const saving = deferred<void>()
	let stored = 'pastoral',
		reads = 0
	const preference = new AccountThemePreference({
		read: async () => {
			reads++
			return stored
		},
		write: async (key) => {
			await saving.promise
			stored = key
		},
	})
	const write = preference.remember(builtin('anime'))
	const restore = preference.restore()
	await tick()
	assert.equal(reads, 0)
	saving.resolve()
	await Promise.all([write, restore])
	assert.equal(reads, 1)
	assert.equal(preference.getSnapshot(), 'anime')
})

void test('read/write failures stay contained and fall back; a failed old save cannot reset a newer choice', async () => {
	const { AccountThemePreference } = load()
	let failing = true
	const written: ThemeKey[] = []
	const preference = new AccountThemePreference({
		read: async () => {
			throw new Error('unavailable')
		},
		write: async (key) => {
			if (failing) throw new Error('unavailable')
			written.push(key)
		},
	})
	await preference.restore()
	assert.equal(preference.getSnapshot(), 'modern')
	await preference.remember(builtin('anime'))
	assert.equal(preference.getSnapshot(), 'modern')
	failing = false
	await preference.remember(builtin('anime'))
	assert.equal(preference.getSnapshot(), 'anime')
	assert.deepEqual(written, ['anime'])
	await preference.restore()
	assert.equal(preference.getSnapshot(), 'modern')
	const old = deferred<void>()
	const next = new AccountThemePreference({
		read: async () => null,
		write: async (key) => {
			if (key === 'pastoral') await old.promise
		},
	})
	const first = next.remember(builtin('pastoral'))
	const second = next.remember(builtin('anime'))
	old.reject(new Error('older failure'))
	await Promise.all([first, second])
	assert.equal(next.getSnapshot(), 'anime')
})

void test('actual App effect mirrors only restored committed selection, not startup, readonly, preview or temporary display', async () => {
	const source = ts.createSourceFile(
		'App.tsx',
		readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	const effects: ts.ArrowFunction[] = []
	function visit(node: ts.Node) {
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(source) === 'useEffect'
		) {
			const callback = node.arguments[0]
			if (
				callback &&
				ts.isArrowFunction(callback) &&
				callback.getText(source).includes('accountTheme.remember')
			)
				effects.push(callback)
		}
		ts.forEachChild(node, visit)
	}
	visit(source)
	assert.equal(effects.length, 1)
	const { AccountThemePreference } = load()
	const saved: ThemeKey[] = []
	const preference = new AccountThemePreference({
		read: async () => assert.fail('App effect must not read storage'),
		write: async (key) => {
			saved.push(key)
		},
	})
	const state: {
		loading: boolean
		installer: { readOnly: boolean; preview?: ThemeSelection } | null
		current: { selection: ThemeSelection }
	} = {
		loading: true,
		installer: null,
		current: { selection: builtin('pastoral') },
	}
	const run = () =>
		runInNewContext(
			ts.transpileModule(`(${effects[0].getText(source)})()`, {
				compilerOptions: { module: ts.ModuleKind.CommonJS },
			}).outputText,
			{
				workshop: { state },
				accountTheme: preference,
				currentDisplay: { presentation: { selection: builtin('modern') } },
			},
		)
	run()
	state.loading = false
	run()
	state.installer = { readOnly: true }
	run()
	assert.equal(preference.getSnapshot(), 'modern')
	assert.equal(saved.length, 0)
	state.installer = { readOnly: false, preview: builtin('anime') }
	run()
	await tick()
	assert.equal(preference.getSnapshot(), 'pastoral')
	assert.deepEqual(saved, ['pastoral'])
	run()
	await tick()
	assert.deepEqual(saved, ['pastoral'])
	state.current = { selection: external }
	run()
	await tick()
	assert.equal(preference.getSnapshot(), 'modern')
	assert.deepEqual(saved, ['pastoral', 'modern'])
})
