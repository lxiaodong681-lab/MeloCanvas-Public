import type { Library } from './core/database'
import { type MusicLibrarySource as Source } from './core/music-library-source'
import {
	PlaylistUndoExpiredError,
	type PlaylistRemovalReceipt,
	type Playlist,
	type PlaylistDetail,
	type PlaylistDuplicatePolicy,
	type PlaylistStore,
} from './core/playlists'
import { importProviderName } from './import-display'
import type {
	PlaylistCoverFiles,
	SavedPlaylistCover,
} from './playlist-cover-files'
import {
	isPlaylistDetailFiltered,
	selectPlaylistDetailItems,
	type PlaylistDetailFilter,
} from './playlist-selection'

export interface PlaylistSummary {
	playlist: Playlist
	count: number
	pendingCount: number
	artwork: string | null
	importSummary: string
}

interface NameForm {
	kind: 'create' | 'rename' | 'copy' | 'description' | 'from-likes'
	value: string
}

export interface PlaylistPicker {
	sources: Source[]
	selectedSourceIds: string[]
	query: string
	duplicatePolicy: PlaylistDuplicatePolicy | null
}

/** In-memory route position; item identity survives edits and repeated sources. */
export interface PlaylistScrollPosition {
	itemId: string | null
	index: number
	/** Absolute content Y; reset to zero if the retained occurrence moved. */
	offset: number
}

interface PlaylistBrowsingState {
	detailQuery: string
	detailFilter: PlaylistDetailFilter
	editing: boolean
	selectedItemIds: string[]
	scroll: PlaylistScrollPosition
}

const topPosition = (): PlaylistScrollPosition => ({
	itemId: null,
	index: 0,
	offset: 0,
})

export interface PlaylistState {
	playlists: PlaylistSummary[]
	currentId: string | null
	detail: PlaylistDetail | null
	sources: Map<string, Source | null>
	detailQuery: string
	detailFilter: PlaylistDetailFilter
	/** Guards delayed callbacks from an old route or filter. */
	detailViewToken: number
	editing: boolean
	selectedItemIds: string[]
	coverForm: { uri: string | null; busy: boolean } | null
	nameForm: NameForm | null
	picker: PlaylistPicker | null
	targetSources: Source[] | null
	deleting: boolean
	undoAvailable: boolean
	error: string
	notice: string
}

