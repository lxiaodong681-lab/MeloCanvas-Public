import type { ListeningVideo } from './listening-source'

interface PartsPublisher {
	video: (video: ListeningVideo | null) => void
	loading: (loading: boolean) => void
	error: (error: string) => void
}
export class ListeningPartsOwner {
	private current: AbortController | null = null
	begin() {
		this.cancel()
		const request = new AbortController()
		this.current = request
		return {
			signal: request.signal,
			isCurrent: () => this.current === request && !request.signal.aborted,
			cancel: () => {
				if (this.current === request) this.cancel()
			},
		}
	}
	cancel() {
		this.current?.abort()
		this.current = null
	}
}

/** The actual automatic-effect publication path, including errors and finally ownership. */
export function readCurrentListeningParts(
	owner: ListeningPartsOwner,
	bvid: string,
	cache: Map<string, ListeningVideo>,
	load: (bvid: string, signal: AbortSignal) => Promise<ListeningVideo>,
	publish: PartsPublisher,
): () => void {
	const request = owner.begin()
	publish.video(null)
	publish.loading(true)
	publish.error('')
	void load(bvid, request.signal)
		.then((video) => {
			if (!request.isCurrent()) return
			cache.set(video.bvid, video)
			publish.video(video)
		})
		.catch((error: unknown) => {
			if (request.isCurrent())
				publish.error(
					error instanceof Error ? error.message : '无法读取分 P，请重试',
				)
		})
		.finally(() => {
			if (request.isCurrent()) publish.loading(false)
		})
	return request.cancel
}

/** Explicit playback was accepted: an older same-BV automatic read no longer owns publication. */
export function acceptExplicitListeningParts(
	owner: ListeningPartsOwner,
	cache: Map<string, ListeningVideo>,
	video: ListeningVideo,
	publish: PartsPublisher,
): void {
	owner.cancel()
	cache.set(video.bvid, video)
	publish.video(video)
	publish.error('')
	publish.loading(false)
}
