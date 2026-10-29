import type { Creator } from './core/creators'
import type { SearchItem, Source } from './core/model'

export function creatorMid(uploaderId: number): string {
	if (!Number.isSafeInteger(uploaderId) || uploaderId <= 0)
		throw new Error('这条音源没有可靠的 UP 主身份，暂时无法打开主页。')
	return String(uploaderId)
}

export function creatorFromSource(
	source: Pick<SearchItem | Source, 'uploader' | 'uploaderId'>,
): Creator {
	const mid = creatorMid(source.uploaderId)
	const name = typeof source.uploader === 'string' ? source.uploader.trim() : ''
	if (!name) throw new Error('这条音源缺少 UP 主昵称，暂时无法打开主页。')
	// A local Source summary is not a remote profile refresh.
	return { source: 'bilibili', mid, name, fetchedAt: 0 }
}

export function creatorSpaceUrl(mid: string): string {
	if (
		typeof mid !== 'string' ||
		mid.trim() !== mid ||
		!/^[1-9][0-9]*$/.test(mid)
	)
		throw new Error('UP 主 mid 无效')
	return `https://space.bilibili.com/${mid}`
}
