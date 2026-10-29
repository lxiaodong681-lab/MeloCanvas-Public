import assert from 'node:assert/strict'
import { test } from 'node:test'

import { themePackageLimits } from '../core/theme-package-types'
import {
	ThemeFileSelection,
	type ThemeFileChoice,
} from '../theme-file-selection'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const choice: ThemeFileChoice = {
	uri: 'content://picker/theme',
	name: 'example.melotheme',
}

void test('文件读取后才传实际bytes校验；大小未知也使用限额读取入口', async () => {
	const calls: string[] = []
	const bytes = new Uint8Array([1, 2, 3])
	const selection = new ThemeFileSelection({
		pick: async () => choice,
		read: async (uri) => {
			calls.push(uri)
			return bytes
		},
		importBytes: async (value) => {
			assert.equal(value, bytes)
			return true
		},
		cancelValidation: () => {
			calls.push('cancel')
		},
	})
	assert.equal(await selection.choose(), true)
	assert.deepEqual(calls, ['cancel', choice.uri])
	assert.deepEqual(selection.getSnapshot(), {
		busy: false,
		file: { name: choice.name, bytes: 3 },
		error: null,
	})
})

void test('取消文件选择不生成错误也不启动读取', async () => {
	const selection = new ThemeFileSelection({
		pick: async () => null,
		read: async () => {
			throw new Error('must not read')
		},
		importBytes: async () => {
			throw new Error('must not validate')
		},
		cancelValidation: () => {},
	})
	assert.equal(await selection.choose(), false)
	assert.deepEqual(selection.getSnapshot(), {
		busy: false,
		file: null,
		error: null,
	})
})

void test('关闭后迟到picker结果不读取；迟到读取结果不验证', async () => {
	const picker = deferred<ThemeFileChoice | null>(),
		read = deferred<Uint8Array>(),
		pickerStarted = deferred<void>(),
		readStarted = deferred<void>()
	let picks = 0,
		reads = 0,
		imports = 0
	const selection = new ThemeFileSelection({
		pick: () => {
			if (++picks === 1) {
				pickerStarted.resolve()
				return picker.promise
			}
			return Promise.resolve(choice)
		},
		read: () => {
			reads++
			readStarted.resolve()
			return read.promise
		},
		importBytes: async () => {
			imports++
			return true
		},
		cancelValidation: () => {},
	})
	const first = selection.choose()
	await pickerStarted.promise
	selection.cancel()
	picker.resolve(choice)
	assert.equal(await first, false)
	assert.equal(reads, 0)
	const second = selection.choose()
	await readStarted.promise
	assert.equal(reads, 1)
	selection.cancel()
	read.resolve(new Uint8Array([1]))
	assert.equal(await second, false)
	assert.equal(imports, 0)
	assert.equal(selection.getSnapshot().error, null)
})

void test('旧读取失败及finally不能清除新选择busy或显示过期错误', async () => {
	const oldRead = deferred<Uint8Array>(),
		newPick = deferred<ThemeFileChoice | null>(),
		readStarted = deferred<void>()
	let picks = 0
	const selection = new ThemeFileSelection({
		pick: () => (++picks === 1 ? Promise.resolve(choice) : newPick.promise),
		read: () => {
			readStarted.resolve()
			return oldRead.promise
		},
		importBytes: async () => true,
		cancelValidation: () => {},
	})
	const old = selection.choose()
	await readStarted.promise
	const current = selection.choose()
	oldRead.reject(new Error('late old failure'))
	assert.equal(await old, false)
	assert.equal(selection.getSnapshot().busy, true)
	assert.equal(selection.getSnapshot().error, null)
	newPick.resolve(null)
	assert.equal(await current, false)
	assert.equal(selection.getSnapshot().busy, false)
})

void test('等待旧工作释放期间关闭立即清UI，不会在drain后重新打开picker', async () => {
	const drain = deferred<void>()
	let picks = 0
	const selection = new ThemeFileSelection({
		pick: async () => {
			picks++
			return choice
		},
		read: async () => new Uint8Array([1]),
		importBytes: async () => true,
		cancelValidation: () => drain.promise,
	})
	const pending = selection.choose()
	selection.cancel()
	assert.equal(selection.getSnapshot().busy, false)
	drain.resolve()
	assert.equal(await pending, false)
	assert.equal(picks, 0)
	assert.equal(selection.getSnapshot().error, null)
})

void test('报告过大在读取前拒绝，实际读取过大也不进入验证', async () => {
	let reads = 0,
		imports = 0
	const selection = new ThemeFileSelection({
		pick: async () => ({
			...choice,
			reportedBytes: themePackageLimits.archiveBytes + 1,
		}),
		read: async () => {
			reads++
			return new Uint8Array()
		},
		importBytes: async () => {
			imports++
			return true
		},
		cancelValidation: () => {},
	})
	assert.equal(await selection.choose(), false)
	assert.equal(reads, 0)
	assert.match(selection.getSnapshot().error!.message, /20 MiB/)
	const actual = new ThemeFileSelection({
		pick: async () => choice,
		read: async () => new Uint8Array(themePackageLimits.archiveBytes + 1),
		importBytes: async () => {
			imports++
			return true
		},
		cancelValidation: () => {},
	})
	assert.equal(await actual.choose(), false)
	assert.equal(imports, 0)
})

void test('保留真实读取错误供重试；installer的false不冒充成功', async () => {
	const disk = new Error('read denied')
	let attempts = 0
	const selection = new ThemeFileSelection({
		pick: async () => choice,
		read: async () => {
			if (++attempts === 1) throw disk
			return new Uint8Array([1])
		},
		importBytes: async () => false,
		cancelValidation: () => {},
	})
	assert.equal(await selection.choose(), false)
	assert.equal(selection.getSnapshot().error, disk)
	assert.equal(await selection.choose(), false)
	assert.equal(selection.getSnapshot().error, null)
})

void test('新选择等待旧single-slot校验及cleanup/finally释放，不被busy静默拒绝', async () => {
	const admitted = deferred<void>(),
		drain = deferred<void>()
	let picks = 0,
		busyRejects = 0
	let slot: Promise<boolean> | null = null
	let cancelled = false
	const selection = new ThemeFileSelection({
		pick: async () => ({ ...choice, uri: `content://picker/${++picks}` }),
		read: async (uri) => new Uint8Array([Number(uri.at(-1))]),
		importBytes: (bytes) => {
			if (slot) {
				busyRejects++
				return Promise.resolve(false)
			}
			if (bytes[0] === 2) return Promise.resolve(true)
			cancelled = false
			slot = drain.promise
				.then(() => !cancelled)
				.finally(() => {
					slot = null
				})
			admitted.resolve()
			return slot
		},
		cancelValidation: () => {
			if (!slot) return Promise.resolve()
			cancelled = true
			return slot.then(() => undefined)
		},
	})
	const first = selection.choose()
	await admitted.promise
	const second = selection.choose()
	try {
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(
			picks,
			1,
			'second picker must wait for the occupied admission slot',
		)
		assert.equal(selection.getSnapshot().busy, true)
		drain.resolve()
		assert.equal(await first, false)
		assert.equal(await second, true)
		assert.equal(picks, 2)
		assert.equal(busyRejects, 0)
	} finally {
		drain.resolve()
		await Promise.allSettled([first, second])
	}
})
