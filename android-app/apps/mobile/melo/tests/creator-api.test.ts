import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { search } from '../bilibili'
import { creatorPosts, creatorProfile, searchCreators } from '../creator-api'
import {
	creatorSearchMid,
	creatorSearchTarget,
} from '../creator-search-selection'

const originalFetch = globalThis.fetch
after(() => {
	globalThis.fetch = originalFetch
})
const response = (data: unknown, code = 0) =>
	new Response(
		JSON.stringify({ code, message: code ? 'platform rejection' : 'OK', data }),
		{ status: 200 },
	)
const profile = {
	mid: 88,
	name: '真实 UP',
	face: '//i0.hdslb.com/avatar.jpg',
	sign: '简介 &amp; 信息',
}
const user = {
	type: 'bili_user',
	mid: 88,
	uname: '<em>真实</em> UP',
	upic: '//i0.hdslb.com/avatar.jpg',
	usign: '摘要 &amp; 信息',
}
const post = {
	bvid: 'BV1vT411i7ET',
	title: '<em>合作</em>投稿 &amp; 内容',
	pic: '//i0.hdslb.com/post.jpg',
	created: 1700000000,
	length: '03:21',
	author: '另一位合作UP',
}
const searchPage = (
	items: unknown[] = [user],
	overrides: Record<string, unknown> = {},
) => ({
	result: items,
	page: 1,
	pagesize: 20,
	numPages: 1,
	numResults: items.length,
	...overrides,
})
const postsPage = (
	items: unknown[] = [post],
	overrides: Record<string, unknown> = {},
) => ({
	list: { vlist: items },
	page: { pn: 1, ps: 30, count: items.length },
	...overrides,
})

function mock(
	handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
	const calls: URL[] = []
	globalThis.fetch = async (input, init) => {
		const url = new URL(
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url,
		)
		assert.equal(init?.credentials, 'omit')
		assert.ok(!JSON.stringify(init?.headers).includes('SESSDATA'))
		if (url.pathname.endsWith('/finger/spi'))
			return response({ b_3: 'test-anonymous', b_4: '' })
		if (url.pathname.endsWith('/nav'))
			return response(
				{
					wbi_img: {
						img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`,
						sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png`,
					},
				},
				-101,
			)
		assert.match(url.searchParams.get('w_rid') ?? '', /^[0-9a-f]{32}$/)
		calls.push(url)
		return handler(url, init)
	}
	return calls
}

void test('UP资料复用游客WBI，不使用账号，真实响应时间且identity精确', async () => {
	const calls = mock(() => response(profile))
	const before = Date.now(),
		value = await creatorProfile('88')
	assert.ok(value.fetchedAt >= before && value.fetchedAt <= Date.now())
	assert.deepEqual(
		{ ...value, fetchedAt: 0 },
		{
			source: 'bilibili',
			mid: '88',
			name: '真实 UP',
			avatar: 'https://i0.hdslb.com/avatar.jpg',
			bio: '简介 & 信息',
			fetchedAt: 0,
		},
	)
	assert.equal(calls.length, 1)
	assert.equal(calls[0].pathname, '/x/space/wbi/acc/info')
	assert.equal(calls[0].searchParams.get('mid'), '88')
})

void test('规范大字符串mid不经Number，数字回包只接受safe integer，输入坏值不联网', async () => {
	const large = '900719925474099312345'
	const calls = mock(() => response({ ...profile, mid: large }))
	assert.equal((await creatorProfile(large)).mid, large)
	assert.equal(calls[0].searchParams.get('mid'), large)
	for (const value of [
		'0',
		'088',
		'88\n',
		' 88',
		'88/x',
		88 as unknown as string,
	])
		await assert.rejects(creatorProfile(value), /mid 无效/)
	assert.equal(calls.length, 1)
	for (const value of [0, 1.2, Number.MAX_SAFE_INTEGER + 1, '088']) {
		mock(() => response({ ...profile, mid: value }))
		await assert.rejects(creatorProfile('88'), /响应异常/)
	}
	mock(() => response({ ...profile, mid: 89 }))
	await assert.rejects(creatorProfile('88'), /身份不匹配/)
})

void test('完整资料缺失或畸形明确失败，不伪造空资料覆盖缓存', async () => {
	for (const value of [
		null,
		[],
		{},
		{ ...profile, name: '' },
		{ ...profile, face: undefined },
		{ ...profile, sign: undefined },
		{ ...profile, face: 'javascript:x' },
		{ ...profile, face: 'https://user:pass@example.com/a' },
	]) {
		mock(() => response(value))
		await assert.rejects(creatorProfile('88'), /响应异常/)
	}
	mock(() => response({ ...profile, sign: '' }))
	assert.equal((await creatorProfile('88')).bio, '')
})

