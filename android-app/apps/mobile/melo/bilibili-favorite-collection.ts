import {
	BilibiliFavoriteReadError,
	readBilibiliFavoritePage,
	type BilibiliFavoritePage,
	type BilibiliFavoriteTransport,
	type FavoriteReadErrorCode,
} from './bilibili-favorite'
import {
	readBilibiliFavoriteIndex,
	type BilibiliFavoriteIndex,
	type BilibiliFavoriteIndexTransport,
} from './bilibili-favorite-index'
import type { ImportDirectoryEntry, ImportDirectorySnapshot } from './core/import-types'
import { directory, id, integer } from './core/import-validation'

export interface FavoriteCollectionIdentity {
	favoriteId: string
	taskId: string
	taskVersion: number
}
export interface FavoriteCollectionError {
	code: FavoriteReadErrorCode | 'busy'
	message: string
	details?: BilibiliFavoriteReadError
}
export interface FavoriteCollectionState {
	phase: 'idle' | 'loading' | 'partial' | 'complete' | 'cancelled' | 'error'
	identity: FavoriteCollectionIdentity | null
	loading: boolean
	/** Real transport settlement, independent of cancellation/timeout of the waiter. */
	transportBusy: boolean
	pages: BilibiliFavoritePage[]
	loadedCount: number
	reportedTotal: number | null
	indexCount: number | null
	missingDetailCount: number
	restartRequired: boolean
	error: FavoriteCollectionError | null
	/** Only a fully reconciled directory; partial pages are not a saved task. */
	directory: ImportDirectorySnapshot | null
}
function initial(): FavoriteCollectionState {
	return {
		phase: 'idle',
		identity: null,
		loading: false,
		transportBusy: false,
		pages: [],
		loadedCount: 0,
		reportedTotal: null,
		indexCount: null,
		missingDetailCount: 0,
		restartRequired: false,
		error: null,
		directory: null,
	}
}
function freeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freeze(child)
		Object.freeze(value)
	}
	return value
}
function validIdentity(
	input: FavoriteCollectionIdentity,
): FavoriteCollectionIdentity {
	id(input.taskId)
	integer(input.taskVersion, 1)
	if (
		typeof input.favoriteId !== 'string' ||
		!/^[1-9][0-9]{0,127}$/.test(input.favoriteId)
	)
		throw new Error('收藏夹身份无效')
	return {
		favoriteId: input.favoriteId,
		taskId: input.taskId,
		taskVersion: input.taskVersion,
	}
}
function candidate(
	identity: FavoriteCollectionIdentity,
	pages: BilibiliFavoritePage[],
	index: BilibiliFavoriteIndex | null,
) {
	const last = pages[pages.length - 1]
	return directory({
		taskId: identity.taskId,
		taskVersion: identity.taskVersion,
		provider: 'bilibili',
		originalPlaylistId: identity.favoriteId,
		originalMetadata: {
			positionBasis: index ? 'resource-index-order' : 'observed-page-order',
			completeness: last.hasMore ? 'incomplete' : 'complete',
			reportedTotal: last.reportedTotal,
			observedCount: pages.reduce(
				(count, page) => count + (page.indexEntries?.length ?? page.items.length),
				0,
			),
			...(index ? {
				resourceIndex: {
					originalEnvelope: index.originalEnvelope,
					items: index.items.map((item) => item.original),
				},
				missingDetailCount: pages.reduce(
					(count, accepted) => count + (accepted.indexEntries?.length ?? accepted.items.length) - accepted.items.length, 0,
				),
			} : {}),
			pages: pages.map((page) => ({
				page: page.page,
				pageSize: page.pageSize,
				reportedTotal: page.reportedTotal,
				hasMore: page.hasMore,
				info: page.info,
				originalEnvelope: page.originalEnvelope,
				originalData: page.originalData,
			})),
		},
		entries: pages.flatMap<ImportDirectoryEntry>((page) => page.indexEntries ?
			page.indexEntries.map<ImportDirectoryEntry>((slot) => {
				const item = page.items.find((value) => value.indexPosition === slot.position)
				return {
					entryId: `index:${slot.position}`,
					originalEntryId: slot.mediaIdentity,
					originalPosition: slot.position,
					originalMetadata: {
						resourceIndex: slot.original,
						...(item ? { media: item.original } : { detailState: 'not-returned' }),
						observed: {
							page: page.page,
							pageIndex: item?.pageIndex ?? null,
							indexPosition: slot.position,
							mediaId: slot.mediaId,
							mediaType: slot.mediaType,
							mediaIdentity: slot.mediaIdentity,
							bvid: item?.bvid ?? null,
						},
					},
				}
			}) : page.items.map((item) => ({
				entryId: `page:${page.page}:item:${item.pageIndex}`,
				originalEntryId: item.mediaIdentity,
				originalPosition: (page.page - 1) * 40 + item.pageIndex,
				originalMetadata: {
					media: item.original,
					observed: {
						page: page.page,
						pageIndex: item.pageIndex,
						mediaId: item.mediaId,
						mediaType: item.mediaType,
						mediaIdentity: item.mediaIdentity,
						bvid: item.bvid,
					},
				},
			})),
		),
	}).snapshot
}

