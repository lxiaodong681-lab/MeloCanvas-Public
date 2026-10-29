import type {
	Creator,
	CreatorScope,
	CreatorStore,
	CreatorSubscription,
} from './core/creators'
import type { Library } from './core/database'
import type { SearchItem, Source } from './core/model'
import { creatorFromSource, creatorSpaceUrl } from './creator-selection'

type CreatorRoute = { kind: 'following' } | { kind: 'profile'; mid: string }
export interface LocalFollowing {
	creator: Creator
	subscription: CreatorSubscription
}
export interface CreatorState {
	routes: CreatorRoute[]
	creator: Creator | null
	subscription: CreatorSubscription | null
	sources: Source[]
	following: LocalFollowing[]
	profileLoaded: boolean
	scopeForm: CreatorScope | null
	unfollowConfirm: boolean
	suspended: boolean
	playbackBusy: boolean
	error: string
	notice: string
}
const initial = (): CreatorState => ({
	routes: [],
	creator: null,
	subscription: null,
	sources: [],
	following: [],
	profileLoaded: false,
	scopeForm: null,
	unfollowConfirm: false,
	suspended: false,
	playbackBusy: false,
	error: '',
	notice: '',
})

/** Local profile browsing never changes playback or a remote relation. */
export class CreatorSession {
	private state = initial()
	private listeners = new Set<() => void>()
	private navigation = 0
	private summary: Creator | null = null
	private pendingPlayback: { cancel: () => void } | null = null
	constructor(
		private store: CreatorStore,
		private library: Pick<Library, 'sourcesByUploader'>,
	) {}
	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private update(change: Partial<CreatorState>) {
		this.state = { ...this.state, ...change }
		for (const listener of this.listeners) listener()
	}
	private fail(error: unknown) {
		this.update({
			error:
				error instanceof Error
					? error.message
					: '本地关注暂时无法保存，请重试。',
		})
	}
	private profileMid() {
		const route = this.state.routes.at(-1)
		return route?.kind === 'profile' ? route.mid : null
	}
	private invalidateNavigation() {
		const pending = this.pendingPlayback
		this.pendingPlayback = null
		pending?.cancel()
		this.navigation++
	}
	cancelPlayback = () => {
		this.invalidateNavigation()
		this.update({ playbackBusy: false })
	}

