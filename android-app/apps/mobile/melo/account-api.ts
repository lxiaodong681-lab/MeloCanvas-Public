import { splitCookiesString, parse } from 'set-cookie-parser'

import { AccountSessionError, type AccountIdentity } from './account-session'

const diagnosticCodes = [
	'bridge-unavailable',
	'headers-unavailable',
	'response-unavailable',
	'native-request-failed',
	'native-unexpected',
	'native-unavailable',
	'native-invalid-argument',
	'native-function-call',
	'response-invalid',
	'generate-transport',
	'generate-json',
	'generate-validate',
	'generate-key-type',
	'generate-key-format',
	'generate-url-type',
	'generate-url-parse',
	'generate-url-protocol',
	'generate-url-host',
	'generate-url-credentials',
	'poll-failed',
	'qr-render-failed',
] as const
type DiagnosticCode = (typeof diagnosticCodes)[number]
/** Only fixed codes may reach the release UI; never copy exception messages. */
export class AccountDiagnosticError extends AccountSessionError {
	constructor(
		readonly diagnostic: DiagnosticCode,
		readonly detail?: DiagnosticCode,
		readonly hostDiagnostic?: { host: string; synthetic: boolean },
	) {
		super(diagnostic.startsWith('generate-') ? 'invalid-response' : 'network')
	}
}
/** A conservative public-domain-only projection, never a URL or token-like label. */
export function diagnosticPublicHostname(value: unknown): string {
	if (
		typeof value !== 'string' ||
		value.length > 253 ||
		!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)
	) return 'domain-invalid'
	const labels = value.split('.')
	if (labels.slice(0, -1).some((label, index) =>
		label.length > 24 ||
		/^[a-f0-9]{12,}$/i.test(label) ||
		(label.length >= 12 && /[a-z]/i.test(label) && /[0-9]/.test(label)) ||
		/^[0-9]{6,}$/.test(label) ||
		(index < labels.length - 2 && label.length >= 12)
	)) return 'domain-masked'
	return value
}
export function syntheticHostnameMatches(): boolean {
	try {
		return new URL('https://passport.bilibili.com/').hostname === 'passport.bilibili.com'
	} catch { return false }
}
export function accountDiagnosticCode(error: unknown): string {
	if (
		!(error instanceof AccountDiagnosticError) ||
		!diagnosticCodes.includes(error.diagnostic)
	)
		return 'unclassified'
	const code = error.detail && diagnosticCodes.includes(error.detail)
		? `${error.diagnostic}/${error.detail}`
		: error.diagnostic
	if (error.diagnostic !== 'generate-url-host' || !error.hostDiagnostic) return code
	const host = ['domain-invalid', 'domain-masked'].includes(error.hostDiagnostic.host)
		? error.hostDiagnostic.host : diagnosticPublicHostname(error.hostDiagnostic.host)
	return `${code}/host=${host}/synthetic=${error.hostDiagnostic.synthetic}`
}

let transport: (url: string, init: RequestInit) => Promise<Response> = (
	url,
	init,
) => fetch(url, init)
export function configureAccountNetwork(fetcher: typeof transport) {
	transport = fetcher
}

