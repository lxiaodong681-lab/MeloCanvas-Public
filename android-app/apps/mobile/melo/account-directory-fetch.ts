import type { DirectoryFetch } from './directory-http'
import { DirectoryReadError } from './external-directory'

interface Access {
	onlineAllowed: boolean
	sessionGeneration: number
}

/** Eligibility only: never injects account credentials into third-party requests.
 * Keeps the original streaming reader and its 8MiB bound intact.
 */
export function createAccountDirectoryFetch(
	fetcher: DirectoryFetch,
	getAccess: () => Access,
	subscribe: (listener: () => void) => () => void,
): DirectoryFetch {
	return async (url, init) => {
		const initial = getAccess()
		if (!initial.onlineAllowed)
			throw new DirectoryReadError('permission', '请先验证账号后读取在线目录')
		const controller = new AbortController()
		let reader: ReturnType<NonNullable<Awaited<ReturnType<DirectoryFetch>>['body']>['getReader']> | undefined
		let unsubscribe: (() => void) | undefined
		const cleanup = () => {
			unsubscribe?.()
			unsubscribe = undefined
			init.signal.removeEventListener('abort', abort)
		}
		const abort = () => {
			controller.abort()
			if (reader) void reader.cancel().catch(() => {})
			cleanup()
		}
		const valid = () => {
			const now = getAccess()
			return now.onlineAllowed && now.sessionGeneration === initial.sessionGeneration
		}
		const check = () => {
			if (!valid() || init.signal.aborted || controller.signal.aborted) {
				abort()
				throw new DirectoryReadError('cancelled', '账号状态已改变或目录读取已取消')
			}
		}
		unsubscribe = subscribe(() => { if (!valid()) abort() })
		init.signal.addEventListener('abort', abort, { once: true })
		try {
			check()
			const response = await fetcher(url, { ...init, signal: controller.signal })
			// Acquire before checking: even a transport ignoring abort must have its
			// late body cancelled, not returned to a caller in a newer session.
			reader = response.body?.getReader()
			check()
			if (!reader) {
				cleanup()
				return { status: response.status, url: response.url, redirected: response.redirected, headers: response.headers, body: null }
			}
			const bodyReader = reader
			return {
				status: response.status,
				url: response.url,
				redirected: response.redirected,
				headers: response.headers,
				body: { getReader: () => ({
					read: async () => {
						try {
							check()
							const part = await bodyReader.read()
							check()
							return part
						} catch (error) { abort(); throw error }
					},
					cancel: async () => { cleanup(); controller.abort(); await bodyReader.cancel() },
					releaseLock: () => { cleanup(); bodyReader.releaseLock() },
				}) },
			}
		} catch (error) {
			abort()
			try { reader?.releaseLock() } catch { /* Preserve the original rejection. */ }
			throw error
		}
	}
}
