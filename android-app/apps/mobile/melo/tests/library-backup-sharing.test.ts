import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { compile } from './search-page-fixture'

void test('backup sharing is linked, deferred until export, and never reports success when unavailable', async () => {
	const pkg = JSON.parse(
		readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
	)
	assert.equal(pkg.expo.autolinking.exclude.includes('expo-sharing'), false)
	assert.equal(pkg.dependencies['expo-sharing'], '~57.0.22')
	let mode = 'missing',
		loads = 0,
		reads = 0,
		exports = 0,
		shares = 0,
		closes = 0
	const output: { shareLibraryBackup?: (full: boolean) => Promise<void> } = {}
	runInNewContext(
		compile(
			readFileSync(
				new URL('../library-backup-mobile.ts', import.meta.url),
				'utf8',
			),
		),
		{
			exports: output,
			require: (dependency: string) => {
				if (dependency === 'expo-sharing') {
					loads++
					if (mode === 'missing')
						throw new Error("Cannot find native module 'ExpoSharing'")
					return {
						isAvailableAsync: async () => mode !== 'unavailable',
						shareAsync: async (uri: string, options: { mimeType: string }) => {
							shares++
							assert.equal(uri, 'file:///backup.zip')
							assert.equal(options.mimeType, 'application/zip')
							if (mode === 'share-error') throw new Error('share failed')
						},
					}
				}
				if (
					dependency === 'expo-document-picker' ||
					dependency === 'expo-file-system'
				)
					return {}
				if (dependency === 'expo-sqlite')
					return {
						openDatabaseSync: () => {
							reads++
							return {
								closeSync: () => {
									closes++
								},
							}
						},
					}
				if (dependency.endsWith('/LibraryBackupModule'))
					return {
						getLibraryBackupModule: () => ({
							exportAsync: async () => {
								exports++
								return 'file:///backup.zip'
							},
						}),
					}
				if (dependency === './core/database') return { migrate: () => {} }
				if (dependency === './core/library-backup')
					return { exportLibraryBackup: () => '{}' }
				throw new Error(dependency)
			},
		},
	)
	assert.equal(
		loads,
		0,
		'app startup must not load optional sharing native module',
	)
	assert.ok(output.shareLibraryBackup)
	await assert.rejects(output.shareLibraryBackup(false), /缺少系统分享组件/)
	assert.equal(reads, 0)
	assert.equal(exports, 0)
	mode = 'unavailable'
	await assert.rejects(output.shareLibraryBackup(true), /不支持系统分享/)
	assert.equal(exports, 0)
	mode = 'available'
	await output.shareLibraryBackup(false)
	assert.equal(shares, 1)
	assert.equal(exports, 1)
	assert.equal(closes, 1)
	mode = 'share-error'
	await assert.rejects(output.shareLibraryBackup(true), /share failed/)
	assert.equal(shares, 2)
})

void test('save is independent of sharing and propagates true, cancel, error and mode', async () => {
	let mode: boolean | Error = true
	let available = true
	const calls: unknown[] = []
	const output: { saveLibraryBackup?: (full: boolean) => Promise<boolean> } = {}
	runInNewContext(
		compile(
			readFileSync(
				new URL('../library-backup-mobile.ts', import.meta.url),
				'utf8',
			),
		),
		{
			exports: output,
			require: (dependency: string) => {
				if (dependency === 'expo-sharing')
					throw new Error('Sharing must not load')
				if (
					dependency === 'expo-document-picker' ||
					dependency === 'expo-file-system'
				)
					return {}
				if (dependency === 'expo-sqlite')
					return {
						openDatabaseSync: () => ({ closeSync: () => calls.push('close') }),
					}
				if (dependency.endsWith('/LibraryBackupModule'))
					return {
						getLibraryBackupModule: () => ({
							saveAsync: available
								? async (catalogue: string, full: boolean) => {
										calls.push([catalogue, full])
										if (mode instanceof Error) throw mode
										return mode
									}
								: undefined,
						}),
					}
				if (dependency === './core/database') return { migrate: () => {} }
				if (dependency === './core/library-backup')
					return {
						exportLibraryBackup: (
							_db: unknown,
							_time: number,
							full: boolean,
						) => (full ? 'full' : 'light'),
					}
				throw new Error(dependency)
			},
		},
	)
	assert.equal(await output.saveLibraryBackup!(false), true)
	mode = false
	assert.equal(await output.saveLibraryBackup!(true), false)
	assert.deepEqual(calls, ['close', ['light', false], 'close', ['full', true]])
	mode = new Error('provider failed')
	await assert.rejects(output.saveLibraryBackup!(false), /provider failed/)
	available = false
	await assert.rejects(
		output.saveLibraryBackup!(false),
		/当前安装版本不支持保存到文件/,
	)
})
