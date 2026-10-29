import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { sourceId, type Source } from '../core/model'
import {
	listeningChapters,
	parseListeningChapters,
	type Chapter,
} from '../listening-chapters'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const noop = () => {}
const originalFetch = globalThis.fetch
after(() => {
	globalThis.fetch = originalFetch
})
const source: Source = {
	id: sourceId('BV1vT411i7ET', 123),
	bvid: 'BV1vT411i7ET',
	cid: 123,
	originalTitle: '真实讲解',
	uploader: 'UP',
	uploaderId: 88,
	performer: null,
	artwork: '',
	duration: 100,
	domain: 'unclassified',
	audioAvailability: 'unknown',
}
const chapter: Chapter = {
	id: '10:0',
	title: '真实章节',
	startSeconds: 10,
	endSeconds: 100,
}
const settle = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve()
}
function deferred<T>() {
	let resolve!: (v: T) => void, reject!: (e: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const text = (value: unknown): string => {
	if (Array.isArray(value)) return value.map(text).join('')
	if (typeof value === 'string' || typeof value === 'number')
		return String(value)
	if (value && typeof value === 'object' && 'children' in value)
		return text((value as ControlNode).children)
	return ''
}

void test('upstream second-based chapters sort, deduplicate, reject invalid points and clamp to this CID duration', () => {
	const result = parseListeningChapters(
		{
			cid: 123,
			bvid: source.bvid,
			view_points: [
				{ from: 50, to: 200, content: '后半段' },
				{ from: 10, to: 80, content: '开场' },
				{ from: 10, to: 20, content: '重复' },
				{ from: -1, to: 3, content: '坏值' },
				{ from: 101, to: 110, content: '越界' },
				null,
			],
		},
		source,
		100,
	)
	assert.deepEqual(
		result.map((c) => [c.title, c.startSeconds, c.endSeconds]),
		[
			['开场', 10, 50],
			['后半段', 50, 100],
		],
	)
	assert.throws(
		() => parseListeningChapters({ cid: 456, view_points: [] }, source, 100),
		/分 P 不匹配/,
	)
	assert.throws(
		() =>
			parseListeningChapters(
				{ cid: 123, bvid: 'BV1234567890', view_points: [] },
				source,
				100,
			),
		/分 P 不匹配/,
	)
	assert.deepEqual(parseListeningChapters({ cid: 123 }, source, 100), [])
	assert.throws(
		() => parseListeningChapters({ cid: 123, view_points: {} }, source, 100),
		/格式不正确/,
	)
})
void test('real loader signs exact BV/CID for web-player endpoint and keeps unavailable separate from empty', async () => {
	const urls: string[] = []
	globalThis.fetch = async (input) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url
		urls.push(url)
		const data = url.includes('/nav')
			? {
					wbi_img: {
						img_url: 'https://i.example/0123456789abcdef0123456789abcdef.png',
						sub_url: 'https://i.example/fedcba9876543210fedcba9876543210.png',
					},
				}
			: {
					bvid: source.bvid,
					cid: 123,
					view_points: [{ from: 10, to: 100, content: '真实章节' }],
				}
		return new Response(JSON.stringify({ code: 0, data }), { status: 200 })
	}
	assert.deepEqual(await listeningChapters(source, 100), [chapter])
	const endpoint = new URL(urls.at(-1)!)
	assert.equal(endpoint.pathname, '/x/player/wbi/v2')
	assert.equal(endpoint.searchParams.get('bvid'), source.bvid)
	assert.equal(endpoint.searchParams.get('cid'), '123')
	assert.ok(endpoint.searchParams.get('w_rid'))
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ code: -403, message: '访问受限' }), {
			status: 200,
		})
	await assert.rejects(listeningChapters(source, 100), /访问受限|403/)
	const aborted = new AbortController()
	aborted.abort()
	await assert.rejects(listeningChapters(source, 100, aborted.signal))
})

