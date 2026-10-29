import type { Source } from './core/model'
import type {
	DismissedRecommendationPage,
	RecommendationSnapshot,
	RecommendationStore,
} from './core/recommendations'
import type { PlaybackRequest } from './playback-intent'

type Store = Pick<
	RecommendationStore,
	| 'load'
	| 'refresh'
	| 'dismiss'
	| 'undo'
	| 'listDismissed'
	| 'restoreSource'
	| 'resetLocalRecommendations'
>
export type RecommendationPlayback = (
	source: Source,
	own: (request: PlaybackRequest) => void,
) => Promise<boolean>

/** Local presentation and pending playback ownership; never generates candidates or a queue. */
export class RecommendationSession {
	private state = {
		open: false,
		view: 'daily' as 'daily' | 'dismissed',
		feedbackPage: null as DismissedRecommendationPage | null,
		feedbackRequestedPage: 1,
		feedbackRevision: 0,
		feedbackError: '',
		feedbackStale: false,
		restoredSourceIds: [] as string[],
		resetConfirming: false,
		snapshot: null as RecommendationSnapshot | null,
		busy: false,
		error: '',
		notice: '',
		playingId: null as string | null,
		playError: '',
	}
	private listeners = new Set<() => void>()
	private playbackRevision = 0
	private pending: PlaybackRequest | null = null
	constructor(private readonly store: Store) {}
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
	open = () => {
		this.update({
			open: true,
			view: 'daily',
			feedbackRevision: this.state.feedbackRevision + 1,
			resetConfirming: false,
			notice: '',
			playError: '',
		})
		return this.load()
	}
	close = () => {
		this.cancelPending()
		this.update({
			open: false,
			feedbackRevision: this.state.feedbackRevision + 1,
			resetConfirming: false,
			playError: '',
		})
	}
	back = () => {
		if (this.state.view === 'dismissed' && this.state.open) {
			this.update({
				view: 'daily',
				feedbackRevision: this.state.feedbackRevision + 1,
				resetConfirming: false,
				error: '',
				playError: '',
			})
			this.load()
		} else this.close()
	}
	openDismissed = () => {
		if (!this.state.open || this.state.busy) return false
		this.cancelPending()
		this.update({
			view: 'dismissed',
			error: '',
			notice: '',
			playError: '',
			feedbackStale: !!this.state.feedbackPage,
			resetConfirming: false,
		})
		return this.loadDismissed(1)
	}
	loadDismissed = (
		page = this.state.feedbackRequestedPage,
		successPrefix = '',
	): boolean => {
		if (
			!this.state.open ||
			this.state.view !== 'dismissed' ||
			this.state.busy ||
			this.state.resetConfirming
		)
			return false
		this.update({
			busy: true,
			feedbackRequestedPage: page,
			feedbackRevision: this.state.feedbackRevision + 1,
			feedbackError: '',
		})
		try {
			const feedbackPage = this.store.listDismissed(page, 20)
			this.update({ feedbackPage, feedbackStale: false, restoredSourceIds: [] })
			return true
		} catch (error) {
			const message =
				error instanceof Error ? error.message : '本地反馈列表读取失败'
			this.update({
				feedbackStale: !!this.state.feedbackPage,
				feedbackError: `${successPrefix}${message}`,
			})
			return false
		} finally {
			this.update({ busy: false })
		}
	}
	restoreSource = (sourceId: string, revision: number): boolean => {
		if (
			!this.state.open ||
			this.state.view !== 'dismissed' ||
			revision !== this.state.feedbackRevision ||
			this.state.resetConfirming ||
			this.state.feedbackStale ||
			!this.state.feedbackPage?.items.some(
				(item) => item.sourceId === sourceId,
			) ||
			this.state.restoredSourceIds.includes(sourceId)
		)
			return false
		const page = this.state.feedbackPage
		if (
			!this.read(
				() => this.store.restoreSource(sourceId),
				'此音源已恢复，可再次参与后续推荐，不保证立即出现在当前列表。',
			)
		)
			return false
		this.update({
			restoredSourceIds: [...this.state.restoredSourceIds, sourceId],
			feedbackStale: true,
		})
		// A post-commit read failure cannot undo or misreport the successful restoration.
		const target = Math.min(
			page.page,
			Math.max(1, Math.ceil(Math.max(0, page.total - 1) / page.pageSize)),
		)
		this.loadDismissed(target, '恢复已成功，列表刷新失败：')
		return true
	}
	prepareReset = (): ((confirmed: boolean) => boolean) | null => {
		if (
			!this.state.open ||
			this.state.view !== 'dismissed' ||
			this.state.busy ||
			this.state.resetConfirming
		)
			return null
		const revision = this.state.feedbackRevision
		let settled = false
		this.update({ resetConfirming: true })
		return (confirmed) => {
			if (
				settled ||
				!this.state.open ||
				this.state.view !== 'dismissed' ||
				revision !== this.state.feedbackRevision
			)
				return false
			settled = true
			this.update({ resetConfirming: false })
			if (!confirmed) return false
			if (
				!this.read(
					() => this.store.resetLocalRecommendations(),
					'已重置本地推荐，喜欢、歌单、关注和播放均保留。',
				)
			)
				return false
			this.update({
				feedbackPage: {
					items: [],
					page: 1,
					pageSize: 20,
					total: 0,
					totalPages: 0,
				},
				feedbackRequestedPage: 1,
				feedbackRevision: this.state.feedbackRevision + 1,
				feedbackStale: false,
				restoredSourceIds: [],
				feedbackError: '',
			})
			return true
		}
	}
	private cancelPending() {
		this.playbackRevision++
		this.pending?.cancel()
		this.pending = null
		this.update({ playingId: null })
	}
	private read(action: () => RecommendationSnapshot, notice?: string): boolean {
		if (!this.state.open || this.state.busy) return false
		this.update({ busy: true, error: '' })
		try {
			const snapshot = action()
			if (
				this.state.playingId &&
				!snapshot.items.some((item) => item.source.id === this.state.playingId)
			)
				this.cancelPending()
			// Store returns the committed result. Do not turn a successful write into failure by rereading.
			this.update({ snapshot, ...(notice === undefined ? {} : { notice }) })
			return true
		} catch (error) {
			this.update({
				error:
					error instanceof Error
						? error.message
						: '本地推荐读取失败，请稍后重试。',
			})
			return false
		} finally {
			this.update({ busy: false })
		}
	}
	load = () =>
		this.state.view === 'dismissed'
			? this.loadDismissed()
			: this.read(() => this.store.load())
	refresh = () =>
		this.read(
			() => this.store.refresh(),
			'已换一批；本机候选较少时，音源可能重复出现。',
		)
	dismiss = (sourceId: string) => {
		if (!this.state.snapshot?.items.some((item) => item.source.id === sourceId))
			return false
		return this.read(
			() => this.store.dismiss(sourceId),
			'已减少推荐此音源，可撤销。其他版本和歌手不受影响。',
		)
	}
	undo = () =>
		this.read(
			() => this.store.undo(),
			'已撤销上次不感兴趣；此音源可再次参与后续推荐。',
		)
	async play(
		sourceId: string,
		action: RecommendationPlayback,
		opened: () => void,
	): Promise<boolean> {
		if (!this.state.open || this.state.view !== 'daily') return false
		this.cancelPending()
		this.update({ playError: '' })
		if (!this.load()) return false
		const item = this.state.snapshot?.items.find(
			(value) => value.source.id === sourceId,
		)
		if (!item) {
			this.update({ playError: '此音源已不在当前本地推荐中，请选择其他音源。' })
			return false
		}
		const revision = this.playbackRevision
		this.update({ playingId: sourceId, playError: '' })
		try {
			const ok = await action(item.source, (request) => {
				if (revision !== this.playbackRevision || !this.state.open)
					request.cancel()
				else this.pending = request
			})
			if (
				revision !== this.playbackRevision ||
				!this.state.open ||
				!this.pending?.isCurrent()
			)
				return false
			if (ok) opened()
			else
				this.update({ playError: '此音源未能开始播放，请重试或选择其他音源。' })
			return ok
		} catch (error) {
			if (
				revision === this.playbackRevision &&
				this.state.open &&
				this.pending?.isCurrent()
			)
				this.update({
					playError:
						error instanceof Error
							? error.message
							: '此音源暂时无法播放，请重试或选择其他音源。',
				})
			return false
		} finally {
			if (revision === this.playbackRevision) {
				this.pending = null
				this.update({ playingId: null })
			}
		}
	}
}
