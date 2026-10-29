import { parseSearchInput } from './core/model'
import type { CreatorSearchState } from './creator-search-session'

/** Explicit identities only: numeric nicknames remain ordinary search terms. */
export function creatorSearchMid(input: string): string | null {
	const value = input.trim()
	if (/^mid:/i.test(value)) {
		const id = value.slice(4).trim()
		if (!/^[1-9][0-9]*$/.test(id))
			throw new Error('UP 主 mid 格式不正确，请使用 mid:123')
		return id
	}
	if (!/^https?:\/\//i.test(value)) return null
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return null
	}
	if (url.hostname.toLowerCase() !== 'space.bilibili.com') return null
	const match = /^\/([1-9][0-9]*)\/?$/.exec(url.pathname)
	if (
		!match ||
		url.username ||
		url.password ||
		url.port ||
		/[\\\s]/.test(value)
	)
		throw new Error('请使用 space.bilibili.com/数字mid 的 UP 主页地址')
	return match[1]
}

/** Exact content identities keep the existing strict video parser in every search tab. */
export function creatorSearchTarget(input: string): 'video' | 'creator' {
	if (creatorSearchMid(input)) return 'creator'
	return parseSearchInput(input).type === 'bv' ? 'video' : 'creator'
}

export function creatorSearchView(
	state: CreatorSearchState,
): 'prompt' | 'loading' | 'empty' | 'interrupted' | null {
	if (state.items.length || state.error) return null
	if (state.loading) return 'loading'
	if (state.page > 0) return 'empty'
	return state.keyword ? 'interrupted' : 'prompt'
}
