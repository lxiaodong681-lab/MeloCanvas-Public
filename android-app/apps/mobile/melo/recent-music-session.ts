import type { RecentMusicHistoryEntry } from '@bbplayer/orpheus'

export interface RecentMusicState {
	open: boolean
	loading: boolean
	clearing: boolean
	confirmClear: boolean
	error: string
	items: RecentMusicHistoryEntry[]
	visibleCount: number
}

/** Reads the native service journal; never infers heard tracks from a prepared queue. */
export class RecentMusicSession {
	state: RecentMusicState = {
		open: false,
		loading: false,
		clearing: false,
		confirmClear: false,
		error: '',
		items: [],
		visibleCount: 20,
	}
	private generation = 0
	private disposed = false
	constructor(
		private read: () => Promise<RecentMusicHistoryEntry[]>,
		private changed: () => void,
		private clearHistory: () => Promise<void>,
	) {}
	open() {
		this.state = { ...this.state, open: true, visibleCount: 20 }
		void this.refresh()
	}
	close() {
		this.generation++
		this.state = {
			...this.state,
			open: false,
			loading: false,
			confirmClear: false,
		}
		this.changed()
	}
	activate() {
		this.disposed = false
	}
	dispose() {
		this.disposed = true
		this.generation++
	}
	showMore() {
		this.state = { ...this.state, visibleCount: this.state.visibleCount + 20 }
		this.changed()
	}
	requestClear() {
		if (this.state.clearing) return
		this.state = { ...this.state, confirmClear: true }
		this.changed()
	}
	cancelClear() {
		this.state = { ...this.state, confirmClear: false }
		this.changed()
	}
	async confirmClear() {
		if (!this.state.confirmClear || this.state.clearing || this.disposed) return
		++this.generation // Any earlier read must not restore the pre-clear list.
		this.state = {
			...this.state,
			clearing: true,
			confirmClear: false,
			loading: false,
			error: '',
		}
		this.changed()
		try {
			await this.clearHistory()
			if (this.disposed) return
			this.state = {
				...this.state,
				clearing: false,
				items: [],
				visibleCount: 20,
			}
			this.changed()
			// A new real playback event may have arrived while clearing. Read it, rather than
			// claiming that history must remain empty or dropping a concurrent event.
			await this.refresh()
		} catch {
			if (this.disposed) return
			this.state = {
				...this.state,
				clearing: false,
				error: '最近播放清空失败，原列表仍保留。请重试。',
			}
			this.changed()
		}
	}
	async refresh() {
		if (!this.state.open || this.state.clearing || this.disposed) return
		const generation = ++this.generation
		this.state = { ...this.state, loading: true, error: '' }
		this.changed()
		try {
			const items = await this.read()
			if (generation !== this.generation) return
			this.state = { ...this.state, items, loading: false }
		} catch {
			if (generation !== this.generation) return
			this.state = {
				...this.state,
				loading: false,
				error: '最近播放读取失败，已显示的记录仍保留。请重试。',
			}
		}
		this.changed()
	}
}
