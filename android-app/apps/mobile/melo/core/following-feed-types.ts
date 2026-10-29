import type { CreatorPostCandidate } from '../creator-api'

import type { Creator, CreatorScope, CreatorSubscription } from './creators'
import type { ContentKind } from './import-mixed-types'
export type FollowingContentScope = 'music' | 'listening' | 'unknown'
export interface FollowingFeedOrigin {
	creator: Creator
	subscription: CreatorSubscription
	page: number
	fetchedAt: number
	/** Query provenance is not ownership. ownerMid remains optional platform metadata. */
	post: CreatorPostCandidate
}
export interface FollowingFeedItem {
	/** Latest eligible cached observation; ties use creatorMid then page. */
	post: CreatorPostCandidate
	contentScope: FollowingContentScope
	/** Current explicit BV-level kinds; empty means no such evidence, not a song. */
	contentKinds: ContentKind[]
	/** Only origins eligible under their own subscription scope AND the requested filter. */
	origins: FollowingFeedOrigin[]
}
export interface FollowingFeedSubscription {
	creator: Creator
	subscription: CreatorSubscription
	status: 'uncached' | 'empty' | 'partial' | 'complete'
	cache: null | {
		revision: number
		lastPage: number
		more: boolean
		total: number
		complete: boolean
		pages: { page: number; fetchedAt: number; itemCount: number }[]
	}
}
export interface FollowingFeedSnapshot {
	profileId: string
	filter: CreatorScope
	/** Cache-only summary, never a claim of current platform completeness.
	 * empty: every subscription has a successful empty cache; partial-empty:
	 * known caches are empty but some subscriptions have never been cached.
	 * filtered-empty: cached posts exist but none meet both scopes. */
	status:
		| 'no-subscriptions'
		| 'uncached'
		| 'empty'
		| 'partial-empty'
		| 'filtered-empty'
		| 'ready'
	/** Deduplicated by BV, after BOTH the source subscription scope and page filter. */
	items: FollowingFeedItem[]
	subscriptions: FollowingFeedSubscription[]
	coverage: {
		cachedSubscriptions: number
		uncachedSubscriptions: number
		partialSubscriptions: number
		/** Distinct BVs in all followed caches, before either scope filter. Not a remote total. */
		cachedPostCount: number
	}
}
