import assert from 'node:assert/strict'
import test from 'node:test'

import {
	readDirectoryHttp,
	type DirectoryHttpResponse,
} from '../directory-http'
import {
	DirectoryReadError,
	externalDirectoryLimits,
} from '../external-directory'

const request = {
	url: 'https://example.invalid/directory',
	method: 'GET' as const,
	headers: {},
}
const response = (
	body: ReadableStream<Uint8Array>,
	status = 200,
): DirectoryHttpResponse => ({
	body,
	status,
	url: request.url,
	redirected: false,
	headers: { get: () => null },
})
const code = (expected: string, status?: number) => (error: unknown) => {
	assert(error instanceof DirectoryReadError)
	assert.equal(error.code, expected)
	if (status !== undefined) assert.equal(error.diagnostics.httpStatus, status)
	return true
}

void test('real stream converts a synchronous underlying cancel throw to rejection without replacing HTTP evidence', async () => {
	let cancelled = 0
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled++
			throw new Error('underlying cleanup failure')
		},
	})
	await assert.rejects(
		readDirectoryHttp(
			async () => response(body, 403),
			request,
			new AbortController().signal,
		),
		code('permission', 403),
	)
	assert.equal(cancelled, 1)
	assert.equal(body.locked, false)
})

void test('real stream over-budget chunk retains limit error and releases lock despite rejected cleanup', async () => {
	let pulls = 0,
		cancelled = 0
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				pulls++
				controller.enqueue(
					new Uint8Array(externalDirectoryLimits.responseBytes + 1),
				)
			},
			cancel() {
				cancelled++
				return Promise.reject(new Error('cleanup rejection'))
			},
		},
		{ highWaterMark: 0 },
	)
	await assert.rejects(
		readDirectoryHttp(
			async () => response(body),
			request,
			new AbortController().signal,
		),
		code('limit'),
	)
	assert.equal(pulls, 1)
	assert.equal(cancelled, 1)
	assert.equal(body.locked, false)
})

void test('real stream cancellation after pending read rejects late bytes and does not wait for cleanup settlement', async () => {
	const abort = new AbortController()
	let control!: ReadableStreamDefaultController<Uint8Array>
	let started!: () => void
	const reading = new Promise<void>((resolve) => {
		started = resolve
	})
	let finishCleanup!: () => void
	const cleanup = new Promise<void>((resolve) => {
		finishCleanup = resolve
	})
	let cancelled = 0
	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				control = controller
			},
			pull() {
				started()
			},
			cancel() {
				cancelled++
				return cleanup
			},
		},
		{ highWaterMark: 0 },
	)
	const pending = readDirectoryHttp(
		async () => response(body),
		request,
		abort.signal,
	)
	await reading
	abort.abort()
	control.enqueue(new Uint8Array([1, 2, 3]))
	try {
		await Promise.race([
			assert.rejects(pending, code('cancelled')),
			new Promise<never>((_, reject) => {
				setImmediate(() =>
					reject(new Error('primary result waited for cleanup')),
				)
			}),
		])
		assert.equal(cancelled, 1)
		assert.equal(body.locked, false)
	} finally {
		finishCleanup()
		await cleanup
	}
})

void test('real stream successful EOF returns exact chunks and releases lock without invoking cancellation', async () => {
	let cancelled = 0
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([0, 1]))
			controller.enqueue(new Uint8Array([2, 255]))
			controller.close()
		},
		cancel() {
			cancelled++
		},
	})
	assert.deepEqual(
		await readDirectoryHttp(
			async () => response(body),
			request,
			new AbortController().signal,
		),
		new Uint8Array([0, 1, 2, 255]),
	)
	assert.equal(cancelled, 0)
	assert.equal(body.locked, false)
})
