import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RecentMusicHistoryEntry } from '@bbplayer/orpheus'

import { RecentMusicSession } from '../recent-music-session'

const item: RecentMusicHistoryEntry = {
	sourceId: 'bilibili:BV1vT411i7ET:1',
	title: '一首歌',
	artist: 'UP · 投稿者',
	artwork: '',
	playedAt: 100,
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

void test('recent history only reads when opened, paginates without deleting, and closes safely', async () => {
	let reads = 0
	const items = Array.from({ length: 25 }, (_, index) => ({
		...item,
		sourceId: `${item.sourceId}${index}`,
	}))
	const session = new RecentMusicSession(
		async () => {
			reads++
			return items
		},
		() => {},
		async () => {},
	)
	await session.refresh()
	assert.equal(reads, 0)
	session.open()
	await turn()
	assert.equal(session.state.items.length, 25)
	assert.equal(session.state.visibleCount, 20)
	session.showMore()
	assert.equal(session.state.visibleCount, 40)
	session.close()
	assert.equal(session.state.open, false)
	assert.equal(session.state.items.length, 25)
})

void test('late reads cannot reopen a closed view or replace a newer refresh', async () => {
	const pending: ((items: RecentMusicHistoryEntry[]) => void)[] = []
	const session = new RecentMusicSession(
		() => new Promise((resolve) => pending.push(resolve)),
		() => {},
		async () => {},
	)
	session.open()
	session.close()
	session.open()
	pending[1]([{ ...item, title: '最新' }])
	await turn()
	pending[0]([item])
	await turn()
	assert.equal(session.state.items[0].title, '最新')
	const refresh = session.refresh()
	session.dispose()
	pending[2]([])
	await refresh
	assert.equal(session.state.items[0].title, '最新')
})

void test('failed refresh preserves previous history and exposes retryable error', async () => {
	let failed = false
	const session = new RecentMusicSession(
		async () => {
			if (failed) throw new Error('storage unavailable')
			return [item]
		},
		() => {},
		async () => {},
	)
	session.open()
	await turn()
	failed = true
	await session.refresh()
	assert.deepEqual(session.state.items, [item])
	assert.match(session.state.error, /读取失败/)
	assert.equal(session.state.loading, false)
	failed = false
	await session.refresh()
	assert.equal(session.state.error, '')
})

void test('clear requires confirmation, rejects stale reads and refreshes later playback', async () => {
	const reads: ((items: RecentMusicHistoryEntry[]) => void)[] = []
	let resolveClear: (() => void) | undefined
	let clears = 0
	const session = new RecentMusicSession(
		() => new Promise((resolve) => reads.push(resolve)),
		() => {},
		() => {
			clears++
			return new Promise((resolve) => {
				resolveClear = resolve
			})
		},
	)
	session.open()
	reads[0]([item])
	await turn()
	await session.confirmClear()
	assert.equal(clears, 0)
	session.requestClear()
	session.cancelClear()
	await session.confirmClear()
	assert.equal(clears, 0)
	void session.refresh() // old outstanding read
	session.requestClear()
	const clearing = session.confirmClear()
	await session.confirmClear()
	assert.equal(clears, 1)
	reads[1]([{ ...item, title: '旧记录' }])
	await turn()
	assert.equal(session.state.items[0].title, item.title)
	await session.refresh()
	assert.equal(reads.length, 2)
	resolveClear?.()
	await turn()
	assert.equal(session.state.items.length, 0)
	reads[2]([{ ...item, title: '清空后的新播放' }])
	await clearing
	assert.equal(session.state.items[0].title, '清空后的新播放')
	assert.equal(session.state.clearing, false)
})

void test('failed clear retains list and can retry; closing does not invent success', async () => {
	let fail = true
	let stored = [item]
	const session = new RecentMusicSession(
		async () => stored,
		() => {},
		async () => {
			if (fail) throw new Error('write failed')
			stored = []
		},
	)
	session.open()
	await turn()
	session.requestClear()
	await session.confirmClear()
	assert.deepEqual(session.state.items, [item])
	assert.match(session.state.error, /清空失败/)
	fail = false
	session.requestClear()
	const clearing = session.confirmClear()
	session.close()
	session.open()
	await clearing
	assert.equal(session.state.items.length, 0)
	assert.equal(session.state.error, '')
})
