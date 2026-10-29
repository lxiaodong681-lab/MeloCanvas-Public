import type { CreatorPostCache } from './core/creator-post-cache'
import type { CreatorScope } from './core/creators'
import type {
	FollowingFeedItem,
	FollowingFeedSnapshot,
} from './core/following-feed-types'
import type { creatorPosts } from './creator-api'
import {
	FollowingFeedRefresh,
	emptyFeedRefresh,
} from './following-feed-refresh'
import type { PlaybackRequest } from './playback-intent'

export interface FollowingFeedReader {
	load(profileId?: string, filter?: CreatorScope): FollowingFeedSnapshot
}
export type FollowingFeedPlayback = (
	item: FollowingFeedItem,
	mode: 'music' | 'listening',
	own: (request: PlaybackRequest) => void,
) => Promise<boolean>

/** Cache-only browsing/playback ownership; remote refresh requires an explicit action. */
export class FollowingFeedSession {
	private state = {
		refresh: emptyFeedRefresh(),
		open: false,
		filter: 'all' as CreatorScope,
		coverageOpen: false,
		snapshot: null as FollowingFeedSnapshot | null,
		stale: false,
		overlay: false,
		error: '',
		playError: '',
		playingBvid: null as string | null,
	}
	private listeners = new Set<() => void>()
	private navigation = 0
	private pending: PlaybackRequest | null = null
	private scroll = new Map<CreatorScope, number>()
	private refresher: FollowingFeedRefresh | null
	constructor(
		private readonly store: FollowingFeedReader,
		cache?: CreatorPostCache,
		posts?: typeof creatorPosts,
	) {
		this.refresher =
			cache && posts
				? new FollowingFeedRefresh(store, cache, posts, (refresh) => {
						this.update({ refresh })
						if (!refresh.running) this.load()
					})
				: null
	}
	refresh = () => {
		if (!this.state.open || this.state.overlay) return
		return this.refresher?.run()
	}
	cancelRefresh = () => {
		this.refresher?.cancel()
		if (this.state.refresh.running) {
			this.update({
				refresh: {
					...this.state.refresh,
					running: false,
					message: '本次刷新已停止；已保存的结果与旧缓存仍可使用。',
				},
			})
			this.load()
		}
	}
	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private update(change: Partial<typeof this.state>) {
		this.state = { ...this.state, ...change }
		for (const listener of this.listeners) listener()
	}
	cancelPending = () => {
		this.navigation++
		const pending = this.pending
		this.pending = null
		pending?.cancel()
		this.update({ playingBvid: null })
	}
	open = () => {
		this.cancelPending()
		this.update({
			open: true,
			overlay: false,
			coverageOpen: false,
			playError: '',
		})
		return this.load()
	}
	close = () => {
		this.cancelRefresh()
		this.cancelPending()
		this.update({
			open: false,
			overlay: false,
			coverageOpen: false,
			playError: '',
		})
	}
	setCoverageOpen = (open: boolean) => {
		if (this.state.open && !this.state.overlay)
			this.update({ coverageOpen: open })
	}
	setFilter = (filter: CreatorScope) => {
		if (!this.state.open || this.state.overlay) return false
		if (filter === this.state.filter) return true
		this.cancelPending()
		this.update({ filter, playError: '' })
		return this.load()
	}
	load = (): boolean => {
		if (!this.state.open || this.state.overlay) return false
		if (this.state.playingBvid) this.cancelPending()
		try {
			const snapshot = this.store.load('local', this.state.filter)
			this.update({ snapshot, stale: false, error: '' })
			return true
		} catch (error) {
			this.update({
				stale: !!this.state.snapshot,
				error:
					error instanceof Error
						? error.message
						: '本地关注更新暂时无法读取，请重试。',
			})
			return false
		}
	}
	pauseForOverlay = () => {
		this.cancelRefresh()
		this.cancelPending()
		this.update({ overlay: true, playError: '' })
	}
	resumeFromOverlay = () => {
		if (!this.state.open || !this.state.overlay) return
		this.update({ overlay: false })
		this.load()
	}
	rememberScroll = (y: number) => {
		if (Number.isFinite(y) && y >= 0) this.scroll.set(this.state.filter, y)
	}
	getScrollOffset = () => this.scroll.get(this.state.filter) ?? 0
	async play(
		bvid: string,
		mode: 'music' | 'listening',
		activate: FollowingFeedPlayback,
		onPresented: () => void,
	): Promise<boolean> {
		if (!this.state.open || this.state.overlay || this.state.playingBvid)
			return false
		if (!this.load()) return false
		const item = this.state.snapshot?.items.find(
			(value) => value.post.bvid === bvid,
		)
		if (!item) {
			this.update({
				playError: '这条投稿已不在当前本地关注范围内，请重新选择。',
			})
			return false
		}
		this.cancelPending()
		const navigation = this.navigation
		const current = () =>
			navigation === this.navigation && this.state.open && !this.state.overlay
		let ownershipReadFailed = false
		const check = async (request: PlaybackRequest): Promise<boolean> => {
			if (!current() || !request.isCurrent()) return false
			try {
				return (
					(await request.checkCurrent()) && current() && request.isCurrent()
				)
			} catch {
				ownershipReadFailed = true
				if (current() && request.isCurrent())
					this.update({ playError: '暂时无法核对本次播放，请稍后重试。' })
				return false
			}
		}
		this.update({ playingBvid: bvid, playError: '' })
		try {
			const success = await activate(item, mode, (request) => {
				if (!current()) request.cancel()
				else this.pending = request
			})
			if (!current()) return false
			const request = this.pending
			if (
				!request ||
				!(await check(request)) ||
				!current() ||
				!request.isCurrent()
			)
				return false
			if (!success) {
				this.update({ playError: '未能开始播放，请核对播放器提示后重试。' })
				return false
			}
			onPresented()
			return true
		} catch (error) {
			if (!current()) return false
			const request = this.pending
			if (request) {
				const verified = await check(request)
				// Before reserve succeeds, the real Intent cannot check its token yet,
				// but remains JS-current. Preserve that actual preparation error.
				if (
					!verified &&
					(ownershipReadFailed || !current() || !request.isCurrent())
				)
					return false
			}
			if (current() && (!request || request.isCurrent()))
				this.update({
					playError:
						error instanceof Error ? error.message : '播放准备失败，请重试。',
				})
			return false
		} finally {
			if (current()) {
				this.pending = null
				this.update({ playingBvid: null })
			}
		}
	}
}
