import type { CreatorPostCache } from './core/creator-post-cache'
import type { creatorPosts } from './creator-api'
import type { FollowingFeedReader } from './following-feed-session'

export interface FeedRefreshState {
	running: boolean
	finishedAt: number | null
	attempted: number
	succeeded: number
	failed: number
	skipped: number
	total: number
	message: string
	errors: { mid: string; message: string }[]
}
export const emptyFeedRefresh = (): FeedRefreshState => ({
	running: false,
	finishedAt: null,
	attempted: 0,
	succeeded: 0,
	failed: 0,
	skipped: 0,
	total: 0,
	message: '',
	errors: [],
})

/** Explicit first-page refresh. Sequential, no retries/timers or account-follow reads. */
export class FollowingFeedRefresh {
	private owner: AbortController | null = null
	private cooldown = new Map<string, { until: number; failures: number }>()
	constructor(
		private store: FollowingFeedReader,
		private cache: Pick<CreatorPostCache, 'load' | 'savePage'>,
		private posts: typeof creatorPosts,
		private publish: (state: FeedRefreshState) => void,
		private now: () => number = Date.now,
	) {}
	cancel = () => {
		this.owner?.abort()
		this.owner = null
	}
	async run(): Promise<void> {
		if (this.owner) return
		const owner = new AbortController()
		this.owner = owner
		const current = () => this.owner === owner && !owner.signal.aborted
		let state = emptyFeedRefresh()
		const report = (change: Partial<FeedRefreshState>) => {
			if (!current()) return
			state = { ...state, ...change }
			this.publish(state)
		}
		try {
			const mids = [
				...new Set(
					this.store
						.load('local', 'all')
						.subscriptions.map(({ creator }) => creator.mid),
				),
			]
			report({
				running: true,
				total: mids.length,
				message: '仅刷新本地关注的最新一页，不读取全部历史投稿。',
			})
			for (const mid of mids) {
				if (!current()) return
				const cooling = this.cooldown.get(mid)
				if (cooling && cooling.until > this.now()) {
					report({ skipped: state.skipped + 1 })
					continue
				}
				// Re-check local membership before dispatch AND before cache commit.
				const followed = () =>
					this.store
						.load('local', 'all')
						.subscriptions.some(({ creator }) => creator.mid === mid)
				if (!followed()) {
					report({ skipped: state.skipped + 1 })
					continue
				}
				report({ attempted: state.attempted + 1 })
				try {
					const revision = this.cache.load(mid)?.revision ?? null
					const request = new AbortController()
					const abort = () => request.abort()
					owner.signal.addEventListener('abort', abort, { once: true })
					const timeout = setTimeout(abort, 20_000)
					let response: Awaited<ReturnType<typeof creatorPosts>>
					try {
						response = await this.posts(mid, 1, request.signal)
					} finally {
						clearTimeout(timeout)
						owner.signal.removeEventListener('abort', abort)
					}
					if (request.signal.aborted) throw new Error('请求已取消或超时')
					if (!current()) return
					if (!followed()) {
						report({ skipped: state.skipped + 1 })
						continue
					}
					if (
						response.page !== 1 ||
						response.items.some((item) => item.queryCreatorMid !== mid)
					)
						throw new Error('投稿身份或分页不匹配')
					// Cache validates pagination and CAS revision; failed saves preserve old data.
					this.cache.savePage(mid, response, this.now(), revision)
					this.cooldown.set(mid, { until: this.now() + 30_000, failures: 0 })
					report({ succeeded: state.succeeded + 1 })
				} catch (error) {
					if (!current()) return
					const failures = (cooling?.failures ?? 0) + 1
					this.cooldown.set(mid, {
						until:
							this.now() +
							Math.min(30 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 5)),
						failures,
					})
					report({
						failed: state.failed + 1,
						errors: [
							...state.errors,
							{
								mid,
								message:
									error instanceof Error ? error.message : '投稿读取失败',
							},
						],
					})
				}
			}
			report({
				running: false,
				finishedAt: this.now(),
				message: `已更新 ${state.succeeded} / ${state.total} 位 UP；${state.failed} 位失败（旧缓存保留），${state.skipped} 位暂缓。每位最多读取最新 30 条，不代表全部投稿。`,
			})
		} catch {
			report({
				running: false,
				finishedAt: this.now(),
				message: '无法核对本地关注，本次刷新已停止；已有缓存保留。',
			})
		} finally {
			if (current()) this.owner = null
		}
	}
}
