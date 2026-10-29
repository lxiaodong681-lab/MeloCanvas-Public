import { importTaskLimits, type ImportMetadata } from './core/import-types'
import type {
	BilibiliFavoriteIndex,
	BilibiliFavoriteIndexItem,
} from './bilibili-favorite-index'
import { readDirectoryHttp, type DirectoryFetch } from './directory-http'
import {
	DirectoryReadError,
	externalDirectoryLimits,
	type DirectoryErrorCode,
} from './external-directory'

export interface BilibiliFavoriteInput {
	favoriteId: string
	page: number
	signal?: AbortSignal
	index?: BilibiliFavoriteIndex
}
export interface BilibiliFavoriteItem {
	/** Index within this response only, never a cross-page directory coordinate. */
	pageIndex: number
	mediaId: string
	mediaType: number
	mediaIdentity: string
	bvid: string | null
	original: ImportMetadata
	/** Verified position in resource/ids; absent in legacy page-only reads. */
	indexPosition?: number
}
export interface BilibiliFavoritePage {
	favoriteId: string
	page: number
	pageSize: 40
	reportedTotal: number
	hasMore: boolean
	info: ImportMetadata
	/** Response envelope excluding data. */
	originalEnvelope: ImportMetadata
	/** Data excluding info/medias; those values are preserved separately in order. */
	originalData: ImportMetadata
	items: BilibiliFavoriteItem[]
	/** Actual index slots for this page, including identities with no returned detail. */
	indexEntries?: BilibiliFavoriteIndexItem[]
}
export interface BilibiliFavoritePartialEvidence {
	favoriteId: string
	page: number
	pageSize: 40
	originalEnvelope: ImportMetadata
	/** Unvalidated page evidence including info/medias, not a successful page or import snapshot. */
	originalData: ImportMetadata
}
export type FavoriteReadErrorCode =
	| Exclude<DirectoryErrorCode, 'invalid-link'>
	| 'restricted'
export class BilibiliFavoriteReadError extends Error {
	constructor(
		readonly code: FavoriteReadErrorCode,
		message: string,
		readonly diagnostics: Record<string, string | number | boolean> = {},
		readonly partial?: BilibiliFavoritePartialEvidence,
	) {
		super(message)
		this.name = 'BilibiliFavoriteReadError'
	}
}
export type BilibiliFavoriteTransport = (
	input: { favoriteId: string; page: number; pageSize: 40 },
	signal: AbortSignal,
) => Promise<Uint8Array>
export const bilibiliFavoriteLimits = {
	pageSize: 40,
	maxPage: 125,
	reportedTotal: 5000,
	responseBytes: externalDirectoryLimits.responseBytes,
	timeoutMs: externalDirectoryLimits.timeoutMs,
	headerBytes: importTaskLimits.playlistMetadataBytes,
	itemBytes: importTaskLimits.entryMetadataBytes,
	metadataDepth: importTaskLimits.metadataDepth,
} as const

function invalid(code: FavoriteReadErrorCode, message: string): never {
	throw new BilibiliFavoriteReadError(code, message)
}
function validInput(input: BilibiliFavoriteInput): void {
	if (
		typeof input.favoriteId !== 'string' ||
		!/^[1-9][0-9]{0,127}$/.test(input.favoriteId) ||
		!Number.isSafeInteger(input.page) ||
		input.page < 1 ||
		input.page > bilibiliFavoriteLimits.maxPage ||
		(input.index !== undefined && input.index.favoriteId !== input.favoriteId)
	)
		invalid('invalid-input', '收藏夹身份或页码无效')
}
function record(value: unknown): ImportMetadata {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		invalid('response', 'B 站收藏页响应缺少对象字段')
	return value as ImportMetadata
}
function decimal(value: unknown): string {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
		return String(value)
	if (typeof value === 'string' && /^[1-9][0-9]{0,127}$/.test(value))
		return value
	return invalid('response', 'B 站收藏页媒体身份无效或超出安全整数范围')
}
const omit = (value: ImportMetadata, names: string[]) =>
	Object.fromEntries(
		Object.entries(value).filter(([key]) => !names.includes(key)),
	)
