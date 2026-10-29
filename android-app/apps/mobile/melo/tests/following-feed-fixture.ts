import { DatabaseSync } from 'node:sqlite'

import { CreatorPostCache } from '../core/creator-post-cache'
import { CreatorStore } from '../core/creators'
import { migrate, type Database } from '../core/database'
import { FollowingFeedStore } from '../core/following-feed'
import type { CreatorPostCandidate } from '../creator-api'
import { FollowingFeedSession } from '../following-feed-session'
export function feedFixture() {
	const raw = new DatabaseSync(':memory:')
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
	}
	migrate(db)
	const creators = new CreatorStore(db),
		cache = new CreatorPostCache(db),
		store = new FollowingFeedStore(db)
	const creator = creators.saveCreator({
		source: 'bilibili',
		mid: '88',
		name: '真实UP',
		fetchedAt: 1,
	})
	creators.follow({
		profileId: 'local',
		creatorMid: '88',
		scope: 'all',
		origin: 'manual',
	})
	const post: CreatorPostCandidate = {
		bvid: 'BV1vT411i7ET',
		title: '缓存原视频',
		artwork: 'https://example.invalid/not-fetched.jpg',
		duration: 300,
		publishedAt: 1700000000000,
		queryCreatorMid: '88',
	}
	cache.savePage(
		'88',
		{ items: [post], page: 1, more: false, total: 1 },
		100,
		null,
	)
	let reads = 0,
		failure: Error | null = null
	const session = new FollowingFeedSession({
		load: (profile, filter) => {
			reads++
			if (failure) throw failure
			return store.load(profile, filter)
		},
	})
	return {
		raw,
		creators,
		cache,
		store,
		creator,
		post,
		session,
		reads: () => reads,
		fail: (value: Error | null) => {
			failure = value
		},
	}
}
