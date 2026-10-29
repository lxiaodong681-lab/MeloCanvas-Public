import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import {
	listeningSourceDetails,
	parseListeningVideo,
} from '../listening-source'

const originalFetch = globalThis.fetch
after(() => {
	globalThis.fetch = originalFetch
})

const bvid = 'BV1vT411i7ET'
const video = {
	bvid,
	cid: 123,
	title: '真实原标题 &amp; 讲解',
	pic: '//i0.hdslb.com/example.jpg',
	duration: 900,
	owner: { name: '真实 UP', mid: 88 },
	pages: [
		{ cid: 123, page: 1, part: '第一部分 &amp; 开场', duration: 310 },
		{ cid: 456, page: 2, part: '第二部分', duration: 590 },
	],
}

void test('真实 view pages 使用各 CID、名称、顺序和独立时长，不改 Source 语义', () => {
	const parsed = parseListeningVideo(video, bvid)
	assert.equal(parsed.title, '真实原标题 & 讲解')
	assert.equal(parsed.uploader, '真实 UP')
	assert.deepEqual(
		parsed.parts.map((part) => [
			part.source.id,
			part.page,
			part.title,
			part.source.duration,
		]),
		[
			['bilibili:BV1vT411i7ET:123', 1, '第一部分 & 开场', 310],
			['bilibili:BV1vT411i7ET:456', 2, '第二部分', 590],
		],
	)
	for (const part of parsed.parts) {
		assert.equal(part.source.originalTitle, parsed.title)
		assert.equal(part.source.uploader, '真实 UP')
		assert.equal(part.source.performer, null)
		assert.equal(part.source.domain, 'unclassified')
		assert.equal(part.source.audioAvailability, 'unknown')
		assert.equal(part.source.artwork, 'https://i0.hdslb.com/example.jpg')
		assert.equal('url' in part.source, false)
	}
})

void test('按明确 page 排序，已知单 P 及未知时长零值仍可用', () => {
	const parsed = parseListeningVideo(
		{ ...video, pages: video.pages.toReversed() },
		bvid,
	)
	assert.deepEqual(
		parsed.parts.map((part) => part.source.cid),
		[123, 456],
	)
	assert.equal(
		parseListeningVideo(
			{ ...video, pages: [{ ...video.pages[0], duration: 0 }] },
			bvid,
		).parts[0].source.duration,
		0,
	)
})

void test('无 pages 不以顶层 CID 伪造分 P；残缺、重复、坏身份和坏时长拒绝', () => {
	assert.throws(
		() => parseListeningVideo({ ...video, videos: 3 }, bvid),
		/分 P 列表不完整/,
	)
	for (const pages of [
		undefined,
		[],
		[null],
		[{ ...video.pages[0], cid: 0 }],
		[{ ...video.pages[0], cid: Number.MAX_SAFE_INTEGER + 1 }],
		[{ ...video.pages[0], duration: -1 }],
		[{ ...video.pages[0], duration: NaN }],
		[{ ...video.pages[0], duration: Infinity }],
		[{ ...video.pages[0], page: 2 }],
		[video.pages[0], { ...video.pages[1], cid: 123 }],
		[video.pages[0], { ...video.pages[1], page: 1 }],
	])
		assert.throws(() => parseListeningVideo({ ...video, pages }, bvid), /分 P/)
})

void test('valid pages without a display name use their real page number and preserve source identity', () => {
	for (const name of ['', '   ', null, undefined, '<br/>']) {
		const parsed = parseListeningVideo({ ...video, pages: [{ ...video.pages[0], part: name }] }, bvid)
		assert.equal(parsed.parts[0].title, '第 1 P')
		assert.equal(parsed.parts[0].page, 1)
		assert.equal(parsed.parts[0].source.id, `bilibili:${bvid}:123`)
		assert.equal(parsed.parts[0].source.originalTitle, '真实原标题 & 讲解')
	}
})

void test('身份不符、缺少原标题/UP或封面不能作为另一视频进入队列', () => {
	assert.throws(() => parseListeningVideo(video, 'BV0000000000'), /身份不匹配/)
	for (const invalid of [
		null,
		{ ...video, title: '' },
		{ ...video, owner: { name: '', mid: 88 } },
		{ ...video, owner: { name: 'UP', mid: 0 } },
		{ ...video, pic: 'javascript:alert(1)' },
	])
		assert.throws(() => parseListeningVideo(invalid, bvid))
})

void test('分 P 请求复用游客 view 读取，平台失败和取消不产生假列表', async () => {
	let calls = 0
	globalThis.fetch = async (input, init) => {
		calls++
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url
		assert.equal(
			url,
			`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
		)
		assert.equal(init?.credentials, 'omit')
		return new Response(JSON.stringify({ code: 0, data: video }), {
			status: 200,
		})
	}
	assert.equal((await listeningSourceDetails(bvid)).parts.length, 2)
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(listeningSourceDetails(bvid, controller.signal), /取消/)
	assert.equal(calls, 1)
	await assert.rejects(listeningSourceDetails('invalid'), /BV/)
	assert.equal(calls, 1)
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({ code: -404, message: 'not available', data: null }),
			{ status: 200 },
		)
	await assert.rejects(listeningSourceDetails(bvid), /-404/)
	globalThis.fetch = async () => {
		throw new TypeError('Network request failed')
	}
	await assert.rejects(listeningSourceDetails(bvid), /网络/)
})
