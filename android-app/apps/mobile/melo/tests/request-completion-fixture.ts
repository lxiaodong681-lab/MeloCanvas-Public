import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

export function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (cause: unknown) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}
export const checkpoint = () =>
	new Promise<void>((resolve) => setImmediate(resolve))
export const json = (data: unknown, code = 0) =>
	new Response(JSON.stringify({ code, data }))

/** Actual cold module; no request algorithm copied. Deadline and transport are explicit ports. */
export function requestFixture(
	transport: (path: string, signal: AbortSignal) => Promise<Response>,
) {
	const path = new URL('../bilibili.ts', import.meta.url)
	const api = {} as typeof import('../bilibili')
	const timers = new Map<number, () => void>()
	const controllers: ReturnType<typeof monitorSignal>[] = []
	class ObservedAbortController extends AbortController {
		constructor() {
			super()
			controllers.push(monitorSignal(this.signal))
		}
	}
	let timerId = 0,
		fetches = 0
	runInNewContext(
		ts.transpileModule(readFileSync(path, 'utf8'), {
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.CommonJS,
			},
		}).outputText,
		{
			exports: api,
			require: createRequire(path),
			AbortController: ObservedAbortController,
			URL,
			Date,
			Error,
			TypeError,
			SyntaxError,
			fetch: async (input: string, init: RequestInit) => {
				assert.ok(init.signal)
				assert.equal(init.credentials, 'omit')
				fetches++
				return transport(new URL(input).pathname, init.signal)
			},
			setTimeout: (callback: () => void, delay: number) => {
				assert.equal(delay, 15000)
				timers.set(++timerId, callback)
				return timerId
			},
			clearTimeout: (id: number) => {
				timers.delete(id)
			},
		},
	)
	const listeningPath = new URL('../listening-source.ts', import.meta.url)
	const listening = {} as typeof import('../listening-source')
	runInNewContext(
		ts.transpileModule(readFileSync(listeningPath, 'utf8'), {
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.CommonJS,
			},
		}).outputText,
		{
			exports: listening,
			Error,
			require: (name: string) =>
				name === './bilibili' ? api : createRequire(listeningPath)(name),
		},
	)
	return {
		api,
		listening,
		expire: () => {
			assert.equal(timers.size, 1)
			const [id, callback] = [...timers][0]
			timers.delete(id)
			callback()
		},
		pendingTimers: () => timers.size,
		pendingInternalListeners: () =>
			controllers.reduce(
				(count, controller) => count + controller.pendingListeners(),
				0,
			),
		fetches: () => fetches,
	}
}

function monitorSignal(signal: AbortSignal) {
	const listeners = new Set<EventListenerOrEventListenerObject>()
	const add = signal.addEventListener.bind(signal),
		remove = signal.removeEventListener.bind(signal)
	Object.defineProperty(signal, 'addEventListener', {
		value: (
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: AddEventListenerOptions | boolean,
		) => {
			if (type === 'abort') listeners.add(listener)
			add(type, listener, options)
		},
	})
	Object.defineProperty(signal, 'removeEventListener', {
		value: (
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: EventListenerOptions | boolean,
		) => {
			if (type === 'abort') listeners.delete(listener)
			remove(type, listener, options)
		},
	})
	return { pendingListeners: () => listeners.size }
}
export function cancellation() {
	const controller = new AbortController(),
		signal = controller.signal
	return { controller, signal, ...monitorSignal(signal) }
}

/** Do not hang the test runner when the production request itself never completes. */
export function observe<T>(promise: Promise<T>) {
	let status: 'pending' | 'success' | 'error' = 'pending',
		value: T | undefined,
		error: unknown
	void promise.then(
		(result) => {
			status = 'success'
			value = result
		},
		(cause: unknown) => {
			status = 'error'
			error = cause
		},
	)
	return { get: () => ({ status, value, error }) }
}