const passport = 'https://passport.bilibili.com/x/passport-login/web/qrcode/'
const headers = {
	'User-Agent': 'Mozilla/5.0',
	Referer: 'https://www.bilibili.com/',
}
async function safeFetch(url: string, signal: AbortSignal, cookie?: string) {
	try {
		const response = await transport(url, {
			headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
			signal,
			credentials: 'omit',
			redirect: 'error',
		})
		if (response.status === 401 && cookie)
			throw new AccountSessionError('expired')
		if (!response.ok) throw new AccountSessionError('network')
		return response
	} catch (error) {
		throw error instanceof AccountSessionError
			? error
			: new AccountSessionError('network')
	}
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new AccountSessionError('invalid-response')
	return value as Record<string, unknown>
}
async function bodyData(response: Response) {
	let body: Record<string, unknown>
	try {
		body = record(await response.json())
	} catch {
		throw new AccountSessionError('invalid-response')
	}
	if (body.code === -101) throw new AccountSessionError('expired')
	if (body.code !== 0) throw new AccountSessionError('invalid-response')
	return record(body.data)
}
export async function verifyAccount(
	cookie: string,
	signal: AbortSignal,
): Promise<AccountIdentity> {
	const data = await bodyData(
		await safeFetch(
			'https://api.bilibili.com/x/web-interface/nav',
			signal,
			cookie,
		),
	)
	if (data.isLogin === false) throw new AccountSessionError('expired')
	if (data.isLogin !== true) throw new AccountSessionError('invalid-response')
	if (
		typeof data.mid !== 'number' ||
		!Number.isSafeInteger(data.mid) ||
		data.mid <= 0 ||
		typeof data.uname !== 'string'
	)
		throw new AccountSessionError('invalid-response')
	let avatar: string | undefined
	if (typeof data.face === 'string') {
		try {
			const url = new URL(data.face)
			if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
				(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com'))) {
				url.protocol = 'https:'
				avatar = url.href
			}
		} catch { /* A missing avatar must not prevent account verification. */ }
	}
	return { mid: String(data.mid), name: data.uname.slice(0, 80), ...(avatar ? { avatar } : {}) }
}
export async function generateLoginQr(
	signal: AbortSignal,
): Promise<{ key: string; url: string }> {
	let response: Response
	try {
		response = await safeFetch(`${passport}generate`, signal)
	} catch (error) {
		throw new AccountDiagnosticError(
			'generate-transport',
			error instanceof AccountDiagnosticError
				? (error.detail ?? error.diagnostic)
				: undefined,
		)
	}
	let data: Record<string, unknown>
	try {
		data = await bodyData(response)
	} catch {
		throw new AccountDiagnosticError('generate-json')
	}
	if (typeof data.qrcode_key !== 'string')
		throw new AccountDiagnosticError('generate-key-type')
	if (!/^[a-zA-Z0-9_-]{8,256}$/.test(data.qrcode_key))
		throw new AccountDiagnosticError('generate-key-format')
	if (typeof data.url !== 'string')
		throw new AccountDiagnosticError('generate-url-type')
	let url: URL
	try {
		url = new URL(data.url)
	} catch {
		throw new AccountDiagnosticError('generate-url-parse')
	}
	if (url.protocol !== 'https:')
		throw new AccountDiagnosticError('generate-url-protocol')
	const hostname = url.hostname
	if (!['passport.bilibili.com', 'account.bilibili.com'].includes(hostname))
		throw new AccountDiagnosticError('generate-url-host', undefined, {
			host: diagnosticPublicHostname(hostname),
			synthetic: syntheticHostnameMatches(),
		})
	if (url.username || url.password)
		throw new AccountDiagnosticError('generate-url-credentials')
	return { key: data.qrcode_key, url: data.url }
}
/** Reuses BBPlayer's web QR protocol, but never forwards Set-Cookie attributes or foreign cookies. */
export function normalizeLoginCookies(header: string): string {
	const allowed = new Set([
		'SESSDATA',
		'bili_jct',
		'DedeUserID',
		'DedeUserID__ckMd5',
		'sid',
	])
	const values = parse(splitCookiesString(header), { decodeValues: false })
	const pairs = new Map<string, string>()
	for (const item of values) {
		if (!allowed.has(item.name)) continue
		if (
			item.domain &&
			!['bilibili.com', '.bilibili.com', 'passport.bilibili.com'].includes(
				item.domain.toLowerCase(),
			)
		)
			continue
		if (
			!item.value ||
			/[\s;,\r\n]/.test(item.value) ||
			item.value.length > 8192
		)
			throw new AccountSessionError('invalid-response')
		pairs.set(item.name, item.value)
	}
	if (
		!pairs.has('SESSDATA') ||
		!pairs.has('bili_jct') ||
		!/^\d+$/.test(pairs.get('DedeUserID') ?? '')
	)
		throw new AccountSessionError('invalid-response')
	return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ')
}
export async function pollLoginQr(
	key: string,
	signal: AbortSignal,
): Promise<
	| { status: 'waiting' | 'scanned' | 'expired' }
	| { status: 'success'; cookie: string }
> {
	if (!/^[a-zA-Z0-9_-]{8,256}$/.test(key))
		throw new AccountSessionError('invalid-response')
	const response = await safeFetch(
		`${passport}poll?qrcode_key=${encodeURIComponent(key)}`,
		signal,
	)
	const data = await bodyData(response)
	if (data.code === 86101) return { status: 'waiting' }
	if (data.code === 86090) return { status: 'scanned' }
	if (data.code === 86038) return { status: 'expired' }
	if (data.code !== 0) throw new AccountSessionError('invalid-response')
	return {
		status: 'success',
		cookie: normalizeLoginCookies(response.headers.get('set-cookie') ?? ''),
	}
}
