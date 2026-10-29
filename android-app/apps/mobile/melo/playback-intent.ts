import type { Source } from './core/model'

export interface PlaybackPreparation {
	token: number
}
export interface PlaybackPreparationPort {
	reservePlayback(): Promise<PlaybackPreparation>
	isPreparationCurrent(preparation: PlaybackPreparation): Promise<boolean>
	cancelPreparation(preparation: PlaybackPreparation): Promise<void>
	/** Complete only this token's pending work, without invalidating successful publication. */
	finishPreparation?(preparation: PlaybackPreparation): Promise<void>
}

export interface PlaybackRequest {
	signal: AbortSignal
	isCurrent: () => boolean
	checkCurrent: () => Promise<boolean>
	cancel: () => boolean
}

export function playMusicIntent<T extends { bvid: string }>(
	intent: PlaybackIntent,
	item: T,
	actions: {
		resolve: (item: T, signal: AbortSignal) => Promise<Source>
		preparation: PlaybackPreparationPort
		activate: (
			source: Source,
			preparation: PlaybackPreparation,
		) => Promise<boolean>
		onPending: (bvid: string) => void
		onStarted: () => void
		onRequest?: (request: PlaybackRequest) => void
	},
): Promise<boolean> {
	return intent.run({
		onRequest: actions.onRequest,
		preparation: actions.preparation,
		prepare: async (signal) => {
			actions.onPending(item.bvid)
			const aborted = () => actions.onPending('')
			signal.addEventListener('abort', aborted)
			try {
				return await actions.resolve(item, signal)
			} finally {
				signal.removeEventListener('abort', aborted)
				if (!signal.aborted) actions.onPending('')
			}
		},
		activate: actions.activate,
		onSuccess: actions.onStarted,
	})
}

/** One user playback intent spans metadata resolution and native activation. */
export class PlaybackIntent {
	private controller: AbortController | null = null
	private revision = 0

	captureCurrent(): () => boolean {
		const revision = this.revision
		return () => revision === this.revision
	}

	begin(): PlaybackRequest {
		this.revision++
		this.controller?.abort()
		const controller = new AbortController()
		this.controller = controller
		return {
			signal: controller.signal,
			cancel: () => {
				if (this.controller !== controller || controller.signal.aborted)
					return false
				this.revision++
				controller.abort()
				this.controller = null
				return true
			},
			isCurrent: () =>
				this.controller === controller && !controller.signal.aborted,
			checkCurrent: async () =>
				this.controller === controller && !controller.signal.aborted,
		}
	}

	cancel(): void {
		this.revision++
		this.controller?.abort()
		this.controller = null
	}

	async run<T>({
		preparation,
		prepare,
		activate,
		onSuccess,
		onRequest,
	}: {
		preparation: PlaybackPreparationPort
		prepare: (
			signal: AbortSignal,
			preparation: PlaybackPreparation,
		) => Promise<T>
		activate: (target: T, preparation: PlaybackPreparation) => Promise<boolean>
		onSuccess: (target: T) => void
		onRequest?: (request: PlaybackRequest) => void
	}): Promise<boolean> {
		const request = this.begin()
		let reserved: PlaybackPreparation | null = null
		let finished = false
		const finish = async () => {
			if (finished || !reserved) return
			finished = true
			try {
				await preparation.finishPreparation?.(reserved)
			} catch {
				// The actual player records cleanup failure separately. Preserve the
				// original metadata/native error, then recheck publication ownership.
			}
		}
		const abort = () => {
			if (reserved) void preparation.cancelPreparation(reserved).catch(() => {})
		}
		const current = async () => {
			if (!request.isCurrent() || !reserved) return false
			if (await preparation.isPreparationCurrent(reserved))
				return request.isCurrent()
			request.cancel()
			return false
		}
		request.checkCurrent = current
		request.signal.addEventListener('abort', abort)
		try {
			onRequest?.(request)
			if (!request.isCurrent()) return false
			reserved = await preparation.reservePlayback()
			if (!request.isCurrent()) {
				await preparation.cancelPreparation(reserved)
				return false
			}
			if (!(await current())) return false
			const target = await prepare(request.signal, reserved)
			if (!(await current())) return false
			const success = await activate(target, reserved)
			await finish()
			// This final native query is the publication linearization point, not an
			// atomic transaction spanning later native controls and React rendering.
			if (!(await current())) return false
			if (success) onSuccess(target)
			return success
		} catch (error) {
			await finish()
			if (!request.isCurrent()) return false
			if (reserved && !(await current())) return false
			throw error
		} finally {
			request.signal.removeEventListener('abort', abort)
			if (!finished) await finish()
		}
	}
}
