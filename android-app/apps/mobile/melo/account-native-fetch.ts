import { Orpheus } from '@bbplayer/orpheus'

import { AccountDiagnosticError } from './account-api'
import { AccountSessionError } from './account-session'
export function accountRuntimeCapabilities(): string {
	return `bridge:${typeof Orpheus.bilibiliAccountRequest === 'function'} Headers:${typeof Headers === 'function'} Response:${typeof Response === 'function'} TextEncoder:${typeof TextEncoder === 'function'}`
}
/** Native OkHttp owns the no-redirect/no-cookie-jar boundary, not RN fetch options. */
export async function fetchNativeBilibili(
	input: string,
	init: RequestInit,
): Promise<Response> {
	if (init.signal?.aborted) throw new AccountSessionError('stale-session')
	if (typeof Orpheus.bilibiliAccountRequest !== 'function')
		throw new AccountDiagnosticError('bridge-unavailable')
	if (typeof Headers !== 'function')
		throw new AccountDiagnosticError('headers-unavailable')
	if (typeof Response !== 'function')
		throw new AccountDiagnosticError('response-unavailable')
	let cookie: string
	try {
		cookie = new Headers(init.headers).get('Cookie') ?? ''
	} catch {
		throw new AccountDiagnosticError('response-invalid')
	}
	let result: { status: number; body: string; setCookie: string }
	try {
		result = await Orpheus.bilibiliAccountRequest(input, cookie)
	} catch (error) {
		const code =
			error && typeof error === 'object' && 'code' in error
				? error.code
				: undefined
		const detail =
			code === 'ERR_UNEXPECTED'
				? 'native-unexpected'
				: code === 'ERR_UNAVAILABLE'
					? 'native-unavailable'
					: code === 'ERR_INVALID_ARGUMENT'
						? 'native-invalid-argument'
						: code === 'ERR_FUNCTION_CALL'
							? 'native-function-call'
							: undefined
		throw new AccountDiagnosticError('native-request-failed', detail)
	}
	if (init.signal?.aborted) throw new AccountSessionError('stale-session')
	try {
		if (
			!result ||
			!Number.isInteger(result.status) ||
			typeof result.body !== 'string' ||
			typeof result.setCookie !== 'string'
		)
			throw new Error()
		return new Response(result.body, {
			status: result.status,
			headers: result.setCookie ? { 'set-cookie': result.setCookie } : {},
		})
	} catch {
		throw new AccountDiagnosticError('response-invalid')
	}
}
