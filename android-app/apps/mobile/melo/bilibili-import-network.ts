import type { BilibiliRequest } from './bilibili'
import type { ListeningVideo } from './listening-source'

/** Shared by the two Bili workflows. Release belongs to the actual body Promise. */
export class BilibiliReadGate {
	private busy = false
	private listeners = new Set<() => void>()
	getSnapshot = () => this.busy
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private notify() {
		for (const listener of this.listeners) listener()
	}
	async run<T>(action: () => Promise<T> | BilibiliRequest<T>): Promise<T> {
		if (this.busy) throw new Error('上一 B站请求尚未真正结束，请等待后再操作')
		this.busy = true
		this.notify()
		let released = false,
			tracksSettlement = false
		const release = () => {
			if (released) return
			released = true
			this.busy = false
			this.notify()
		}
		try {
			const read = action()
			if ('settled' in read) {
				tracksSettlement = true
				// Either receipt outcome releases admission; consume rejection without
				// replacing result's error. Production receipts fulfill on raw failure too.
				void read.settled.then(release, release).catch(() => {})
				return await read.result
			}
			return await read
		} finally {
			if (!tracksSettlement) release()
		}
	}
}

/** Only waiting ends on abort/timeout; gate release follows the raw-settlement receipt. */
export async function readBilibiliView(
	gate: BilibiliReadGate,
	load: (bvid: string, signal: AbortSignal) => BilibiliRequest<ListeningVideo>,
	bvid: string,
	signal: AbortSignal,
): Promise<ListeningVideo> {
	if (signal.aborted) throw new Error('已取消读取视频')
	const controller = new AbortController()
	const abort = () => controller.abort()
	signal.addEventListener('abort', abort, { once: true })
	let rejectAbort!: () => void,
		timedOut = false
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = () =>
			reject(
				new Error(
					timedOut ? '读取原视频超时，请稍后显式重试' : '已取消读取视频',
				),
			)
		controller.signal.addEventListener('abort', rejectAbort, { once: true })
	})
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, 30000)
	try {
		return await Promise.race([
			gate.run(() => load(bvid, controller.signal)),
			aborted,
		])
	} finally {
		clearTimeout(timer)
		signal.removeEventListener('abort', abort)
		controller.signal.removeEventListener('abort', rejectAbort)
	}
}