void test('UP搜索返回摘要fetchedAt0，清展示HTML且不添加Artist分类或假完整profile', async () => {
	const calls = mock(() => response(searchPage()))
	const value = await searchCreators(' 真实 UP ')
	assert.deepEqual(value, {
		items: [
			{
				source: 'bilibili',
				mid: '88',
				name: '真实 UP',
				avatar: 'https://i0.hdslb.com/avatar.jpg',
				bio: '摘要 & 信息',
				fetchedAt: 0,
			},
		],
		page: 1,
		more: false,
	})
	assert.equal(calls[0].searchParams.get('search_type'), 'bili_user')
	assert.equal(calls[0].searchParams.get('keyword'), '真实 UP')
	assert.equal(calls[0].searchParams.get('page_size'), '20')
})

void test('搜索真实空与越界空可返回，整页/末页more与page对应', async () => {
	mock(() => response(searchPage([], { numPages: 0 })))
	assert.deepEqual(await searchCreators('空'), {
		items: [],
		page: 1,
		more: false,
	})
	mock(() => response(searchPage([], { page: 2, numPages: 1, numResults: 1 })))
	assert.deepEqual(await searchCreators('越界', 2), {
		items: [],
		page: 2,
		more: false,
	})
	const items = Array.from({ length: 20 }, (_, index) => ({
		...user,
		mid: index + 1,
	}))
	mock(() => response(searchPage(items, { numPages: 2, numResults: 21 })))
	assert.equal((await searchCreators('整页')).more, true)
	mock(() =>
		response(searchPage([user], { page: 2, numPages: 2, numResults: 21 })),
	)
	assert.equal((await searchCreators('末页', 2)).more, false)
})

void test('搜索缺result、分页不一致、坏用户或重复identity不被当成空且不自动重试', async () => {
	for (const value of [
		null,
		{},
		{ ...searchPage(), result: undefined },
		searchPage([], { numResults: 1 }),
		searchPage([user], { page: 2 }),
		searchPage([user], { numPages: 2 }),
		searchPage([user], { pagesize: 10 }),
		searchPage([{ ...user, mid: Number.MAX_SAFE_INTEGER + 1 }]),
		searchPage([{ ...user, uname: '' }]),
		searchPage([user, user]),
	]) {
		const calls = mock(() => response(value))
		await assert.rejects(searchCreators('坏响应'), /响应异常/)
		assert.equal(calls.length, 1)
	}
})

void test('UP 搜索零结果可省略 result，完整零分页仍返回空且不重试', async () => {
	const calls = mock(() =>
		response({ page: 1, pagesize: 20, numPages: 0, numResults: 0 }),
	)
	assert.deepEqual(await searchCreators('PR62_Original_Test_20261020'), {
		items: [],
		page: 1,
		more: false,
	})
	assert.equal(calls.length, 1)
})

void test('省略 result 不能掩盖非零结果、错页、类型错误或显式 null', async () => {
	const empty = { page: 1, pagesize: 20, numPages: 0, numResults: 0 }
	for (const value of [
		{ ...empty, numResults: 1 },
		{ ...empty, numPages: 1 },
		{ ...empty, page: 2 },
		{ ...empty, pagesize: 10 },
		{ ...empty, numResults: '0' },
		{ ...empty, result: null },
	]) {
		const calls = mock(() => response(value))
		await assert.rejects(searchCreators('坏空响应'), /响应异常/)
		assert.equal(calls.length, 1)
	}
})

void test('投稿候选保留查询mid而不把合作author冒充owner，created秒转换安全整数毫秒', async () => {
	const calls = mock(() => response(postsPage()))
	assert.deepEqual(await creatorPosts('88'), {
		items: [
			{
				bvid: post.bvid,
				title: '合作投稿 & 内容',
				artwork: 'https://i0.hdslb.com/post.jpg',
				duration: 201,
				publishedAt: 1700000000000,
				queryCreatorMid: '88',
			},
		],
		page: 1,
		more: false,
		total: 1,
	})
	assert.equal(calls[0].pathname, '/x/space/wbi/arc/search')
	assert.equal(calls[0].searchParams.get('mid'), '88')
	assert.equal(calls[0].searchParams.get('ps'), '30')
	const large = '900719925474099312345'
	mock(() => response(postsPage([{ ...post, mid: large }])))
	assert.equal((await creatorPosts('88')).items[0].ownerMid, large)
	mock(() => response(postsPage([{ ...post, owner: { mid: 99 }, mid: 99 }])))
	assert.equal((await creatorPosts('88')).items[0].ownerMid, '99')
})

