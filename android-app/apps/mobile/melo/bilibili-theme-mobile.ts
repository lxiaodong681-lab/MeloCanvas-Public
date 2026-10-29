import { fetch } from 'expo/fetch'

import { getAccountAccess } from './account-access'
import { accountSession } from './account-runtime'
import { createAccountDirectoryFetch } from './account-directory-fetch'
import { beginBilibiliRequest } from './bilibili'
import { BilibiliReadGate } from './bilibili-import-network'
import { readDirectoryHttp } from './directory-http'
import { checkCancelled } from './core/theme-archive'
import { createThemeImageDecoder } from './theme-image-decoder'
import { bilibiliThemeImageUrl, importBilibiliTheme, listOwnedBilibiliThemes, searchBilibiliThemes, type BilibiliThemeItem, type BilibiliThemePort } from './bilibili-theme'

const gate = new BilibiliReadGate()
let importing = false
const publicImages = createAccountDirectoryFetch(fetch, getAccountAccess, accountSession.subscribe)
function port(onProgress?: (message: string) => void): BilibiliThemePort {
	let count = 0, downloaded = 0
	return {
		request: (endpoint, signal) => gate.run(() => beginBilibiliRequest(endpoint, signal)),
		decoder: createThemeImageDecoder(),
		background: async (bytes, color, adjustments) => {
			const native = await import('@bbplayer/native')
			return native.prepareThemeBackgroundAsync(bytes, color, adjustments)
		},
		image: async (url, edge, signal) => {
			checkCancelled(signal)
			onProgress?.(`正在适配第 ${++count} 张静态图片`)
			const controller = new AbortController()
			const abort = () => controller.abort()
			signal.addEventListener('abort', abort, { once: true })
			const timeout = setTimeout(abort, 20000)
			try {
				const bytes = await readDirectoryHttp(publicImages, { url: bilibiliThemeImageUrl(url), method: 'GET', headers: { Referer: 'https://www.bilibili.com/' } }, controller.signal)
				downloaded += bytes.length
				if (downloaded > 32 * 1024 * 1024) throw new Error('主题下载总量超过 32 MiB，请选择更简单的主题')
				checkCancelled(signal)
				const native = await import('@bbplayer/native')
				const result = await native.normalizeThemeImageAsync(bytes, edge)
				checkCancelled(signal)
				return result
			} finally { clearTimeout(timeout); signal.removeEventListener('abort', abort) }
		},
	}
}
export function searchMobileBilibiliThemes(keyword: string, page: number, signal: AbortSignal) {
	return searchBilibiliThemes(keyword, page, port(), signal)
}
export function listMobileOwnedBilibiliThemes(page: number, signal: AbortSignal) {
	if (!getAccountAccess().onlineAllowed) throw new Error('请先登录 B站账号')
	return listOwnedBilibiliThemes(page, port(), signal)
}
export async function importMobileBilibiliTheme(item: BilibiliThemeItem, signal: AbortSignal, onProgress: (message: string) => void, options: Parameters<typeof importBilibiliTheme>[3] = {}) {
	if (importing) throw new Error('上一主题仍在处理，请稍候重试')
	const initial = getAccountAccess()
	if (!initial.onlineAllowed) throw new Error('请先登录 B站账号')
	importing = true
	const controller = new AbortController()
	const abort = () => controller.abort()
	const unsubscribe = accountSession.subscribe(() => {
		const access = getAccountAccess()
		if (!access.onlineAllowed || access.sessionGeneration !== initial.sessionGeneration) abort()
	})
	signal.addEventListener('abort', abort, { once: true })
	try {
		checkCancelled(signal)
		const result = await importBilibiliTheme(item, port(onProgress), controller.signal, options)
		checkCancelled(signal)
		return result
	} finally { importing = false; unsubscribe(); signal.removeEventListener('abort', abort) }
}
