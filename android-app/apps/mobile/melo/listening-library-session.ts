import type { BilibiliRequest } from './bilibili'
import { BilibiliReadGate, readBilibiliView } from './bilibili-import-network'
import { BilibiliPreviewSession } from './bilibili-preview-session'
import type { SavedVideoItem, VideoSaveBucket } from './core/import-mixed-types'
import type { VideoCatalog } from './core/video-catalog'
import type { VideoSaves } from './core/video-saves'
import type { ListeningVideo } from './listening-source'

export class ListeningLibrarySession {
	readonly preview = new BilibiliPreviewSession(() => this.close())
	private state = {
		route: 'closed' as 'closed' | 'list' | 'item',
		bucket: 'listening' as VideoSaveBucket,
		items: [] as SavedVideoItem[],
		offset: 0,
		more: false,
		item: null as SavedVideoItem | null,
		video: null as ListeningVideo | null,
		selectedCid: null as number | null,
		error: '',
		notice: '',
		busy: false,
		transportBusy: false,
		playback: this.preview.getSnapshot(),
	}
	private listeners = new Set<() => void>()
	private generation = 0
	private controller: AbortController | null = null
	constructor(
		private saves: VideoSaves,
		private catalog: VideoCatalog,
		private load: (
			bvid: string,
			signal: AbortSignal,
		) => BilibiliRequest<ListeningVideo>,
		readonly gate: BilibiliReadGate,
	) {
		this.gate.subscribe(() =>
			this.update({ transportBusy: this.gate.getSnapshot() }),
		)
		this.preview.subscribe(() =>
			this.update({ playback: this.preview.getSnapshot() }),
		)
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
	private invalidate() {
		this.generation++
		this.controller?.abort()
		this.controller = null
		this.preview.cancel()
	}
	reportError = (error: unknown) =>
		this.update({
			error:
				error instanceof Error ? error.message : '本地收藏读取失败，记录保留',
		})
	close = () => {
		this.invalidate()
		this.update({ route: 'closed', busy: false })
	}
	open = (bucket: VideoSaveBucket = 'listening', offset = 0) => {
		this.invalidate()
		this.update({
			route: 'list',
			items: [],
			more: false,
			bucket,
			item: null,
			video: null,
			selectedCid: null,
			offset,
			busy: false,
			error: '',
			notice: '',
		})
		try {
			const page = this.saves.list(bucket, { offset, limit: 21 })
			this.update({ items: page.slice(0, 20), more: page.length > 20 })
		} catch (error) {
			this.reportError(error)
		}
	}
	back = () =>
		this.state.route === 'item'
			? this.open(this.state.bucket, this.state.offset)
			: this.close()
	next = () => {
		if (this.state.more) this.open(this.state.bucket, this.state.offset + 20)
	}
	previous = () =>
		this.open(this.state.bucket, Math.max(0, this.state.offset - 20))
	openItem = (itemId: string) => {
		this.invalidate()
		this.update({
			route: 'item',
			item: null,
			video: null,
			selectedCid: null,
			busy: false,
			error: '',
			notice: '',
		})
		try {
			const item = this.saves.get(itemId)
			if (!item) throw new Error('该本地收藏已移除，导入历史仍保留')
			this.update({ item })
			const cached = item.bvid ? this.catalog.get(item.bvid) : null
			const visited = cached?.lastVisited
			this.update({
				item,
				video: cached,
				selectedCid: visited?.inCurrentParts
					? cached!.parts.find((part) => part.source.id === visited.sourceId)!
							.source.cid
					: null,
				notice:
					visited && !visited.inCurrentParts
						? '最后访问分 P 已不在当前目录，原音源和进度保留，请明确重选。'
						: '',
			})
		} catch (error) {
			this.reportError(error)
		}
	}
	async readVideo() {
		const bvid = this.state.item?.bvid
		if (!bvid || this.state.busy || this.gate.getSnapshot()) return false
		this.controller?.abort()
		const generation = ++this.generation,
			controller = new AbortController()
		this.controller = controller
		this.update({ busy: true, error: '' })
		try {
			const video = await readBilibiliView(
				this.gate,
				this.load,
				bvid,
				controller.signal,
			)
			if (generation !== this.generation) return false
			if (video.bvid !== bvid) throw new Error('返回的原视频身份不一致')
			this.catalog.save(video, Date.now())
			const itemId = this.state.item!.itemId
			this.openItem(itemId)
			return true
		} catch (error) {
			if (generation === this.generation) this.reportError(error)
			return false
		} finally {
			if (generation === this.generation) this.update({ busy: false })
		}
	}
	selectCid = (cid: number) => {
		if (this.state.video?.parts.some((part) => part.source.cid === cid)) {
			this.preview.cancel()
			this.update({ selectedCid: cid, error: '' })
		}
	}
	selectedSource = () =>
		this.state.video?.parts.find(
			(part) => part.source.cid === this.state.selectedCid,
		)?.source ?? null
	remove = () => {
		if (!this.state.item) return false
		try {
			this.saves.remove(this.state.item.itemId)
			this.open(this.state.bucket, this.state.offset)
			return true
		} catch (error) {
			this.reportError(error)
			return false
		}
	}
}
export type ListeningLibraryState = ReturnType<
	ListeningLibrarySession['getSnapshot']
>