void test('投稿真空、越界和more明确，空vlist缺失、错页、重复BV、坏时间/时长/owner均拒绝', async () => {
	mock(() => response(postsPage([])))
	assert.deepEqual(await creatorPosts('88'), {
		items: [],
		page: 1,
		more: false,
		total: 0,
	})
	mock(() => response(postsPage([], { page: { pn: 2, ps: 30, count: 1 } })))
	assert.equal((await creatorPosts('88', 2)).total, 1)
	const items = Array.from({ length: 30 }, (_, index) => ({
		...post,
		bvid: `BV${String(index).padStart(10, '0')}`,
	}))
	mock(() => response(postsPage(items, { page: { pn: 1, ps: 30, count: 31 } })))
	assert.equal((await creatorPosts('88')).more, true)
	for (const value of [
		null,
		{},
		{ list: {}, page: { pn: 1, ps: 30, count: 0 } },
		postsPage([], { page: { pn: 1, ps: 30, count: 1 } }),
		postsPage([post], { page: { pn: 2, ps: 30, count: 1 } }),
		postsPage([post], { page: { pn: 1, ps: 20, count: 1 } }),
		postsPage([post, post]),
		...[
			{ bvid: '' },
			{ bvid: `${post.bvid}\n` },
			{ created: -1 },
			{ created: 1.5 },
			{ created: Number.MAX_SAFE_INTEGER },
			{ length: '3:99' },
			{ length: 'xx' },
			{ title: '' },
			{ mid: 0 },
			{ mid: Number.MAX_SAFE_INTEGER + 1 },
			{ mid: 88, owner: { mid: 99 } },
		].map((change) => postsPage([{ ...post, ...change }])),
	]) {
		const calls = mock(() => response(value))
		await assert.rejects(creatorPosts('88'), /响应异常/)
		assert.equal(calls.length, 1)
	}
})

