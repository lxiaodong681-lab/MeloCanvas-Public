import type { search } from './bilibili'
import type { SearchItem } from './core/model'
import { canSortSearch, type SearchOrder } from './search-order'

export interface SearchState {
	submitted: string
	order: SearchOrder
	items: SearchItem[]
	/** Confirmed course occurrences on accepted pages, not a remote result total. */
	ketangCount: number
	page: number
	more: boolean
	loading: boolean
	error: string
	failedPage: number | null
}

// Page means the last successful page. Failed requests never advance it.
export class SearchSession {
	private state: SearchState = {
		submitted: '',
		order: 'relevance',
		items: [],
		ketangCount: 0,
		page: 0,
		more: false,
		loading: false,
		error: '',
		failedPage: null,
	}
	private request: AbortController | null = null
	private listeners = new Set<() => void>()
	constructor(
		private readonly fetchPage: (
			input: string,
			page: number,
			signal: AbortSignal,
			order: SearchOrder,
		) => ReturnType<typeof search>,
	) {}
	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private update(change: Partial<SearchState>) {
		this.state = { ...this.state, ...change }
		for (const listener of this.listeners) listener()
	}
	cancel = () => {
		this.request?.abort()
		this.request = null
		if (this.state.loading) this.update({ loading: false })
	}
	find = async (input: string, page = 1, order = this.state.order) => {
		// Prevent duplicate pagination taps; a fresh query always supersedes work.
		if (
			page > 1 &&
			(this.state.loading ||
				input !== this.state.submitted ||
				order !== this.state.order ||
				page !== this.state.page + 1 ||
				!this.state.more)
		)
			return
		this.request?.abort()
		const controller = new AbortController()
		this.request = controller
		this.update({
			submitted: input.trim(),
			order,
			loading: true,
			error: '',
			failedPage: null,
			...(page === 1
				? { items: [], ketangCount: 0, page: 0, more: false }
				: {}),
		})
		try {
			const response = await this.fetchPage(
				input,
				page,
				controller.signal,
				order,
			)
			if (controller.signal.aborted || this.request !== controller) return
			const items = page === 1 ? [] : [...this.state.items]
			const seen = new Set(items.map((item) => item.bvid))
			for (const item of response.items) {
				if (!seen.has(item.bvid)) items.push(item)
				seen.add(item.bvid)
			}
			this.update({
				items,
				ketangCount:
					(page === 1 ? 0 : this.state.ketangCount) +
					(response.ketangCount ?? 0),
				page,
				more: response.more,
			})
		} catch (error) {
			if (controller.signal.aborted || this.request !== controller) return
			this.update({
				error: error instanceof Error ? error.message : '网络请求失败，请重试',
				failedPage: page,
			})
		} finally {
			if (!controller.signal.aborted && this.request === controller) {
				this.request = null
				this.update({ loading: false })
			}
		}
	}
	setOrder = async (order: SearchOrder) => {
		if (order === this.state.order) return
		if (this.state.submitted && canSortSearch(this.state.submitted)) {
			await this.find(this.state.submitted, 1, order)
		} else {
			this.update({ order })
		}
	}
	retry = () => this.find(this.state.submitted, this.state.failedPage ?? 1)
	loadMore = () => this.find(this.state.submitted, this.state.page + 1)
}

export function musicResults(items: SearchItem[]) {
	return items.filter((item) =>
		/音乐|翻唱|演奏|原创|VOCALOID|演唱|^MV$|乐评|电台/i.test(item.category),
	)
}
