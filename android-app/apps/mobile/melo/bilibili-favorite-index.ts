import {
	BilibiliFavoriteReadError,
	bilibiliFavoriteLimits,
} from './bilibili-favorite'
import type { ImportMetadata } from './core/import-types'
import { metadata } from './core/import-validation'
import { readDirectoryHttp, type DirectoryFetch } from './directory-http'
import { DirectoryReadError } from './external-directory'

export interface BilibiliFavoriteIndexItem {
	position: number
	mediaId: string
	mediaType: number
	mediaIdentity: string
	bvid: string | null
	original: ImportMetadata
}
export interface BilibiliFavoriteIndex {
	favoriteId: string
	originalEnvelope: ImportMetadata
	items: BilibiliFavoriteIndexItem[]
}
export type BilibiliFavoriteIndexTransport = (
	input: { favoriteId: string },
	signal: AbortSignal,
) => Promise<Uint8Array>

function validId(value: unknown): string {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
		return String(value)
	if (typeof value === 'string' && /^[1-9][0-9]{0,127}$/.test(value))
		return value
	throw new BilibiliFavoriteReadError('response', '收藏夹索引媒体身份无效')
}
function validInput(favoriteId: string) {
	if (typeof favoriteId !== 'string' || !/^[1-9][0-9]{0,127}$/.test(favoriteId))
		throw new BilibiliFavoriteReadError('invalid-input', '收藏夹索引身份无效')
}
function object(value: unknown): ImportMetadata {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new BilibiliFavoriteReadError('response', '收藏夹索引缺少对象字段')
	return value as ImportMetadata
}
function frozen<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) frozen(child)
		Object.freeze(value)
	}
	return value
}
function decode(favoriteId: string, bytes: Uint8Array): BilibiliFavoriteIndex {
	if (!(bytes instanceof Uint8Array))
		throw new BilibiliFavoriteReadError('response', '收藏夹索引未返回字节数据')
	if (bytes.byteLength > bilibiliFavoriteLimits.responseBytes)
		throw new BilibiliFavoriteReadError('limit', '收藏夹索引超过响应大小上限')
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	} catch {
		throw new BilibiliFavoriteReadError(
			'response',
			'收藏夹索引不是有效 UTF-8 JSON',
		)
	}
	const envelope = object(parsed)
	if (typeof envelope.code !== 'number' || !Number.isSafeInteger(envelope.code))
		throw new BilibiliFavoriteReadError('response', '收藏夹索引缺少有效状态码')
	if (envelope.code !== 0)
		throw new BilibiliFavoriteReadError(
			'platform',
			'B 站未允许读取收藏夹索引',
			{
				platformCode: envelope.code,
			},
		)
	if (typeof envelope.v_voucher === 'string' && envelope.v_voucher)
		throw new BilibiliFavoriteReadError('restricted', '收藏夹索引需要风控验证')
	if (!Array.isArray(envelope.data))
		throw new BilibiliFavoriteReadError(
			'response',
			'收藏夹索引缺少明确的条目数组',
		)
	if (envelope.data.length > bilibiliFavoriteLimits.reportedTotal)
		throw new BilibiliFavoriteReadError('limit', '收藏夹索引超过5000项保护上限')
	try {
		const originalEnvelope = metadata(
			Object.fromEntries(
				Object.entries(envelope).filter(([key]) => key !== 'data'),
			),
			bilibiliFavoriteLimits.headerBytes,
		)
		const items = envelope.data.map(
			(value, position): BilibiliFavoriteIndexItem => {
				const original = metadata(
					object(value),
					bilibiliFavoriteLimits.itemBytes,
				)
				const mediaId = validId(original.id),
					mediaType = original.type
				if (
					typeof mediaType !== 'number' ||
					!Number.isSafeInteger(mediaType) ||
					mediaType <= 0
				)
					throw new BilibiliFavoriteReadError(
						'response',
						'收藏夹索引媒体类型无效',
					)
				const bv = original.bvid
				if (
					bv !== undefined &&
					bv !== null &&
					bv !== '' &&
					(typeof bv !== 'string' || !/^BV[A-Za-z0-9]{10}$/.test(bv))
				)
					throw new BilibiliFavoriteReadError(
						'response',
						'收藏夹索引 BV 身份无效',
					)
				return {
					position,
					mediaId,
					mediaType,
					mediaIdentity: `${mediaType}:${mediaId}`,
					bvid: typeof bv === 'string' && bv ? bv : null,
					original,
				}
			},
		)
		return frozen({ favoriteId, originalEnvelope, items })
	} catch (error) {
		if (error instanceof BilibiliFavoriteReadError) throw error
		throw new BilibiliFavoriteReadError('limit', '收藏夹索引元数据超过保存预算')
	}
}

/** Reuse BBPlayer's ordered resource/ids protocol without filtering types or deduplicating. */
export function createBilibiliFavoriteIndexTransport(
	fetcher: DirectoryFetch,
): BilibiliFavoriteIndexTransport {
	return async ({ favoriteId }, signal) => {
		validInput(favoriteId)
		return readDirectoryHttp(
			fetcher,
			{
				url: `https://api.bilibili.com/x/v3/fav/resource/ids?media_id=${favoriteId}`,
				method: 'GET',
				headers: {
					Referer: 'https://www.bilibili.com/',
					'User-Agent':
						'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
				},
			},
			signal,
		)
	}
}

export async function readBilibiliFavoriteIndex(
	input: { favoriteId: string; signal?: AbortSignal },
	transport: BilibiliFavoriteIndexTransport,
): Promise<BilibiliFavoriteIndex> {
	validInput(input.favoriteId)
	const favoriteId = input.favoriteId,
		controller = new AbortController()
	if (input.signal?.aborted)
		throw new BilibiliFavoriteReadError('cancelled', '收藏夹索引读取已取消')
	let timedOut = false,
		rejectAbort: (() => void) | undefined
	const cancel = () => controller.abort()
	input.signal?.addEventListener('abort', cancel, { once: true })
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, bilibiliFavoriteLimits.timeoutMs)
	try {
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = () =>
				reject(
					new BilibiliFavoriteReadError(
						timedOut ? 'timeout' : 'cancelled',
						timedOut ? '收藏夹索引读取超时' : '收藏夹索引读取已取消',
					),
				)
			controller.signal.addEventListener('abort', rejectAbort, { once: true })
		})
		const bytes = await Promise.race([
			transport({ favoriteId }, controller.signal),
			aborted,
		])
		if (controller.signal.aborted)
			throw new BilibiliFavoriteReadError('cancelled', '收藏夹索引读取已终止')
		return decode(favoriteId, bytes)
	} catch (error) {
		if (input.signal?.aborted)
			throw new BilibiliFavoriteReadError('cancelled', '收藏夹索引读取已取消')
		if (timedOut)
			throw new BilibiliFavoriteReadError('timeout', '收藏夹索引读取超时')
		if (error instanceof BilibiliFavoriteReadError) throw error
		if (error instanceof DirectoryReadError)
			throw new BilibiliFavoriteReadError(
				error.code === 'invalid-link' ? 'invalid-input' : error.code,
				error.message,
				error.diagnostics,
			)
		throw new BilibiliFavoriteReadError('network', '收藏夹索引连接失败')
	} finally {
		clearTimeout(timer)
		input.signal?.removeEventListener('abort', cancel)
		if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
	}
}
