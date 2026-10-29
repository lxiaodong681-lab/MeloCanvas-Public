import { AccountSessionError, type AccountSession } from './account-session'
import {
	createBilibiliFavoriteTransport,
	type BilibiliFavoriteTransport,
} from './bilibili-favorite'
import {
	createBilibiliFavoriteFoldersTransport,
	type BilibiliFavoriteFoldersTransport,
} from './bilibili-favorite-folders'
import {
	createBilibiliFavoriteIndexTransport,
	type BilibiliFavoriteIndexTransport,
} from './bilibili-favorite-index'
import type { DirectoryFetch } from './directory-http'
import {
	DirectoryReadError,
	externalDirectoryLimits,
} from './external-directory'

type Account = Pick<
	AccountSession,
	'getSnapshot' | 'getGeneration' | 'subscribe' | 'authorizedFetch' | 'signOut'
>
export interface AccountFavoriteIdentity {
	mid: string
	name: string
	generation: number
}
export interface AccountFavoritesPort {
	getIdentity(): AccountFavoriteIdentity | null
	subscribe(listener: () => void): () => void
	folders: BilibiliFavoriteFoldersTransport
	page: BilibiliFavoriteTransport
	index?: BilibiliFavoriteIndexTransport
}
const decimal = (value: string | null) =>
	!!value && /^[1-9][0-9]{0,127}$/.test(value) && value.trim() === value
function identity(account: Account): AccountFavoriteIdentity | null {
	const state = account.getSnapshot()
	if (state.status !== 'authenticated' || !state.account) return null
	return {
		mid: state.account.mid,
		name: state.account.name,
		generation: account.getGeneration(),
	}
}
function validUrl(
	input: string,
	init: Parameters<DirectoryFetch>[1],
	owner: AccountFavoriteIdentity,
): void {
	let url: URL
	try {
		url = new URL(input)
	} catch {
		throw new DirectoryReadError('invalid-input', '账号收藏夹请求地址无效')
	}
	const params = [...url.searchParams.keys()]
	const page = url.searchParams.get('pn')
	const ownFolders =
		url.pathname === '/x/v3/fav/folder/created/list-all' &&
		params.length === 1 &&
		params[0] === 'up_mid' &&
		decimal(owner.mid) &&
		url.searchParams.get('up_mid') === owner.mid
	const contents =
		url.pathname === '/x/v3/fav/resource/list' &&
		params.length === 3 &&
		new Set(params).size === 3 &&
		params.every((key) => ['media_id', 'pn', 'ps'].includes(key)) &&
		decimal(url.searchParams.get('media_id')) &&
		Number.isSafeInteger(Number(page)) &&
		String(Number(page)) === page &&
		Number(page) >= 1 &&
		Number(page) <= 125 &&
		url.searchParams.get('ps') === '40'
	const resourceIndex =
		url.pathname === '/x/v3/fav/resource/ids' &&
		params.length === 1 && params[0] === 'media_id' &&
		decimal(url.searchParams.get('media_id'))
	if (
		!decimal(owner.mid) ||
		url.origin !== 'https://api.bilibili.com' ||
		url.username ||
		url.password ||
		url.hash ||
		/^https:\/\/[^/]*@/i.test(input) ||
		init.method !== 'GET' ||
		init.body !== undefined ||
		Object.keys(init.headers).some((key) =>
			/^(cookie|authorization)$/i.test(key),
		) ||
		(!ownFolders && !contents && !resourceIndex)
	)
		throw new DirectoryReadError(
			'invalid-input',
			'仅可通过当前账号读取本人收藏夹与所选收藏页',
		)
}
function current(account: Account, owner: AccountFavoriteIdentity): boolean {
	const now = identity(account)
	return now?.mid === owner.mid && now.generation === owner.generation
}

/** Fixed official endpoints only. The account boundary, never this adapter, attaches credentials.
 * Native transport already refuses redirects/cookie jars and bounds the body to 1MiB.
 * Keep existing directory readers and their stricter validation/8MiB ceiling unchanged.
 */
