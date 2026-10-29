import he from 'he'

import { beginBilibiliRequest, type BilibiliRequest } from './bilibili'
import { sourceId, type Source } from './core/model'

export interface ListeningPart {
	source: Source
	page: number
	title: string
}

export interface ListeningVideo {
	bvid: string
	title: string
	uploader: string
	parts: ListeningPart[]
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object')
		throw new Error('视频分 P 信息格式不正确，请重试')
	return value as Record<string, unknown>
}

function text(value: unknown): string {
	return typeof value === 'string'
		? he.decode(value.replace(/<[^>]*>/g, '')).trim()
		: ''
}

function positiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export async function listeningSourceDetails(
	bvid: string,
	signal?: AbortSignal,
): Promise<ListeningVideo> {
	return beginListeningSourceDetails(bvid, signal).result
}

/** Gate consumers must keep settled separately from the cancellable view result. */
export function beginListeningSourceDetails(
	bvid: string,
	signal?: AbortSignal,
): BilibiliRequest<ListeningVideo> {
	if (!/^BV[A-Za-z0-9]{10}$/.test(bvid))
		return {
			result: Promise.reject(new Error('BV 号格式不正确')),
			settled: Promise.resolve(),
		}
	const read = beginBilibiliRequest<unknown>(
		`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
		signal,
	)
	return {
		result: read.result.then((data) => parseListeningVideo(data, bvid)),
		settled: read.settled,
	}
}

export function parseListeningVideo(
	data: unknown,
	expectedBvid: string,
): ListeningVideo {
	const video = record(data)
	if (!/^BV[A-Za-z0-9]{10}$/.test(expectedBvid) || video.bvid !== expectedBvid)
		throw new Error('返回的视频身份不匹配，请重试')
	const owner = record(video.owner)
	const title = text(video.title)
	const uploader = text(owner.name)
	if (!title || !uploader || !positiveInteger(owner.mid))
		throw new Error('视频标题或上传者信息缺失，请重试')
	const image = typeof video.pic === 'string' ? video.pic : ''
	const artwork = image.startsWith('//')
		? `https:${image}`
		: image.replace(/^http:/, 'https:')
	if (!artwork.startsWith('https://'))
		throw new Error('视频封面信息无效，请重试')
	if (!Array.isArray(video.pages) || video.pages.length === 0)
		throw new Error('这条内容没有可用的分 P 信息，请更换音源')
	if (
		'videos' in video &&
		(!positiveInteger(video.videos) || video.videos !== video.pages.length)
	)
		throw new Error('视频分 P 列表不完整，请重试')
	const cids = new Set<number>()
	const pages = new Set<number>()
	const parts = video.pages.map((value): ListeningPart => {
		const part = record(value)
		if (
			!positiveInteger(part.cid) ||
			!positiveInteger(part.page) ||
			cids.has(part.cid) ||
			pages.has(part.page) ||
			typeof part.duration !== 'number' ||
			!Number.isFinite(part.duration) ||
			part.duration < 0
		)
			throw new Error('视频分 P 的身份、顺序或时长无效，请重试')
		// Some valid videos omit this display label. Page/CID remain mandatory;
		// the page number describes the part without inventing a song title.
		const partTitle = text(part.part) || `第 ${part.page} P`
		cids.add(part.cid)
		pages.add(part.page)
		return {
			page: part.page,
			title: partTitle,
			source: {
				id: sourceId(expectedBvid, part.cid),
				bvid: expectedBvid,
				cid: part.cid,
				originalTitle: title,
				uploader,
				uploaderId: owner.mid as number,
				performer: null,
				artwork,
				duration: part.duration,
				domain: 'unclassified',
				audioAvailability: 'unknown',
			},
		}
	})
	parts.sort((left, right) => left.page - right.page)
	if (parts.some((part, index) => part.page !== index + 1))
		throw new Error('视频分 P 列表不完整，请重试')
	return { bvid: expectedBvid, title, uploader, parts }
}