	openSource = (source: SearchItem | Source) => {
		const summary = creatorFromSource(source)
		this.summary = summary
		this.openProfile(summary.mid)
	}
	openSummary = (creator: Creator) => {
		creatorSpaceUrl(creator.mid)
		if (!creator.name.trim()) throw new Error('UP 主昵称暂时无法读取')
		this.summary = { ...creator, fetchedAt: 0 }
		this.openProfile(creator.mid)
	}
	acceptProfile = (creator: Creator) => {
		if (creator.mid !== this.profileMid() || creator.fetchedAt <= 0)
			throw new Error('UP 主资料与当前页面不匹配')
		const saved = this.store.saveCreator(creator)
		this.update({ creator: saved })
		this.refresh()
	}
	openFollowing = () => {
		this.invalidateNavigation()
		this.summary = null
		this.state = { ...initial(), routes: [{ kind: 'following' }] }
		this.update({})
		this.refresh()
	}
	openProfile = (mid: string) => {
		creatorSpaceUrl(mid)
		this.invalidateNavigation()
		const parent =
			this.state.routes[0]?.kind === 'following'
				? [{ kind: 'following' as const }]
				: []
		this.update({
			routes: [...parent, { kind: 'profile', mid }],
			creator: this.summary?.mid === mid ? this.summary : null,
			subscription: null,
			sources: [],
			profileLoaded: false,
			scopeForm: null,
			unfollowConfirm: false,
			suspended: false,
			playbackBusy: false,
			error: '',
			notice: '',
		})
		this.refresh()
	}
	back = () => {
		if (this.state.scopeForm !== null || this.state.unfollowConfirm) {
			this.closeForm()
			return
		}
		this.invalidateNavigation()
		this.summary = null
		if (this.state.routes.length > 1) {
			this.state = { ...initial(), routes: [{ kind: 'following' }] }
			this.update({})
			this.refresh()
		} else {
			this.state = initial()
			this.update({})
		}
	}
	refresh = () => {
		try {
			const mid = this.profileMid()
			if (mid) {
				const creator =
					this.store.getCreator(mid) ??
					(this.summary?.mid === mid ? this.summary : null)
				if (!creator)
					throw new Error('本地 UP 主资料已不存在，请返回重新选择。')
				const subscription = this.store.getSubscription('local', mid)
				const sources = this.library.sourcesByUploader(mid)
				this.update({
					creator,
					subscription,
					sources,
					profileLoaded: true,
					error: '',
				})
			} else if (this.state.routes.at(-1)?.kind === 'following') {
				const following = this.store
					.listSubscriptions('local')
					.map((subscription) => {
						const creator = this.store.getCreator(subscription.creatorMid)
						if (!creator)
							throw new Error('部分本地 UP 主资料暂时无法读取，请重试。')
						return { creator, subscription }
					})
				this.update({ following, error: '' })
			}
		} catch (error) {
			this.fail(error)
		}
	}
	requestScope = () => {
		if (this.state.profileLoaded) {
			this.invalidateNavigation()
			this.update({
				scopeForm: this.state.subscription?.scope ?? 'all',
				unfollowConfirm: false,
				playbackBusy: false,
				error: '',
				notice: '',
			})
		}
	}
	setScope = (scope: CreatorScope) => {
		if (this.state.scopeForm !== null)
			this.update({ scopeForm: scope, error: '' })
	}
	closeForm = () =>
		this.update({ scopeForm: null, unfollowConfirm: false, error: '' })
	saveScope = (): boolean => {
		const { creator, scopeForm, profileLoaded } = this.state
		const mid = this.profileMid()
		if (!profileLoaded || !creator || creator.mid !== mid || scopeForm === null)
			return false
		try {
			// Re-read before the first save: an existing richer profile always wins.
			const saved =
				this.store.getCreator(mid) ?? this.store.saveCreator(creator)
			const existing = this.store.getSubscription('local', mid)
			const subscription = existing
				? this.store.updateScope('local', mid, scopeForm)
				: this.store.follow({
						profileId: 'local',
						creatorMid: mid,
						scope: scopeForm,
						origin: 'manual',
					}).subscription
			this.update({
				creator: saved,
				subscription,
				scopeForm: null,
				error: '',
				notice: existing
					? '本地关注范围已保存'
					: '已在音绘本地关注，通知保持关闭',
			})
			this.refresh()
			return true
		} catch (error) {
			this.fail(error)
			return false
		}
	}
	requestUnfollow = () => {
		if (this.state.profileLoaded && this.state.subscription) {
			this.invalidateNavigation()
			this.update({
				unfollowConfirm: true,
				scopeForm: null,
				playbackBusy: false,
				error: '',
				notice: '',
			})
		}
	}
	unfollow = (): boolean => {
		const mid = this.profileMid()
		if (!mid || !this.state.unfollowConfirm || this.state.creator?.mid !== mid)
			return false
		try {
			this.store.unfollow('local', mid)
			this.update({
				subscription: null,
				unfollowConfirm: false,
				error: '',
				notice: '已取消本地关注；喜欢、历史与 B 站关系保留',
			})
			this.refresh()
			return true
		} catch (error) {
			this.fail(error)
			return false
		}
	}
	resumeFromPlayer = () => this.update({ suspended: false })
	async openSpace(open: (url: string) => Promise<unknown>): Promise<void> {
		const mid = this.profileMid()
		if (!mid) return
		const navigation = this.navigation
		try {
			await open(creatorSpaceUrl(mid))
		} catch (error) {
			if (navigation === this.navigation) this.fail(error)
		}
	}
	async presentPlayback(
		activate: () => Promise<boolean>,
		onPresented: () => void,
		cancel: () => void = () => {},
	): Promise<boolean> {
		this.pendingPlayback?.cancel()
		const pending = { cancel }
		this.pendingPlayback = pending
		const navigation = this.navigation
		this.update({ playbackBusy: true, error: '' })
		try {
			const success = await activate()
			if (
				this.pendingPlayback === pending &&
				navigation === this.navigation &&
				success &&
				this.profileMid()
			) {
				this.update({ suspended: true })
				onPresented()
			}
			return success
		} catch (error) {
			if (this.pendingPlayback === pending && navigation === this.navigation)
				this.fail(error)
			return false
		} finally {
			if (this.pendingPlayback === pending) {
				this.pendingPlayback = null
				if (navigation === this.navigation) this.update({ playbackBusy: false })
			}
		}
	}
}
