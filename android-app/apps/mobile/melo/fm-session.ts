import type { FmPlaybackContext } from '@bbplayer/orpheus'

import type { PlaybackMode } from './core/listening'
import type { Source } from './core/model'
import type { HeartDiscoveryPort } from './heart-discovery'
import type {
	LocalRecommendation,
	RecommendationStore,
} from './core/recommendations'
import {
	PlaybackIntent,
	type PlaybackPreparation,
	type PlaybackPreparationPort,
	type PlaybackRequest,
} from './playback-intent'

export interface FmPlayerState {
	auditionId?: string | null
	fmContext: FmPlaybackContext | null
	mode: PlaybackMode
	queue: readonly { id: string; sourceId?: string }[]
	currentIndex: number
	switching: boolean
}
export interface FmPlaybackPort extends PlaybackPreparationPort {
	read(): FmPlayerState
	startFm(sources: Source[], preparation: PlaybackPreparation): Promise<boolean>
	exitFm(fmId: string, preparation: PlaybackPreparation): Promise<boolean>
	appendFm(
		sources: Source[],
		fmId: string,
		expectedTailEntryId: string,
	): Promise<boolean>
}
type RefillStatus =
	| 'idle'
	| 'loading'
	| 'added'
	| 'empty'
	| 'blocked'
	| 'error'
	| 'limit'

