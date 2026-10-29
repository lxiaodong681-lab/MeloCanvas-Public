import {
	BilibiliContentScopeReader,
	type BilibiliContentScope,
} from './bilibili-content-scope'
import { CreatorPostCache } from './creator-post-cache'
import { CreatorStore, type CreatorScope } from './creators'
import type { Database } from './database'
import type {
	FollowingContentScope,
	FollowingFeedOrigin,
	FollowingFeedItem,
	FollowingFeedSubscription,
	FollowingFeedSnapshot,
} from './following-feed-types'

const compare = (left: string, right: string) =>
	left < right ? -1 : left > right ? 1 : 0
const matches = (filter: CreatorScope, scope: FollowingContentScope) =>
	filter === 'all' || filter === scope
function newer(left: FollowingFeedOrigin, right: FollowingFeedOrigin) {
	return (
		right.fetchedAt - left.fetchedAt ||
		compare(left.subscription.creatorMid, right.subscription.creatorMid) ||
		left.page - right.page
	)
}

/** Explicitly loaded public caches only. No network, writes, recommendations or playback. */
export class FollowingFeedStore {
	constructor(private readonly db: Database) {}
	load(
		profileId = 'local',
		filter: CreatorScope = 'all',
	): FollowingFeedSnapshot {
		if (!['all', 'music', 'listening'].includes(filter))
			throw new Error('关注更新筛选范围无效')
		this.db.execSync('BEGIN')
		try {
			const result = this.read(profileId, filter)
			this.db.execSync('COMMIT')
			return result
		} catch (error) {
			try {
				this.db.execSync('ROLLBACK')
			} catch {
				/* Preserve the original read/COMMIT failure. */
			}
			throw error
		}
	}
	private read(profileId: string, filter: CreatorScope): FollowingFeedSnapshot {
		const creators = new CreatorStore(this.db),
			cache = new CreatorPostCache(this.db)
		const subscriptions: FollowingFeedSubscription[] = []
		const observations: FollowingFeedOrigin[] = []
		const cachedBvids = new Set<string>()
		for (const subscription of creators.listSubscriptions(profileId)) {
			const creator = creators.getCreator(subscription.creatorMid)
			if (!creator) throw new Error('关注 UP 主资料缺失；原数据已保留。')
			const stored = cache.readInSnapshot(subscription.creatorMid)
			subscriptions.push({
				creator,
				subscription,
				status: !stored
					? 'uncached'
					: stored.total === 0
						? 'empty'
						: stored.complete
							? 'complete'
							: 'partial',
				cache: stored
					? {
							revision: stored.revision,
							lastPage: stored.lastPage,
							more: stored.more,
							total: stored.total,
							complete: stored.complete,
							pages: stored.pages.map((page) => ({
								page: page.page,
								fetchedAt: page.fetchedAt,
								itemCount: page.items.length,
							})),
						}
					: null,
			})
			for (const page of stored?.pages ?? [])
				for (const post of page.items) {
					cachedBvids.add(post.bvid)
					observations.push({
						creator,
						subscription,
						page: page.page,
						fetchedAt: page.fetchedAt,
						post,
					})
				}
		}
		const evidence = cachedBvids.size
			? new BilibiliContentScopeReader(this.db).readInSnapshot(cachedBvids)
			: new Map<string, BilibiliContentScope>()
		const items = new Map<string, FollowingFeedItem>()
		for (const origin of observations) {
			const { kinds = [], scope = 'unknown' } =
				evidence.get(origin.post.bvid) ?? {}
			if (!matches(origin.subscription.scope, scope) || !matches(filter, scope))
				continue
			let item = items.get(origin.post.bvid)
			if (!item) {
				item = {
					post: origin.post,
					contentScope: scope,
					contentKinds: kinds,
					origins: [],
				}
				items.set(origin.post.bvid, item)
			}
			item.origins.push(origin)
		}
		for (const item of items.values()) {
			item.origins.sort(newer)
			item.post = item.origins[0].post
		}
		const cachedSubscriptions = subscriptions.filter(
			(value) => value.cache !== null,
		).length
		return {
			profileId,
			filter,
			status: !subscriptions.length
				? 'no-subscriptions'
				: !cachedSubscriptions
					? 'uncached'
					: !cachedBvids.size
						? cachedSubscriptions < subscriptions.length
							? 'partial-empty'
							: 'empty'
						: !items.size
							? 'filtered-empty'
							: 'ready',
			items: [...items.values()].sort(
				(left, right) =>
					right.post.publishedAt - left.post.publishedAt ||
					compare(left.post.bvid, right.post.bvid),
			),
			subscriptions,
			coverage: {
				cachedSubscriptions,
				uncachedSubscriptions: subscriptions.length - cachedSubscriptions,
				partialSubscriptions: subscriptions.filter(
					(value) => value.status === 'partial',
				).length,
				cachedPostCount: cachedBvids.size,
			},
		}
	}
}
