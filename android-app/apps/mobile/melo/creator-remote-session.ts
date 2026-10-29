import type { BilibiliContentScopeReader } from './core/bilibili-content-scope'
import {
	CreatorPostCacheConflictError,
	type CreatorPostCache,
	type CachedCreatorPosts,
} from './core/creator-post-cache'
import type { Creator, CreatorScope } from './core/creators'
import type {
	creatorPosts,
	creatorProfile,
	CreatorPostCandidate,
} from './creator-api'
import { creatorSpaceUrl } from './creator-selection'

export interface CreatorRemoteState {
	mid: string | null
	visit: object | null
	profileLoading: boolean
	profileError: string
	profileUpdated: boolean
	posts: CreatorPostCandidate[]
	postFilter: CreatorScope
	visiblePosts: CreatorPostCandidate[]
	filterError: string
	postsLoading: boolean
	postsError: string
	page: number
	more: boolean
	total: number | null
	failedPage: number | null
	cacheStatus: 'unread' | 'ready' | 'failed'
	cacheError: string
	postsNotice: string
	postsReadTimes: { page: number; fetchedAt: number }[]
	restartRequired: boolean
}
const empty = (
	mid: string | null,
	visit: object | null = null,
): CreatorRemoteState => ({
	mid,
	visit,
	profileLoading: false,
	profileError: '',
	profileUpdated: false,
	posts: [],
	postFilter: 'all',
	visiblePosts: [],
	filterError: '',
	postsLoading: false,
	postsError: '',
	page: 0,
	more: false,
	total: null,
	failedPage: null,
	cacheStatus: 'unread',
	cacheError: '',
	postsNotice: '',
	postsReadTimes: [],
	restartRequired: false,
})

