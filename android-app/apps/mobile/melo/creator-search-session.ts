import type { Creator } from './core/creators'
import type { searchCreators } from './creator-api'

export interface CreatorSearchState {
	keyword: string
	items: Creator[]
	page: number
	more: boolean
	loading: boolean
	error: string
	failedPage: number | null
}

/** Independent from video search; page is always the last successful page. */
export class CreatorSearchSession {
	private state: CreatorSearchState = {
		keyword: '',
		items: [],
		page: 0,
		more: false,
		loading: false,
		error: '',
		failedPage: null,
	}
	private request: AbortController | null = null
	private listeners = new Set<() => void>()
	constructor(
		private fetchPage: (
			keyword: string,
			page: number,
			signal: AbortSignal,
		) => ReturnType<typeof searchCreators>,
	) {}
	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private update(change: Partial<CreatorSearchState>) {
		this.state = { ...this.state, ...change }
		for (const listener of this.listeners) listener()
	}
	cancel = () => {
		this.request?.abort()
		this.request = null
		if (this.state.loading) this.update({ loading: false })
	}
	rejectInput = (input: string, error: unknown) => {
		this.cancel()
		this.update({
			keyword: input.trim(),
			items: [],
			page: 0,
			more: false,
			error: error instanceof Error ? error.message : '请检查 UP 主关键词',
			failedPage: null,
		})
	}
	find = async (input: string, page = 1): Promise<void> => {
		const keyword = input.trim()
		if (!keyword) {
			this.rejectInput(input, new Error('请输入 UP 主关键词'))
			return
		}
		if (
			page > 1 &&
			(this.state.loading ||
				keyword !== this.state.keyword ||
				page !== this.state.page + 1 ||
				!this.state.more)
		)
			return
		this.cancel()
		const controller = new AbortController()
		this.request = controller
		this.update({
			keyword,
			loading: true,
			error: '',
			failedPage: null,
			...(keyword !== this.state.keyword
				? { items: [], page: 0, more: false }
				: {}),
		})
		try {
			if (!keyword) throw new Error('请输入 UP 主关键词')
			const response = await this.fetchPage(keyword, page, controller.signal)
			if (controller.signal.aborted || this.request !== controller) return
			if (response.page !== page)
				throw new Error('B 站 UP 主分页响应异常，请重试')
			const items = page === 1 ? [] : [...this.state.items]
			const seen = new Set(items.map((item) => item.mid))
			for (const item of response.items) {
				if (!seen.has(item.mid)) items.push(item)
				seen.add(item.mid)
			}
			this.update({ items, page, more: response.more })
		} catch (error) {
			if (!controller.signal.aborted && this.request === controller)
				this.update({
					error:
						error instanceof Error
							? error.message
							: 'UP 主搜索暂时无法完成，请重试',
					failedPage: page,
				})
		} finally {
			if (!controller.signal.aborted && this.request === controller) {
				this.request = null
				this.update({ loading: false })
			}
		}
	}
	retry = () =>
		this.state.failedPage === null
			? Promise.resolve()
			: this.find(this.state.keyword, this.state.failedPage)
	loadMore = () =>
		this.state.failedPage === null
			? this.find(this.state.keyword, this.state.page + 1)
			: Promise.resolve()
}
