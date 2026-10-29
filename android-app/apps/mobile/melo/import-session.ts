import type { Library } from './core/database'
import type {
	ImportCommitReceipt,
	ImportCommitRequest,
	ImportPlaylistTarget,
} from './core/import-playlist-types'
import {
	ImportConflictError,
	type ImportDirectorySnapshot,
	type ImportTask,
	type ImportTaskDetail,
	type ImportTaskEntry,
	type ExternalImportProvider,
} from './core/import-types'
import type { ImportStore } from './core/imports'
import type { SearchItem, Source } from './core/model'
import type {
	Playlist,
	PlaylistDuplicatePolicy,
	PlaylistStore,
} from './core/playlists'
import {
	DirectoryReadError,
	parseExternalDirectoryUrl,
	type ExternalDirectoryInput,
} from './external-directory'
import {
	filterImportEntries,
	importBatchQuery,
	importOriginalQuery,
	importReviewFilters,
	importTaskDescription,
	type ImportReviewFilter,
} from './import-display'
import type { ListeningVideo } from './listening-source'
import { rankImportCandidates, matchImportPart } from './import-matching'

type Provider = ExternalImportProvider
type Route =
	| 'closed'
	| 'home'
	| 'input'
	| 'task'
	| 'entry'
	| 'destination'
	| 'result'
