import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { creatorPosts } from '../creator-api'

import {
	FollowingFeedRefresh,
	emptyFeedRefresh,
} from '../following-feed-refresh'

import { feedFixture } from './following-feed-fixture'

void test('explicit refresh reads only local followed first page and preserves scope classification', async () => {
	const f = feedFixture()
	let state = emptyFeedRefresh()
	let calls = 0
	try {
		const refresh = new FollowingFeedRefresh(
			f.store,
			f.cache,
			async (mid, page) => {
				calls++
				assert.equal(mid, '88')
				assert.equal(page, 1)
				return {
					page: 1,
					more: false,
					total: 1,
					items: [{ ...f.post, title: '新投稿' }],
				}
			},
			(next) => (state = next),
			() => 1000,
		)
		assert.equal(calls, 0)
		await refresh.run()
		assert.equal(state.succeeded, 1)
		assert.equal(state.finishedAt, 1000)
		assert.equal(f.store.load().items[0].post.title, '新投稿')
		assert.equal(f.store.load().items[0].contentScope, 'unknown')
		await refresh.run()
		assert.equal(calls, 1)
		assert.equal(state.skipped, 1)
	} finally {
		f.raw.close()
	}
})
void test('failed refresh retains cache and backs off without automatic retries', async () => {
	const f = feedFixture()
	let state = emptyFeedRefresh()
	let calls = 0
	let now = 1000
	try {
		const refresh = new FollowingFeedRefresh(
			f.store,
			f.cache,
			async () => {
				calls++
				throw new Error('synthetic offline')
			},
			(next) => (state = next),
			() => now,
		)
		await refresh.run()
		assert.equal(state.failed, 1)
		assert.equal(state.errors[0].message, 'synthetic offline')
		assert.equal(f.cache.load('88')?.pages[0].items[0].title, f.post.title)
		await refresh.run()
		assert.equal(calls, 1)
		now += 60_000
		await refresh.run()
		assert.equal(calls, 2)
	} finally {
		f.raw.close()
	}
})
void test('late response after cancellation cannot write cache or publish completion', async () => {
	const f = feedFixture()
	let state = emptyFeedRefresh()
	let resolve!: (value: Awaited<ReturnType<typeof creatorPosts>>) => void
	try {
		const refresh = new FollowingFeedRefresh(
			f.store,
			f.cache,
			() => new Promise((yes) => (resolve = yes)),
			(next) => (state = next),
		)
		const run = refresh.run()
		refresh.cancel()
		const before = state
		resolve({
			page: 1,
			more: false,
			total: 1,
			items: [{ ...f.post, title: '旧响应' }],
		})
		await run
		assert.equal(state, before)
		assert.equal(f.cache.load('88')?.pages[0].items[0].title, f.post.title)
	} finally {
		f.raw.close()
	}
})
void test('concurrent cache change rejects stale result and keeps newer page', async () => {
	const f = feedFixture()
	let state = emptyFeedRefresh()
	try {
		const refresh = new FollowingFeedRefresh(
			f.store,
			f.cache,
			async () => {
				f.cache.savePage(
					'88',
					{
						page: 1,
						more: false,
						total: 1,
						items: [{ ...f.post, title: 'newer' }],
					},
					200,
					f.cache.load('88')!.revision,
				)
				return { page: 1, more: false, total: 1, items: [f.post] }
			},
			(next) => (state = next),
		)
		await refresh.run()
		assert.equal(state.failed, 1)
		assert.equal(f.cache.load('88')?.pages[0].items[0].title, 'newer')
	} finally {
		f.raw.close()
	}
})

void test('first-page budget remains partial when platform reports later pages', async () => {
	const f = feedFixture()
	let calls = 0
	try {
		const refresh = new FollowingFeedRefresh(
			f.store,
			f.cache,
			async () => {
				calls++
				return {
					page: 1,
					more: true,
					total: 60,
					items: Array.from({ length: 30 }, (_, i) => ({
						...f.post,
						bvid: `BV${String(i).padStart(10, '0')}`,
					})),
				}
			},
			() => {},
		)
		await refresh.run()
		assert.equal(calls, 1)
		assert.equal(f.cache.load('88')?.complete, false)
		assert.equal(f.store.load().subscriptions[0].status, 'partial')
	} finally {
		f.raw.close()
	}
})

void test('unfollowing during a response prevents commit and never imports remote follows', async () => {
	const f = feedFixture()
	let state = emptyFeedRefresh()
	try {
		const revision = f.cache.load('88')!.revision
		const refresh = new FollowingFeedRefresh(
			f.store,
			f.cache,
			async () => {
				f.creators.unfollow('local', '88')
				return {
					page: 1,
					more: false,
					total: 1,
					items: [{ ...f.post, title: 'late' }],
				}
			},
			(next) => (state = next),
		)
		await refresh.run()
		assert.equal(state.succeeded, 0)
		assert.equal(state.skipped, 1)
		assert.equal(f.cache.load('88')!.revision, revision)
		assert.equal(f.store.load().subscriptions.length, 0)
	} finally {
		f.raw.close()
	}
})
