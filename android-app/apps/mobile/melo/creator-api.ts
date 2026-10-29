import he from 'he'

import { ensureGuest, request, signed } from './bilibili'
import type { Creator } from './core/creators'
import { creatorSearchMid } from './creator-search-selection'

/** A remote candidate, never a playable Source or verified ownership relation. */
export interface CreatorPostCandidate {
	bvid: string
	title: string
	artwork: string
	duration: number
	publishedAt: number
	queryCreatorMid: string
	ownerMid?: string
}

const searchSize = 20
const postsSize = 30
const invalid = () =>
	new Error('B 站 UP 主响应异常，暂时无法确认资料或分页，请稍后重试')

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw invalid()
	return value as Record<string, unknown>
}

function mid(value: unknown): string {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
		return String(value)
	if (
		typeof value === 'string' &&
		value.trim() === value &&
		/^[1-9][0-9]*$/.test(value)
	)
		return value
	throw invalid()
}

function validateMid(value: string): void {
	if (
		typeof value !== 'string' ||
		value.trim() !== value ||
		!/^[1-9][0-9]*$/.test(value)
	)
		throw new Error('UP 主 mid 无效')
}

function integer(value: unknown, positive = false): number {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < (positive ? 1 : 0)
	)
		throw invalid()
	return value
}

function validatePage(page: number): void {
	if (!Number.isSafeInteger(page) || page <= 0)
		throw new Error('UP 主分页页码无效')
}

function text(value: unknown, empty = false): string {
	if (typeof value !== 'string') throw invalid()
	const result = he.decode(value.replace(/<[^>]*>/g, '')).trim()
	if (!empty && !result) throw invalid()
	return result
}

function image(value: unknown): string {
	if (typeof value !== 'string') throw invalid()
	const normalized = value.startsWith('//')
		? `https:${value}`
		: value.replace(/^http:/, 'https:')
	try {
		const url = new URL(normalized)
		if (
			url.protocol !== 'https:' ||
			!url.hostname ||
			url.username ||
			url.password
		)
			throw invalid()
	} catch {
		throw invalid()
	}
	return normalized
}

function pagination(
	page: number,
	returned: unknown,
	size: unknown,
	total: unknown,
	length: number,
) {
	if (integer(returned, true) !== page) throw invalid()
	const pageSize = integer(size, true),
		count = integer(total)
	const pages = Math.ceil(count / pageSize)
	const expected =
		page > pages ? 0 : Math.min(pageSize, count - (page - 1) * pageSize)
	if (length !== expected) throw invalid()
	return { total: count, pages, more: page < pages }
}

async function read(
	endpoint: string,
	params: Record<string, string>,
	signal?: AbortSignal,
): Promise<unknown> {
	await ensureGuest(signal)
	const query = await signed(params, signal)
	const data = await request<unknown>(`${endpoint}?${query}`, signal)
	if (
		data &&
		typeof data === 'object' &&
		'v_voucher' in data &&
		typeof data.v_voucher === 'string' &&
		data.v_voucher
	)
		throw new Error('B 站游客请求需要风控验证，请稍后重试')
	return data
}

export async function creatorProfile(
	creatorMid: string,
	signal?: AbortSignal,
): Promise<Creator> {
	validateMid(creatorMid)
	const data = record(
		await read('/x/space/wbi/acc/info', { mid: creatorMid }, signal),
	)
	if (mid(data.mid) !== creatorMid)
		throw new Error('返回的 UP 主身份不匹配，请重试')
	return {
		source: 'bilibili',
		mid: creatorMid,
		name: text(data.name),
		avatar: image(data.face),
		bio: text(data.sign, true),
		fetchedAt: Date.now(),
	}
}

