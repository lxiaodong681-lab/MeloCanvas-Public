import assert from 'node:assert/strict'
import { test } from 'node:test'

import { themePackageLimits } from '../core/theme-package-types'
import {
	createThemeImageDecoder,
	type ThemeImageDecodeBridge,
} from '../theme-image-decoder'

const image = {
	mime: 'image/png',
	width: 1,
	height: 1,
	frames: 1,
	decodedBytes: 4,
} as const
const deferred = () => {
	let resolve!: (value: typeof image) => void
	let reject!: (error: Error) => void
	const promise = new Promise<typeof image>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const code = (value: string) => (error: unknown) =>
	!!error &&
	typeof error === 'object' &&
	'code' in error &&
	error.code === value

void test('bridge receives an immutable input snapshot and tightened budgets', async () => {
	const bytes = new Uint8Array([1, 2, 3])
	const decoder = createThemeImageDecoder(async (actual, limits) => {
		assert.deepEqual([...actual], [1, 2, 3])
		assert.equal(limits.fileBytes, 10)
		assert(Object.isFrozen(limits))
		return image
	})
	const pending = decoder.decodeImage(bytes, {
		...themePackageLimits,
		fileBytes: 10,
	})
	bytes[0] = 99
	assert.deepEqual(await pending, image)
})

void test('limits and pre-abort reject before invoking native', async () => {
	let calls = 0
	const decoder = createThemeImageDecoder(async () => {
		calls++
		return image
	})
	for (const limits of [
		{ ...themePackageLimits, imagePixels: NaN },
		{ ...themePackageLimits, fileBytes: 9 * 1024 * 1024 },
		{ ...themePackageLimits, fileBytes: 1 },
	])
		await assert.rejects(
			decoder.decodeImage(new Uint8Array(2), limits),
			code('LIMIT_EXCEEDED'),
		)
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(
		decoder.decodeImage(
			new Uint8Array(2),
			themePackageLimits,
			controller.signal,
		),
		code('CANCELLED'),
	)
	assert.equal(calls, 0)
})

for (const outcome of ['success', 'failure'] as const)
	void test(`cancelled ${outcome} waits for native settlement before rejecting and releasing admission`, async () => {
		const work = deferred()
		let calls = 0
		const decoder = createThemeImageDecoder(() => {
			calls++
			return calls === 1 ? work.promise : Promise.resolve(image)
		})
		const controller = new AbortController()
		const pending = decoder.decodeImage(
			new Uint8Array(2),
			themePackageLimits,
			controller.signal,
		)
		let settled = false
		const completion = pending.then(
			() => {
				settled = true
				return null
			},
			(error: unknown) => {
				settled = true
				return error
			},
		)
		await Promise.resolve()
		controller.abort()
		try {
			await new Promise((resolve) => setImmediate(resolve))
			assert.equal(
				settled,
				false,
				'installer cancellation must wait for the actual native slot',
			)
			await assert.rejects(
				decoder.decodeImage(new Uint8Array(2), themePackageLimits),
				/忙/,
			)
			assert.equal(calls, 1)
		} finally {
			if (outcome === 'success') work.resolve(image)
			else work.reject(new Error('late native failure'))
		}
		assert(code('CANCELLED')(await completion))
		assert.deepEqual(
			await decoder.decodeImage(new Uint8Array(2), themePackageLimits),
			image,
		)
		assert.equal(calls, 2)
	})

void test('native failure releases admission and malformed or oversized output is rejected', async () => {
	for (const result of [
		{ ...image, frames: 2 },
		{ ...image, width: 9000 },
		{ ...image, decodedBytes: 3 },
	]) {
		const decoder = createThemeImageDecoder(
			(async () => result) as ThemeImageDecodeBridge,
		)
		await assert.rejects(
			decoder.decodeImage(new Uint8Array(2), themePackageLimits),
			code('IMAGE_INVALID'),
		)
	}
	let calls = 0
	const decoder = createThemeImageDecoder(() => {
		if (++calls === 1)
			throw Object.assign(new Error('limit'), { code: 'ERR_THEME_IMAGE_LIMIT' })
		return Promise.resolve(image)
	})
	await assert.rejects(
		decoder.decodeImage(new Uint8Array(2), themePackageLimits),
		code('LIMIT_EXCEEDED'),
	)
	assert.deepEqual(
		await decoder.decodeImage(new Uint8Array(2), themePackageLimits),
		image,
	)
})