/** Only explicit actions read the network. Errors never remove local profile/content. */
export class CreatorRemoteSession {
	private state = empty(null)
	private profileRequest: AbortController | null = null
	private postsRequest: AbortController | null = null
	private cacheRevision: number | null = null
	private listeners = new Set<() => void>()
	constructor(
		private api: {
			profile: (
				mid: string,
				signal: AbortSignal,
			) => ReturnType<typeof creatorProfile>
			posts: (
				mid: string,
				page: number,
				signal: AbortSignal,
			) => ReturnType<typeof creatorPosts>
		},
		private acceptProfile: (creator: Creator) => void,
		private cache: Pick<CreatorPostCache, 'load' | 'savePage'>,
		private scopes: Pick<BilibiliContentScopeReader, 'load'>,
		private now: () => number = Date.now,
		private cancelPlayback: () => void = () => {},
	) {}
	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private update(change: Partial<CreatorRemoteState>) {
		this.state = { ...this.state, ...change }
		for (const listener of this.listeners) listener()
	}
	select = (mid: string | null, visit: object | null = null) => {
		if (this.state.mid === mid && this.state.visit === visit) return
		if (mid !== null) creatorSpaceUrl(mid)
		this.cancel()
		this.state = empty(mid, visit)
		this.cacheRevision = null
		this.update({})
		if (mid !== null) this.loadCached(mid)
	}
	private publishCache(mid: string, cached: CachedCreatorPosts | null) {
		if (cached && cached.mid !== mid) throw new Error('本地投稿缓存身份不匹配')
		const posts: CreatorPostCandidate[] = [],
			seen = new Set<string>()
		for (const page of cached?.pages ?? [])
			for (const post of page.items) {
				if (!seen.has(post.bvid)) posts.push(post)
				seen.add(post.bvid)
			}
		this.cacheRevision = cached?.revision ?? null
		this.update({
			posts,
			...this.filtered(posts),
			page: cached?.lastPage ?? 0,
			more: cached?.more ?? false,
			total: cached?.total ?? null,
			postsReadTimes:
				cached?.pages.map(({ page, fetchedAt }) => ({ page, fetchedAt })) ?? [],
			cacheStatus: 'ready',
			cacheError: '',
		})
	}
	private filtered(posts: CreatorPostCandidate[]) {
		try {
			const scopes = this.scopes.load(posts.map((post) => post.bvid))
			return {
				visiblePosts: posts.filter(
					(post) =>
						this.state.postFilter === 'all' ||
						this.state.postFilter ===
							(scopes.get(post.bvid)?.scope ?? 'unknown'),
				),
				filterError: '',
			}
		} catch (error) {
			return {
				visiblePosts: [],
				filterError: `本地投稿分类读取失败：${error instanceof Error ? error.message : '请重试本地读取'}`,
			}
		}
	}
	setPostFilter = (filter: CreatorScope): boolean => {
		if (!this.state.mid || !['all', 'music', 'listening'].includes(filter))
			return false
		if (filter === this.state.postFilter) return true
		this.cancelPlayback()
		this.update({ postFilter: filter, visiblePosts: [], filterError: '' })
		return this.loadCached(this.state.mid) && !this.state.filterError
	}
	/** Fresh local qualification at each asynchronous playback boundary, never a view request. */
	requirePost = (
		candidate: CreatorPostCandidate,
		visit: object | null,
		filter: CreatorScope,
	): CreatorPostCandidate => {
		if (
			!visit ||
			this.state.visit !== visit ||
			this.state.postFilter !== filter ||
			this.state.mid !== candidate.queryCreatorMid
		)
			throw new Error('投稿页面或筛选已变化，请重新选择')
		if (!this.loadCached(candidate.queryCreatorMid))
			throw new Error(this.state.cacheError)
		if (this.state.filterError) throw new Error(this.state.filterError)
		const current = this.state.visiblePosts.find(
			(post) => post.bvid === candidate.bvid,
		)
		if (!current)
			throw new Error('这条投稿已不在当前本地筛选结果中，请重新选择')
		return current
	}
	private loadCached(mid: string): boolean {
		try {
			const cached = this.cache.load(mid)
			if (this.state.mid !== mid) return false
			this.publishCache(mid, cached)
			return true
		} catch (error) {
			if (this.state.mid === mid)
				this.update({
					cacheStatus: 'failed',
					cacheError: `本地投稿缓存读取失败：${error instanceof Error ? error.message : '请重试本地读取'}`,
				})
			return false
		}
	}
	reloadPostsCache = () => {
		const mid = this.state.mid
		if (!mid || this.state.postsLoading) return false
		this.cancelPlayback()
		this.update({ cacheError: '' })
		return this.loadCached(mid)
	}
	cancel = () => {
		this.profileRequest?.abort()
		this.postsRequest?.abort()
		this.profileRequest = null
		this.postsRequest = null
		this.update({ profileLoading: false, postsLoading: false })
	}
	refreshProfile = async (): Promise<void> => {
		const mid = this.state.mid
		if (!mid || this.state.profileLoading) return
		const controller = new AbortController()
		this.profileRequest = controller
		this.update({
			profileLoading: true,
			profileError: '',
			profileUpdated: false,
		})
		try {
			const value = await this.api.profile(mid, controller.signal)
			if (
				controller.signal.aborted ||
				this.profileRequest !== controller ||
				this.state.mid !== mid
			)
				return
			if (value.mid !== mid || value.fetchedAt <= 0)
				throw new Error('返回的 UP 主资料身份或时间异常，请重试')
			this.acceptProfile(value)
			this.update({ profileUpdated: true })
		} catch (error) {
			if (!controller.signal.aborted && this.profileRequest === controller)
				this.update({
					profileError:
						error instanceof Error
							? error.message
							: 'UP 主资料暂时无法读取，请重试',
				})
		} finally {
			if (!controller.signal.aborted && this.profileRequest === controller) {
				this.profileRequest = null
				this.update({ profileLoading: false })
			}
		}
	}
	readPosts = async (page = 1): Promise<void> => {
		const mid = this.state.mid
		if (
			!mid ||
			this.state.postsLoading ||
			(page > 1 &&
				(page !== this.state.page + 1 ||
					!this.state.more ||
					this.state.restartRequired))
		)
			return
		if (this.state.cacheStatus !== 'ready' && !this.loadCached(mid)) return
		if (
			page > 1 &&
			(page !== this.state.page + 1 ||
				!this.state.more ||
				this.state.restartRequired)
		)
			return
		const expectedRevision = this.cacheRevision
		const controller = new AbortController()
		this.postsRequest = controller
		this.update({
			postsLoading: true,
			postsError: '',
			cacheError: '',
			postsNotice: '',
			failedPage: null,
		})
		try {
			const response = await this.api.posts(mid, page, controller.signal)
			if (
				controller.signal.aborted ||
				this.postsRequest !== controller ||
				this.state.mid !== mid
			)
				return
			if (
				response.page !== page ||
				response.items.some((item) => item.queryCreatorMid !== mid)
			)
				throw new Error('返回的 UP 主投稿分页异常，请重试')
			try {
				// Check ownership immediately before the synchronous cache transaction.
				if (
					controller.signal.aborted ||
					this.postsRequest !== controller ||
					this.state.mid !== mid
				)
					return
				const saved = this.cache.savePage(
					mid,
					response,
					this.now(),
					expectedRevision,
				)
				if (
					controller.signal.aborted ||
					this.postsRequest !== controller ||
					this.state.mid !== mid
				)
					return
				this.publishCache(mid, saved)
				this.update({ restartRequired: false })
			} catch (error) {
				if (
					controller.signal.aborted ||
					this.postsRequest !== controller ||
					this.state.mid !== mid
				)
					return
				if (error instanceof CreatorPostCacheConflictError) {
					this.update({
						restartRequired: true,
						failedPage: null,
						postsNotice:
							'投稿缓存或分页已变化，本次旧结果未写入。请刷新 UP 投稿，从第 1 页重新读取。',
					})
					this.loadCached(mid)
				} else
					this.update({
						cacheError: `网络已返回第 ${page} 页，但本地投稿缓存保存失败；此前可用内容已保留。${error instanceof Error ? error.message : '请重试'}`,
						failedPage: page,
					})
			}
		} catch (error) {
			if (!controller.signal.aborted && this.postsRequest === controller)
				this.update({
					postsError:
						error instanceof Error
							? error.message
							: 'UP 主投稿暂时无法读取，请重试',
					failedPage: page,
				})
		} finally {
			if (!controller.signal.aborted && this.postsRequest === controller) {
				this.postsRequest = null
				this.update({ postsLoading: false })
			}
		}
	}
	retryPosts = () =>
		this.state.failedPage === null
			? Promise.resolve()
			: this.readPosts(this.state.failedPage)
	loadMore = () =>
		this.state.failedPage === null
			? this.readPosts(this.state.page + 1)
			: Promise.resolve()
}