export function createAccountFavoritesFetch(account: Account): DirectoryFetch {
	return async (input, init) => {
		const owner = identity(account)
		if (!owner)
			throw new DirectoryReadError(
				'permission',
				'请联网核验 B 站账号后读取我的收藏夹',
			)
		validUrl(input, init, owner)
		const controller = new AbortController()
		const abort = () => controller.abort()
		const check = () => {
			if (
				init.signal.aborted ||
				controller.signal.aborted ||
				!current(account, owner)
			)
				throw new DirectoryReadError(
					'cancelled',
					'账号已变更或收藏夹读取已取消',
				)
		}
		const unsubscribe = account.subscribe(() => {
			if (!current(account, owner)) abort()
		})
		init.signal.addEventListener('abort', abort, { once: true })
		try {
			check()
			const response = await account.authorizedFetch(input, {
				method: 'GET',
				headers: init.headers,
				signal: controller.signal,
				credentials: 'omit',
				redirect: 'error',
			})
			check()
			// Native responses have no response.url; native validation and no-redirect own that case.
			if (
				response.redirected ||
				(response.url && response.url !== input) ||
				(response.status >= 300 && response.status < 400)
			)
				throw new DirectoryReadError(
					'redirect',
					'账号收藏夹端点发生不允许的跳转',
				)
			if (response.status === 401) {
				await account.signOut('expired')
				throw new DirectoryReadError('permission', '登录已失效，请重新扫码')
			}
			const length = response.headers.get('content-length')
			if (
				length !== null &&
				(!/^[0-9]+$/.test(length) ||
					Number(length) > externalDirectoryLimits.responseBytes)
			)
				throw new DirectoryReadError('limit', '账号收藏夹响应超过大小上限')
			const bytes = new TextEncoder().encode(await response.text())
			check()
			if (bytes.byteLength > externalDirectoryLimits.responseBytes)
				throw new DirectoryReadError('limit', '账号收藏夹响应超过大小上限')
			let envelope: unknown
			try {
				envelope = JSON.parse(
					new TextDecoder('utf-8', { fatal: true }).decode(bytes),
				)
			} catch {
				/* Existing parsers report malformed responses. */
			}
			if (
				envelope &&
				typeof envelope === 'object' &&
				'code' in envelope &&
				envelope.code === -101
			) {
				await account.signOut('expired')
				throw new DirectoryReadError('permission', '登录已失效，请重新扫码')
			}
			let chunk: Uint8Array | null = bytes
			return {
				status: response.status,
				url: input,
				redirected: false,
				headers: {
					get: (name: string) =>
						name.toLowerCase() === 'content-length'
							? String(bytes.length)
							: null,
				},
				body: {
					getReader: () => ({
						read: async () => {
							check()
							if (!chunk) return { done: true }
							const value = chunk
							chunk = null
							return { done: false, value }
						},
						cancel: async () => {
							chunk = null
							abort()
						},
						releaseLock: () => {
							chunk = null
						},
					}),
				},
			}
		} catch (error) {
			if (error instanceof DirectoryReadError) throw error
			if (error instanceof AccountSessionError) {
				if (error.code === 'stale-session')
					throw new DirectoryReadError(
						'cancelled',
						'账号已变更，请重新读取收藏夹',
					)
				if (error.code === 'signed-out' || error.code === 'expired')
					throw new DirectoryReadError('permission', error.message)
			}
			throw new DirectoryReadError('network', '账号收藏夹连接失败，请稍后重试')
		} finally {
			unsubscribe()
			init.signal.removeEventListener('abort', abort)
		}
	}
}

export function createAccountFavorites(account: Account): AccountFavoritesPort {
	const fetcher = createAccountFavoritesFetch(account)
	return {
		getIdentity: () => identity(account),
		subscribe: (listener) => account.subscribe(listener),
		folders: createBilibiliFavoriteFoldersTransport(fetcher),
		page: createBilibiliFavoriteTransport(fetcher),
		index: createBilibiliFavoriteIndexTransport(fetcher),
	}
}