/** Presentation and bounded local refill only; native owns the FM context and all return state. */
export class FmSession {
	private state = {
		open: false,
		candidates: [] as LocalRecommendation[],
		candidateError: '',
		busy: false,
		error: '',
		contextId: null as string | null,
		returnMode: null as PlaybackMode | null,
		selected: false,
		refill: 'idle' as RefillStatus,
		refillMessage: '',
		heartLoading: false,
		heartSelected: false,
		heartQueries: [] as string[],
		heartMessage: '',
	}
	private listeners = new Set<() => void>()
	private revision = 0
	private pending: PlaybackRequest | null = null
	private pageIntent: () => boolean = () => true
	private attempted = ''
	private refillRequest: object | null = null
	private heartRequest: AbortController | null = null
	constructor(
		private readonly store: Pick<RecommendationStore, 'fmCandidates'>,
		private readonly intent: PlaybackIntent,
		private readonly player: FmPlaybackPort,
		private readonly heart?: HeartDiscoveryPort,
	) {}
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
		this.cancelPending()
		this.pageIntent = this.intent.captureCurrent()
		this.update({ open: true, error: '' })
		if (!this.player.read().fmContext) this.loadCandidates()
	}
	close = () => {
		this.cancelPending()
		this.update({ open: false, error: '' })
	}
	cancelPending = () => {
		this.heartRequest?.abort()
		this.heartRequest = null
		if (this.state.heartLoading) this.update({ heartLoading: false })
		this.revision++
		this.pending?.cancel()
		this.pending = null
		this.pageIntent = this.intent.captureCurrent()
		if (this.state.busy) this.update({ busy: false })
	}
	loadCandidates = () => {
		if (!this.state.open || this.state.busy || this.player.read().fmContext)
			return false
		this.heartRequest?.abort()
		this.heartRequest = null
		this.update({heartSelected: false, heartLoading: false, heartQueries: [], heartMessage: ''})
		try {
			this.update({
				candidates: this.store.fmCandidates([], 20),
				candidateError: '',
			})
			return true
		} catch (error) {
			this.update({
				candidateError:
					error instanceof Error ? error.message : '本机候选暂时无法读取',
			})
			return false
		}
	}
	loadHeartCandidates = async () => {
		if (!this.heart || !this.state.open || this.state.busy || this.player.read().fmContext) return false
		this.heartRequest?.abort()
		const request = new AbortController()
		this.heartRequest = request
		this.update({heartLoading: true, heartMessage: '', candidateError: ''})
		try {
			const batch = await this.heart.discover(request.signal)
			if (request.signal.aborted || this.heartRequest !== request || !this.state.open || !this.pageIntent() || this.player.read().fmContext) return false
			this.update({candidates: batch.sources.map(source => ({source, reasons: []})), heartSelected: true, heartQueries: batch.queries, heartMessage: batch.message})
			return true
		} catch (error) {
			if (!request.signal.aborted && this.heartRequest === request && this.state.open)
				this.update({heartMessage: error instanceof Error ? error.message : '心动推荐暂时无法读取'})
			return false
		} finally {
			if (this.heartRequest === request) {
				this.heartRequest = null
				this.update({heartLoading: false})
			}
		}
	}
	start = (opened: () => void) => this.replace('start', opened)
	exit = (opened: (hasReturnTrack: boolean) => void) =>
		this.replace('exit', opened)
	private async replace(
		action: 'start' | 'exit',
		opened: (hasTrack: boolean) => void,
	): Promise<boolean> {
		if (!this.state.open || this.state.busy || this.state.heartLoading) return false
		const context = this.player.read().fmContext
		if (action === 'start' ? !!context : !context) return false
		const revision = ++this.revision
		this.update({ busy: true, error: '' })
		let success = false
		try {
			success = await this.intent.run({
				preparation: this.player,
				onRequest: (owned) => {
					this.pageIntent = owned.isCurrent
					if (revision !== this.revision || !this.state.open) owned.cancel()
					else this.pending = owned
				},
				prepare: async () => {
					if (action === 'exit') return []
					const candidates = this.state.heartSelected ? this.state.candidates : this.store.fmCandidates([], 20)
					this.update({ candidates, candidateError: '' })
					if (!candidates.length)
						throw new Error('当前没有可用的本机候选，请先搜索或整理音乐库。')
					return candidates.map((item) => item.source)
				},
				activate: (sources, preparation) =>
					action === 'start'
						? this.player.startFm(sources, preparation)
						: this.player.exitFm(context!.id, preparation),
				onSuccess: () => {
					if (revision === this.revision && this.state.open) {
						this.update({ open: false })
						const target =
							context?.returnMode === 'music'
								? context.manualMusic
								: context?.returnListening
						opened(
							action === 'start' ||
								!!target?.tracks.some(
									(track) => track.id === target.currentEntryId,
								),
						)
					}
				},
			})
			if (!success)
				await this.publishError(
					revision,
					action === 'start'
						? '私人 FM 未能确认开始，请查看播放器或重试。'
						: '退出私人 FM 未能确认完成，请查看播放器或重试。',
				)
			return success
		} catch (error) {
			await this.publishError(
				revision,
				error instanceof Error ? error.message : '播放操作未完成，请重试',
			)
			return false
		} finally {
			// PlaybackIntent settles the owned preparation without invalidating its
			// completed token, so real failures can still be published correctly.
			if (revision === this.revision) {
				this.pending = null
				this.update({ busy: false })
			}
		}
	}
	private async publishError(revision: number, message: string) {
		const owned = this.pending
		if (!owned || revision !== this.revision || !this.state.open) return
		try {
			if (!(await owned.checkCurrent())) return
		} catch {
			return
		}
		if (
			revision === this.revision &&
			this.state.open &&
			this.pending === owned &&
			owned.isCurrent()
		)
			this.update({ error: message })
	}
	observe = async () => {
		// The temporary candidate does not retire the original FM context or refill attempt.
		if (this.player.read().auditionId) return
		if (this.state.open && !this.pageIntent()) this.close()
		const frame = this.player.read()
		const contextId = frame.fmContext?.id ?? null
		if (contextId !== this.state.contextId) {
			this.attempted = ''
			this.refillRequest = null
			this.update({
				contextId,
				returnMode: frame.fmContext?.returnMode ?? null,
				refill: 'idle',
				refillMessage: '',
			})
		}
		const selected = !!contextId && frame.mode === 'music'
		if (selected !== this.state.selected) this.update({ selected })
		await this.refill(false)
	}
	retryRefill = () => this.refill(true)
	private async refill(explicit: boolean): Promise<boolean> {
		const frame = this.player.read(),
			context = frame.fmContext
		if (
			frame.auditionId ||
			!context ||
			frame.mode !== 'music' ||
			frame.switching ||
			this.refillRequest ||
			frame.currentIndex < 0
		)
			return false
		if (!explicit && frame.queue.length - frame.currentIndex - 1 > 3)
			return false
		const tail = frame.queue.at(-1)?.id,
			entry = frame.queue[frame.currentIndex]?.id
		if (!tail || !entry) return false
		const key = JSON.stringify([context.id, tail, entry])
		if (!explicit && this.attempted === key) return false
		this.attempted = key
		if (frame.queue.length >= 5000) {
			this.update({
				refill: 'limit',
				refillMessage: '本次 FM 队列已达上限，当前内容结束后将停止。',
			})
			return false
		}
		const own = {}
		this.refillRequest = own
		this.update({ refill: 'loading', refillMessage: '' })
		const current = () =>
			this.refillRequest === own &&
			!this.player.read().auditionId &&
			this.player.read().fmContext?.id === context.id
		try {
			const excluded = frame.queue.map((item) => item.sourceId ?? item.id)
			const candidates = this.store.fmCandidates(
				excluded,
				Math.min(20, 5000 - frame.queue.length),
			)
			if (!candidates.length) {
				if (current())
					this.update({
						refill: 'empty',
						refillMessage: '暂时没有更多本机候选，当前内容结束后将停止。',
					})
				return false
			}
			const ok = await this.player.appendFm(
				candidates.map((item) => item.source),
				context.id,
				tail,
			)
			if (!current()) return false
			this.update(
				ok
					? {
							refill: 'added',
							refillMessage: `已补充 ${candidates.length} 首本机候选。`,
						}
					: {
							refill: 'blocked',
							refillMessage: '本次未补充队列，可稍后再检查本机候选。',
						},
			)
			return ok
		} catch (error) {
			if (current())
				this.update({
					refill: 'error',
					refillMessage:
						error instanceof Error ? error.message : '本机候选暂时无法补充',
				})
			return false
		} finally {
			if (this.refillRequest === own) this.refillRequest = null
		}
	}
}