function jsonBudget(value: unknown, bytes: number, maxDepth: number): void {
	function depth(item: unknown, level: number): void {
		if (level > maxDepth) invalid('limit', 'B 站收藏页元数据嵌套超过上限')
		if (typeof item === 'number' && !Number.isFinite(item))
			invalid('response', 'B 站收藏页原信息包含非有限数字')
		if (item && typeof item === 'object')
			for (const child of Object.values(item)) depth(child, level + 1)
	}
	depth(value, 0)
	if (new TextEncoder().encode(JSON.stringify(value)).byteLength > bytes)
		invalid('limit', 'B 站收藏页原信息超过大小上限')
}
function voucher(value: ImportMetadata): boolean {
	return typeof value.v_voucher === 'string' && value.v_voucher.length > 0
}
function matchesIndex(item: BilibiliFavoriteItem, slot: BilibiliFavoriteIndexItem): boolean {
	return item.mediaIdentity === slot.mediaIdentity &&
		(!item.bvid || !slot.bvid || item.bvid === slot.bvid)
}
function decode(
	input: BilibiliFavoriteInput,
	bytes: Uint8Array,
): BilibiliFavoritePage {
	if (!(bytes instanceof Uint8Array))
		invalid('response', '收藏页读取器未返回字节数据')
	if (bytes.byteLength > bilibiliFavoriteLimits.responseBytes)
		invalid('limit', 'B 站收藏页响应超过 8MiB')
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	} catch {
		return invalid('response', 'B 站收藏页响应不是有效 UTF-8 JSON')
	}
	const envelope = record(parsed)
	if (typeof envelope.code !== 'number' || !Number.isSafeInteger(envelope.code))
		invalid('response', 'B 站收藏页缺少有效状态码')
	if (envelope.code !== 0)
		throw new BilibiliFavoriteReadError('platform', 'B 站未允许读取此收藏页', {
			platformCode: envelope.code,
		})
	if (voucher(envelope))
		invalid('restricted', 'B 站游客收藏页需要风控验证，请稍后重试')
	const data = record(envelope.data)
	if (voucher(data))
		invalid('restricted', 'B 站游客收藏页需要风控验证，请稍后重试')
	const originalEnvelope = omit(envelope, ['data']),
		originalData = omit(data, ['info', 'medias'])
	jsonBudget(
		{ info: data.info ?? null, originalEnvelope, originalData },
		bilibiliFavoriteLimits.headerBytes,
		bilibiliFavoriteLimits.metadataDepth,
	)
	if (Array.isArray(data.medias)) {
		if (data.medias.length > bilibiliFavoriteLimits.pageSize)
			invalid('limit', 'B 站收藏页超过40项单页上限')
		for (const item of data.medias)
			jsonBudget(
				item,
				bilibiliFavoriteLimits.itemBytes,
				bilibiliFavoriteLimits.metadataDepth,
			)
	}
	const partial: BilibiliFavoritePartialEvidence = {
		favoriteId: input.favoriteId,
		page: input.page,
		pageSize: 40,
		originalEnvelope,
		originalData: data,
	}
	jsonBudget(
		partial,
		bilibiliFavoriteLimits.responseBytes,
		bilibiliFavoriteLimits.metadataDepth + 4,
	)
	try {
		const info = record(data.info)
		if (decimal(info.id) !== input.favoriteId)
			invalid('response', 'B 站返回了不同的收藏夹身份')
		if (typeof info.title !== 'string')
			invalid('response', 'B 站收藏页缺少原标题')
		const total = info.media_count
		if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)
			invalid('response', 'B 站收藏页缺少有效总数')
		if (total > bilibiliFavoriteLimits.reportedTotal)
			invalid('limit', '收藏夹报告数量超过5000项保护上限')
		if (!Array.isArray(data.medias))
			invalid('response', 'B 站收藏页缺少媒体列表，不能当作空收藏')
		if (typeof data.has_more !== 'boolean')
			invalid('response', 'B 站收藏页缺少明确分页状态')
		const items = data.medias.map((item, pageIndex): BilibiliFavoriteItem => {
			const original = record(item),
				mediaId = decimal(original.id),
				mediaType = original.type
			if (
				typeof mediaType !== 'number' ||
				!Number.isSafeInteger(mediaType) ||
				mediaType <= 0
			)
				invalid('response', 'B 站收藏页媒体类型无效')
			const bv = original.bvid
			if (
				bv !== undefined &&
				bv !== null &&
				bv !== '' &&
				(typeof bv !== 'string' || !/^BV[A-Za-z0-9]{10}$/.test(bv))
			)
				invalid('response', 'B 站收藏页 BV 身份无效')
			return {
				pageIndex,
				mediaId,
				mediaType,
				mediaIdentity: `${mediaType}:${mediaId}`,
				bvid: typeof bv === 'string' && bv ? bv : null,
				original,
			}
		})
		const offset = (input.page - 1) * 40
		const expected = Math.min(40, Math.max(0, total - offset))
		const indexEntries = input.index?.items.slice(offset, offset + expected)
		if (
			(total === 0 && input.page !== 1) ||
			(total > 0 && offset >= total) ||
			(input.index && input.index.items.length !== total) ||
			(indexEntries ? items.length > expected : items.length !== expected) ||
			data.has_more !== offset + (indexEntries ? expected : items.length) < total
		)
			throw new BilibiliFavoriteReadError(
				'incomplete',
				`B 站收藏页总数、页码或分页状态不一致（本页收到 ${items.length} 项，预期 ${expected} 项；目录报告 ${total} 项；还有下一页：${data.has_more ? '是' : '否'}），请重新核对目录`,
				{
					reportedTotal: total,
					receivedCount: items.length,
					expectedCount: expected,
					hasMore: data.has_more,
				},
				partial,
			)
		if (indexEntries) {
			// Earliest and latest order-preserving matches must agree. Otherwise a
			// repeated identity leaves the missing occurrence's position unknowable.
			const positions: number[] = []
			let cursor = 0
			for (const item of items) {
				while (cursor < indexEntries.length && !matchesIndex(item, indexEntries[cursor])) cursor++
				if (cursor === indexEntries.length)
					throw new BilibiliFavoriteReadError('incomplete', '收藏页详情与真实索引身份或顺序不一致，请重新读取目录', {}, partial)
				positions.push(cursor++)
			}
			cursor = indexEntries.length - 1
			for (let i = items.length - 1; i >= 0; i--) {
				while (cursor >= 0 && !matchesIndex(items[i], indexEntries[cursor])) cursor--
				if (cursor !== positions[i])
					throw new BilibiliFavoriteReadError('incomplete', '重复索引条目缺少详情，无法确定原出现位置，请重新核对目录', {}, partial)
				items[i].indexPosition = indexEntries[cursor--].position
			}
		}
		const page: BilibiliFavoritePage = {
			favoriteId: input.favoriteId,
			page: input.page,
			pageSize: 40,
			reportedTotal: total,
			hasMore: data.has_more,
			info,
			originalEnvelope,
			originalData,
			items,
			...(indexEntries ? { indexEntries } : {}),
		}
		jsonBudget(
			page,
			bilibiliFavoriteLimits.responseBytes,
			bilibiliFavoriteLimits.metadataDepth + 4,
		)
		return page
	} catch (error) {
		if (
			error instanceof BilibiliFavoriteReadError &&
			error.code !== 'limit' &&
			!error.partial
		)
			throw new BilibiliFavoriteReadError(
				error.code,
				error.message,
				error.diagnostics,
				partial,
			)
		throw error
	}
}