const localId = () =>
	`local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/** Local playlist UI state. Selection and ordering always address itemId, never sourceId. */
export class PlaylistSession {
	private state: PlaylistState = {
		playlists: [],
		currentId: null,
		detail: null,
		sources: new Map(),
		detailQuery: '',
		detailFilter: 'all',
		detailViewToken: 0,
		editing: false,
		selectedItemIds: [],
		coverForm: null,
		nameForm: null,
		picker: null,
		targetSources: null,
		deleting: false,
		undoAvailable: false,
		error: '',
		notice: '',
	}
	private listeners = new Set<() => void>()
	private browsing = new Map<string, PlaylistBrowsingState>()
	private detailScroll = topPosition()
	private viewSequence = 0
	private matching: {
		detail: PlaylistDetail | null
		sources: Map<string, Source | null>
		query: string
		filter: PlaylistDetailFilter
		items: ReturnType<typeof selectPlaylistDetailItems>
		indices: Map<string, number>
	} | null = null
	private removal: {
		playlistId: string
		receipt: PlaylistRemovalReceipt
	} | null = null

	constructor(
		private store: PlaylistStore,
		private library: Pick<Library, 'getMusic' | 'musicLikes'>,
		private createId: () => string = localId,
		private coverFiles?: PlaylistCoverFiles,
	) {
		this.refresh()
	}

	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private rememberCurrentView() {
		if (!this.state.currentId) return
		this.browsing.set(this.state.currentId, {
			detailQuery: this.state.detailQuery,
			detailFilter: this.state.detailFilter,
			editing: this.state.editing,
			selectedItemIds: this.state.selectedItemIds,
			scroll: { ...this.detailScroll },
		})
	}
	private update(change: Partial<PlaylistState>) {
		if ('currentId' in change && change.currentId !== this.state.currentId) {
			this.rememberCurrentView()
			this.detailScroll = change.currentId
				? { ...(this.browsing.get(change.currentId)?.scroll ?? topPosition()) }
				: topPosition()
			change = {
				...change,
				coverForm: null,
				detailViewToken: ++this.viewSequence,
			}
		}
		this.state = { ...this.state, ...change }
		this.rememberCurrentView()
		for (const listener of this.listeners) listener()
	}
	/** Read-only reconciliation: no notification or new database read while scrolling. */
	getDetailScroll = (token: number): PlaylistScrollPosition => {
		if (token !== this.state.detailViewToken || !this.state.currentId)
			return topPosition()
		const position = this.detailScroll
		if (position.itemId === null) return { ...position }
		const visible = this.visibleItems()
		if (!visible.length) return topPosition()
		const found = this.matching!.indices.get(position.itemId) ?? -1
		const index =
			found < 0 ? Math.min(position.index, visible.length - 1) : found
		return {
			itemId: visible[index].item.itemId,
			index,
			offset: found === position.index ? position.offset : 0,
		}
	}
	/** Native scroll callbacks must carry the token captured by that rendered view. */
	recordDetailScroll = (token: number, position: PlaylistScrollPosition) => {
		if (
			token !== this.state.detailViewToken ||
			!this.state.currentId ||
			!Number.isFinite(position.offset) ||
			!Number.isFinite(position.index)
		)
			return
		this.visibleItems()
		if (
			position.itemId !== null &&
			!this.matching!.indices.has(position.itemId)
		)
			return
		this.detailScroll = {
			itemId: position.itemId,
			index: Math.max(0, Math.floor(position.index)),
			offset: Math.max(0, position.offset),
		}
		this.rememberCurrentView()
	}
	private resetDetailPosition() {
		this.detailScroll = topPosition()
		return ++this.viewSequence
	}
	private visibleItems() {
		const {
			detail,
			sources,
			detailQuery: query,
			detailFilter: filter,
		} = this.state
		if (
			!this.matching ||
			this.matching.detail !== detail ||
			this.matching.sources !== sources ||
			this.matching.query !== query ||
			this.matching.filter !== filter
		) {
			const items = selectPlaylistDetailItems(detail, sources, query, filter)
			this.matching = {
				detail,
				sources,
				query,
				filter,
				items,
				indices: new Map(items.map(({ item }, index) => [item.itemId, index])),
			}
		}
		return this.matching.items
	}
	setDetailQuery = (detailQuery: string) => {
		if (!this.state.currentId || detailQuery === this.state.detailQuery) return
		this.update({ detailQuery, detailViewToken: this.resetDetailPosition() })
	}
	setDetailFilter = (detailFilter: PlaylistDetailFilter) => {
		if (!this.state.currentId || detailFilter === this.state.detailFilter)
			return
		this.update({ detailFilter, detailViewToken: this.resetDetailPosition() })
	}
	clearDetailFilters = () => {
		if (!this.state.currentId) return
		this.update({
			detailQuery: '',
			detailFilter: 'all',
			detailViewToken: this.resetDetailPosition(),
		})
	}
	private fail(error: unknown) {
		this.update({
			error:
				error instanceof Error ? error.message : '本地歌单操作失败，请重试',
		})
	}
	private invalidateUndo(id: string) {
		if (this.removal?.playlistId === id) this.removal = null
	}
	private commit(action: () => Partial<PlaylistState>): boolean {
		try {
			this.update({ error: '', ...action() })
			this.refresh()
			return true
		} catch (error) {
			this.fail(error)
			return false
		}
	}

	refresh = () => {
		try {
			const hydrated = new Map<string, Source | null>()
			const sourceFor = (id: string) => {
				if (!hydrated.has(id)) hydrated.set(id, this.library.getMusic(id))
				return hydrated.get(id) ?? null
			}
			const playlists = this.store
				.listSummaries()
				.map(
					({
						playlist,
						count,
						pendingCount,
						firstSourceId,
						importProviders,
					}) => ({
						playlist,
						count,
						pendingCount,
						importSummary: importProviders.length
							? `导入条目来源：${importProviders.map(importProviderName).join(' / ')}，本地副本`
							: '',
						artwork:
							playlist.coverUri ??
							(firstSourceId
								? (sourceFor(firstSourceId)?.artwork ?? null)
								: null),
					}),
				)
			const playlistIds = new Set(playlists.map(({ playlist }) => playlist.id))
			const detail = this.state.currentId
				? this.store.get(this.state.currentId)
				: null
			const sources = new Map<string, Source | null>()
			for (const item of detail?.items ?? [])
				if (item.sourceId !== null && !sources.has(item.sourceId))
					sources.set(item.sourceId, sourceFor(item.sourceId))
			const currentIds = new Set(detail?.items.map((item) => item.itemId) ?? [])
			this.update({
				playlists,
				detail,
				sources,
				undoAvailable:
					!!this.removal && this.removal.playlistId === this.state.currentId,
				error:
					this.state.currentId && !detail
						? '这张歌单已不存在，请返回音乐库。'
						: '',
				selectedItemIds: this.state.selectedItemIds.filter((id) =>
					currentIds.has(id),
				),
			})
			for (const id of this.browsing.keys())
				if (!playlistIds.has(id)) this.browsing.delete(id)
		} catch (error) {
			this.fail(error)
		}
	}

	open = (id: string) => {
		const saved = this.browsing.get(id)
		this.update({
			currentId: id,
			detail: null,
			sources: new Map(),
			detailQuery: saved?.detailQuery ?? '',
			detailFilter: saved?.detailFilter ?? 'all',
			detailViewToken: ++this.viewSequence,
			editing: saved?.editing ?? false,
			selectedItemIds: saved?.selectedItemIds ?? [],
			coverForm: null,
			nameForm: null,
			picker: null,
			targetSources: null,
			deleting: false,
			notice: '',
		})
		this.refresh()
	}
	close = () => {
		this.update({
			currentId: null,
			detail: null,
			sources: new Map(),
			detailQuery: '',
			detailFilter: 'all',
			editing: false,
			selectedItemIds: [],
			coverForm: null,
			nameForm: null,
			picker: null,
			targetSources: null,
			deleting: false,
			notice: '',
			error: '',
		})
		this.refresh()
	}
	clearNotice = () => this.update({ notice: '' })
	closeSheet = () =>
		this.update({
			coverForm: null,
			nameForm: null,
			picker: null,
			targetSources: null,
			deleting: false,
			error: '',
		})
	requestName = (kind: NameForm['kind']) => {
		if (kind !== 'create' && kind !== 'from-likes' && !this.state.detail) return
		const name = this.state.detail?.name ?? ''
		this.update({
			coverForm: null,
			nameForm: {
				kind,
				value:
					kind === 'from-likes'
						? '我喜欢的音乐'
						: kind === 'create'
							? ''
							: kind === 'description'
								? (this.state.detail?.description ?? '')
								: kind === 'copy'
									? `${name}的副本`.slice(0, 40)
									: name,
			},
			picker: null,
			deleting: false,
			error: '',
		})
	}
	setName = (value: string) => {
		if (this.state.nameForm)
			this.update({ nameForm: { ...this.state.nameForm, value }, error: '' })
	}
	saveName = (): boolean => {
		const form = this.state.nameForm
		if (!form) return false
		if (form.kind !== 'description' && !form.value.trim()) {
			this.fail(new Error('请先给歌单起个名字'))
			return false
		}
		return this.commit(() => {
			if (form.kind === 'create' || form.kind === 'from-likes') {
				const playlist =
					form.kind === 'from-likes'
						? this.store.createFromLikes(
								this.createId(),
								form.value,
								this.createId,
							)
						: { ...this.store.create(this.createId(), form.value), items: [] }
				return {
					currentId: playlist.id,
					detail: playlist,
					sources: new Map(),
					detailQuery: '',
					detailFilter: 'all',
					coverForm: null,
					nameForm: null,
					editing: false,
					selectedItemIds: [],
					picker:
						form.kind === 'create' && this.state.targetSources
							? this.pickerFor(this.state.targetSources)
							: null,
					targetSources: null,
					notice:
						form.kind === 'from-likes'
							? '已将当前喜欢保存为独立歌单，喜欢保持不变'
							: '歌单已创建',
				}
			}
			const detail = this.state.detail
			if (!detail) throw new Error('这张歌单已不存在')
			if (form.kind === 'description') {
				this.store.setDescription(detail.id, form.value)
				this.invalidateUndo(detail.id)
				return {
					coverForm: null,
					nameForm: null,
					undoAvailable: false,
					notice: '歌单简介已保存',
				}
			}
			if (form.kind === 'rename') {
				this.store.rename(detail.id, form.value)
				this.invalidateUndo(detail.id)
				return {
					coverForm: null,
					nameForm: null,
					undoAvailable: false,
					notice: '歌单名称已保存',
				}
			}
			const copy = this.store.copy(
				detail.id,
				this.createId(),
				form.value,
				detail.items.map(() => this.createId()),
			)
			return {
				currentId: copy.id,
				detail: copy,
				detailQuery: '',
				detailFilter: 'all',
				coverForm: null,
				nameForm: null,
				editing: false,
				selectedItemIds: [],
				notice: '已复制为独立的本地歌单',
			}
		})
	}

	requestCover = () => {
		if (!this.state.detail) return
		this.closeSheet()
		this.update({ coverForm: { uri: this.state.detail.coverUri, busy: false } })
	}
	useAutomaticCover = () => {
		if (this.state.coverForm && !this.state.coverForm.busy)
			this.update({ coverForm: { uri: null, busy: false }, error: '' })
	}
	pickCover = async () => {
		const form = this.state.coverForm
		if (!form || form.busy || !this.coverFiles) return false
		const pending = { ...form, busy: true }
		this.update({ coverForm: pending, error: '' })
		try {
			const uri = await this.coverFiles.pick()
			if (this.state.coverForm !== pending) return false
			this.update({ coverForm: { uri: uri ?? form.uri, busy: false } })
			return uri !== null
		} catch (error) {
			if (this.state.coverForm === pending) {
				this.update({ coverForm: form })
				this.fail(error)
			}
			return false
		}
	}
	saveCover = async () => {
		const form = this.state.coverForm,
			detail = this.state.detail
		if (!form || form.busy || !detail || !this.coverFiles) return false
		const pending = { ...form, busy: true }
		this.update({ coverForm: pending, error: '' })
		let saved: SavedPlaylistCover | null = null
		try {
			if (form.uri && form.uri !== detail.coverUri)
				saved = await this.coverFiles.persist(form.uri)
			if (
				this.state.coverForm !== pending ||
				this.state.currentId !== detail.id
			)
				return false
			this.store.setCoverUri(detail.id, saved?.uri ?? form.uri)
			saved = null // Committed files may be shared by independent playlist copies.
			this.invalidateUndo(detail.id)
			this.update({
				coverForm: null,
				undoAvailable: false,
				notice: form.uri ? '歌单封面已保存' : '已恢复自动封面',
			})
			this.refresh()
			return true
		} catch (error) {
			if (this.state.coverForm === pending) {
				this.update({ coverForm: form })
				this.fail(error)
			}
			return false
		} finally {
			try {
				saved?.discard()
			} catch {
				/* Only discard the new uncommitted private copy; original cover is intact. */
			}
		}
	}

	setEditing = (editing: boolean) =>
		this.update({ editing, selectedItemIds: [], error: '' })
	clearSelection = () => this.update({ selectedItemIds: [] })
	toggleItem = (itemId: string) => {
		if (
			!this.state.editing ||
			!this.visibleItems().some(({ item }) => item.itemId === itemId)
		)
			return
		const selected = this.state.selectedItemIds
		this.update({
			selectedItemIds: selected.includes(itemId)
				? selected.filter((id) => id !== itemId)
				: [...selected, itemId],
		})
	}
	selectAll = () => {
		if (!this.state.editing) return
		this.update({
			selectedItemIds: [
				...new Set([
					...this.state.selectedItemIds,
					...this.visibleItems().map(({ item }) => item.itemId),
				]),
			],
		})
	}
	move = (itemId: string, offset: -1 | 1): boolean => {
		const detail = this.state.detail
		if (
			!detail ||
			isPlaylistDetailFiltered(this.state.detailQuery, this.state.detailFilter)
		)
			return false
		const ids = detail.items.map((item) => item.itemId)
		const index = ids.indexOf(itemId)
		const target = index + offset
		if (index < 0 || target < 0 || target >= ids.length) return false
		;[ids[index], ids[target]] = [ids[target], ids[index]]
		return this.commit(() => {
			this.store.reorder(detail.id, ids)
			this.invalidateUndo(detail.id)
			return { undoAvailable: false, notice: '歌单顺序已保存' }
		})
	}
	removeSelected = (): boolean => {
		const detail = this.state.detail
		if (!this.state.editing || !detail || !this.state.selectedItemIds.length)
			return false
		return this.commit(() => {
			const receipt = this.store.remove(detail.id, this.state.selectedItemIds)
			if (receipt) this.removal = { playlistId: detail.id, receipt }
			return {
				selectedItemIds: [],
				undoAvailable: !!receipt,
				notice: '已从这张歌单移除，喜欢与音源保持不变',
			}
		})
	}
	undoRemove = (): boolean => {
		if (!this.removal || this.removal.playlistId !== this.state.currentId)
			return false
		try {
			this.store.undoRemove(this.removal.receipt)
			this.removal = null
			this.update({
				undoAvailable: false,
				notice: '已恢复本次移除的条目',
				error: '',
			})
			this.refresh()
			return true
		} catch (error) {
			if (error instanceof PlaylistUndoExpiredError) {
				this.removal = null
				this.update({ undoAvailable: false })
			}
			this.fail(error)
			return false
		}
	}

	openAdd = (sources?: Source[]) => {
		if (!this.state.detail) return
		try {
			const known = sources ?? this.library.musicLikes()
			this.update({
				picker: this.pickerFor(known),
				targetSources: null,
				coverForm: null,
				nameForm: null,
				deleting: false,
				error: '',
			})
		} catch (error) {
			this.fail(error)
		}
	}
	private pickerFor(sources: Source[]): PlaylistPicker {
		return {
			sources: [
				...new Map(sources.map((source) => [source.id, source])).values(),
			],
			selectedSourceIds: [],
			query: '',
			duplicatePolicy: null,
		}
	}
	requestAddSources = (sources: Source[]) => {
		if (!sources.length) return
		this.update({
			targetSources: sources,
			picker: null,
			coverForm: null,
			nameForm: null,
			deleting: false,
			error: '',
		})
		this.refresh()
	}
	selectTarget = (id: string) => {
		const sources = this.state.targetSources
		if (!sources) return
		this.open(id)
		if (this.state.detail) this.openAdd(sources)
		else this.update({ targetSources: sources })
	}
	setPickerQuery = (query: string) => {
		if (this.state.picker)
			this.update({ picker: { ...this.state.picker, query } })
	}
	toggleSource = (sourceId: string) => {
		const picker = this.state.picker
		if (!picker?.sources.some((source) => source.id === sourceId)) return
		const selected = picker.selectedSourceIds
		this.update({
			picker: {
				...picker,
				selectedSourceIds: selected.includes(sourceId)
					? selected.filter((id) => id !== sourceId)
					: [...selected, sourceId],
			},
			error: '',
		})
	}
	setDuplicatePolicy = (duplicatePolicy: PlaylistDuplicatePolicy) => {
		if (this.state.picker)
			this.update({
				picker: { ...this.state.picker, duplicatePolicy },
				error: '',
			})
	}
	appendSelected = (): boolean => {
		const { detail, picker } = this.state
		if (!detail || !picker || !picker.selectedSourceIds.length) return false
		const selectedIds = new Set(picker.selectedSourceIds)
		const selected = picker.sources.filter((source) =>
			selectedIds.has(source.id),
		)
		if (!picker.duplicatePolicy) {
			this.fail(new Error('请选择如何处理歌单里已有的音源'))
			return false
		}
		return this.commit(() => {
			const result = this.store.append(
				detail.id,
				selected.map((source) => ({ source, itemId: this.createId() })),
				picker.duplicatePolicy!,
			)
			if (result.added.length) this.invalidateUndo(detail.id)
			return {
				picker: null,
				notice: `已添加 ${result.added.length} 项${result.skippedItemIds.length ? `，跳过 ${result.skippedItemIds.length} 项已有音源` : ''}`,
			}
		})
	}
	requestDelete = () => {
		if (this.state.detail)
			this.update({ deleting: true, nameForm: null, picker: null, error: '' })
	}
	confirmDelete = (): boolean => {
		const detail = this.state.detail
		if (!detail || !this.state.deleting) return false
		return this.commit(() => {
			const deleted = this.store.delete(detail.id)
			this.invalidateUndo(detail.id)
			return {
				currentId: null,
				detail: null,
				detailQuery: '',
				detailFilter: 'all',
				editing: false,
				selectedItemIds: [],
				deleting: false,
				undoAvailable: false,
				notice: deleted ? '歌单已删除，喜欢与音源保持不变' : '这张歌单已不存在',
			}
		})
	}
}
