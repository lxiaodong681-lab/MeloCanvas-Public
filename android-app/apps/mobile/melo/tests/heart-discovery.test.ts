import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BilibiliRequestRestrictedError } from '../bilibili-request-error'
import { readHeartProfile, sampleHeartSeeds } from '../core/heart-profile'
import type { SearchItem } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import { FmSession } from '../fm-session'
import { discoverHeart } from '../heart-discovery'

import { fmFixture, fmSource, deferred } from './fm-test-fixture'

void test('all lists contribute equally, repeated items do not dominate, history stays weak and UP names are not artist seeds', (t) => {
	const f = fmFixture(t, 3),
		playlists = new PlaylistStore(f.db)
	playlists.create('small', 'private list name')
	playlists.create('big', 'another private name')
	playlists.append(
		'small',
		[
			{ itemId: 'a', source: fmSource(1) },
			{ itemId: 'b', source: fmSource(1) },
		],
		'keep-all',
	)
	playlists.append('big', [{ itemId: 'c', source: fmSource(2) }], 'keep-all')
	const profile = readHeartProfile(
		f.db,
		Array.from({ length: 100 }, () => ({
			sourceId: fmSource(3).id,
			title: 'history',
			artist: 'UP',
			artwork: '',
			playedAt: 1,
		})),
	)
	assert.equal(profile.playlistCount, 2)
	assert.deepEqual(
		profile.seeds.map((seed) => seed.weight),
		[5, 5, 0.5],
	)
	assert.equal(
		profile.seeds.some((seed) => /UP|private/.test(seed.query)),
		false,
	)
	assert.equal(
		sampleHeartSeeds(profile, () => 0)[0].query,
		fmSource(2).originalTitle,
	)
	assert.equal(
		sampleHeartSeeds(profile, () => 0).length,
		1,
		'a weak history tail must not become mandatory after other seeds are removed',
	)
})

const item = (id: number, category = '翻唱'): SearchItem => ({
	bvid: `BV00000000${String(id).padStart(2, '0')}`,
	originalTitle: '合成音乐',
	uploader: 'UP',
	uploaderId: 1,
	artwork: '',
	duration: 120,
	category,
})
const profile = {
	seeds: [
		{ query: '甲', weight: 5, origin: 'playlist' as const },
		{ query: '乙', weight: 5, origin: 'playlist' as const },
	],
	knownBvids: [item(1).bvid],
	playlistCount: 2,
}
void test('heart discovery sends bounded keywords, removes known/duplicate/nonmusic videos, and returns playable identities without writes', async () => {
	let draw = 0
	const queries: string[] = [],
		details: string[] = []
	const result = await discoverHeart(
		profile,
		async (query) => {
			queries.push(query)
			return {
				items: [item(1), item(2), item(2), item(3, '知识'), item(4)],
				more: false,
			}
		},
		async (bvid) => {
			details.push(bvid)
			return { ...fmSource(1), bvid, id: `bilibili:${bvid}:1` }
		},
		new AbortController().signal,
		() => [0, 0.9, 0.5][draw++ % 3],
	)
	assert.deepEqual(queries, ['甲', '乙'])
	assert.deepEqual(details, [item(2).bvid, item(4).bvid])
	assert.equal(result.sources.length, 2)
})
void test('source restriction stops the entire batch; cancellation cannot return delayed candidates', async () => {
	let calls = 0
	const result = await discoverHeart(
		profile,
		async () => {
			calls++
			throw new BilibiliRequestRestrictedError()
		},
		async () => fmSource(1),
		new AbortController().signal,
	)
	assert.equal(calls, 1)
	assert.match(result.message, /受限/)
	const abort = new AbortController()
	await assert.rejects(
		discoverHeart(
			profile,
			async () => {
				abort.abort()
				return { items: [item(2)], more: false }
			},
			async () => fmSource(1),
			abort.signal,
		),
		/取消/,
	)
})
void test('FM heart preview never starts playback, cancellation suppresses stale network data, and confirmation uses displayed candidates', async (t) => {
	const f = fmFixture(t),
		batch = deferred<{
			sources: ReturnType<typeof fmSource>[]
			queries: string[]
			message: string
		}>()
	const session = new FmSession(f.store, f.intent, f.player, {
		discover: async () => batch.promise,
	})
	session.open()
	const pending = session.loadHeartCandidates()
	session.close()
	batch.resolve({
		sources: [fmSource(100)],
		queries: ['歌手'],
		message: 'done',
	})
	assert.equal(await pending, false)
	assert.equal(f.starts.length, 0)
	session.open()
	await session.loadHeartCandidates()
	assert.equal(f.starts.length, 0)
	await session.start(() => {})
	assert.deepEqual(f.starts[0].sources, [fmSource(100)])
})

void test('an initially empty daily snapshot fills after music is added on the same day', (t) => {
	const f = fmFixture(t, 0)
	assert.equal(f.store.load().items.length, 0)
	f.library.save(fmSource(1))
	assert.equal(f.store.load().items.length, 1)
})