/** One explicit page only. Does not bootstrap cookies, request view, paginate or create Sources. */
export function createBilibiliFavoriteTransport(
	fetcher: DirectoryFetch,
): BilibiliFavoriteTransport {
	return async (input, signal) => {
		validInput(input)
		const params = new URLSearchParams({
			media_id: input.favoriteId,
			pn: String(input.page),
			ps: '40',
		})
		return readDirectoryHttp(
			fetcher,
			{
				url: `https://api.bilibili.com/x/v3/fav/resource/list?${params}`,
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
export async function readBilibiliFavoritePage(
	input: BilibiliFavoriteInput,
	transport: BilibiliFavoriteTransport,
): Promise<BilibiliFavoritePage> {
	validInput(input)
	const request = {
		favoriteId: input.favoriteId,
		page: input.page,
		pageSize: 40 as const,
	}
	const index = input.index
	if (input.signal?.aborted) invalid('cancelled', '收藏页读取已取消')
	const controller = new AbortController()
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
						timedOut ? '收藏页读取超时' : '收藏页读取已取消',
					),
				)
			controller.signal.addEventListener('abort', rejectAbort, { once: true })
		})
		const bytes = await Promise.race([
			transport(request, controller.signal),
			aborted,
		])
		if (controller.signal.aborted)
			invalid(timedOut ? 'timeout' : 'cancelled', '收藏页读取已终止')
		return decode({ ...request, index }, bytes)
	} catch (error) {
		if (input.signal?.aborted) invalid('cancelled', '收藏页读取已取消')
		if (timedOut) invalid('timeout', '收藏页读取超时')
		if (error instanceof BilibiliFavoriteReadError) throw error
		if (error instanceof DirectoryReadError)
			throw new BilibiliFavoriteReadError(
				error.code === 'invalid-link' ? 'invalid-input' : error.code,
				error.message,
				error.diagnostics,
			)
		throw new BilibiliFavoriteReadError('network', '收藏页网络读取失败')
	} finally {
		clearTimeout(timer)
		input.signal?.removeEventListener('abort', cancel)
		if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
	}
}
