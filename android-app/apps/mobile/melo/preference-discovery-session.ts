import type { search } from './bilibili'
import { BilibiliRequestRestrictedError } from './bilibili-request-error'
import {
	preferenceSeeds,
	type MusicPreferences,
} from './core/music-preferences'
import {
	preferenceCandidates,
	type PreferenceCandidate,
	type PreferenceResultBatch,
} from './preference-recommendation'
import { musicResults } from './search-session'

export interface PreferenceDiscoveryState {
	items: PreferenceCandidate[]
	loading: boolean
	error: string
	searched: boolean
	pendingSeeds: string[]
}
/** Explicit, bounded online recall. No autoplay, library writes or artist-identity claims. */
export class PreferenceDiscoverySession {
	private state: PreferenceDiscoveryState = {
		items: [],
		loading: false,
		error: '',
		searched: false,
		pendingSeeds: [],
	}
	private request: AbortController | null = null
	private seeds: string[] = []
	private results = new Map<string, PreferenceResultBatch>()
	private listeners = new Set<() => void>()
	constructor(private readonly fetchPage: typeof search) {}
	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private update(change: Partial<PreferenceDiscoveryState>) {
		this.state = { ...this.state, ...change }
		for (const listener of this.listeners) listener()
	}
	cancel = () => {
		this.request?.abort()
		this.request = null
		this.update({ loading: false })
	}
	reset = () => {
		this.cancel()
		this.seeds = []
		this.results.clear()
		this.update({ items: [], error: '', searched: false, pendingSeeds: [] })
	}
	load = async (preferences: MusicPreferences) => {
		const seeds = preferenceSeeds(preferences).slice(0, 3)
		if (JSON.stringify(seeds) !== JSON.stringify(this.seeds)) this.reset()
		this.seeds = seeds
		if (!seeds.length) {
			this.update({ error: '先选一种曲风或填写喜欢的歌手' })
			return
		}
		await this.run(seeds)
	}
	/** Retry only unfinished queries, never refetch successful queries implicitly. */
	retry = async () => {
		if (this.state.loading || !this.state.pendingSeeds.length) return
		await this.run([...this.state.pendingSeeds])
	}
	private publishItems() {
		this.update({ items: preferenceCandidates(this.seeds, this.results) })
	}
	private async run(seeds: string[]) {
		this.cancel()
		const controller = new AbortController()
		this.request = controller
		// Keep the last useful candidates until each individual query succeeds.
		this.update({
			loading: true,
			error: '',
			searched: true,
			pendingSeeds: seeds,
		})
		try {
			for (const seed of seeds) {
				try {
					const result = await this.fetchPage(
						seed,
						1,
						controller.signal,
						'relevance',
					)
					if (controller.signal.aborted || this.request !== controller) return
					this.results.set(seed, {
						items: musicResults(result.items).slice(0, 8),
						retrievedAt: Date.now(),
					})
					this.update({
						pendingSeeds: this.state.pendingSeeds.filter(
							(value) => value !== seed,
						),
					})
					this.publishItems()
				} catch (error) {
					if (controller.signal.aborted || this.request !== controller) return
					// A source restriction ends this run, including unattempted queries.
					// Only a later explicit user action may resume the pending seeds.
					if (error instanceof BilibiliRequestRestrictedError) {
						this.update({
							error:
								'B 站请求受限，已停止本轮查找，请稍后再试。已有结果仍可用，未完成项已保留。',
						})
						return
					}
					// Failed and not-yet-attempted seeds stay explicitly retryable.
				}
			}
			this.update({
				error: this.state.pendingSeeds.length
					? `暂时没能读取：${this.state.pendingSeeds.join('、')}。已有结果仍可用。`
					: '',
			})
		} finally {
			if (!controller.signal.aborted && this.request === controller) {
				this.request = null
				this.update({ loading: false })
			}
		}
	}
}
