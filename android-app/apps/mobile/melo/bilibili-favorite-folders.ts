import { importTaskLimits, type ImportMetadata } from './core/import-types'
import { readDirectoryHttp, type DirectoryFetch } from './directory-http'
import {
	DirectoryReadError,
	externalDirectoryLimits,
	type DirectoryErrorCode,
} from './external-directory'

export interface BilibiliFavoriteFoldersInput {
	userMid: string
	signal?: AbortSignal
}
export interface BilibiliFavoriteFolder {
	/** Response order only, not a claim about all folders belonging to an account. */
	index: number
	folderId: string
	title: string
	mediaCount: number
	/** Original evidence only. Does not indicate privacy, permission or readability. */
	favState: number
	original: ImportMetadata
}
export interface BilibiliFavoriteFolders {
	userMid: string
	observedCount: number
	reportedCount: number | null
	folders: BilibiliFavoriteFolder[]
	/** Envelope excluding data. */
	originalEnvelope: ImportMetadata
	/** Data excluding list; each raw list object is preserved in folders.original. */
	originalData: ImportMetadata
}
export type FavoriteFoldersErrorCode =
	| Exclude<DirectoryErrorCode, 'invalid-link'>
	| 'restricted'
export class BilibiliFavoriteFoldersReadError extends Error {
	constructor(
		readonly code: FavoriteFoldersErrorCode,
		message: string,
		readonly diagnostics: Record<string, string | number | boolean> = {},
	) {
		super(message)
		this.name = 'BilibiliFavoriteFoldersReadError'
	}
}
/** Promise must cover the real body read, even when a caller stops waiting. */
export type BilibiliFavoriteFoldersTransport = (
	input: { userMid: string },
	signal: AbortSignal,
) => Promise<Uint8Array>
export const bilibiliFavoriteFoldersLimits = {
	responseBytes: externalDirectoryLimits.responseBytes,
	timeoutMs: externalDirectoryLimits.timeoutMs,
	folders: importTaskLimits.entries,
	headerBytes: importTaskLimits.playlistMetadataBytes,
	itemBytes: importTaskLimits.entryMetadataBytes,
	metadataDepth: importTaskLimits.metadataDepth,
} as const
function invalid(code: FavoriteFoldersErrorCode, message: string): never {
	throw new BilibiliFavoriteFoldersReadError(code, message)
}
function validateMid(mid: string): void {
	if (typeof mid !== 'string' || !/^[1-9][0-9]{0,127}$/.test(mid))
		invalid('invalid-input', 'UP 主 mid 必须是规范十进制字符串')
}
function record(value: unknown): ImportMetadata {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		invalid('response', 'B 站收藏夹列表响应缺少对象字段')
	return value as ImportMetadata
}
function decimal(value: unknown): string {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
		return String(value)
	if (typeof value === 'string' && /^[1-9][0-9]{0,127}$/.test(value))
		return value
	return invalid('response', '收藏夹身份无效或超出数字安全精度')
}
function count(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		invalid('response', '收藏夹计数字段无效')
	return value
}
function budget(
	value: unknown,
	bytes: number,
	maxDepth: number = bilibiliFavoriteFoldersLimits.metadataDepth,
): void {
	function check(item: unknown, level: number): void {
		if (level > maxDepth) invalid('limit', '收藏夹列表元数据嵌套超过上限')
		if (typeof item === 'number' && !Number.isFinite(item))
			invalid('response', '收藏夹原信息包含非有限数字')
		if (item && typeof item === 'object')
			for (const child of Object.values(item)) check(child, level + 1)
	}
	check(value, 0)
	if (new TextEncoder().encode(JSON.stringify(value)).byteLength > bytes)
		invalid('limit', '收藏夹列表原信息超过大小上限')
}
const omit = (value: ImportMetadata, key: string) =>
	Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
const voucher = (value: ImportMetadata) =>
	typeof value.v_voucher === 'string' && value.v_voucher.length > 0
