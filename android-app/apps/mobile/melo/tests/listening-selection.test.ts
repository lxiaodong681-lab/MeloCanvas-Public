import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PlaybackMode } from '../core/listening'
import type { SearchItem, Source } from '../core/model'
import { selectListening } from '../listening-selection'
import { parseListeningVideo } from '../listening-source'

const video = parseListeningVideo(
	{
		bvid: 'BV1vT411i7ET',
		title: '原视频',
		pic: 'https://i0.hdslb.com/a.jpg',
		owner: { name: 'UP', mid: 8 },
		pages: [
			{ cid: 123, page: 1, part: '开场', duration: 50 },
			{ cid: 456, page: 2, part: '后续', duration: 60 },
		],
	},
	'BV1vT411i7ET',
)
const result: SearchItem = { ...video.parts[0].source, category: '知识' }
// Search results carry no CID; existing saved sources do.
const {
	bvid,
	originalTitle,
	uploader,
	uploaderId,
	artwork,
	duration,
	category,
} = result
const item: SearchItem = {
	bvid,
	originalTitle,
	uploader,
	uploaderId,
	artwork,
	duration,
	category,
}

function setup(mode: PlaybackMode = 'music', playing = true) {
	let confirmations = 0
	const played: { source: Source; related: Source[] }[] = []
	const actions = {
		load: async () => video,
		current: () => ({ mode, playing }),
		confirm: async () => {
			confirmations++
			return true
		},
		play: async (source: Source, related: Source[]) => {
			played.push({ source, related })
			return true
		},
	}
	return { actions, played, confirmations: () => confirmations }
}

void test('播放中的音乐先确认，再提交本 BV 的完整明确队列', async () => {
	const state = setup()
	const value = await selectListening(
		item,
		new AbortController().signal,
		state.actions,
	)
	assert.equal(value, video)
	assert.equal(state.confirmations(), 1)
	assert.equal(state.played[0].source.cid, 123)
	assert.deepEqual(
		state.played[0].related.map((source) => source.cid),
		[123, 456],
	)
	assert.ok(
		state.played[0].related.every(
			(source) => source.bvid === item.bvid && source.domain === 'unclassified',
		),
	)
})

void test('音乐暂停和已在听视频时无需确认；续听严格选原 CID', async () => {
	for (const [mode, playing] of [
		['music', false],
		['listening', true],
	] as const) {
		const state = setup(mode, playing)
		await selectListening(
			video.parts[1].source,
			new AbortController().signal,
			state.actions,
		)
		assert.equal(state.confirmations(), 0)
		assert.equal(state.played[0].source.cid, 456)
	}
})

void test('取消确认、失效分 P、预检失败都不调用播放器', async () => {
	const state = setup()
	assert.equal(
		await selectListening(item, new AbortController().signal, {
			...state.actions,
			confirm: async () => false,
		}),
		null,
	)
	await assert.rejects(
		selectListening(
			{ ...video.parts[0].source, cid: 999 },
			new AbortController().signal,
			state.actions,
		),
		/分 P 已变更/,
	)
	await assert.rejects(
		selectListening(item, new AbortController().signal, {
			...state.actions,
			load: async () => {
				throw new Error('offline')
			},
		}),
		/offline/,
	)
	assert.equal(state.played.length, 0)
})

void test('预检结束或确认后取消的旧请求不会提交播放器', async () => {
	for (const stage of ['before', 'loaded', 'confirmed']) {
		const state = setup()
		const controller = new AbortController()
		if (stage === 'before') controller.abort()
		const value = await selectListening(item, controller.signal, {
			...state.actions,
			load: async () => {
				if (stage === 'loaded') controller.abort()
				return video
			},
			confirm: async () => {
				if (stage === 'confirmed') controller.abort()
				return true
			},
		})
		assert.equal(value, null)
		assert.equal(state.played.length, 0)
	}
})

void test('原生切换失败或提交完成前取消不会被UI视作成功', async () => {
	const state = setup('music', false)
	const controller = new AbortController()
	assert.equal(
		await selectListening(item, controller.signal, {
			...state.actions,
			play: async () => false,
		}),
		null,
	)
	assert.equal(
		await selectListening(item, controller.signal, {
			...state.actions,
			play: async () => {
				controller.abort()
				return true
			},
		}),
		null,
	)
})