/** In-memory, explicit one-page actions. No automatic retry, pagination or persistence. */
export class BilibiliFavoriteCollectionSession {
	private state = freeze(initial())
	private listeners = new Set<() => void>()
	private active: AbortController | null = null
	private busy = false
	private index: BilibiliFavoriteIndex | null = null
	private indexTransport: BilibiliFavoriteIndexTransport | undefined
	constructor(private readonly transport: BilibiliFavoriteTransport) {}
	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private update(change: Partial<FavoriteCollectionState>) {
		this.state = freeze({ ...this.state, ...change })
		for (const listener of this.listeners) listener()
	}
	private available() {
		if (!this.busy && !this.state.loading) return true
		this.update({
			error: {
				code: 'busy',
				message: '上一收藏页请求尚未结束，请等待后显式重试',
			},
		})
		return false
	}
	start = async (
		input: FavoriteCollectionIdentity,
		indexTransport?: BilibiliFavoriteIndexTransport,
	): Promise<boolean> => {
		let identity: FavoriteCollectionIdentity
		try {
			identity = validIdentity(input)
		} catch (error) {
			this.update({
				error: {
					code: 'invalid-input',
					message: error instanceof Error ? error.message : '收藏任务身份无效',
				},
			})
			return false
		}
		if (!this.available()) return false
		this.index = null
		this.indexTransport = indexTransport
		this.state = freeze({ ...initial(), identity })
		return this.read(1)
	}
	next = async (): Promise<boolean> => {
		if (!this.available()) return false
		if (
			!this.state.identity ||
			this.state.directory ||
			this.state.restartRequired
		)
			return false
		return this.read(this.state.pages.length + 1)
	}
	cancel = (): void => {
		const active = this.active
		if (!active) return
		this.active = null
		active.abort()
		this.update({ phase: 'cancelled', loading: false, error: null })
	}
	/** Forget private in-memory pages without releasing an unsettled raw request. */
	clear = (): void => {
		this.active?.abort()
		this.active = null
		this.index = null
		this.indexTransport = undefined
		this.update({ ...initial(), transportBusy: this.busy })
	}
	private async read(pageNumber: number): Promise<boolean> {
		const identity = this.state.identity!
		const active = new AbortController()
		this.active = active
		// Reserve admission before notifying listeners or invoking caller-controlled transport.
		this.busy = true
		this.update({
			phase: 'loading',
			loading: true,
			transportBusy: true,
			error: null,
		})
		let started = false
		const release = () => {
			this.busy = false
			this.update({ transportBusy: false })
		}
		const run = (signal: AbortSignal, operation: () => Promise<Uint8Array>) => {
			started = true
			this.busy = true
			this.update({ transportBusy: true })
			return Promise.resolve().then(() => {
				if (signal.aborted)
					throw new BilibiliFavoriteReadError('cancelled', '收藏页读取已取消')
				return operation()
			}).finally(release)
		}
		try {
			if (!this.index && this.indexTransport) {
				const transport = this.indexTransport
				const index = await readBilibiliFavoriteIndex(
					{ favoriteId: identity.favoriteId, signal: active.signal },
					(request, signal) => run(signal, () => transport(request, signal)),
				)
				if (this.active !== active || active.signal.aborted) return false
				this.index = index
				this.update({ indexCount: index.items.length })
			}
			const page = await readBilibiliFavoritePage(
				{ ...identity, page: pageNumber, signal: active.signal, index: this.index ?? undefined },
				(request, signal) => run(signal, () => this.transport(request, signal)),
			)
			if (this.active !== active || active.signal.aborted) return false
			if (
				page.favoriteId !== identity.favoriteId ||
				page.page !== pageNumber ||
				(this.state.reportedTotal !== null &&
					page.reportedTotal !== this.state.reportedTotal)
			) {
				throw new BilibiliFavoriteReadError(
					'incomplete',
					'收藏夹身份、页序或报告总数改变，请重新开始收集',
					{},
					{
						favoriteId: page.favoriteId,
						page: page.page,
						pageSize: 40,
						originalEnvelope: page.originalEnvelope,
						originalData: {
							...page.originalData,
							info: page.info,
							medias: page.items.map((item) => item.original),
						},
					},
				)
			}
			const pages = [...this.state.pages, page]
			let value: ImportDirectorySnapshot
			try {
				value = candidate(identity, pages, this.index)
			} catch (error) {
				throw new BilibiliFavoriteReadError(
					'limit',
					error instanceof Error ? error.message : '收藏目录包装后超过保存预算',
				)
			}
			this.active = null
			this.update({
				pages,
				loading: false,
				loadedCount: value.entries.length,
				missingDetailCount: pages.reduce(
					(count, accepted) => count + (accepted.indexEntries?.length ?? accepted.items.length) - accepted.items.length, 0,
				),
				reportedTotal: page.reportedTotal,
				phase: page.hasMore ? 'partial' : 'complete',
				directory: page.hasMore ? null : value,
				error: null,
			})
			return true
		} catch (error) {
			if (this.active !== active || active.signal.aborted) return false
			const failure =
				error instanceof BilibiliFavoriteReadError
					? error
					: new BilibiliFavoriteReadError('network', '收藏目录读取失败')
			const info = failure.partial?.originalData.info
			const changedIdentity =
				info &&
				typeof info === 'object' &&
				!Array.isArray(info) &&
				(typeof info.id === 'number' ? String(info.id) : info.id) !==
					identity.favoriteId
			this.active = null
			this.update({
				phase: 'error',
				loading: false,
				restartRequired:
					failure.code === 'incomplete' || Boolean(changedIdentity),
				error: {
					code: failure.code,
					message: failure.message,
					details: failure,
				},
			})
			return false
		} finally {
			if (!started) release()
			if (this.active === active) {
				this.active = null
				this.update({ loading: false })
			}
		}
	}
}