export interface ImportBinding {
	playlistId: string
	itemId: string
	sourceId: string | null
	updatedAt: number
}
export const importBatchBudget = {
	requests: 20,
	candidates: 20,
	timeoutMs: 15000,
} as const
export interface ImportBatchProgress {
	phase: 'running' | 'paused' | 'completed' | 'failed'
	eligible: number
	skipped: number
	budget: number
	requested: number
	completed: number
	empty: number
}
export interface ImportState {
	batch: ImportBatchProgress | null
	route: Route
	provider: Provider | null
	url: string
	tasks: ImportTask[]
	task: ImportTaskDetail | null
	entryId: string | null
	taskPage: number
	taskFilter: ImportReviewFilter
	binding: ImportBinding | null
	reading: boolean
	unsaved: ImportDirectorySnapshot | null
	query: string
	candidates: SearchItem[]
	searchPage: number
	searchMore: boolean
	searching: boolean
	searchError: string
	video: ListeningVideo | null
	videoBusy: boolean
	selectedCid: number | null
	playlists: Playlist[]
	command: ImportCommitRequest | null
	receipt: ImportCommitReceipt | null
	busy: boolean
	suspended: boolean
	playbackBusy: boolean
	error: string
	notice: string
}
interface Ports {
	readDirectory: (
		input: ExternalDirectoryInput,
	) => Promise<ImportDirectorySnapshot>
	search: (
		keyword: string,
		page: number,
		signal: AbortSignal,
		rereadIncomplete?: boolean,
	) => Promise<{ items: SearchItem[]; more: boolean }>
	video: (bvid: string, signal: AbortSignal) => Promise<ListeningVideo>
}
const initial = (): ImportState => ({
	batch: null,
	route: 'closed',
	provider: null,
	url: '',
	tasks: [],
	task: null,
	entryId: null,
	taskPage: 0,
	taskFilter: 'all',
	binding: null,
	reading: false,
	unsaved: null,
	query: '',
	candidates: [],
	searchPage: 0,
	searchMore: false,
	searching: false,
	searchError: '',
	video: null,
	videoBusy: false,
	selectedCid: null,
	playlists: [],
	command: null,
	receipt: null,
	busy: false,
	suspended: false,
	playbackBusy: false,
	error: '',
	notice: '',
})
const localId = () =>
	`import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/** UI workflow only. The stores own persistence, identities, revisions and transactions. */
export class ImportSession {
	private state = initial()
	private listeners = new Set<() => void>()
	private generation = 0
	private controller: AbortController | null = null
	private originalVideoRequest: object | null = null
	private cancelPlayback: (() => void) | null = null
	private playerReturn: {
		sourceId: string
		entryId: string | null
		isCurrent: () => boolean
	} | null = null
	private taskPages = new Map<string, number>()
	private taskFilters = new Map<string, ImportReviewFilter>()
	private scrollOffsets = new Map<string, number>()
	constructor(
		private store: ImportStore,
		private library: Pick<Library, 'get' | 'save'>,
		private playlists: PlaylistStore,
		private ports: Ports,
		private id = localId,
	) {}
	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private update(change: Partial<ImportState>) {
		this.state = { ...this.state, ...change }
		const task = this.state.task
		if (task && this.state.route === 'task') {
			const lastPage = Math.max(
				0,
				Math.ceil(
					filterImportEntries(task.entries, this.state.taskFilter).length / 20,
				) - 1,
			)
			if (this.state.taskPage > lastPage) {
				this.state = { ...this.state, taskPage: lastPage }
				this.taskPages.set(task.taskId, lastPage)
				this.scrollOffsets.set(`task:${task.taskId}:`, 0)
			}
		}
		for (const listener of this.listeners) listener()
	}
	private invalidate() {
		if (this.state.batch?.phase === 'running')
			this.update({ batch: { ...this.state.batch, phase: 'paused' } })
		this.generation++
		this.originalVideoRequest = null
		this.controller?.abort()
		this.controller = null
		this.cancelPlayback?.()
		this.cancelPlayback = null
		this.playerReturn = null
	}
	private navigation(change: Partial<ImportState>) {
		this.invalidate()
		this.update({
			reading: false,
			searching: false,
			videoBusy: false,
			playbackBusy: false,
			suspended: false,
			error: '',
			notice: '',
			...change,
		})
	}
	private error(error: unknown) {
		this.update({
			error: error instanceof Error ? error.message : '操作失败，请重试',
		})
	}
	reportError = (error: unknown) => this.error(error)
	rememberScroll = (key: string, offset: number) => {
		if (Number.isFinite(offset) && offset >= 0)
			this.scrollOffsets.set(key, offset)
	}
	scrollOffset = (key: string) => this.scrollOffsets.get(key) ?? 0
	setTaskPage = (page: number) => {
		if (!this.state.task || !Number.isSafeInteger(page) || page < 0) return
		this.taskPages.set(this.state.task.taskId, page)
		this.update({ taskPage: page })
	}
	createTaskFilterAction = () => {
		const generation = this.generation
		return (filter: ImportReviewFilter) => {
			if (generation !== this.generation || this.state.suspended) return false
			return this.setTaskFilter(filter)
		}
	}
	private setTaskFilter = (filter: ImportReviewFilter) => {
		const task = this.state.task
		if (
			!task ||
			this.state.route !== 'task' ||
			!importReviewFilters.includes(filter) ||
			filter === this.state.taskFilter
		)
			return false
		this.taskFilters.set(task.taskId, filter)
		this.taskPages.set(task.taskId, 0)
		this.scrollOffsets.set(`task:${task.taskId}:`, 0)
		this.update({ taskFilter: filter, taskPage: 0 })
		return true
	}

	private conflict(error: unknown) {
		if (error instanceof ImportConflictError) {
			try {
				const task = this.state.task && this.store.get(this.state.task.taskId)
				this.update({ task, command: null, route: task ? 'task' : 'home' })
			} catch {
				/* Keep the last visible evidence when re-reading also fails. */
			}
			this.update({ command: null })
		}
		this.error(error)
	}
	open = () => {
		this.navigation({
			route: 'home',
			task: null,
			entryId: null,
			command: null,
			receipt: null,
		})
		this.refreshTasks()
	}
	close = () => this.navigation({ route: 'closed' })
	back = () => {
		if (this.state.route === 'entry' || this.state.route === 'destination')
			this.navigation({
				route: 'task',
				entryId: null,
				command: null,
				video: null,
				selectedCid: null,
			})
		else if (this.state.route === 'result') this.open()
		else if (this.state.route === 'task' || this.state.route === 'input')
			this.open()
		else this.close()
	}
	refreshTasks = () => {
		try {
			this.update({ tasks: this.store.list(), error: '' })
		} catch (error) {
			this.error(error)
		}
	}
	chooseProvider = (provider: Provider) =>
		this.navigation({
			route: 'input',
			provider,
			url: '',
			unsaved: null,
			task: null,
			command: null,
		})
	setUrl = (url: string) => {
		if (!this.state.reading && !this.state.unsaved)
			this.update({ url, error: '' })
	}
	cancelRead = () => {
		this.invalidate()
		this.update({
			reading: false,
			searching: false,
			videoBusy: false,
			playbackBusy: false,
			notice: '已取消读取，本地任务保留。',
		})
	}
	async readDirectory() {
		if (this.state.reading || this.state.busy) return false
		let reference: ReturnType<typeof parseExternalDirectoryUrl>
		let version: number
		try {
			reference = parseExternalDirectoryUrl(this.state.url)
			if (reference.provider !== this.state.provider)
				throw new Error('链接来源与所选平台不一致')
			version =
				Math.max(
					0,
					...this.store
						.list()
						.filter(
							(task) =>
								task.provider === reference.provider &&
								task.originalPlaylistId === reference.originalPlaylistId,
						)
						.map((task) => task.taskVersion),
				) + 1
			if (!Number.isSafeInteger(version)) throw new Error('目录版本超过上限')
		} catch (error) {
			this.error(error)
			return false
		}
		this.invalidate()
		const generation = this.generation,
			controller = new AbortController()
		this.controller = controller
		this.update({ reading: true, error: '', notice: '', unsaved: null })
		try {
			let snapshot: ImportDirectorySnapshot
			try {
				snapshot = await this.ports.readDirectory({
					url: this.state.url,
					taskId: this.id(),
					taskVersion: version,
					signal: controller.signal,
				})
			} catch (error) {
				if (
					!(error instanceof DirectoryReadError) ||
					error.code !== 'incomplete' ||
					!error.snapshot
				)
					throw error
				snapshot = error.snapshot
			}
			if (generation !== this.generation) return false
			this.update({ unsaved: snapshot })
			return this.saveDirectory()
		} catch (error) {
			if (generation === this.generation && !controller.signal.aborted)
				this.error(error)
			return false
		} finally {
			if (generation === this.generation) {
				this.controller = null
				this.update({ reading: false })
			}
		}
	}
	saveDirectory = () => {
		if (!this.state.unsaved) return false
		try {
			const task = this.store.createDirectory(this.state.unsaved)
			this.navigation({
				task,
				taskPage: 0,
				taskFilter: 'all',
				route: 'task',
				unsaved: null,
				entryId: null,
			})
			return true
		} catch (error) {
			this.error(error)
			return false
		}
	}
	openTask = (taskId: string) => {
		this.navigation({
			taskPage: this.taskPages.get(taskId) ?? 0,
			taskFilter: this.taskFilters.get(taskId) ?? 'all',
			route: 'task',
			batch: null,
			task: null,
			entryId: null,
			command: null,
			receipt: null,
			binding: null,
		})
		try {
			const task = this.store.get(taskId)
			if (!task) throw new Error('导入任务已不存在')
			if (task.provider === 'bilibili')
				throw new Error(
					'B站原目录请从独立的收藏夹审核入口打开，不能进入外部歌曲候选流程',
				)
			this.update({ task })
		} catch (error) {
			this.error(error)
		}
	}
	async importPlaylist() {
		if (this.state.reading || this.state.batch?.phase === 'running') return null
		if (this.state.route === 'input' && !(await this.readDirectory())) return null
		let task = this.state.task
		if (!task || task.provider === 'bilibili') return null
		const processed = new Set(task.commits.flatMap(commit => commit.results.map(row => row.entryId)))
		const remaining = task.entries.filter(entry => !processed.has(entry.entryId) || this.binding(task!, entry.entryId)?.sourceId === null)
		if (!remaining.length) return task.commits[0]?.playlistId ?? null
		this.invalidate()
		const generation = this.generation
		let progress: ImportBatchProgress = { phase: 'running', eligible: remaining.length, skipped: processed.size,
			budget: remaining.length, requested: 0, completed: 0, empty: 0 }
		this.update({ route: 'task', batch: progress, error: '', notice: '' })
		try {
			for (const entry of remaining) {
				if (generation !== this.generation) return null
				const binding = this.binding(task, entry.entryId)
				let matched = entry.review.confirmation ? this.library.get(entry.review.confirmation.sourceId) : null
				if (entry.review.state !== 'confirmed') {
					const controller = new AbortController()
					this.controller = controller
					let timer: ReturnType<typeof setTimeout> | undefined
					let abort: (() => void) | undefined
					let source: Source | null = null
					try {
						progress = Object.assign({}, progress, { requested: progress.requested + 1 })
						this.update({ batch: progress })
						const find = async () => {
							const query = importOriginalQuery(entry, task!.provider)
							if (!query) return null
							const result = await this.ports.search(query, 1, controller.signal, false)
							for (const candidate of rankImportCandidates(entry, task!.provider, result.items)) {
								if (controller.signal.aborted) return null
								let video: ListeningVideo
								try {
									video = await this.ports.video(candidate.bvid, controller.signal)
								} catch (error) {
									if (controller.signal.aborted || (error instanceof Error &&
										(error.name === 'AbortError' || error.name === 'TimeoutError'))) return null
									// An unavailable video must not hide the remaining matching candidates.
									continue
								}
								if (controller.signal.aborted) return null
								const selected = matchImportPart(entry, task!.provider, video)
								if (selected) return selected
							}
							return null
						}
						source = await Promise.race([find(), new Promise<null>((resolve) => {
							abort = () => resolve(null)
							controller.signal.addEventListener('abort', abort, { once: true })
							timer = setTimeout(() => controller.abort(), importBatchBudget.timeoutMs)
						})])
					} catch {
						// Keep the original song when a provider cannot supply a usable source.
					} finally {
						clearTimeout(timer)
						if (abort) controller.signal.removeEventListener('abort', abort)
					}
					if (generation !== this.generation) return null
					if (source) {
						matched = source
						this.library.save(source)
						task = this.store.review(task.taskId, entry.entryId, { review: {
							state: 'confirmed', candidates: [{ ...this.candidate(source), evidence: { method: 'automatic-title-duration-match' } }],
							confirmation: { candidateId: source.id, sourceId: source.id },
						} }, task.revision)
					} else progress = Object.assign({}, progress, { empty: progress.empty + 1 })
				}
				if (matched && binding?.sourceId === null) {
					this.playlists.changeSource(binding.playlistId, binding.itemId, matched, binding.updatedAt, 'automatic-title-duration-match')
				}
				progress = Object.assign({}, progress, { completed: progress.completed + 1 })
				this.update({ task, batch: progress })
			}
			const unsaved = remaining.filter(entry => !processed.has(entry.entryId))
			if (!unsaved.length) {
				this.update({ batch: { ...progress, phase: 'completed' } })
				return task.commits[0]?.playlistId ?? null
			}
			this.setSelected(unsaved.map(entry => entry.entryId), true)
			if (this.state.error || !this.prepareCommit({ kind: 'create', playlistId: this.id(), name: importTaskDescription(task).name }, 'keep-all')) {
				this.update({ batch: { ...progress, phase: 'failed' } })
				return null
			}
			this.update({ batch: { ...progress, phase: 'completed' } })
			if (!this.commit()) return null
			return this.state.receipt?.playlistId ?? null
		} catch (error) {
			if (generation === this.generation) {
				this.update({ batch: { ...progress, phase: 'failed' } })
				this.conflict(error)
			}
			return null
		} finally {
			if (generation === this.generation) this.controller = null
		}
	}

	openPlaylistItem = (playlistId: string, itemId: string) => {
		try {
			const playlist = this.playlists.get(playlistId)
			const item = playlist?.items.find(value => value.itemId === itemId)
			if (!playlist || !item?.importOrigin) throw new Error('没有找到这首导入歌曲')
			this.openTask(item.importOrigin.taskId)
			this.openEntry(item.importOrigin.entryId)
			this.update({ binding: { playlistId, itemId, sourceId: item.sourceId, updatedAt: playlist.updatedAt },
				query: importOriginalQuery(item.importOrigin, item.importOrigin.provider) })
			void this.searchCandidates()
		} catch (error) { this.error(error) }
	}

	applySelectedSource = () => {
		const source = this.selectedSource(), binding = this.state.binding
		if (!source) return null
		if (!binding) return this.confirmCandidate() ? '' : null
		try {
			const playlist = this.playlists.changeSource(binding.playlistId, binding.itemId, source, binding.updatedAt)
			this.update({ binding: { ...binding, sourceId: source.id, updatedAt: playlist.updatedAt }, notice: '音源已更换', error: '' })
			return playlist.id
		} catch (error) { this.error(error); return null }
	}

	private batchEligible(entry: ImportTaskEntry) {
		return (
			entry.review.state === 'pending' &&
			entry.reviewedAt === null &&
			entry.review.candidates.length === 0 &&
			entry.review.confirmation === null
		)
	}
	pauseBatch = () => {
		if (this.state.batch?.phase !== 'running') return
		this.invalidate()
		this.update({
			notice: '查找已暂停，已保存的候选保留。再次点击可查找剩余条目。',
		})
	}
	async findBatchCandidates() {
		const originalTask = this.state.task
		if (
			this.state.route !== 'task' ||
			!originalTask ||
			this.state.busy ||
			this.state.batch?.phase === 'running'
		)
			return false
		this.invalidate()
		const generation = this.generation
		let task: ImportTaskDetail
		try {
			const current = this.store.get(originalTask.taskId)
			if (!current || current.provider === 'bilibili')
				throw new Error('请打开网易云或 QQ 导入任务')
			task = current
		} catch (error) {
			this.error(error)
			return false
		}
		const eligible = task.entries.filter(
			(entry) =>
				this.batchEligible(entry) && importBatchQuery(entry, task.provider),
		)
		const entries = eligible.slice(0, importBatchBudget.requests)
		let progress: ImportBatchProgress = {
			phase: 'running',
			eligible: eligible.length,
			skipped: task.entries.length - eligible.length,
			budget: entries.length,
			requested: 0,
			completed: 0,
			empty: 0,
		}
		this.update({ task, batch: progress, error: '', notice: '' })
		try {
			for (const entry of entries) {
				if (generation !== this.generation) return false
				// Fail closed on any concurrent edit. Never overwrite another review.
				const current = this.store.get(task.taskId)
				if (!current || current.revision !== task.revision)
					throw new Error('任务已变更，已停止查找；请重新打开任务后继续。')
				const controller = new AbortController()
				this.controller = controller
				const query = importBatchQuery(entry, task.provider)
				progress = Object.assign({}, progress, {
					requested: progress.requested + 1,
				})
				this.update({ batch: progress })
				let timer: ReturnType<typeof setTimeout> | undefined
				let abort: (() => void) | undefined
				let result: Awaited<ReturnType<Ports['search']>>
				try {
					result = await Promise.race([
						this.ports.search(query, 1, controller.signal, false),
						new Promise<never>((_, reject) => {
							abort = () => reject(new Error('查找已暂停'))
							controller.signal.addEventListener('abort', abort, { once: true })
							timer = setTimeout(() => {
								reject(new Error('本项查找超时，请稍后手动重试'))
								controller.abort()
							}, importBatchBudget.timeoutMs)
						}),
					])
				} finally {
					clearTimeout(timer)
					if (abort) controller.signal.removeEventListener('abort', abort)
				}
				if (generation !== this.generation || controller.signal.aborted)
					return false
				const candidates = [
					...new Map(result.items.map((item) => [item.bvid, item])).values(),
				]
					.slice(0, importBatchBudget.candidates)
					.map((item) => ({
						candidateId: `search:${item.bvid}`,
						bvid: item.bvid,
						cid: null,
						metadata: {
							originalTitle: item.originalTitle,
							uploader: item.uploader,
							durationSeconds: item.duration,
						},
						evidence: {
							method: 'user-started-batch-search',
							query,
							page: 1,
							more: result.more,
						},
					}))
				task = this.store.review(
					task.taskId,
					entry.entryId,
					{ review: { state: 'needs-review', candidates, confirmation: null } },
					task.revision,
				)
				progress = Object.assign({}, progress, {
					completed: progress.completed + 1,
					empty: progress.empty + (candidates.length ? 0 : 1),
				})
				this.update({ task, batch: progress })
			}
			progress = { ...progress, phase: 'completed' }
			this.update({
				batch: progress,
				notice: entries.length
					? '本轮查找已结束，版本均需人工核对。空结果项请打开后手动调整关键词查找。'
					: '没有可批量查找的条目。已审核或信息不足的条目请手动查看。',
			})
			return true
		} catch (error) {
			if (generation === this.generation) {
				this.update({
					batch: { ...progress, phase: 'failed' },
					notice:
						'已停止，已保存的候选保留。可再次点击查找剩余条目，或打开失败项手动查找。',
				})
				this.error(error)
			}
			return false
		} finally {
			if (generation === this.generation) this.controller = null
		}
	}
	setSelected = (entryIds: string[], selected: boolean) => {
		const task = this.state.task
		if (!task || this.state.busy || !entryIds.length) return false
		try {
			this.update({
				task: this.store.setSelected(
					task.taskId,
					entryIds,
					selected,
					task.revision,
				),
				command: null,
				error: '',
			})
			return true
		} catch (error) {
			this.conflict(error)
			return false
		}
	}
	private entry(): ImportTaskEntry {
		const entry = this.state.task?.entries.find(
			(value) => value.entryId === this.state.entryId,
		)
		if (!entry) throw new Error('请选择当前任务中的条目')
		return entry
	}
	private binding(
		task: ImportTaskDetail,
		entryId: string,
	): ImportBinding | null {
		const receipt = task.commits.find((commit) =>
			commit.results.some((row) => row.entryId === entryId),
		)
		const result = receipt?.results.find((row) => row.entryId === entryId)
		if (!receipt || !result?.itemId) return null
		const playlist = this.playlists.get(receipt.playlistId)
		const item = playlist?.items.find(
			(value) =>
				value.itemId === result.itemId &&
				value.importOrigin?.taskId === task.taskId &&
				value.importOrigin.entryId === entryId,
		)
		if (!playlist || !item) return null
		return {
			playlistId: playlist.id,
			itemId: item.itemId,
			sourceId: item.sourceId,
			updatedAt: playlist.updatedAt,
		}
	}
	openEntry = (entryId: string) => {
		const task = this.state.task
		if (!task || !task.entries.some((entry) => entry.entryId === entryId))
			return
		this.navigation({
			route: 'entry',
			entryId,
			binding: null,
			query: '',
			candidates: [],
			searchPage: 0,
			searchMore: false,
			searchError: '',
			video: null,
			selectedCid: null,
		})
		try {
			this.update({ binding: this.binding(task, entryId) })
		} catch (error) {
			this.error(error)
		}
	}
	createOriginalQueryAction = () => {
		const generation = this.generation
		return () => {
			if (
				generation !== this.generation ||
				this.state.route !== 'entry' ||
				!this.state.task
			)
				return
			const query = importOriginalQuery(this.entry(), this.state.task.provider)
			if (query) this.setQuery(query)
		}
	}

	setQuery = (query: string) => {
		if (query === this.state.query) return
		this.invalidate()
		this.update({
			query,
			candidates: [],
			searchPage: 0,
			searchMore: false,
			searchError: '',
			searching: false,
			videoBusy: false,
			video: null,
			selectedCid: null,
			playbackBusy: false,
		})
	}
	showSearchResults = () => {
		this.invalidate()
		this.update({ video: null, selectedCid: null, videoBusy: false, searching: false })
	}
	async searchCandidates(more = false) {
		if (this.state.searching || this.state.route !== 'entry') return false
		const query = this.state.query.trim()
		if (!query) {
			this.update({ searchError: '请输入歌曲或版本关键词，也可输入 BV 号' })
			return false
		}
		if (more && (!this.state.searchMore || !this.state.searchPage)) return false
		this.invalidate()
		const generation = this.generation,
			controller = new AbortController()
		this.controller = controller
		const page = more ? this.state.searchPage + 1 : 1
		this.update({
			searching: true,
			videoBusy: false,
			playbackBusy: false,
			searchError: '',
			error: '',
			...(!more ? { candidates: [], searchPage: 0, searchMore: false } : {}),
		})
		try {
			const result = await this.ports.search(query, page, controller.signal)
			if (generation !== this.generation) return false
			const candidates = new Map(
				(more ? [...this.state.candidates, ...result.items] : result.items).map(
					(item) => [item.bvid, item],
				),
			)
			this.update({
				candidates: [...candidates.values()],
				searchPage: page,
				searchMore: result.more,
			})
			return true
		} catch (error) {
			if (generation === this.generation && !controller.signal.aborted) {
				const message =
					error instanceof Error ? error.message : '候选读取失败，请重试'
				this.update({ searchError: message })
				const task = this.state.task
				if (task && this.state.entryId) {
					try {
						this.update({
							task: this.store.review(
								task.taskId,
								this.state.entryId,
								{ retry: { errorCode: 'CANDIDATE_READ', message } },
								task.revision,
							),
						})
					} catch (saveError) {
						this.conflict(saveError)
					}
				}
			}
			return false
		} finally {
			if (generation === this.generation) {
				this.controller = null
				this.update({ searching: false })
			}
		}
	}
	async readVideo(bvid: string) {
		if (this.state.route !== 'entry') return false
		this.invalidate()
		const generation = this.generation,
			controller = new AbortController()
		this.controller = controller
		this.update({
			videoBusy: true,
			searching: false,
			playbackBusy: false,
			video: null,
			selectedCid: null,
			error: '',
		})
		try {
			const video = await this.ports.video(bvid, controller.signal)
			if (generation !== this.generation) return false
			if (video.bvid !== bvid) throw new Error('候选视频身份不一致')
			this.update({ video })
			return true
		} catch (error) {
			if (generation === this.generation && !controller.signal.aborted)
				this.error(error)
			return false
		} finally {
			if (generation === this.generation) {
				this.controller = null
				this.update({ videoBusy: false })
			}
		}
	}
	createOriginalVideoAction(
		bvid: string,
		open: (url: string) => Promise<unknown>,
	): () => Promise<void> {
		// Bind when rendered, not after an old native onPress reaches a new visit.
		const generation = this.generation
		return async () => {
			const video = this.state.video
			if (
				generation !== this.generation ||
				this.state.route !== 'entry' ||
				!video ||
				video.bvid !== bvid
			)
				return
			const request = {}
			this.originalVideoRequest = request
			try {
				const part = video.parts.find(
					(value) => value.source.cid === this.state.selectedCid,
				)
				// Only a verified, explicitly selected part determines the public URL.
				const suffix = part ? `?p=${part.page}` : ''
				await open(`https://www.bilibili.com/video/${video.bvid}${suffix}`)
			} catch (error) {
				if (
					generation === this.generation &&
					this.originalVideoRequest === request
				)
					this.error(error)
			} finally {
				if (this.originalVideoRequest === request)
					this.originalVideoRequest = null
			}
		}
	}
	selectCid = (cid: number) => {
		if (!this.state.video?.parts.some((part) => part.source.cid === cid)) return
		this.invalidate()
		this.update({
			selectedCid: cid,
			error: '',
			searching: false,
			videoBusy: false,
			playbackBusy: false,
		})
		const task = this.state.task,
			source = this.selectedSource()
		if (!task || !source) return
		try {
			const entry = this.entry()
			if (entry.review.state !== 'confirmed')
				this.update({
					task: this.store.review(
						task.taskId,
						entry.entryId,
						{
							review: {
								state: 'needs-review',
								candidates: [this.candidate(source)],
								confirmation: null,
							},
						},
						task.revision,
					),
				})
		} catch (error) {
			this.conflict(error)
		}
	}
	selectedSource = (): Source | null =>
		this.state.video?.parts.find(
			(part) => part.source.cid === this.state.selectedCid,
		)?.source ?? null
	private candidate(source: Source) {
		return {
			candidateId: source.id,
			bvid: source.bvid,
			cid: source.cid,
			metadata: {
				originalTitle: source.originalTitle,
				uploader: source.uploader,
				durationSeconds: source.duration,
			},
			evidence: { method: 'explicit-user-choice' },
		}
	}
	confirmCandidate = () => {
		const task = this.state.task,
			source = this.selectedSource()
		if (!task || !source) {
			this.error(new Error('请先明确选择分 P，再确认这个版本'))
			return false
		}
		try {
			const entry = this.entry()
			const processed = task.commits.some((receipt) =>
				receipt.results.some((row) => row.entryId === entry.entryId),
			)
			if (
				processed &&
				(!this.state.binding || this.state.binding.sourceId !== null)
			)
				throw new Error('此条目已处理，原项改源或副本匹配将在后续开放。')
			const saved = this.library.get(source.id)
			if (!saved) this.library.save(source)
			const next = this.store.review(
				task.taskId,
				entry.entryId,
				{
					review: {
						state: 'confirmed',
						candidates: [this.candidate(source)],
						confirmation: { candidateId: source.id, sourceId: source.id },
					},
				},
				task.revision,
			)
			this.update({
				task: next,
				notice: '已保存人工确认；原平台证据保持。',
				error: '',
			})
			return true
		} catch (error) {
			this.conflict(error)
			return false
		}
	}
	markNotFound = () => {
		const task = this.state.task
		if (
			!task ||
			!this.state.searchPage ||
			this.state.searchMore ||
			this.state.candidates.length ||
			this.state.searchError ||
			this.state.searching
		)
			return false
		try {
			const entry = this.entry()
			if (entry.review.state === 'confirmed')
				throw new Error('已有人工确认保留，不用空搜索覆盖。')
			this.update({
				task: this.store.review(
					task.taskId,
					entry.entryId,
					{
						review: { state: 'not-found', candidates: [], confirmation: null },
					},
					task.revision,
				),
				notice: '已记录本次未找到，条目保留。',
			})
			return true
		} catch (error) {
			this.conflict(error)
			return false
		}
	}
	resolvePending = () => {
		const task = this.state.task,
			binding = this.state.binding
		if (!task || !binding || !this.state.entryId) return false
		try {
			const playlist = this.store.resolvePending(
				task.taskId,
				this.state.entryId,
				{
					playlistId: binding.playlistId,
					itemId: binding.itemId,
					expectedRevision: task.revision,
					expectedUpdatedAt: binding.updatedAt,
				},
			)
			this.update({
				binding: {
					...binding,
					updatedAt: playlist.updatedAt,
					sourceId:
						playlist.items.find((item) => item.itemId === binding.itemId)
							?.sourceId ?? null,
				},
				notice: '原待匹配条目已更新，顺序与身份保留。',
				error: '',
			})
			try {
				this.update({ task: this.store.get(task.taskId) })
			} catch (error) {
				this.error(error)
			}
			return true
		} catch (error) {
			this.conflict(error)
			return false
		}
	}
	openDestination = () => {
		this.navigation({ route: 'destination', command: null })
		try {
			this.update({ playlists: this.playlists.list() })
		} catch (error) {
			this.error(error)
		}
	}
	prepareCommit = (
		target: ImportPlaylistTarget,
		duplicatePolicy: PlaylistDuplicatePolicy,
	) => {
		const task = this.state.task
		if (!task) return false
		try {
			const processed = new Set(
				task.commits.flatMap((receipt) =>
					receipt.results.map((result) => result.entryId),
				),
			)
			const chosen = task.entries.filter(
				(entry) => entry.selected && !processed.has(entry.entryId),
			)
			if (!chosen.length) throw new Error('请先选择尚未保存的条目')
			if (target.kind === 'create' && !target.name.trim())
				throw new Error('请输入本地副本名称')
			this.update({
				command: {
					commitId: this.id(),
					expectedRevision: task.revision,
					target,
					duplicatePolicy,
					itemIds: chosen.map((entry) => ({
						entryId: entry.entryId,
						itemId: this.id(),
					})),
				},
				error: '',
			})
			return true
		} catch (error) {
			this.error(error)
			return false
		}
	}
	newPlaylistId = () => this.id()
	commit = () => {
		const task = this.state.task,
			command = this.state.command
		if (!task || !command || this.state.busy) return false
		this.update({ busy: true, error: '' })
		try {
			const result = this.store.commitSelected(task.taskId, command)
			// Commit succeeded: keep its receipt even if the following read fails.
			this.navigation({
				route: 'result',
				receipt: result.receipt,
				command: null,
			})
			try {
				this.update({ task: this.store.get(task.taskId) })
			} catch (error) {
				this.error(error)
			}
			return true
		} catch (error) {
			this.conflict(error)
			return false
		} finally {
			this.update({ busy: false })
		}
	}
	openReceipt = (receipt: ImportCommitReceipt) =>
		this.navigation({ route: 'result', receipt, command: null })
	continueTask = () => {
		if (this.state.task) this.openTask(this.state.task.taskId)
	}
	async playPreview(
		action: (
			source: Source,
			ownRequest: (cancel: () => void, isCurrent: () => boolean) => void,
		) => Promise<boolean>,
		started: () => void,
	) {
		const source = this.selectedSource()
		if (!source || this.state.playbackBusy) return false
		const generation = this.generation
		this.update({ playbackBusy: true, error: '' })
		try {
			const success = await action(source, (cancel, isCurrent) => {
				if (generation === this.generation) {
					this.cancelPlayback = cancel
					this.playerReturn = { sourceId: source.id, entryId: null, isCurrent }
				} else cancel()
			})
			if (generation !== this.generation || !success) return false
			this.cancelPlayback = null
			this.update({ suspended: true })
			started()
			return true
		} catch (error) {
			if (generation === this.generation) this.error(error)
			return false
		} finally {
			if (generation === this.generation) this.update({ playbackBusy: false })
		}
	}
	observePlayer = (sourceId: string | null, entryId: string | null) => {
		if (!this.state.suspended || !this.playerReturn || !entryId) return
		if (
			this.playerReturn.sourceId !== sourceId ||
			!this.playerReturn.isCurrent() ||
			(this.playerReturn.entryId !== null &&
				this.playerReturn.entryId !== entryId)
		) {
			this.close()
		} else this.playerReturn.entryId = entryId
	}
	resumeFromPlayer = (sourceId: string | null, entryId: string | null) => {
		if (!this.state.suspended || this.state.route === 'closed') return false
		if (
			!this.playerReturn ||
			this.playerReturn.sourceId !== sourceId ||
			!this.playerReturn.isCurrent() ||
			(this.playerReturn.entryId !== null &&
				this.playerReturn.entryId !== entryId)
		) {
			this.close()
			return false
		}
		this.playerReturn = null
		this.update({ suspended: false })
		return true
	}
}
