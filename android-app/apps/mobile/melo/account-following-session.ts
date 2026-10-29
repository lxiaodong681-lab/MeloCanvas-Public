import he from 'he'

import { AccountSessionError, type AccountSession } from './account-session'
import { request } from './bilibili'
import type { Creator, CreatorScope, CreatorStore } from './core/creators'

type Account = Pick<
	AccountSession,
	'getSnapshot' | 'getGeneration' | 'subscribe'
>
type Store = Pick<CreatorStore, 'listSubscriptions' | 'saveCreator' | 'follow'>

export interface AccountFollowingPageData {
	items: Creator[]
	page: number
	total: number
	more: boolean
}
export interface AccountFollowingState {
	open: boolean
	accountName: string
	items: Creator[]
	selectedMids: string[]
	existingMids: string[]
	scope: CreatorScope
	page: number
	total: number | null
	more: boolean
	loading: boolean
	failedPage: number | null
	error: string
	notice: string
	review: { items: Creator[]; scope: CreatorScope } | null
}

const pageSize = 50
const invalid = () => new Error('B 站关注列表响应异常，请稍后重试')
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw invalid()
	return value as Record<string, unknown>
}
function normalizeMid(value: unknown): string {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
		return String(value)
	if (
		typeof value === 'string' &&
		/^[1-9][0-9]*$/.test(value) &&
		value.trim() === value
	)
		return value
	throw invalid()
}
function text(value: unknown, allowEmpty = false): string {
	if (typeof value !== 'string') throw invalid()
	const result = he.decode(value.replace(/<[^>]*>/g, '')).trim()
	if (!allowEmpty && !result) throw invalid()
	return result
}
function avatar(value: unknown): string | undefined {
	if (value === '' || value === undefined || value === null) return undefined
	if (typeof value !== 'string') throw invalid()
	const normalized = value.startsWith('//')
		? `https:${value}`
		: value.replace(/^http:/, 'https:')
	try {
		const url = new URL(normalized)
		if (
			url.protocol !== 'https:' ||
			!url.hostname ||
			url.username ||
			url.password
		)
			throw invalid()
	} catch {
		throw invalid()
	}
	return normalized
}

/** Adapt BBPlayer's existing getFollowings response to the local Creator model. */
export function parseAccountFollowings(
	value: unknown,
	page: number,
	fetchedAt = Date.now(),
): AccountFollowingPageData {
	if (
		!Number.isSafeInteger(page) ||
		page < 1 ||
		!Number.isSafeInteger(page * pageSize)
	)
		throw invalid()
	if (!Number.isSafeInteger(fetchedAt) || fetchedAt < 0) throw invalid()
	const data = record(value)
	if (
		typeof data.total !== 'number' ||
		!Number.isSafeInteger(data.total) ||
		data.total < 0
	)
		throw invalid()
	const list = data.list === null ? [] : data.list
	if (
		!Array.isArray(list) ||
		list.length > pageSize ||
		list.length > data.total
	)
		throw invalid()
	const seen = new Set<string>()
	const items = list.map((entry) => {
		const item = record(entry),
			creatorMid = normalizeMid(item.mid)
		if (seen.has(creatorMid)) throw invalid()
		seen.add(creatorMid)
		return {
			source: 'bilibili' as const,
			mid: creatorMid,
			name: text(item.uname),
			avatar: avatar(item.face),
			bio: item.sign === undefined ? undefined : text(item.sign, true),
			fetchedAt,
		}
	})
	return {
		items,
		page,
		total: data.total,
		more: items.length > 0 && page * pageSize < data.total,
	}
}

/** Uses the configured account transport; no cookie is exposed to this feature. */
export async function readAccountFollowings(
	account: Account,
	page: number,
	signal: AbortSignal,
): Promise<AccountFollowingPageData> {
	const before = account.getSnapshot()
	if (before.status !== 'authenticated' || !before.account)
		throw new AccountSessionError('signed-out')
	const accountMid = normalizeMid(before.account.mid),
		generation = account.getGeneration()
	if (
		!Number.isSafeInteger(page) ||
		page < 1 ||
		!Number.isSafeInteger(page * pageSize)
	)
		throw invalid()
	const query = new URLSearchParams({
		vmid: accountMid,
		pn: String(page),
		ps: String(pageSize),
	})
	// Same endpoint and pagination as BBPlayer getFollowings. It only reads.
	const data = await request<unknown>(`/x/relation/followings?${query}`, signal)
	const after = account.getSnapshot()
	if (
		signal.aborted ||
		generation !== account.getGeneration() ||
		after.status !== 'authenticated' ||
		after.account?.mid !== accountMid
	)
		throw new AccountSessionError('stale-session')
	return parseAccountFollowings(data, page)
}

const empty = (open = false): AccountFollowingState => ({
	open,
	accountName: '',
	items: [],
	selectedMids: [],
	existingMids: [],
	scope: 'all',
	page: 0,
	total: null,
	more: false,
	loading: false,
	failedPage: null,
	error: '',
	notice: '',
	review: null,
})

