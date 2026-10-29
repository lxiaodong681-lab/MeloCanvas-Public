import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { search, sourceDetails } from '../bilibili'
import type { SearchItem } from '../core/model'
import { musicResults, SearchSession } from '../search-session'

const originalFetch = globalThis.fetch
after(() => {
	globalThis.fetch = originalFetch
})
const response = (data: unknown, code = 0) =>
	new Response(
		JSON.stringify({ code, message: code ? 'not available' : '', data }),
		{ status: 200 },
	)

void test('游客关键词使用 WBI、保留原标题与 UP，过滤非视频课程', async () => {
	const calls: string[] = []
	globalThis.fetch = async (input, init) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url
		calls.push(url)
		assert.equal(init?.credentials, 'omit')
		if (url.includes('/finger/spi'))
			return response({ b_3: 'anonymous-device', b_4: '' })
		if (url.includes('/nav'))
			return response(
				{
					wbi_img: {
						img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`,
						sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png`,
					},
				},
				-101,
			)
		assert.match(url, /w_rid=[0-9a-f]{32}/)
		return response({
			numPages: 2,
			result: [
				{
					type: 'video',
					bvid: 'BV1vT411i7ET',
					title: '<em>歌</em> &amp; Live',
					author: '真实 UP',
					mid: 10,
					pic: '//i0.hdslb.com/a.jpg',
					duration: '03:21',
					typename: '音乐现场',
				},
				{ type: 'ketang', bvid: '', title: '课程' },
			],
		})
	}
	const result = await search('歌曲')
	assert.equal(result.items.length, 1)
	assert.equal(result.items[0].originalTitle, '歌 & Live')
	assert.equal(result.items[0].uploader, '真实 UP')
	assert.equal(result.items[0].duration, 201)
	assert.equal(result.items[0].artwork, 'https://i0.hdslb.com/a.jpg')
	assert.equal(result.more, true)
	assert.equal(calls.length, 3)
})

void test('空结果与平台/网络错误可区分', async () => {
	globalThis.fetch = async () => response({ result: [], numPages: 0 })
	assert.deepEqual(await search('no-result'), { items: [], more: false })
	globalThis.fetch = async () => response(null, -412)
	await assert.rejects(search('blocked'), /请求受限/)
	globalThis.fetch = async () => {
		throw new TypeError('Network request failed')
	}
	await assert.rejects(search('offline'), /网络/)
})

void test('游客风控voucher不是正常空或可补读shape，明确错误且不重复请求', async () => {
	for (const data of [
		{ v_voucher: 'fixture-challenge-not-for-display' },
		{
			v_voucher: 'fixture-challenge-not-for-display',
			result: [],
			numPages: 0,
			numResults: 0,
		},
	]) {
		let calls = 0
		globalThis.fetch = async () => {
			calls++
			return response(data)
		}
		await assert.rejects(search('游客风控'), (error: unknown) => {
			assert.ok(error instanceof Error)
			assert.match(error.message, /请求受限/)
			assert.ok(!error.message.includes('fixture-challenge-not-for-display'))
			return true
		})
		assert.equal(calls, 1, '已知风控载荷不触发不完整响应补读')
	}
})

void test('没有或空voucher字段不改变合法真空语义且不自动重试', async () => {
	for (const extra of [{}, { v_voucher: '' }]) {
		let calls = 0
		globalThis.fetch = async () => {
			calls++
			return response({ result: [], numPages: 0, numResults: 0, ...extra })
		}
		assert.deepEqual(await search('合法空'), { items: [], more: false })
		assert.equal(calls, 1)
	}
})

void test('风控沿生产search进入失败状态，用户显式重试后才重新请求', async () => {
	let calls = 0
	globalThis.fetch = async () => {
		calls++
		return response(
			calls === 1
				? { v_voucher: 'fixture-challenge-not-for-display' }
				: { result: [], numPages: 0, numResults: 0 },
		)
	}
	const session = new SearchSession(search)
	await session.find('关键词')
	assert.equal(calls, 1)
	assert.equal(session.getSnapshot().page, 0)
	assert.equal(session.getSnapshot().failedPage, 1)
	assert.match(session.getSnapshot().error, /请求受限/)
	assert.equal(session.getSnapshot().loading, false)
	await session.retry()
	assert.equal(calls, 2)
	assert.equal(session.getSnapshot().page, 1)
	assert.equal(session.getSnapshot().failedPage, null)
	assert.equal(session.getSnapshot().error, '')
	assert.deepEqual(session.getSnapshot().items, [])
})

