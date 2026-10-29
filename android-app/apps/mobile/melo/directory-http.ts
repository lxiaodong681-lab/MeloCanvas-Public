import {
	DirectoryReadError,
	externalDirectoryLimits,
} from './external-directory'

interface DirectoryBodyReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>
	cancel(): Promise<void>
	releaseLock(): void
}
export interface DirectoryHttpResponse {
	status: number
	url: string
	redirected: boolean
	headers: { get(name: string): string | null }
	body: { getReader(): DirectoryBodyReader } | null
}
export type DirectoryFetch = (
	url: string,
	init: {
		method: 'GET' | 'POST'
		headers: Record<string, string>
		body?: string
		credentials: 'omit'
		redirect: 'error'
		signal: AbortSignal
	},
) => Promise<DirectoryHttpResponse>

export interface DirectoryHttpRequest {
	url: string
	method: 'GET' | 'POST'
	headers: Record<string, string>
	body?: string
}

export async function readDirectoryHttp(
	fetcher: DirectoryFetch,
	request: DirectoryHttpRequest,
	signal: AbortSignal,
): Promise<Uint8Array> {
	if (signal.aborted)
		throw new DirectoryReadError('cancelled', '目录读取已取消')
	// Rejection from redirect:error can be generic; do not guess its cause from an error string.
	const response = await fetcher(request.url, {
		...request,
		signal,
		credentials: 'omit',
		redirect: 'error',
	})
	const reader = response.body?.getReader()
	let finished = false
	try {
		if (
			response.redirected ||
			response.url !== request.url ||
			(response.status >= 300 && response.status < 400)
		)
			throw new DirectoryReadError('redirect', '目录端点发生不允许的跳转')
		if (response.status < 200 || response.status >= 300)
			throw new DirectoryReadError(
				[401, 403].includes(response.status) ? 'permission' : 'platform',
				'平台目录请求未成功',
				{ httpStatus: response.status },
			)
		const length = response.headers.get('content-length')
		if (
			length !== null &&
			(!/^[0-9]+$/.test(length) ||
				Number(length) > externalDirectoryLimits.responseBytes)
		)
			throw new DirectoryReadError('limit', '平台响应声明长度无效或超过 8MiB')
		if (!reader)
			throw new DirectoryReadError('response', '目录响应没有可有界读取的数据流')
		const chunks: Uint8Array[] = []
		let size = 0
		while (true) {
			if (signal.aborted)
				throw new DirectoryReadError('cancelled', '目录读取已取消')
			const part = await reader.read()
			if (signal.aborted)
				throw new DirectoryReadError('cancelled', '目录读取已取消')
			if (part.done) {
				finished = true
				break
			}
			if (!(part.value instanceof Uint8Array))
				throw new DirectoryReadError('response', '目录响应数据流无效')
			if (part.value.byteLength > externalDirectoryLimits.responseBytes - size)
				throw new DirectoryReadError('limit', '平台实际响应超过 8MiB')
			size += part.value.byteLength
			chunks.push(part.value)
		}
		const bytes = new Uint8Array(size)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		return bytes
	} finally {
		// Cleanup failure must not replace the original HTTP/limit/cancellation error.
		if (reader) {
			if (!finished) void reader.cancel().catch(() => {})
			try {
				reader.releaseLock()
			} catch {
				/* A pending native read may release after abort. */
			}
		}
	}
}
