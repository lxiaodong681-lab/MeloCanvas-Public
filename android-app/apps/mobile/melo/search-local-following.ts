import type { CreatorScope, CreatorStore } from './core/creators'

export interface SearchLocalFollowing {
	scopes: ReadonlyMap<string, CreatorScope> | null
	error: string
}

/** Read-only local relationship snapshot; remote search summaries never supply it. */
export function readSearchLocalFollowing(
	store: Pick<CreatorStore, 'listSubscriptions'>,
): SearchLocalFollowing {
	try {
		return {
			scopes: new Map(
				store
					.listSubscriptions('local')
					.map((value) => [value.creatorMid, value.scope]),
			),
			error: '',
		}
	} catch {
		return { scopes: null, error: '本地关注状态暂不可用，搜索结果仍可浏览。' }
	}
}