void test('BV 详情以首个 CID 建身份，歌手留空，失效内容不入库', async () => {
	globalThis.fetch = async () =>
		response({
			bvid: 'BV1vT411i7ET',
			cid: 1,
			title: '原标题',
			pic: 'http://i0.hdslb.com/a.jpg',
			duration: 300,
			pages: [{ cid: 111, duration: 299 }],
			owner: { name: 'UP 主', mid: 10 },
		})
	const source = await sourceDetails('BV1vT411i7ET')
	assert.equal(source.id, 'bilibili:BV1vT411i7ET:111')
	assert.equal(source.duration, 299)
	assert.equal(source.performer, null)
	assert.equal(source.audioAvailability, 'unknown')
	assert.equal(source.artwork, 'https://i0.hdslb.com/a.jpg')
	globalThis.fetch = async () => response(null, -404)
	await assert.rejects(sourceDetails('BV0000000000'), /-404/)
})

void test('已取消的搜索不继续请求网络', async () => {
	let calls = 0
	globalThis.fetch = async (_input, init) => {
		calls++
		assert.equal(init?.signal?.aborted, true)
		throw new DOMException('aborted', 'AbortError')
	}
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(search('取消', 1, controller.signal), /取消/)
	assert.equal(calls, 0)
})

void test('缺失结果字段不能伪装为真实空结果', async () => {
	let calls = 0
	globalThis.fetch = async () => {
		calls++
		return response({ numPages: 1, numResults: 20 })
	}
	await assert.rejects(search('不完整响应'), /搜索响应异常/)
	assert.equal(calls, 2, '只对不完整响应补读一次')
})

void test('服务端声称当前页有结果但返回空数组时不能显示零条', async () => {
	globalThis.fetch = async () =>
		response({ result: [], numPages: 2, numResults: 30 })
	await assert.rejects(search('矛盾响应'), /搜索响应异常/)
})

const video = {
	type: 'video',
	bvid: 'BV1vT411i7ET',
	title: '音源',
	author: 'UP',
	mid: 1,
	pic: '//example.com/image.jpg',
	duration: '01:00',
	typename: 'MV',
}

void test('仅不完整响应补读一次，恢复后返回结果', async () => {
	let calls = 0
	globalThis.fetch = async () => {
		calls++
		return response(
			calls === 1 ? { numPages: 1 } : { result: [video], numPages: 1 },
		)
	}
	assert.equal((await search('补读')).items.length, 1)
	assert.equal(calls, 2)
})

void test('真实空、越界空页、网络、平台限制和坏 JSON 不自动重试', async () => {
	for (const data of [
		{ result: [], numPages: 0, numResults: 0 },
		{ result: [], numPages: 1, numResults: 20 },
	]) {
		let calls = 0
		globalThis.fetch = async () => {
			calls++
			return response(data)
		}
		assert.deepEqual(await search('空', 2), { items: [], more: false })
		assert.equal(calls, 1)
	}
	for (const failure of ['network', 'platform', 'http', 'json']) {
		let calls = 0
		globalThis.fetch = async () => {
			calls++
			if (failure === 'network') throw new TypeError('offline')
			if (failure === 'platform') return response(null, -412)
			if (failure === 'http') return new Response('', { status: 503 })
			return new Response('<html>blocked</html>')
		}
		await assert.rejects(search('失败'), /网络|请求受限|HTTP|响应无法读取/)
		assert.equal(calls, 1)
	}
})

void test('畸形数据和条目报响应异常，不伪装为无结果', async () => {
	for (const data of [
		null,
		{},
		{ result: {}, numPages: 0 },
		{ result: [], numPages: -1 },
		{ result: [], numPages: 0, numResults: 1 },
		{ result: [null], numPages: 1 },
		{ result: [video], numPages: 0 },
		{ result: [{ ...video, title: null }], numPages: 1 },
	]) {
		globalThis.fetch = async () => response(data)
		await assert.rejects(search('畸形'), /搜索响应异常/)
	}
})

void test('合法 JSON 中的异常响应外壳明确报错，不误标网络且不重试', async () => {
	for (const body of [
		null,
		[],
		{},
		{ data: {} },
		{ code: '0', data: {} },
		{ code: 0.5, data: {} },
	]) {
		let calls = 0
		globalThis.fetch = async () => {
			calls++
			return new Response(JSON.stringify(body))
		}
		await assert.rejects(search('异常外壳'), /B 站响应异常/)
		assert.equal(calls, 1)
	}
})

void test('取消后不补读异常响应', async () => {
	const controller = new AbortController()
	let calls = 0
	globalThis.fetch = async () => {
		calls++
		controller.abort()
		return response({ numPages: 1 })
	}
	await assert.rejects(search('取消补读', 1, controller.signal), /取消/)
	assert.equal(calls, 1)
})

