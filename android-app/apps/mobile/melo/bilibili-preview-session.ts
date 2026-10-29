import type { Source } from './core/model'
import type { ListeningVideo } from './listening-source'
import type { PlaybackRequest } from './playback-intent'

export interface PreviewPlayerIdentity {
	mode: 'music' | 'listening'
	sourceId: string | null
	entryId: string | null
}
export type BilibiliPreviewAction = (
	source: Source,
	mode: 'music' | 'listening',
	video: ListeningVideo,
	own: (request: PlaybackRequest) => void,
) => Promise<PreviewPlayerIdentity | null>

/** UI ownership only; uses the App's existing single PlaybackIntent and native player. */
export class BilibiliPreviewSession {
	private generation = 0
	private request: PlaybackRequest | null = null
	private binding: PreviewPlayerIdentity | null = null
	private state = { busy: false, suspended: false, error: '' }
	private listeners = new Set<() => void>()
	constructor(private readonly lost: () => void) {}
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
	cancel = () => {
		this.generation++
		if (this.state.busy) this.request?.cancel()
		this.request = null
		this.binding = null
		this.update({ busy: false, suspended: false, error: '' })
	}
	async play(
		source: Source,
		mode: 'music' | 'listening',
		video: ListeningVideo,
		action: BilibiliPreviewAction,
	): Promise<boolean> {
		if (this.state.busy) return false
		this.cancel()
		const generation = this.generation
		this.update({ busy: true })
		try {
			const actual = await action(source, mode, video, (request) => {
				if (generation !== this.generation) request.cancel()
				else this.request = request
			})
			if (generation !== this.generation || !actual) return false
			if (
				!this.request?.isCurrent() ||
				actual.mode !== mode ||
				actual.sourceId !== source.id ||
				!actual.entryId
			)
				throw new Error('播放器实际项目与本次试听不一致，请重新选择')
			this.binding = actual
			this.update({ busy: false, suspended: true })
			return true
		} catch (error) {
			if (generation === this.generation)
				this.update({
					error:
						error instanceof Error ? error.message : '试听失败，原确认未改动',
				})
			return false
		} finally {
			if (generation === this.generation) this.update({ busy: false })
		}
	}
	private matches(actual: PreviewPlayerIdentity): boolean {
		return (
			!!this.binding &&
			!!this.request?.isCurrent() &&
			this.binding.mode === actual.mode &&
			this.binding.sourceId === actual.sourceId &&
			this.binding.entryId === actual.entryId
		)
	}
	observe = (actual: PreviewPlayerIdentity) => {
		if (this.state.suspended && !this.matches(actual)) {
			this.cancel()
			this.lost()
		}
	}
	resume = (actual: PreviewPlayerIdentity): boolean => {
		if (!this.state.suspended) return false
		if (!this.matches(actual)) {
			this.cancel()
			this.lost()
			return false
		}
		this.binding = null
		this.request = null
		this.update({ suspended: false })
		return true
	}
	async observeCurrent(
		hint: PreviewPlayerIdentity,
		read: () => Promise<PreviewPlayerIdentity>,
	): Promise<void> {
		if (!this.state.suspended || this.matches(hint)) return
		const generation = this.generation,
			binding = this.binding
		try {
			const actual = await read()
			if (generation === this.generation && binding === this.binding)
				this.observe(actual)
		} catch (error) {
			if (generation === this.generation)
				this.update({
					error:
						error instanceof Error ? error.message : '暂时无法核对当前播放器',
				})
		}
	}
	async resumeCurrent(
		read: () => Promise<PreviewPlayerIdentity>,
	): Promise<boolean> {
		if (!this.state.suspended) return false
		const generation = this.generation,
			binding = this.binding
		try {
			const actual = await read()
			return generation === this.generation && binding === this.binding
				? this.resume(actual)
				: false
		} catch (error) {
			if (generation === this.generation)
				this.update({
					error:
						error instanceof Error ? error.message : '暂时无法核对当前播放器',
				})
			return false
		}
	}
}