void test('空词/非法页码不联网；搜索摘要与投稿大mid字符串精确保留', async () => {
	let calls = mock(() => response(searchPage()))
	await assert.rejects(searchCreators(' '), /关键词/)
	for (const page of [0, -1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		await assert.rejects(searchCreators('UP', page), /页码/)
		await assert.rejects(creatorPosts('88', page), /页码/)
	}
	assert.equal(calls.length, 0)
	const large = '900719925474099312345'
	mock(() => response(searchPage([{ ...user, mid: large }])))
	assert.equal((await searchCreators('UP')).items[0].mid, large)
	calls = mock(() => response(postsPage()))
	assert.equal((await creatorPosts(large)).items[0].queryCreatorMid, large)
	assert.equal(calls[0].searchParams.get('mid'), large)
})

void test('风控voucher/平台拒绝/HTTP和网络各保留错误，不重试不伪造空', async () => {
	for (const call of [
		() => creatorProfile('88'),
		() => searchCreators('UP'),
		() => creatorPosts('88'),
	]) {
		let calls = mock(() => response({ v_voucher: 'not-saved-challenge' }))
		await assert.rejects(call(), /请求受限/)
		assert.equal(calls.length, 1)
		calls = mock(() => response(null, -352))
		await assert.rejects(call(), /请求受限/)
		assert.equal(calls.length, 1)
		mock(() => new Response('blocked', { status: 412 }))
		await assert.rejects(call(), /请求受限/)
		mock(() => {
			throw new TypeError('offline')
		})
		await assert.rejects(call(), /网络连接失败/)
		mock(() => new Response('{'))
		await assert.rejects(call(), /响应无法读取/)
	}
})

void test('取消在调用前/响应返回后均不返回缓存假成功，在途取消终止请求', async () => {
	const controller = new AbortController()
	controller.abort()
	const calls = mock(() => response(profile))
	await assert.rejects(creatorProfile('88', controller.signal), /取消/)
	assert.equal(calls.length, 0)
	const during = new AbortController()
	mock(() => {
		during.abort()
		return response(profile)
	})
	await assert.rejects(creatorProfile('88', during.signal), /取消/)
	const pending = new AbortController()
	mock(
		(_url, init) =>
			new Promise((_resolve, reject) =>
				init?.signal?.addEventListener('abort', () =>
					reject(new Error('aborted')),
				),
			),
	)
	const result = creatorPosts('88', 1, pending.signal)
	await new Promise((resolve) => setImmediate(resolve))
	pending.abort()
	await assert.rejects(result, /取消/)
})

void test('游客UP读取超时明确反馈，cause记录本地取消边界且不自动重试', async (context) => {
	context.mock.timers.enable({ apis: ['setTimeout'] })
	const cause = new Error('transport aborted')
	const calls = mock(
		(_url, init) =>
			new Promise((_resolve, reject) =>
				init?.signal?.addEventListener('abort', () => reject(cause)),
			),
	)
	const result = creatorProfile('88')
	await new Promise((resolve) => setImmediate(resolve))
	context.mock.timers.tick(15001)
	await assert.rejects(result, (error: unknown) => {
		assert.ok(error instanceof Error)
		assert.equal(error.message, '请求超时，请检查网络后重试')
		assert.ok(error.cause instanceof Error)
		assert.equal(error.cause.message, '请求已取消')
		return true
	})
	assert.equal(calls.length, 1)
})

void test('共享游客初始化后原视频search仍使用video类型并保持不完整响应一次重读', async () => {
	let attempt = 0
	const calls = mock((url) => {
		assert.equal(url.searchParams.get('search_type'), 'video')
		attempt++
		return response(attempt === 1 ? {} : { result: [], numPages: 0 })
	})
	assert.deepEqual(await search('原视频搜索'), { items: [], more: false })
	assert.equal(calls.length, 2)
})

void test('explicit UP identity parser keeps exact decimal strings and rejects non-homepage URLs', () => {
	assert.equal(creatorSearchMid('  MID:9007199254740993 '), '9007199254740993')
	assert.equal(
		creatorSearchMid('https://SPACE.bilibili.com/88/?from=search#top'),
		'88',
	)
	assert.equal(creatorSearchMid('http://space.bilibili.com/88'), '88')
	assert.equal(creatorSearchMid('88'), null)
	assert.equal(creatorSearchMid('Aimer'), null)
	for (const value of [
		'mid:0',
		'mid:01',
		'mid:-1',
		'mid:1e3',
		'mid:1.5',
		'mid:',
		'https://space.bilibili.com/88/video',
		'https://space.bilibili.com/0',
		'https://space.bilibili.com/%38%38',
		'https://person@space.bilibili.com/88',
		'https://space.bilibili.com:444/88',
	])
		assert.throws(() => creatorSearchMid(value), value)
	for (const value of [
		'https://space.bilibili.com.evil/88',
		'https://evil.example/88',
		'ftp://space.bilibili.com/88',
		'//space.bilibili.com/88',
	])
		assert.equal(creatorSearchMid(value), null, value)
	assert.equal(creatorSearchTarget('https://space.bilibili.com/88'), 'creator')
})

void test('exact UP searches use verified profile identity, no user search or pagination; numeric nicknames remain keyword searches', async () => {
	const hugeMid = '9007199254740993'
	let calls = mock((url) => {
		assert.equal(url.pathname, '/x/space/wbi/acc/info')
		assert.equal(url.searchParams.get('mid'), hugeMid)
		return response({ ...profile, mid: hugeMid })
	})
	for (const input of [
		`mid:${hugeMid}`,
		`https://space.bilibili.com/${hugeMid}?from=search`,
	]) {
		const value = await searchCreators(input)
		assert.equal(value.items[0]?.mid, hugeMid)
		assert.equal(value.more, false)
		assert.equal(value.page, 1)
	}
	assert.equal(calls.length, 2)
	await assert.rejects(searchCreators(`mid:${hugeMid}`, 2), /没有下一页/)
	assert.equal(calls.length, 2)
	calls = mock(() => response({ ...profile, mid: '99' }))
	await assert.rejects(searchCreators('mid:88'), /身份不匹配/)
	assert.equal(calls.length, 1)
	calls = mock((url) => {
		assert.equal(url.pathname, '/x/web-interface/wbi/search/type')
		assert.equal(url.searchParams.get('keyword'), '88')
		return response(searchPage())
	})
	assert.equal((await searchCreators('88')).items[0]?.mid, '88')
	assert.equal(calls.length, 1)
})

// Additional boundary coverage from the independent PR64 review.
void test('review: explicit empty shape cannot mask invalid envelope, HTTP, voucher or malformed scalar counts', async () => {
	const empty = { page: 1, pagesize: 20, numPages: 0, numResults: 0 }
	for (const code of [-352, -412, -101, 1, '0', null, undefined]) {
		const calls = mock(
			() => new Response(JSON.stringify({ code, data: empty })),
		)
		await assert.rejects(searchCreators('review'))
		assert.equal(calls.length, 1)
	}
	for (const change of [
		{ numPages: '0' },
		{ numPages: null },
		{ numResults: null },
		{ numResults: false },
		{ numResults: undefined },
		{ numPages: undefined },
		{ page: '1' },
		{ page: 0 },
		{ pagesize: '20' },
		{ result: {} },
		{ result: '' },
		{ result: false },
		{ result: [user] },
	]) {
		const calls = mock(() => response({ ...empty, ...change }))
		await assert.rejects(searchCreators('review'), /响应异常/)
		assert.equal(calls.length, 1)
	}
	let calls = mock(() => response({ ...empty, v_voucher: 'challenge' }))
	await assert.rejects(searchCreators('review'), /请求受限/)
	assert.equal(calls.length, 1)
	calls = mock(
		() =>
			new Response(JSON.stringify({ code: 0, data: empty }), { status: 412 }),
	)
	await assert.rejects(searchCreators('review'), /请求受限/)
	assert.equal(calls.length, 1)
})
