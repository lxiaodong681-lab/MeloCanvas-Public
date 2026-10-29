import type {
	AccountFavoriteIdentity,
	AccountFavoritesPort,
} from './account-favorites'
import type { BilibiliRequest } from './bilibili'
import type { BilibiliFavoriteTransport } from './bilibili-favorite'
import type { BilibiliFavoriteIndexTransport } from './bilibili-favorite-index'
import { BilibiliFavoriteCollectionSession } from './bilibili-favorite-collection'
import {
	readBilibiliFavoriteFolders,
	type BilibiliFavoriteFolders,
	type BilibiliFavoriteFoldersTransport,
} from './bilibili-favorite-folders'
import { BilibiliReadGate, readBilibiliView } from './bilibili-import-network'
import { BilibiliPreviewSession } from './bilibili-preview-session'
import { BilibiliApiError } from './bilibili-request-error'
import type { Library } from './core/database'
import type {
	ContentKind,
	FavoritePlaylistDefault,
	MixedCommitReceipt,
	MixedCommitRequest,
	MixedImportTaskDetail,
	SavedVideoItem,
} from './core/import-mixed-types'
import { originalVideoBvid } from './core/import-mixed-validation'
import type {
	ImportOrganizationReceipt,
	ImportOrganizationRequest,
} from './core/import-organization-types'
import type { ImportPlaylistTarget } from './core/import-playlist-types'
import { ImportConflictError, type ImportTaskEntry } from './core/import-types'
import type { ImportStore } from './core/imports'
import type { Source } from './core/model'
import type {
	Playlist,
	PlaylistDuplicatePolicy,
	PlaylistStore,
} from './core/playlists'
import type { VideoCatalog } from './core/video-catalog'
import type { VideoSaves } from './core/video-saves'
import type { ListeningVideo } from './listening-source'
import { importEntryDescription, importTaskDescription } from './import-display'

export interface FavoritePlaylistProgress {
	phase: 'reading' | 'loading' | 'paused' | 'done'
	title: string
	total: number
	processed: number
	skipped: number
	unavailable: { entryId: string; title: string; reason: string }[]
	playlistId: string | null
}