/** Search summaries use fetchedAt=0; never save them as complete profile refreshes. */
export async function searchCreators(
	keyword: string,
	page = 1,
	signal?: AbortSignal,
): Promise<{ items: Creator[]; page: number; more: boolean }> {
	if (typeof keyword !== 'string' || !keyword.trim())
		throw new Error('请输入 UP 主关键词')
	validatePage(page)
	const exactMid = creatorSearchMid(keyword)
	if (exactMid) {
		if (page !== 1) throw new Error('UP 主精确定位没有下一页')
		return {
			items: [await creatorProfile(exactMid, signal)],
			page: 1,
			more: false,
		}
	}
	const data = record(
		await read(
			'/x/web-interface/wbi/search/type',
			{
				keyword: keyword.trim(),
				search_type: 'bili_user',
				page: String(page),
				page_size: String(searchSize),
			},
			signal,
		),
	)
	// The API omits result for an explicitly empty search page.
	const results =
		data.result === undefined && data.numResults === 0 && data.numPages === 0
			? []
			: data.result
	if (!Array.isArray(results)) throw invalid()
	const info = pagination(
		page,
		data.page,
		data.pagesize,
		data.numResults,
		results.length,
	)
	if (integer(data.numPages) !== info.pages || data.pagesize !== searchSize)
		throw invalid()
	const seen = new Set<string>()
	const items = results.map((entry: unknown): Creator => {
		const value = record(entry),
			creatorMid = mid(value.mid)
		if (value.type !== 'bili_user' || seen.has(creatorMid)) throw invalid()
		seen.add(creatorMid)
		return {
			source: 'bilibili',
			mid: creatorMid,
			name: text(value.uname),
			avatar: image(value.upic),
			bio: text(value.usign, true),
			fetchedAt: 0,
		}
	})
	return { items, page, more: info.more }
}

function duration(value: unknown): number {
	if (
		typeof value !== 'string' ||
		!/^[0-9]+:[0-5][0-9](?::[0-5][0-9])?$/.test(value) ||
		value.trim() !== value
	)
		throw invalid()
	const seconds = value
		.split(':')
		.reduce((sum, part) => sum * 60 + Number(part), 0)
	return integer(seconds)
}

export async function creatorPosts(
	creatorMid: string,
	page = 1,
	signal?: AbortSignal,
): Promise<{
	items: CreatorPostCandidate[]
	page: number
	more: boolean
	total: number
}> {
	validateMid(creatorMid)
	validatePage(page)
	const data = record(
		await read(
			'/x/space/wbi/arc/search',
			{ mid: creatorMid, pn: String(page), ps: String(postsSize), keyword: '' },
			signal,
		),
	)
	const paging = record(data.page),
		list = record(data.list)
	if (!Array.isArray(list.vlist)) throw invalid()
	const info = pagination(
		page,
		paging.pn,
		paging.ps,
		paging.count,
		list.vlist.length,
	)
	if (paging.ps !== postsSize) throw invalid()
	const seen = new Set<string>()
	const items = list.vlist.map((entry: unknown): CreatorPostCandidate => {
		const value = record(entry)
		if (
			typeof value.bvid !== 'string' ||
			value.bvid.trim() !== value.bvid ||
			!/^BV[A-Za-z0-9]{10}$/.test(value.bvid) ||
			seen.has(value.bvid)
		)
			throw invalid()
		seen.add(value.bvid)
		const publishedAt = integer(value.created) * 1000
		integer(publishedAt)
		// Collaboration may name a different author. Only explicit numeric identities count.
		const owner = value.owner === undefined ? undefined : record(value.owner)
		const ownerMid =
			owner?.mid === undefined
				? value.mid === undefined
					? undefined
					: mid(value.mid)
				: mid(owner.mid)
		if (
			owner?.mid !== undefined &&
			value.mid !== undefined &&
			mid(value.mid) !== ownerMid
		)
			throw invalid()
		return {
			bvid: value.bvid,
			title: text(value.title),
			artwork: image(value.pic),
			duration: duration(value.length),
			publishedAt,
			queryCreatorMid: creatorMid,
			...(ownerMid === undefined ? {} : { ownerMid }),
		}
	})
	return { items, page, more: info.more, total: info.total }
}
