import type { AccountSession } from './account-session'
import {
	BilibiliSubtitleError,
	type BilibiliSubtitleProvider,
	type SubtitleDocument,
	type SubtitleFailure,
	type SubtitleLine,
	type SubtitleTarget,
	type SubtitleTrack,
} from './bilibili-subtitles'

type Account = Pick<
	AccountSession,
	'getSnapshot' | 'getGeneration' | 'subscribe'
>
type Provider = Pick<
	BilibiliSubtitleProvider,
	'discover' | 'load' | 'invalidate'
>
export type ListeningSubtitleFailure =
	| SubtitleFailure
	| 'offline'
	| 'missing-target'
export interface ListeningSubtitlesSnapshot {
	target: SubtitleTarget | null
	status:
		| 'idle'
		| 'loading-tracks'
		| 'choice'
		| 'loading'
		| 'ready'
		| 'no-tracks'
		| 'error'
	tracks: SubtitleTrack[]
	selectedTrackId: string | null
	document: SubtitleDocument | null
	error: ListeningSubtitleFailure | null
}
const sameTarget = (a: SubtitleTarget | null, b: SubtitleTarget | null) =>
	a?.bvid === b?.bvid && a?.cid === b?.cid && a?.page === b?.page
const empty = (target: SubtitleTarget | null): ListeningSubtitlesSnapshot => ({
	target: target ? { ...target } : null,
	status: 'idle',
	tracks: [],
	selectedTrackId: null,
	document: null,
	error: null,
})

/** A user-opened, in-memory companion to the existing listening playback session.
 * Closing the sheet retains a loaded track; P/account changes discard its data.
 */
export class ListeningSubtitlesSession {
	private state = empty(null)
	private listeners = new Set<() => void>()
	private request: AbortController | null = null
	private provider: Provider
	private unsubscribe: (() => void) | null = null
	private accountGeneration: number
	private visible = false
	private disposed = false
	constructor(
		private readonly account: Account,
		createProvider: (getTarget: () => SubtitleTarget | null) => Provider,
	) {
		this.accountGeneration = account.getGeneration()
		this.provider = createProvider(() => this.state.target)
	}
	getSnapshot = (): ListeningSubtitlesSnapshot => this.state
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private emit(state: ListeningSubtitlesSnapshot) {
		this.state = state
		this.listeners.forEach((listener) => listener())
	}
	private abort() {
		this.request?.abort()
		this.request = null
	}
	private accessFailure(): ListeningSubtitleFailure | null {
		const status = this.account.getSnapshot().status
		return status === 'authenticated'
			? null
			: status === 'offline'
				? 'offline'
				: 'login-required'
	}
	private changedAccount = () => {
		const generation = this.account.getGeneration()
		const failure = this.accessFailure()
		if (generation === this.accountGeneration && !failure) return
		this.accountGeneration = generation
		this.abort()
		this.provider.invalidate()
		this.emit({
			...empty(this.state.target),
			status: failure || this.visible ? 'error' : 'idle',
			error: failure ?? (this.visible ? 'stale' : null),
		})
	}
	setTarget(target: SubtitleTarget | null): void {
		if (this.disposed || sameTarget(this.state.target, target)) return
		this.abort()
		this.provider.invalidate()
		this.emit(empty(target))
		if (this.visible) void this.discover()
	}
	async open(target: SubtitleTarget | null): Promise<void> {
		if (this.disposed) return
		this.unsubscribe ??= this.account.subscribe(this.changedAccount)
		this.visible = false
		this.setTarget(target)
		this.visible = true
		if (this.accountGeneration !== this.account.getGeneration())
			this.changedAccount()
		if (
			this.accessFailure() ||
			!target ||
			['idle', 'error'].includes(this.state.status)
		)
			await this.discover()
	}
	hide(): void {
		this.visible = false
		this.abort()
		if (this.state.status === 'loading-tracks')
			this.emit(empty(this.state.target))
		else if (this.state.status === 'loading')
			this.emit({ ...this.state, status: 'choice', error: null })
	}
	dispose(): void {
		this.hide()
		this.disposed = true
		this.provider.invalidate()
		this.unsubscribe?.()
		this.unsubscribe = null
		this.state = empty(null)
		this.listeners.clear()
	}
	private current(request: AbortController): boolean {
		return (
			!this.disposed &&
			this.visible &&
			this.request === request &&
			!request.signal.aborted
		)
	}
	private failure(error: unknown): ListeningSubtitleFailure {
		return (
			this.accessFailure() ??
			(error instanceof BilibiliSubtitleError ? error.reason : 'unavailable')
		)
	}
	async discover(): Promise<void> {
		if (this.disposed || !this.visible) return
		this.abort()
		const target = this.state.target
		const failure = this.accessFailure() ?? (!target ? 'missing-target' : null)
		if (failure || !target) {
			this.provider.invalidate()
			this.emit({ ...empty(target), status: 'error', error: failure })
			return
		}
		const request = new AbortController()
		this.request = request
		this.emit({ ...empty(target), status: 'loading-tracks' })
		try {
			const result = await this.provider.discover(target, request.signal)
			if (!this.current(request)) return
			this.emit({
				...empty(target),
				status: result.tracks.length ? 'choice' : 'no-tracks',
				tracks: result.tracks,
			})
		} catch (error) {
			if (this.current(request))
				this.emit({
					...empty(target),
					status: 'error',
					error: this.failure(error),
				})
		} finally {
			if (this.request === request) this.request = null
		}
	}
	showTracks(): void {
		if (this.disposed || !this.state.tracks.length) return
		this.abort()
		this.emit({ ...this.state, status: 'choice', error: null })
	}
	async selectTrack(id: string): Promise<void> {
		if (
			this.disposed ||
			!this.visible ||
			this.accessFailure() ||
			!this.state.tracks.some((track) => track.id === id)
		)
			return
		this.abort()
		if (this.state.document?.track.id === id) {
			this.emit({
				...this.state,
				selectedTrackId: id,
				status: 'ready',
				error: null,
			})
			return
		}
		const request = new AbortController()
		this.request = request
		this.emit({
			...this.state,
			status: 'loading',
			selectedTrackId: id,
			document: null,
			error: null,
		})
		try {
			const document = await this.provider.load(id, request.signal)
			if (!this.current(request)) return
			this.emit({ ...this.state, status: 'ready', document, error: null })
		} catch (error) {
			if (this.current(request))
				this.emit({
					...this.state,
					status: 'error',
					document: null,
					error: this.failure(error),
				})
		} finally {
			if (this.request === request) this.request = null
		}
	}
	async retry(): Promise<void> {
		if (
			this.state.selectedTrackId &&
			this.state.tracks.length &&
			!this.accessFailure()
		)
			await this.selectTrack(this.state.selectedTrackId)
		else await this.discover()
	}
	/** Reject a retained row callback after P change, account change or panel close. */
	seekPosition(line: SubtitleLine): number | null {
		const doc = this.state.document
		return this.visible &&
			this.state.status === 'ready' &&
			!this.accessFailure() &&
			doc &&
			doc.generation === this.account.getGeneration() &&
			sameTarget(doc.target, this.state.target) &&
			doc.lines.includes(line)
			? line.startMs / 1000
			: null
	}
}