export interface BilibiliImportPorts {
	account?: AccountFavoritesPort
	folders: BilibiliFavoriteFoldersTransport
	page: BilibiliFavoriteTransport
	index?: BilibiliFavoriteIndexTransport
	video: (bvid: string, signal: AbortSignal) => BilibiliRequest<ListeningVideo>
}
const localId = () =>
	`bili-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
export function processedBilibiliEntries(
	task: MixedImportTaskDetail,
): Set<string> {
	return new Set(
		task.history.flatMap((event) =>
			event.receipt.results.map((result) => result.entryId),
		),
	)
}
function favoriteVideoEntry(entry: ImportTaskEntry): boolean {
	const observed = entry.originalMetadata.observed
	const media = entry.originalMetadata.media
	const observedType = observed && typeof observed === 'object' && !Array.isArray(observed) ? observed.mediaType : undefined
	const type = observedType ?? (media && typeof media === 'object' && !Array.isArray(media) ? media.type : undefined)
	return typeof type !== 'number' || type === 2
}
export class BilibiliImportSession {
	readonly collector: BilibiliFavoriteCollectionSession
	readonly preview = new BilibiliPreviewSession(() => this.close())
	private state = {
		route: 'closed' as
			| 'closed'
			| 'folders'
			| 'collection'
			| 'task'
			| 'entry'
			| 'destination'
			| 'result'
			| 'organization'
			| 'organized',
		mid: '',
		folderAccess: 'public' as 'public' | 'account',
		folderAccount: null as AccountFavoriteIdentity | null,
		mineAvailable: false,
		folders: null as BilibiliFavoriteFolders | null,
		favoriteId: '',
		task: null as MixedImportTaskDetail | null,
		entryId: null as string | null,
		video: null as ListeningVideo | null,
		selectedCid: null as number | null,
		playlists: [] as Playlist[],
		command: null as MixedCommitRequest | null,
		receipt: null as MixedCommitReceipt | null,
		busy: false,
		error: '',
		notice: '',
		binding: null as {
			playlistId: string
			itemId: string
			sourceId: string | null
			updatedAt: number
		} | null,
		organizationItem: null as SavedVideoItem | null,
		organizationCommand: null as ImportOrganizationRequest | null,
		organizationReceipt: null as ImportOrganizationReceipt | null,
		page: 0,
		transportBusy: false,
		quick: null as FavoritePlaylistProgress | null,
		collection: null as ReturnType<
			BilibiliFavoriteCollectionSession['getSnapshot']
		> | null,
		playback: this.preview.getSnapshot(),
	}
	private listeners = new Set<() => void>()
	private generation = 0
	private controller: AbortController | null = null
	private unsubscribeAccount: (() => void) | null = null
	private scrollOffsets = new Map<string, number>()
	constructor(
		private store: ImportStore,
		private library: Library,
		private playlists: PlaylistStore,
		private catalog: VideoCatalog,
		private saves: VideoSaves,
		private ports: BilibiliImportPorts,
		readonly gate = new BilibiliReadGate(),
		private id = localId,
	) {
		this.state = { ...this.state, mineAvailable: Boolean(ports.account) }
		this.collector = new BilibiliFavoriteCollectionSession(
			(request, signal) => {
				if (!this.checkAccountRead())
					return Promise.reject(new Error('账号已变更，请重新读取收藏夹'))
				const read =
					this.state.folderAccess === 'account'
						? this.ports.account!.page
						: this.ports.page
				return this.gate.run(() => read(request, signal))
			},
		)
		this.gate.subscribe(() =>
			this.update({ transportBusy: this.gate.getSnapshot() }),
		)
		this.collector.subscribe(() =>
			this.update({ collection: this.collector.getSnapshot() }),
		)
		this.preview.subscribe(() =>
			this.update({ playback: this.preview.getSnapshot() }),
		)
	}
	getSnapshot = () => this.state
	rememberScroll = (key: string, offset: number) => {
		if (Number.isFinite(offset) && offset >= 0) this.scrollOffsets.set(key, offset)
	}
	scrollOffset = (key: string) => this.scrollOffsets.get(key) ?? 0
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
		this.collector.cancel()
		this.preview.cancel()
	}
	private navigate(change: Partial<typeof this.state>) {
		this.invalidate()
		this.update({
			busy: false,
			error: '',
			notice: '',
			command: null,
			organizationCommand: null,
			quick: null,
			...change,
		})
	}
	private leaveAccountRead() {
		this.unsubscribeAccount?.()
		this.unsubscribeAccount = null
		if (this.state.folderAccess === 'account') this.collector.clear()
	}
	private accountReadCurrent(): boolean {
		const owner = this.state.folderAccount
		const now = this.ports.account?.getIdentity()
		return (
			!!owner && now?.mid === owner.mid && now.generation === owner.generation
		)
	}
	private accountChanged = () => {
		if (this.state.folderAccess !== 'account' || this.accountReadCurrent())
			return
		this.leaveAccountRead()
		this.scrollOffsets.clear()
		this.invalidate()
		this.update({
			route: 'folders',
			folders: null,
			folderAccount: null,
			favoriteId: '',
			collection: null,
			task: null,
			entryId: null,
			video: null,
			busy: false,
			error: '账号已变更，请联网核验后重新读取我的收藏夹',
			notice: '',
			quick: null,
		})
	}
	private checkAccountRead(): boolean {
		if (this.state.folderAccess !== 'account' || this.accountReadCurrent())
			return true
		this.accountChanged()
		return false
	}
	reportError = (error: unknown) =>
		this.update({
			error: error instanceof Error ? error.message : '操作失败，原记录保留',
		})
	private failure(error: unknown) {
		if (error instanceof ImportConflictError) {
			this.update({
				command: null,
				organizationCommand: null,
				organizationItem: null,
				binding: null,
			})
			try {
				if (this.state.task)
					this.update({
						task: this.store.getMixed(this.state.task.taskId),
						route: 'task',
					})
			} catch {
				/* Keep visible evidence. */
			}
		}
		this.reportError(error)
	}
	open = () => {
		this.leaveAccountRead()
		this.navigate({
			route: 'folders',
			folderAccess: 'public',
			folderAccount: null,
			folders: null,
			favoriteId: '',
			task: null,
			entryId: null,
			receipt: null,
		})
	}
	close = () => {
		this.leaveAccountRead()
		this.scrollOffsets.clear()
		this.navigate({
			route: 'closed',
			folderAccess: 'public',
			folderAccount: null,
			folders: null,
			collection: null,
		})
	}
	back = () => {
		if (this.state.route === 'organization') this.openEntry(this.state.entryId!)
		else if (this.state.route === 'entry' || this.state.route === 'destination')
			this.navigate({
				route: 'task',
				entryId: null,
				video: null,
				selectedCid: null,
			})
		else if (this.state.route === 'collection')
			this.navigate({ route: 'folders' })
		else this.close()
	}
	setMid = (mid: string) => {
		if (!this.state.busy) {
			this.leaveAccountRead()
			this.update({
				mid,
				folderAccess: 'public',
				folderAccount: null,
				folders: null,
				error: '',
			})
		}
	}
	usePublicFolders = () => {
		if (
			this.state.route !== 'folders' ||
			this.state.busy ||
			this.gate.getSnapshot()
		)
			return
		this.leaveAccountRead()
		this.navigate({
			folderAccess: 'public',
			folderAccount: null,
			folders: null,
			collection: null,
		})
	}
	setPage = (page: number) => {
		if (Number.isSafeInteger(page) && page >= 0) this.update({ page })
	}
	cancelRead = () => {
		this.invalidate()
		this.update({
			busy: false,
			quick: this.state.quick ? { ...this.state.quick, phase: 'paused' } : null,
			notice: '已取消等待；未完成页面没有保存，已有本地任务保留。',
		})
	}
	readFolders = () => this.readFolderList('public')
	readMyFolders = () => this.readFolderList('account')
	private async readFolderList(access: 'public' | 'account') {
		if (this.state.route !== 'folders') return false
		if (this.state.busy || this.gate.getSnapshot()) {
			this.reportError(new Error('上一请求尚未结束，请稍后显式读取'))
			return false
		}
		const owner =
			access === 'account' ? this.ports.account?.getIdentity() : null
		if (access === 'account' && !owner) {
			this.reportError(new Error('请联网核验 B 站账号后读取我的收藏夹'))
			return false
		}
		this.leaveAccountRead()
		this.invalidate()
		const generation = this.generation,
			controller = new AbortController()
		this.controller = controller
		this.update({
			busy: true,
			error: '',
			notice: '',
			folders: null,
			folderAccess: access,
			folderAccount: owner ?? null,
			collection: null,
		})
		if (access === 'account')
			this.unsubscribeAccount = this.ports.account!.subscribe(
				this.accountChanged,
			)
		const transport =
			access === 'account' ? this.ports.account!.folders : this.ports.folders
		try {
			const folders = await readBilibiliFavoriteFolders(
				{ userMid: owner?.mid ?? this.state.mid, signal: controller.signal },
				(request, signal) => this.gate.run(() => transport(request, signal)),
			)
			if (generation !== this.generation) return false
			if (!this.checkAccountRead()) return false
			this.update({ folders })
			return true
		} catch (error) {
			if (generation === this.generation) this.reportError(error)
			return false
		} finally {
			if (generation === this.generation) {
				this.controller = null
				this.update({ busy: false })
			}
		}
	}
	importFolder = (favoriteId: string) => this.chooseFolder(favoriteId, true)
	async chooseFolder(favoriteId: string, automatic = false) {
		if (this.state.route !== 'folders') return false
		if (!this.checkAccountRead()) return false
		if (this.gate.getSnapshot() || this.state.busy) return false
		if (
			!this.state.folders?.folders.some(
				(folder) => folder.folderId === favoriteId,
			)
		)
			return false
		let version: number
		try {
			version =
				Math.max(
					0,
					...this.store
						.list()
						.filter(
							(task) =>
								task.provider === 'bilibili' &&
								task.originalPlaylistId === favoriteId,
						)
						.map((task) => task.taskVersion),
				) + 1
		} catch (error) {
			this.reportError(error)
			return false
		}
		const title = this.state.folders.folders.find((folder) => folder.folderId === favoriteId)!.title
		this.navigate({ route: 'collection', favoriteId, task: null, page: 0,
			busy: automatic,
			quick: automatic ? { phase: 'reading', title, total: 0, processed: 0, skipped: 0, unavailable: [], playlistId: null } : null,
		})
		const generation = this.generation
		const index = this.state.folderAccess === 'account'
			? this.ports.account!.index : this.ports.index
		const loaded = await this.collector.start({
			favoriteId, taskId: this.id(), taskVersion: version,
		}, index ? (request, signal) => {
			if (!this.checkAccountRead())
				return Promise.reject(new Error('账号已变更，请重新读取收藏夹索引'))
			return this.gate.run(() => index(request, signal))
		} : undefined)
		if (generation !== this.generation) return false
		if (!automatic) return loaded
		if (!loaded) {
			this.update({ busy: false, quick: { ...this.state.quick!, phase: 'paused' } })
			return false
		}
		return this.finishFavoriteImport(generation)
	}
	/** The folder is the user's selection. Read every page and default only its original video P1. */
	continueFavoriteImport = () => {
		if (!this.state.quick || this.state.quick.phase === 'done' || this.state.busy || this.gate.getSnapshot()) return Promise.resolve(false)
		this.update({ busy: true, error: '', notice: '' })
		return this.finishFavoriteImport(this.generation)
	}
	importCurrentTask = () => {
		const task = this.state.task
		if (!task || task.provider !== 'bilibili' || this.state.busy || this.gate.getSnapshot()) return Promise.resolve(false)
		this.invalidate()
		this.update({ quick: { phase: 'loading', title: importTaskDescription(task).name,
			total: task.entries.length, processed: 0, skipped: 0, unavailable: [], playlistId: null }, busy: true, error: '', notice: '' })
		return this.finishFavoriteImport(this.generation)
	}
	private async finishFavoriteImport(generation: number): Promise<boolean> {
		const controller = new AbortController()
		this.controller = controller
		const owner = this.ports.account?.getIdentity() ?? null
		const current = () => {
			if (generation !== this.generation || controller.signal.aborted) return false
			const now = this.ports.account?.getIdentity() ?? null
			if (owner?.mid !== now?.mid || owner?.generation !== now?.generation)
				throw new Error('账号已变更，请重新读取收藏夹')
			return this.checkAccountRead()
		}
		try {
			if (!current()) return false
			if (this.state.command) {
				this.update({ busy: false })
				return this.commit()
			}
			if (!this.state.task) {
				while (!this.collector.getSnapshot().directory) {
					if (!await this.collector.next())
						throw new Error(this.collector.getSnapshot().error?.message ?? '收藏夹读取已暂停')
					if (!current()) return false
				}
				const directory = this.collector.getSnapshot().directory!
				if (!current()) return false
				this.store.createDirectory({ ...directory, originalMetadata: { ...directory.originalMetadata, importMode: 'favorite-playlist' } })
				this.update({ task: this.store.getMixed(directory.taskId) })
			}
			const task = this.state.task!
			const processed = processedBilibiliEntries(task)
			const entries = task.entries.filter((entry) => !processed.has(entry.entryId))
			const choices: FavoritePlaylistDefault[] = []
			const cached = new Map<string, Source>()
			const unavailableVideos = new Map<string, string>()
			const unavailable: FavoritePlaylistProgress['unavailable'] = []
			let skipped = 0
			this.update({ quick: { ...this.state.quick!, phase: 'loading', total: entries.length, processed: 0, skipped, unavailable } })
			for (const entry of entries) {
				if (!current()) return false
				if (!favoriteVideoEntry(entry)) {
					choices.push({ entryId: entry.entryId, sourceId: null, skip: true })
					skipped++
				} else {
					const bvid = originalVideoBvid(entry)
					let source = entry.review.confirmation ? this.library.get(entry.review.confirmation.sourceId) : null
					let reason = '平台未返回可读取的视频信息'
					if (!source && bvid) {
						source = cached.get(bvid) ?? null
						const stored = !source ? this.catalog.get(bvid) : null
						if (stored && stored.fetchedAt >= task.createdAt) source = stored.parts[0]?.source ?? null
						if (unavailableVideos.has(bvid)) reason = unavailableVideos.get(bvid)!
						else if (!source) {
							try {
								const video = await readBilibiliView(this.gate, this.ports.video, bvid, controller.signal)
								if (!current()) return false
								if (video.bvid !== bvid) throw new Error('返回视频与收藏夹原视频不一致')
								this.catalog.save(video, Date.now())
								source = video.parts[0].source
							} catch (error) {
								if (!current()) return false
								if (!(error instanceof BilibiliApiError) || ![-404, 62002, 62004].includes(error.code)) throw error
								reason = '视频已失效或当前账号无权读取'
								unavailableVideos.set(bvid, reason)
							}
						}
						if (source) cached.set(bvid, source)
					}
					choices.push({ entryId: entry.entryId, sourceId: source?.id ?? null, ...(!source ? { unavailable: reason } : {}) })
					if (!source) unavailable.push({ entryId: entry.entryId, title: importEntryDescription(entry, 'bilibili').title, reason })
				}
				this.update({ quick: { ...this.state.quick!, processed: choices.length, skipped, unavailable: [...unavailable] } })
			}
			if (!current()) return false
			if (!choices.length || choices.every((choice) => choice.skip)) {
				this.update({ route: 'result', quick: { ...this.state.quick!, phase: 'done' }, notice: '收藏夹没有可导入的视频，未创建空歌单。' })
				return true
			}
			const next = this.store.defaultFavoritePlaylist(task.taskId, choices, task.revision)
			this.update({ task: next })
			if (!current()) return false
			if (!this.prepare({ kind: 'create', playlistId: this.id(), name: importTaskDescription(next).name }, 'keep-all', 'keep-all')) return false
			if (!current()) return false
			this.update({ busy: false })
			const committed = this.commit()
			if (!committed && this.state.quick) this.update({ quick: { ...this.state.quick, phase: 'paused' } })
			return committed
		} catch (error) {
			if (generation === this.generation) {
				this.failure(error)
				if (this.state.quick) this.update({ quick: { ...this.state.quick, phase: 'paused' } })
			}
			return false
		} finally {
			if (generation === this.generation) {
				this.controller = null
				this.update({ busy: false })
			}
		}
	}
	nextPage = () =>
		this.state.route === 'collection' && this.checkAccountRead()
			? this.collector.next()
			: Promise.resolve(false)
	saveDirectory = () => {
		if (!this.checkAccountRead()) return false
		const directory = this.collector.getSnapshot().directory
		if (
			this.state.route !== 'collection' ||
			!directory ||
			directory.originalPlaylistId !== this.state.favoriteId
		)
			return false
		try {
			this.store.createDirectory(directory)
			this.openTask(directory.taskId)
			return true
		} catch (error) {
			this.failure(error)
			return false
		}
	}
	openTask = (taskId: string) => {
		this.leaveAccountRead()
		this.navigate({
			route: 'task',
			folderAccess: 'public',
			folderAccount: null,
			folders: null,
			collection: null,
			task: null,
			entryId: null,
			video: null,
			selectedCid: null,
			page: 0,
			receipt: null,
		})
		try {
			const task = this.store.getMixed(taskId)
			if (!task) throw new Error('本地任务已不存在')
			this.update({ task })
			if (task.originalMetadata.importMode === 'favorite-playlist') {
				const receipt = task.history.findLast((event) => event.kind === 'mixed')?.receipt
				const processed = processedBilibiliEntries(task)
				const done = task.entries.every(
					(entry) => processed.has(entry.entryId) || !favoriteVideoEntry(entry),
				)
				this.update({ route: done ? 'result' : 'collection',
					receipt: receipt?.kind === 'mixed' ? receipt : null,
					quick: { phase: done ? 'done' : 'paused', title: importTaskDescription(task).name,
						total: task.entries.length, processed: done ? task.entries.length : 0,
						skipped: task.entries.filter((entry) => !entry.selected).length,
						playlistId: done ? receipt?.playlistId ?? null : null,
						unavailable: task.entries.filter((entry) => entry.selected && !entry.review.confirmation).map((entry) => ({ entryId: entry.entryId, title: importEntryDescription(entry, 'bilibili').title, reason: entry.retries.at(-1)?.message ?? '视频暂不可用' })),
					},
				})
			}
		} catch (error) {
			this.reportError(error)
		}
	}
	processed = () =>
		this.state.task
			? processedBilibiliEntries(this.state.task)
			: new Set<string>()
	selected = () => {
		const processed = this.processed()
		return (
			this.state.task?.entries.filter(
				(entry) => entry.selected && !processed.has(entry.entryId),
			) ?? []
		)
	}
	kind = (entryId: string): ContentKind =>
		this.state.task?.contentReviews.find((review) => review.entryId === entryId)
			?.kind ?? 'unknown'
	private entry(): ImportTaskEntry {
		const entry = this.state.task?.entries.find(
			(item) => item.entryId === this.state.entryId,
		)
		if (!entry) throw new Error('请选择本任务的原条目')
		return entry
	}
	openEntry = (entryId: string) => {
		if (!this.state.task?.entries.some((entry) => entry.entryId === entryId))
			return
		this.navigate({
			route: 'entry',
			entryId,
			video: null,
			selectedCid: null,
			binding: null,
			organizationItem: null,
		})
		try {
			const initial = this.state.task.history
				.flatMap((event) =>
					event.kind === 'mixed' ? event.receipt.results : [],
				)
				.find(
					(row) =>
						row.entryId === entryId &&
						row.outcome === 'added' &&
						row.targetKind === 'unclassified',
				)
			const saved = initial?.itemId ? this.saves.get(initial.itemId) : null
			this.update({
				binding: this.pendingBinding(entryId),
				organizationItem:
					saved?.bucket === 'unclassified' &&
					saved.importOrigin.taskId === this.state.task.taskId &&
					saved.importOrigin.entryId === entryId
						? saved
						: null,
			})
		} catch (error) {
			this.reportError(error)
		}
	}
	private pendingBinding(entryId: string): typeof this.state.binding {
		const task = this.state.task
		if (!task) return null
		for (const organization of task.organizations) {
			if (
				organization.entryId !== entryId ||
				organization.targetKind !== 'playlist'
			)
				continue
			const playlist = this.playlists.get(organization.targetId)
			const item = playlist?.items.find(
				(row) =>
					row.itemId === organization.itemId &&
					row.importOrigin?.taskId === task.taskId &&
					row.importOrigin.entryId === entryId,
			)
			if (playlist && item)
				return {
					playlistId: playlist.id,
					itemId: item.itemId,
					sourceId: item.sourceId,
					updatedAt: playlist.updatedAt,
				}
		}
		for (const event of task.history) {
			const result = event.receipt.results.find(
				(row) => row.entryId === entryId,
			)
			if (
				!result?.itemId ||
				!event.receipt.playlistId ||
				(event.kind === 'mixed' &&
					'targetKind' in result &&
					result.targetKind !== 'playlist')
			)
				continue
			const playlist = this.playlists.get(event.receipt.playlistId)
			const item = playlist?.items.find(
				(row) =>
					row.itemId === result.itemId &&
					row.importOrigin?.taskId === task.taskId &&
					row.importOrigin.entryId === entryId,
			)
			if (playlist && item)
				return {
					playlistId: playlist.id,
					itemId: item.itemId,
					sourceId: item.sourceId,
					updatedAt: playlist.updatedAt,
				}
		}
		return null
	}
	openPending = (
		taskId: string,
		entryId: string,
		playlistId: string,
		itemId: string,
	) => {
		this.openTask(taskId)
		if (!this.state.task) return
		this.openEntry(entryId)
		if (
			this.state.binding?.playlistId !== playlistId ||
			this.state.binding.itemId !== itemId
		) {
			this.update({
				binding: null,
				error: '所选是副本、已移除或不是原提交项目，不能补写原歌单项。',
			})
		}
	}
	setSelected = (entryId: string, selected: boolean) => {
		const task = this.state.task
		if (!task || this.state.command || this.processed().has(entryId))
			return false
		try {
			const next = this.store.setSelected(
				task.taskId,
				[entryId],
				selected,
				task.revision,
			)
			this.update({ task: { ...task, ...next }, error: '' })
			return true
		} catch (error) {
			this.failure(error)
			return false
		}
	}
	setKind = (kind: ContentKind) => {
		const task = this.state.task
		if (
			!task ||
			!this.state.entryId ||
			(this.processed().has(this.state.entryId) && !this.state.organizationItem)
		)
			return false
		try {
			this.update({
				task: this.store.reviewContent(
					task.taskId,
					this.state.entryId,
					{ kind },
					task.revision,
				),
				command: null,
				error: '',
			})
			return true
		} catch (error) {
			this.failure(error)
			return false
		}
	}
	originalBvid = (): string | null => {
		try {
			return originalVideoBvid(this.entry())
		} catch {
			return null
		}
	}
	async readVideo() {
		if (
			this.state.route !== 'entry' ||
			this.state.busy ||
			this.gate.getSnapshot()
		)
			return false
		const bvid = this.originalBvid()
		if (!bvid) {
			this.reportError(new Error('原条目未提供可核验 BV，原证据保留'))
			return false
		}
		this.invalidate()
		const generation = this.generation,
			controller = new AbortController()
		this.controller = controller
		this.update({
			busy: true,
			video: null,
			selectedCid: null,
			error: '',
			notice: '',
		})
		try {
			const video = await readBilibiliView(
				this.gate,
				this.ports.video,
				bvid,
				controller.signal,
			)
			if (generation !== this.generation) return false
			if (video.bvid !== bvid) throw new Error('返回视频与原目录 BV 不一致')
			this.catalog.save(video, Date.now())
			this.update({
				video,
				notice:
					'原视频目录已核验并保存在本机；尚未选择或确认 CID，音轨可用性未核验。',
			})
			return true
		} catch (error) {
			if (generation === this.generation) this.reportError(error)
			return false
		} finally {
			if (generation === this.generation) {
				this.controller = null
				this.update({ busy: false })
			}
		}
	}
	selectCid = (cid: number) => {
		if (this.state.video?.parts.some((part) => part.source.cid === cid)) {
			this.preview.cancel()
			this.update({
				selectedCid: cid,
				error: '',
				notice: '已选择分 P，仍需明确确认；试听不会替代确认。',
			})
		}
	}
	selectedSource = (): Source | null =>
		this.state.video?.parts.find(
			(part) => part.source.cid === this.state.selectedCid,
		)?.source ?? null
	confirmCid = () => {
		const task = this.state.task,
			source = this.selectedSource()
		if (!task || !source || !this.state.entryId) {
			this.reportError(new Error('请先读取原视频并明确选择分 P'))
			return false
		}
		if (
			this.processed().has(this.state.entryId) &&
			!this.state.organizationItem &&
			(!this.state.binding || this.state.binding.sourceId !== null)
		) {
			this.reportError(new Error('该出现项已处理，不能重写原提交确认'))
			return false
		}
		try {
			if (!this.library.get(source.id))
				throw new Error('核验音源未保存，请重新读取原视频')
			const next = this.store.review(
				task.taskId,
				this.state.entryId,
				{
					review: {
						state: 'confirmed',
						candidates: [
							{
								candidateId: source.id,
								bvid: source.bvid,
								cid: source.cid,
								metadata: { originalTitle: source.originalTitle },
								evidence: { method: 'explicit-original-bv-part' },
							},
						],
						confirmation: { candidateId: source.id, sourceId: source.id },
					},
				},
				task.revision,
			)
			this.update({
				task: { ...task, ...next },
				error: '',
				notice: '已保存原 BV/CID 人工确认；内容类型独立，独立音轨仍未核验。',
			})
			return true
		} catch (error) {
			this.failure(error)
			return false
		}
	}
	resolvePending = () => {
		const task = this.state.task,
			binding = this.state.binding,
			entryId = this.state.entryId
		if (!task || !binding || binding.sourceId !== null || !entryId) return false
		try {
			const playlist = this.store.resolvePending(task.taskId, entryId, {
				playlistId: binding.playlistId,
				itemId: binding.itemId,
				expectedRevision: task.revision,
				expectedUpdatedAt: binding.updatedAt,
			})
			this.update({
				binding: {
					...binding,
					sourceId:
						playlist.items.find((item) => item.itemId === binding.itemId)
							?.sourceId ?? null,
					updatedAt: playlist.updatedAt,
				},
				notice: '原歌单待匹配项已补全，顺序与来源记录保留。',
				error: '',
			})
			try {
				this.update({ task: this.store.getMixed(task.taskId) })
			} catch (error) {
				this.reportError(
					new Error(
						'原项已补全，但任务暂时无法重新读取；请返回本地任务重开核对。',
						{ cause: error },
					),
				)
			}
			return true
		} catch (error) {
			this.failure(error)
			return false
		}
	}
	openDestination = () => {
		this.navigate({ route: 'destination' })
		try {
			this.update({ playlists: this.playlists.list() })
		} catch (error) {
			this.reportError(error)
		}
	}
	newId = () => this.id()
	prepare = (
		musicTarget: ImportPlaylistTarget | null,
		songDuplicatePolicy: PlaylistDuplicatePolicy,
		videoDuplicatePolicy: MixedCommitRequest['videoDuplicatePolicy'],
	) => {
		const task = this.state.task
		if (!task || this.state.command) return false
		try {
			const chosen = this.selected()
			if (!chosen.length) throw new Error('请逐项选择尚未保存的内容')
			const songs = chosen.some((entry) => this.kind(entry.entryId) === 'song')
			if (songs !== (musicTarget !== null))
				throw new Error('有歌曲才指定音乐歌单；零歌曲时不创建空歌单')
			if (musicTarget?.kind === 'create' && !musicTarget.name.trim())
				throw new Error('请输入音乐歌单名称')
			this.update({
				command: {
					commitId: this.id(),
					expectedRevision: task.revision,
					musicTarget,
					songDuplicatePolicy,
					videoDuplicatePolicy,
					itemIds: chosen.map((entry) => ({
						entryId: entry.entryId,
						itemId: this.id(),
					})),
				},
				error: '',
			})
			return true
		} catch (error) {
			this.reportError(error)
			return false
		}
	}
	commit = () => {
		const task = this.state.task,
			command = this.state.command
		if (!task || !command || this.state.busy) return false
		this.update({ busy: true, error: '' })
		try {
			const result = this.store.commitMixed(task.taskId, command)
			this.navigate({ route: 'result', receipt: result.receipt,
				quick: this.state.quick ? { ...this.state.quick, phase: 'done', playlistId: result.receipt.playlistId } : null,
			})
			try {
				this.update({ task: this.store.getMixed(task.taskId) })
			} catch (error) {
				this.reportError(error)
			}
			return true
		} catch (error) {
			this.failure(error)
			return false
		} finally {
			this.update({ busy: false })
		}
	}
	openReceipt = (receipt: MixedCommitReceipt) =>
		this.navigate({ route: 'result', receipt })
	openOrganizationReceipt = (receipt: ImportOrganizationReceipt) =>
		this.navigate({ route: 'organized', organizationReceipt: receipt })
	openOrganization = () => {
		if (!this.state.organizationItem || !this.state.entryId) return
		this.navigate({ route: 'organization' })
		try {
			this.update({ playlists: this.playlists.list() })
		} catch (error) {
			this.reportError(error)
		}
	}
	prepareOrganization = (musicTarget: ImportPlaylistTarget | null) => {
		const task = this.state.task,
			item = this.state.organizationItem,
			entryId = this.state.entryId
		if (!task || !item || !entryId || this.state.organizationCommand)
			return false
		try {
			const kind = this.kind(entryId)
			if (kind === 'unknown')
				throw new Error('请先明确保存非待分类的人工内容类型')
			if ((kind === 'song') !== (musicTarget !== null))
				throw new Error('整理歌曲才指定音乐歌单，长内容保留听视频类别')
			this.update({
				organizationCommand: {
					operationId: this.id(),
					expectedRevision: task.revision,
					expectedItem: {
						itemId: item.itemId,
						bvid: item.bvid,
						position: item.position,
						addedAt: item.addedAt,
					},
					musicTarget,
				},
				error: '',
			})
			return true
		} catch (error) {
			this.reportError(error)
			return false
		}
	}
	organize = () => {
		const task = this.state.task,
			entryId = this.state.entryId,
			request = this.state.organizationCommand
		if (!task || !entryId || !request || this.state.busy) return false
		this.update({ busy: true, error: '' })
		try {
			const result = this.store.organizeUnclassified(
				task.taskId,
				entryId,
				request,
			)
			this.navigate({
				route: 'organized',
				organizationReceipt: result.receipt,
				organizationItem: null,
			})
			try {
				this.update({ task: this.store.getMixed(task.taskId) })
			} catch (error) {
				this.reportError(error)
			}
			return true
		} catch (error) {
			this.failure(error)
			return false
		} finally {
			this.update({ busy: false })
		}
	}
}

export type BilibiliImportState = ReturnType<
	BilibiliImportSession['getSnapshot']
>