function decode(userMid: string, bytes: Uint8Array): BilibiliFavoriteFolders {
	if (!(bytes instanceof Uint8Array))
		invalid('response', '收藏夹读取器未返回字节数据')
	if (bytes.byteLength > bilibiliFavoriteFoldersLimits.responseBytes)
		invalid('limit', '收藏夹列表响应超过 8MiB')
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	} catch {
		return invalid('response', '收藏夹列表响应不是有效 UTF-8 JSON')
	}
	const envelope = record(parsed)
	if (typeof envelope.code !== 'number' || !Number.isSafeInteger(envelope.code))
		invalid('response', '收藏夹列表缺少有效状态码')
	if (envelope.code !== 0)
		throw new BilibiliFavoriteFoldersReadError(
			'platform',
			'B 站未允许读取此收藏夹列表',
			{ platformCode: envelope.code },
		)
	if (voucher(envelope))
		invalid('restricted', 'B 站游客收藏夹列表需要风控验证，请稍后重试')
	if (envelope.data === null)
		invalid('response', '平台未返回可读取的收藏夹列表，暂时无法判断是否为空。')
	const data = record(envelope.data)
	if (voucher(data))
		invalid('restricted', 'B 站游客收藏夹列表需要风控验证，请稍后重试')
	const originalEnvelope = omit(envelope, 'data'),
		originalData = omit(data, 'list')
	budget(
		{ originalEnvelope, originalData },
		bilibiliFavoriteFoldersLimits.headerBytes,
	)
	if (!Array.isArray(data.list))
		invalid('response', '收藏夹列表缺失，不能当作没有收藏夹')
	if (data.list.length > bilibiliFavoriteFoldersLimits.folders)
		invalid('limit', '收藏夹数量超过5000项保护上限')
	const reportedCount = 'count' in data ? count(data.count) : null
	if (
		reportedCount !== null &&
		reportedCount > bilibiliFavoriteFoldersLimits.folders
	)
		invalid('limit', '收藏夹报告数量超过5000项保护上限')
	if (reportedCount !== null && reportedCount !== data.list.length)
		throw new BilibiliFavoriteFoldersReadError(
			'incomplete',
			'收藏夹列表报告数量与本次读取数量不一致',
			{ reportedCount, observedCount: data.list.length },
		)
	const seen = new Set<string>()
	const folders = data.list.map((raw, index): BilibiliFavoriteFolder => {
		budget(raw, bilibiliFavoriteFoldersLimits.itemBytes)
		const original = record(raw),
			folderId = decimal(original.id)
		if (seen.has(folderId))
			invalid('response', '收藏夹列表出现重复身份，原响应不能当作完整列表')
		seen.add(folderId)
		if (typeof original.title !== 'string' || !original.title.trim())
			invalid('response', '收藏夹缺少原标题')
		return {
			index,
			folderId,
			title: original.title,
			mediaCount: count(original.media_count),
			favState: count(original.fav_state),
			original,
		}
	})
	const value = {
		userMid,
		observedCount: folders.length,
		reportedCount,
		folders,
		originalEnvelope,
		originalData,
	}
	budget(
		value,
		bilibiliFavoriteFoldersLimits.responseBytes,
		bilibiliFavoriteFoldersLimits.metadataDepth + 4,
	)
	return value
}

/** One fixed official endpoint. No login/cookie bootstrap, contents, selection or import. */
export function createBilibiliFavoriteFoldersTransport(
	fetcher: DirectoryFetch,
): BilibiliFavoriteFoldersTransport {
	return async ({ userMid }, signal) => {
		validateMid(userMid)
		return readDirectoryHttp(
			fetcher,
			{
				url: `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${userMid}`,
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

/** Timely waiter cancellation is not proof of raw transport settlement. No retry or concurrency gate. */
export async function readBilibiliFavoriteFolders(
	input: BilibiliFavoriteFoldersInput,
	transport: BilibiliFavoriteFoldersTransport,
): Promise<BilibiliFavoriteFolders> {
	const { userMid, signal } = input
	validateMid(userMid)
	if (signal?.aborted) invalid('cancelled', '收藏夹列表读取已取消')
	const controller = new AbortController()
	let timedOut = false,
		rejectAbort: (() => void) | undefined
	const cancel = () => controller.abort()
	signal?.addEventListener('abort', cancel, { once: true })
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, bilibiliFavoriteFoldersLimits.timeoutMs)
	try {
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = () =>
				reject(
					new BilibiliFavoriteFoldersReadError(
						timedOut ? 'timeout' : 'cancelled',
						timedOut ? '收藏夹列表读取超时' : '收藏夹列表读取已取消',
					),
				)
			controller.signal.addEventListener('abort', rejectAbort, { once: true })
		})
		const bytes = await Promise.race([
			transport({ userMid }, controller.signal),
			aborted,
		])
		if (controller.signal.aborted)
			invalid(timedOut ? 'timeout' : 'cancelled', '收藏夹列表读取已终止')
		return decode(userMid, bytes)
	} catch (error) {
		if (signal?.aborted) invalid('cancelled', '收藏夹列表读取已取消')
		if (timedOut) invalid('timeout', '收藏夹列表读取超时')
		if (error instanceof BilibiliFavoriteFoldersReadError) throw error
		if (error instanceof DirectoryReadError)
			throw new BilibiliFavoriteFoldersReadError(
				error.code === 'invalid-link' ? 'invalid-input' : error.code,
				error.message,
				error.diagnostics,
			)
		throw new BilibiliFavoriteFoldersReadError(
			'network',
			'收藏夹列表网络读取失败',
		)
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener('abort', cancel)
		if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
	}
}