void test('超时和请求中取消分别反馈，均不自动重试', async (context) => {
	context.mock.timers.enable({ apis: ['setTimeout'] })
	try {
		for (const cancel of [false, true]) {
			const controller = new AbortController()
			let calls = 0
			globalThis.fetch = async (_input, init) => {
				calls++
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError')),
					)
					if (cancel) controller.abort()
					else context.mock.timers.tick(15000)
				})
			}
			await assert.rejects(
				search('等待', 1, controller.signal),
				cancel ? /取消/ : /超时/,
			)
			assert.equal(calls, 1)
		}
	} finally {
		context.mock.timers.reset()
	}
})

const item = (bvid: string, category = '日常'): SearchItem => ({
	bvid,
	originalTitle: bvid,
	uploader: 'UP',
	uploaderId: 1,
	artwork: '',
	duration: 60,
	category,
})
const deferred = <T>() => {
	let resolve!: (value: T) => void
	let reject!: (reason: Error) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

void test('翻页失败保留列表与成功页，重试同一页且去重', async () => {
	const calls: number[] = []
	let failed = false
	const session = new SearchSession(async (_query, page) => {
		calls.push(page)
		if (page === 2 && !failed) {
			failed = true
			throw new Error('网络连接失败')
		}
		return {
			items: page === 1 ? [item('a')] : [item('a'), item('b'), item('b')],
			more: page < 2,
		}
	})
	await session.find('歌曲')
	await session.loadMore()
	assert.equal(session.getSnapshot().page, 1)
	assert.equal(session.getSnapshot().failedPage, 2)
	assert.deepEqual(
		session.getSnapshot().items.map((result) => result.bvid),
		['a'],
	)
	await session.retry()
	assert.deepEqual(calls, [1, 2, 2])
	assert.deepEqual(
		session.getSnapshot().items.map((result) => result.bvid),
		['a', 'b'],
	)
	assert.equal(session.getSnapshot().error, '')
	assert.equal(session.getSnapshot().more, false)
})

void test('旧搜索的晚到成功和失败不能覆盖新搜索或其加载状态', async () => {
	for (const outcome of ['success', 'failure']) {
		const old = deferred<{ items: SearchItem[]; more: boolean }>()
		const current = deferred<{ items: SearchItem[]; more: boolean }>()
		const session = new SearchSession((query) =>
			query === 'old' ? old.promise : current.promise,
		)
		const first = session.find('old')
		const second = session.find('current')
		if (outcome === 'success')
			old.resolve({ items: [item('old')], more: false })
		else old.reject(new Error('old failure'))
		await first
		assert.equal(session.getSnapshot().loading, true)
		assert.equal(session.getSnapshot().submitted, 'current')
		assert.equal(session.getSnapshot().error, '')
		current.resolve({ items: [item('current')], more: false })
		await second
		assert.equal(session.getSnapshot().items[0].bvid, 'current')
	}
})

void test('重复分页点击只请求一次，切换关键词后旧分页不能混入', async () => {
	const pending = deferred<{ items: SearchItem[]; more: boolean }>()
	let pageCalls = 0
	const session = new SearchSession(async (query, page) => {
		if (page === 2) {
			pageCalls++
			return pending.promise
		}
		return { items: [item(query)], more: true }
	})
	await session.find('first')
	const page = session.loadMore()
	await session.loadMore()
	assert.equal(pageCalls, 1)
	await session.find('next')
	pending.resolve({ items: [item('old-page')], more: false })
	await page
	assert.deepEqual(
		session.getSnapshot().items.map((result) => result.bvid),
		['next'],
	)
	assert.equal(session.getSnapshot().page, 1)
})

void test('显式取消阻止晚到结果，并结束加载；首屏失败可重试', async () => {
	const pending = deferred<{ items: SearchItem[]; more: boolean }>()
	const session = new SearchSession(() => pending.promise)
	const active = session.find('取消')
	session.cancel()
	pending.resolve({ items: [item('late')], more: false })
	await active
	assert.equal(session.getSnapshot().loading, false)
	assert.equal(session.getSnapshot().items.length, 0)
	let calls = 0
	const retry = new SearchSession(async () => {
		if (++calls === 1) throw new Error('网络连接失败')
		return { items: [], more: false }
	})
	await retry.find('空')
	assert.equal(retry.getSnapshot().failedPage, 1)
	await retry.retry()
	assert.equal(retry.getSnapshot().page, 1)
	assert.equal(retry.getSnapshot().error, '')
})

void test('音乐分区保留真实音乐分类，未知分区 BV 不归类，筛选不改变原始列表', () => {
	const items = [
		'日常',
		'音乐综合',
		'MV',
		'乐评盘点',
		'电台',
		'BV 精确查找',
	].map((category) => item(category, category))
	assert.deepEqual(
		musicResults(items).map((result) => result.category),
		items.slice(1, -1).map((result) => result.category),
	)
	assert.equal(items.length, 6)
	assert.equal(musicResults([item('非音乐')]).length, 0)
})