/** Account following is an in-memory picker. Only confirmImport writes local follows. */
export class AccountFollowingSession {
	private state = empty()
	private listeners = new Set<() => void>()
	private controller: AbortController | null = null
	private identity: { mid: string; generation: number } | null = null
	private unsubscribeAccount: (() => void) | null = null
	constructor(
		private store: Store,
		private account: Account,
		private read = readAccountFollowings,
		private profileId = 'local',
	) {}
	getSnapshot = (): AccountFollowingState => this.state
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private update(change: Partial<AccountFollowingState>) {
		this.state = { ...this.state, ...change }
		for (const listener of this.listeners) listener()
	}
	private current(): boolean {
		const state = this.account.getSnapshot()
		return (
			!!this.identity &&
			state.status === 'authenticated' &&
			state.account?.mid === this.identity.mid &&
			this.account.getGeneration() === this.identity.generation
		)
	}
	private invalidateAccount = () => {
		if (this.current()) return
		this.controller?.abort()
		this.controller = null
		this.identity = null
		this.state = empty(this.state.open)
		this.update({ error: '账号状态已变更，请返回后重新打开关注导入' })
	}
	close = () => {
		this.controller?.abort()
		this.controller = null
		this.identity = null
		this.unsubscribeAccount?.()
		this.unsubscribeAccount = null
		this.state = empty()
		this.update({})
	}
	open = async (): Promise<void> => {
		this.close()
		this.state = empty(true)
		const account = this.account.getSnapshot()
		if (account.status !== 'authenticated' || !account.account) {
			this.update({ error: '关注导入需要联网核验 B 站账号，请联网后重试' })
			return
		}
		this.identity = {
			mid: account.account.mid,
			generation: this.account.getGeneration(),
		}
		this.unsubscribeAccount = this.account.subscribe(this.invalidateAccount)
		this.update({ accountName: account.account.name })
		await this.load(1)
	}
	private async load(page: number): Promise<void> {
		if (
			!this.state.open ||
			this.state.loading ||
			this.state.review ||
			!this.current()
		)
			return
		const controller = new AbortController()
		this.controller = controller
		this.update({ loading: true, failedPage: null, error: '' })
		try {
			const response = await this.read(this.account, page, controller.signal)
			if (
				this.controller !== controller ||
				controller.signal.aborted ||
				!this.current()
			)
				return
			if (response.page !== page) throw invalid()
			const previous = page === 1 ? [] : this.state.items
			const seen = new Set(previous.map((creator) => creator.mid))
			const added = response.items.filter((creator) => !seen.has(creator.mid))
			const existingMids = this.store
				.listSubscriptions(this.profileId)
				.map((item) => item.creatorMid)
			this.update({
				items: [...previous, ...added],
				existingMids,
				selectedMids: this.state.selectedMids.filter(
					(mid) => !existingMids.includes(mid),
				),
				page,
				total: response.total,
				more: response.more && added.length > 0,
				notice:
					response.more && added.length === 0
						? 'B 站未返回更多条目，已显示本次可读取的关注。'
						: '',
			})
		} catch (error) {
			if (
				this.controller !== controller ||
				controller.signal.aborted ||
				!this.current()
			)
				return
			this.update({
				failedPage: page,
				error:
					error instanceof AccountSessionError
						? error.message
						: '读取 B 站关注失败，请检查网络或本地存储后重试',
			})
		} finally {
			if (this.controller === controller) {
				this.controller = null
				this.update({ loading: false })
			}
		}
	}
	loadMore = async (): Promise<void> => {
		if (this.state.more && this.state.failedPage === null)
			await this.load(this.state.page + 1)
	}
	retry = async (): Promise<void> => {
		if (this.state.failedPage !== null) await this.load(this.state.failedPage)
	}
	toggle = (creatorMid: string): void => {
		if (
			!this.current() ||
			this.state.loading ||
			this.state.review ||
			this.state.existingMids.includes(creatorMid) ||
			!this.state.items.some((item) => item.mid === creatorMid)
		)
			return
		this.update({
			selectedMids: this.state.selectedMids.includes(creatorMid)
				? this.state.selectedMids.filter((mid) => mid !== creatorMid)
				: [...this.state.selectedMids, creatorMid],
			notice: '',
		})
	}
	setScope = (scope: CreatorScope): void => {
		if (
			!this.current() ||
			this.state.review ||
			!['all', 'music', 'listening'].includes(scope)
		)
			return
		this.update({ scope })
	}
	requestImport = (): boolean => {
		if (!this.current() || this.state.loading || this.state.review) return false
		const items = this.state.items.filter(
			(item) =>
				this.state.selectedMids.includes(item.mid) &&
				!this.state.existingMids.includes(item.mid),
		)
		if (!items.length) return false
		this.update({
			review: { items, scope: this.state.scope },
			error: '',
			notice: '',
		})
		return true
	}
	cancelReview = (): void => {
		this.update({ review: null })
	}
	confirmImport = (): number => {
		const review = this.state.review
		if (!review || !this.current()) return 0
		// Consume this explicit confirmation before mutations, preventing duplicate submits.
		this.update({ review: null })
		if (!this.current()) return 0
		let created = 0
		const completed = new Set<string>()
		let existingMids: string[]
		try {
			existingMids = this.store
				.listSubscriptions(this.profileId)
				.map((item) => item.creatorMid)
			for (const creator of review.items) {
				if (!existingMids.includes(creator.mid)) {
					this.store.saveCreator(creator)
					const result = this.store.follow({
						profileId: this.profileId,
						creatorMid: creator.mid,
						scope: review.scope,
						origin: 'biliImport',
					})
					if (result.created) created++
					existingMids.push(creator.mid)
				}
				completed.add(creator.mid)
			}
			this.update({
				existingMids,
				selectedMids: this.state.selectedMids.filter(
					(mid) => !completed.has(mid),
				),
				error: '',
				notice: `已导入 ${created} 位 UP 主到音绘关注；以后可在音绘中独立管理。`,
			})
		} catch {
			this.update({
				existingMids: [...new Set([...this.state.existingMids, ...completed])],
				selectedMids: this.state.selectedMids.filter(
					(mid) => !completed.has(mid),
				),
				error: `音绘关注保存未完成，已成功导入 ${created} 位；其余选择已保留，请检查存储后重试。`,
			})
		}
		return created
	}
}
