import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	offlineState,
	offlinePlaybackTrack,
	offlineLimitBytes,
} from '../offline-state'
const track = {
	id: 'playlist-item:abc',
	sourceId: 'bilibili:BV1vT411i7ET:123',
	url: 'orpheus://bilibili?bvid=BV1vT411i7ET&cid=123&quality=30232',
	title: 'Synthetic fixture',
}
const task = {
	id: 'melo-offline:test',
	state: 3,
	percentDownloaded: 100,
	bytesDownloaded: 1234,
	contentLength: 1234,
	track,
}
void test('completed upstream state alone never promises offline availability', () => {
	assert.match(offlineState(task), /不完整/)
	assert.throws(() => offlinePlaybackTrack(task), /完整性/)
	assert.match(offlineState({ ...task, state: 2 }), /99%/)
	assert.match(offlineState({ ...task, state: 1, stopReason: 2 }), /网络已切换/)
	assert.match(offlineState({ ...task, state: 1, stopReason: 1 }), /已取消/)
})
void test('verified offline playback preserves actual source and quality, not queue occurrence', () => {
	const playable = offlinePlaybackTrack({ ...task, verifiedComplete: true })
	assert.equal(playable.sourceId, track.sourceId)
	assert.equal(playable.id, track.sourceId)
	assert.equal(playable.url, track.url + '&meloOffline=1')
	assert.equal(track.id, 'playlist-item:abc')
})
void test('unknown length or incomplete state cannot be played even with stale verification', () => {
	assert.throws(() =>
		offlinePlaybackTrack({
			...task,
			contentLength: -1,
			verifiedComplete: true,
		}),
	)
	assert.throws(() =>
		offlinePlaybackTrack({ ...task, state: 2, verifiedComplete: true }),
	)
})
void test('capacity requires finite explicit bounded input', () => {
	assert.equal(offlineLimitBytes('1'), 1024 ** 3)
	for (const value of ['', '-1', 'Infinity', 'NaN', '65', '0', '0.01', '1e2'])
		assert.throws(() => offlineLimitBytes(value))
})

void test('offline adapter pins the online source before open so loader retries cannot renew Wi-Fi ownership', async () => {
	const { readFileSync } = await import('node:fs')
	const source = readFileSync(new URL('../../../../packages/orpheus/android/src/main/java/expo/modules/orpheus/util/OfflinePlaybackDataSource.kt', import.meta.url), 'utf8')
	assert.equal(source.match(/online\.createDataSource\(\)/g)?.length, 1)
	assert.ok(source.indexOf('private val onlineOwner = OfflineUpstreamOwner { online.createDataSource() }') < source.indexOf('override fun open('))
	assert.match(source, /getReadOnlyCacheDataSource\(context\) else onlineOwner\.source/)
	assert.doesNotMatch(source.slice(source.indexOf('override fun open(')), /online\.createDataSource\(\)/)
})
