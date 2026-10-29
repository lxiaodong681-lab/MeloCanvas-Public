export interface Source {
	id: string
	bvid: string
	cid: number
	originalTitle: string
	uploader: string
	uploaderId: number
	performer: string | null
	artwork: string
	duration: number
	domain: 'music' | 'unclassified'
	audioAvailability: 'unknown'
}

export interface SearchItem {
	bvid: string
	originalTitle: string
	uploader: string
	uploaderId: number
	artwork: string
	duration: number
	category: string
}

export const sourceId = (bvid: string, cid: number) => `bilibili:${bvid}:${cid}`

export function sourceUri(source: Source): string {
	return `orpheus://bilibili?bvid=${source.bvid}&cid=${source.cid}&quality=30232`
}

export function parseSearchInput(
	input: string,
): { type: 'bv'; bvid: string } | { type: 'keyword'; keyword: string } {
	const query = input.trim()
	if (!query) throw new Error('请输入歌曲关键词或 BV 号')
	const match = /^(?:bv)([A-Za-z0-9]{10})$/i.exec(query)
	if (match) return { type: 'bv', bvid: `BV${match[1]}` }
	if (/^bv/i.test(query)) throw new Error('BV 号格式不正确，请检查后重试')
	if (/^https?:\/\//i.test(query)) {
		const url = new URL(query)
		const id = /\/video\/(BV[A-Za-z0-9]{10})(?:\/|$)/i.exec(url.pathname)?.[1]
		if (/(^|\.)bilibili\.com$/i.test(url.hostname) && id)
			return { type: 'bv', bvid: `BV${id.slice(2)}` }
		throw new Error('请粘贴 bilibili.com/video/BV… 链接或直接输入 BV 号')
	}
	return { type: 'keyword', keyword: query }
}

export function playbackError(message: string): string {
	if (/离线内容缺失或不完整/.test(message))
		return '这首歌曲尚未完整下载，离线时无法播放。请联网后重新保存。'
	if (/WiFiPlaybackRequired/.test(message))
		return '已开启仅 Wi-Fi 播放。请连接 Wi-Fi 后手动重试，或在“我的音绘”关闭此限制。'
	if (/LocalAudio/.test(message))
		return '本地音频无法读取或格式不支持，请重新选择音频文件导入。'
	if (/AudioOnlyUnavailable/.test(message))
		return '该内容没有独立音轨，请返回更换音源。音绘不会下载视频流来收听。'
	if (/code=-404|code=62002|code=62004/.test(message))
		return '这条 B 站内容已失效或不可访问，请更换音源。'
	if (/code=-412|code=-352|code=-799/.test(message))
		return 'B 站暂时限制了游客请求，请稍后重试。'
	return '音频加载失败，请检查网络后重试，或返回更换音源。'
}