void test('actual panel seeks seconds in current P, highlights chapter, and does not auto-play', async () => {
	const seeks: number[] = []
	const f = controlFixture(
		{},
		{ './listening-chapters': { listeningChapters: async () => [chapter] } },
	)
	const Panel = f.load('listening-chapters-ui')
		.ListeningChaptersPanel as ControlNode['type']
	const element = f.element(Panel, {
		source,
		duration: 100,
		position: 20,
		switching: false,
		onSeek: (s: number) => seeks.push(s),
	})
	f.render(element)
	await settle()
	const tree = f.render(element)
	const row = controlNodes(tree).find((n) =>
		String(n.props.accessibilityLabel).startsWith('跳转章节'),
	)!
	assert.ok(row)
	assert.equal(
		(row.props.accessibilityState as { selected: boolean }).selected,
		true,
	)
	;(row.props.onPress as () => void)()
	assert.deepEqual(seeks, [10])
	f.unmount()
	;(row.props.onPress as () => void)()
	assert.deepEqual(seeks, [10])
})

void test('actual panel distinguishes empty/error/retry and aborts old CID results on P change', async () => {
	const old = deferred<Chapter[]>(),
		calls: { cid: number; signal: AbortSignal }[] = []
	let retry = false
	const f = controlFixture(
		{},
		{
			'./listening-chapters': {
				listeningChapters: async (
					s: Source,
					_duration: number,
					signal: AbortSignal,
				) => {
					calls.push({ cid: s.cid, signal })
					if (s.cid === 123) return old.promise
					if (!retry) throw new Error('网络暂不可用')
					return []
				},
			},
		},
	)
	const Panel = f.load('listening-chapters-ui')
		.ListeningChaptersPanel as ControlNode['type']
	const render = (s: Source) =>
		f.render(
			f.element(Panel, {
				source: s,
				duration: 100,
				position: 0,
				switching: false,
				onSeek: () => assert.fail('must not seek'),
			}),
		)
	render(source)
	const next = { ...source, id: sourceId(source.bvid, 456), cid: 456 }
	render(next)
	await settle()
	let tree = render(next)
	assert.equal(calls[0].signal.aborted, true)
	assert.match(text(tree), /章节暂时无法读取/)
	old.resolve([chapter])
	await settle()
	tree = render(next)
	assert.doesNotMatch(text(tree), /真实章节/)
	retry = true
	const button = controlNodes(tree).find(
		(n) => typeof n.props.onPress === 'function' && /重试/.test(text(n)),
	)
	assert.ok(button)
	;(button.props.onPress as () => void)()
	render(next)
	await settle()
	tree = render(next)
	assert.match(text(tree), /当前分 P 暂无章节/)
	assert.doesNotMatch(text(tree), /网络暂不可用/)
	f.unmount()
	assert.equal(calls.at(-1)!.signal.aborted, true)
})

void test('actual listening player loads chapters only from explicit entry and keeps the parts tab separate', async () => {
	let reads = 0
	const f = controlFixture(
		{},
		{
			'./listening-chapters': {
				listeningChapters: async () => {
					reads++
					return [chapter]
				},
			},
		},
	)
	const Player = f.load('listening-ui').ListeningPlayer as ControlNode['type']
	const props = {
		source,
		parts: [{ source, page: 1, title: '真实分P' }],
		partsLoading: false,
		partsError: '',
		position: 20,
		duration: 100,
		speed: 1,
		playing: false,
		buffering: false,
		switching: false,
		error: '',
		bottomInset: 0,
		reducedMotion: true,
		canReturnMusic: false,
		onClose: noop,
		onTheme: noop,
		onSource: noop,
		onCreator: noop,
		onSeek: noop,
		onToggle: noop,
		onSpeed: noop,
		onPart: noop,
		onRetryParts: noop,
		onRetry: noop,
		onReturnMusic: noop,
		onCancel: noop,
	}
	const element = f.element(Player, props)
	let tree = f.render(element)
	assert.equal(reads, 0)
	const entry = controlNodes(tree).find(
		(n) =>
			typeof n.props.onPress === 'function' && text(n) === '当前章节与分 P',
	)
	assert.ok(entry)
	;(entry.props.onPress as () => void)()
	f.render(element)
	await settle()
	tree = f.render(element)
	assert.equal(reads, 1)
	assert.match(text(tree), /真实章节/)
	const parts = controlNodes(tree).find(
		(n) => typeof n.props.onPress === 'function' && text(n) === '分 P 列表',
	)
	assert.ok(parts)
	;(parts.props.onPress as () => void)()
	tree = f.render(element)
	assert.match(text(tree), /真实分P/)
	assert.doesNotMatch(text(tree), /跳转章节|真实章节/)
	f.unmount()
})
