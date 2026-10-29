import { parseSearchInput } from './core/model'

export type SearchOrder = 'relevance' | 'published'

export function canSortSearch(input: string): boolean {
	try {
		return parseSearchInput(input).type === 'keyword'
	} catch {
		return false
	}
}
