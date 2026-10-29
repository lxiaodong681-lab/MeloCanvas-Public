import {
	normalizeChapters,
	type Chapter,
	type VideoViewPoint,
} from '../src/features/player/utils/chapters'

import { request, signed } from './bilibili'
import { sourceId, type Source } from './core/model'

export type { Chapter }

export function parseListeningChapters(
	data: unknown,
	source: Pick<Source, 'bvid' | 'cid'>,
	duration: number,
): Chapter[] {
	if (!data || typeof data !== 'object' || Array.isArray(data))
		throw new Error('章节信息格式不正确，请重试')
	const value = data as Record<string, unknown>
	if (
		value.cid !== source.cid ||
		(value.bvid !== undefined && value.bvid !== source.bvid)
	)
		throw new Error('章节所属分 P 不匹配，请重试')
	if (value.view_points === undefined || value.view_points === null) return []
	if (!Array.isArray(value.view_points))
		throw new Error('章节列表格式不正确，请重试')
	const points = value.view_points.filter(
		(point): point is VideoViewPoint =>
			!!point &&
			typeof point === 'object' &&
			typeof point.from === 'number' &&
			typeof point.to === 'number' &&
			typeof point.content === 'string',
	)
	return normalizeChapters(points, duration)
}

/** The upstream web-player contract reports chapter boundaries in seconds for this CID. */
export async function listeningChapters(
	source: Pick<Source, 'id' | 'bvid' | 'cid'>,
	duration: number,
	signal?: AbortSignal,
): Promise<Chapter[]> {
	if (
		!/^BV[A-Za-z0-9]{10}$/.test(source.bvid) ||
		!Number.isSafeInteger(source.cid) ||
		source.cid <= 0 ||
		source.id !== sourceId(source.bvid, source.cid)
	)
		throw new Error('当前分 P 身份不完整，请重新选择内容')
	if (!Number.isFinite(duration) || duration <= 0)
		throw new Error('当前分 P 的时长暂不可用，请稍后重试')
	const query = await signed(
		{ bvid: source.bvid, cid: String(source.cid) },
		signal,
	)
	if (signal?.aborted) throw new Error('章节读取已取消')
	const data = await request<unknown>(`/x/player/wbi/v2?${query}`, signal)
	return parseListeningChapters(data, source, duration)
}
