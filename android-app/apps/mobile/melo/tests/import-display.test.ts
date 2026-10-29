import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BilibiliFavoriteCollectionSession } from '../bilibili-favorite-collection'
import type {
	ImportDirectorySnapshot,
	ImportJson,
	ImportMetadata,
	ImportTaskDetail,
} from '../core/import-types'
import {
	importEntryDescription,
	importOriginalQuery,
	importDurationComparison,
	importTaskDescription,
} from '../import-display'

function task(
	metadata: ImportMetadata,
	provider: ImportTaskDetail['provider'] = 'bilibili',
	entryCount = 2,
): ImportTaskDetail {
	return {
		taskId: 't',
		provider,
		originalPlaylistId: '123',
		taskVersion: 1,
		revision: 0,
		createdAt: 1,
		updatedAt: 1,
		entryCount,
		originalMetadata: metadata,
		entries: [],
		commits: [],
	}
}
const entry = (
	originalMetadata: ImportMetadata,
	originalEntryId: string | null = '2:7',
) => ({ originalMetadata, originalEntryId })

void test('resource index without returned detail has an explicit unplayable label and no invented metadata', () => {
	const description = importEntryDescription(entry({
		detailState: 'not-returned', resourceIndex: { id: 7, type: 2, bvid: 'BV1vT411i7ET' },
		observed: { bvid: null },
	}), 'bilibili')
	assert.equal(description.title, '平台未返回详情（不可播放）')
	assert.equal(description.duration, null)
	assert.equal(description.artists, 'UP 主信息缺失')
})
const metadata = (): ImportMetadata => ({
	positionBasis: 'observed-page-order',
	completeness: 'complete',
	reportedTotal: 2,
	observedCount: 2,
	pages: [{ page: 1, info: { id: '123', title: '保存的收藏夹名' } }],
})

void test('real collector output displays original video title/UP/seconds and saved folder name without editing evidence', async () => {
	const media = {
		id: 7,
		type: 2,
		bvid: 'BV1vT411i7ET',
		title: '视频原标题',
		upper: { mid: 88, name: '原UP' },
		duration: 198.5,
		unknown: ['原信息'],
	}
	const session = new BilibiliFavoriteCollectionSession(async () =>
		new TextEncoder().encode(
			JSON.stringify({
				code: 0,
				data: {
					info: { id: 123, title: '保存的收藏夹名', media_count: 2 },
					medias: [media, media],
					has_more: false,
				},
			}),
		),
	)
	await session.start({ favoriteId: '123', taskId: 't', taskVersion: 1 })
	const saved = session.getSnapshot().directory as ImportDirectorySnapshot
	const before = JSON.stringify(saved)
	for (const item of saved.entries)
		assert.deepEqual(importEntryDescription(item, 'bilibili'), {
			title: '视频原标题',
			artists: 'UP 主：原UP',
			album: 'B站原目录条目',
			duration: 198.5,
		})
	assert.deepEqual(importTaskDescription(task(saved.originalMetadata)), {
		name: '保存的收藏夹名',
		expected: 2,
		read: 2,
		incomplete: false,
	})
	assert.equal(JSON.stringify(saved), before)
})

void test('Bilibili never reads misleading track/artist/album/interval fields or infers a content kind', () => {
	const value = entry({
		media: {
			title: '原目录媒体',
			upper: { name: '原上传者' },
			duration: 12,
			type: 12,
			attr: 9,
			artists: ['不能当歌手'],
			album: '不能当专辑',
			interval: 999,
		},
		track: {
			name: '错误曲名',
			ar: [{ name: '错误歌手' }],
			al: { name: '错误专辑' },
			dt: 999000,
		},
	})
	assert.deepEqual(importEntryDescription(value, 'bilibili'), {
		title: '原目录媒体',
		artists: 'UP 主：原上传者',
		album: 'B站原目录条目',
		duration: 12,
	})
	assert.deepEqual(
		importEntryDescription(
			entry({ media: { title: '已失效视频', duration: 0, type: 9999 } }),
			'bilibili',
		),
		{
			title: '已失效视频',
			artists: 'UP 主信息缺失',
			album: 'B站原目录条目',
			duration: 0,
		},
	)
})

void test('missing or malformed Bilibili evidence uses explicit missing text rather than external music fallback', () => {
	const invalidMedia: ImportJson[] = [
		null,
		[],
		'bad',
		{},
		{ title: '', upper: { name: ' ' } },
		{ title: ' ', upper: [] },
		{ title: 7, upper: { name: 8 } },
	]
	for (const media of invalidMedia) {
		const value = entry({
			media,
			track: { name: '不应使用', ar: ['错误歌手'], album: '错误专辑' },
			title: '错误层级标题',
		})
		assert.deepEqual(importEntryDescription(value, 'bilibili'), {
			title: '原标题缺失（原条目 2:7）',
			artists: 'UP 主信息缺失',
			album: 'B站原目录条目',
			duration: null,
		})
	}
	assert.equal(
		importEntryDescription(entry({}, null), 'bilibili').title,
		'原标题缺失',
	)
	for (const duration of [null, '90', -1, Infinity, NaN])
		assert.equal(
			importEntryDescription(entry({ media: { duration } }), 'bilibili')
				.duration,
			null,
		)
})

void test('Bilibili folder title uses only page-one info with matching identity, never external playlist names', () => {
	const saved = metadata()
	saved.playlist = { name: '错误歌单名', dissname: '错误QQ名' }
	saved.name = '错误顶层名'
	assert.equal(importTaskDescription(task(saved)).name, '保存的收藏夹名')
	for (const pages of [
		undefined,
		null,
		[],
		[{ page: 2, info: { id: '123', title: '后页名称' } }],
		[{ page: 1, info: { id: '456', title: '别的收藏夹' } }],
		[{ page: 1, info: { id: '123', title: ' ' } }],
		[{ page: 1, info: [] }],
	]) {
		const bad = metadata()
		if (pages === undefined) delete bad.pages
		else bad.pages = pages
		bad.playlist = { name: '不能回退到歌单' }
		assert.equal(
			importTaskDescription(task(bad)).name,
			'B站收藏夹 123（名称缺失）',
		)
	}
})

void test('Bilibili missing/invalid count stays unknown and missing completeness is not presented as complete', () => {
	for (const field of ['reportedTotal', 'observedCount']) {
		for (const invalid of [undefined, null, '2', -1, 1.5, Infinity]) {
			const raw = metadata()
			if (invalid === undefined) delete raw[field]
			else raw[field] = invalid
			const description = importTaskDescription(task(raw))
			assert.equal(
				field === 'reportedTotal' ? description.expected : description.read,
				null,
			)
			assert.equal(description.incomplete, true)
		}
	}
	for (const completeness of [null, 'incomplete', 'unknown', true]) {
		const raw = metadata()
		raw.completeness = completeness
		assert.equal(importTaskDescription(task(raw)).incomplete, true)
	}
	const absent = metadata()
	delete absent.completeness
	assert.equal(importTaskDescription(task(absent)).incomplete, true)
	for (const raw of [
		{ ...metadata(), reportedTotal: 3 },
		{ ...metadata(), observedCount: 1 },
	])
		assert.equal(importTaskDescription(task(raw)).incomplete, true)
	assert.deepEqual(
		importTaskDescription(
			task(
				{ ...metadata(), reportedTotal: 0, observedCount: 0 },
				'bilibili',
				0,
			),
		),
		{
			name: '保存的收藏夹名',
			expected: 0,
			read: 0,
			incomplete: false,
		},
	)
})

void test('NetEase and QQ entry displays preserve existing nested, top-level and fallback behavior', () => {
	assert.deepEqual(
		importEntryDescription(
			entry({
				track: {
					name: '原歌曲',
					ar: [{ name: '甲' }, { name: '乙' }],
					al: { name: '原专辑' },
					dt: 198000,
				},
			}),
			'netease',
		),
		{
			title: '原歌曲',
			artists: '甲 / 乙',
			album: '原专辑',
			duration: 198,
		},
	)
	assert.deepEqual(
		importEntryDescription(
			entry({
				track: {
					title: 'QQ标题',
					singer: [{ name: 'QQ歌手' }],
					album: { name: 'QQ专辑' },
					interval: 201,
				},
			}),
			'qq',
		),
		{
			title: 'QQ标题',
			artists: 'QQ歌手',
			album: 'QQ专辑',
			duration: 201,
		},
	)
	assert.deepEqual(
		importEntryDescription(
			entry({
				title: '直接标题',
				artists: ['甲', '乙'],
				album: '专辑字符串',
				interval: 45,
			}),
			'qq',
		),
		{
			title: '直接标题',
			artists: '甲 / 乙',
			album: '专辑字符串',
			duration: 45,
		},
	)
	assert.deepEqual(importEntryDescription(entry({}), 'netease'), {
		title: '原平台条目 2:7',
		artists: '表演者信息待读取',
		album: '专辑信息待读取',
		duration: null,
	})
	assert.equal(
		importEntryDescription(entry({}, null), 'qq').title,
		'原条目信息待读取',
	)
})

void test('NetEase and QQ task labels and partial directory counts remain unchanged', () => {
	for (const [provider, playlist] of [
		['netease', { name: '网易原歌单' }],
		['qq', { dissname: 'QQ原歌单' }],
	] as const) {
		assert.deepEqual(
			importTaskDescription(
				task(
					{
						playlist,
						directory: {
							expectedCount: 3,
							readMetadataCount: 1,
							status: 'incomplete',
						},
					},
					provider,
				),
			),
			{
				name: provider === 'netease' ? '网易原歌单' : 'QQ原歌单',
				expected: 3,
				read: 1,
				incomplete: true,
			},
		)
	}
	assert.deepEqual(importTaskDescription(task({}, 'netease')), {
		name: '歌单 123',
		expected: 2,
		read: 2,
		incomplete: false,
	})
})

void test('original query uses only real parsed titles and artists, retaining Live and cover wording', () => {
	for (const provider of ['netease', 'qq']) {
		const rawMetadata = {
			track: {
				name: '  原曲 Live（翻唱）  ',
				singer: [{ name: '歌手甲' }, { name: '  ' }, { name: '歌手乙' }],
			},
		}
		const before = JSON.stringify(rawMetadata)
		assert.equal(
			importOriginalQuery(entry(rawMetadata), provider),
			'原曲 Live（翻唱） 歌手甲 歌手乙',
		)
		assert.equal(JSON.stringify(rawMetadata), before)
		for (const missing of [
			{},
			{ name: '  ', artists: ['  ', {}] },
			{ track: {} },
		] as ImportMetadata[])
			assert.equal(importOriginalQuery(entry(missing), provider), '')
		assert.equal(
			importOriginalQuery(entry({ name: '  ', title: '原曲' }), provider),
			'原曲',
		)
		assert.equal(
			importOriginalQuery(entry({ artists: ['歌手'] }), provider),
			'歌手',
		)
	}
	assert.equal(
		importOriginalQuery(entry({ media: { title: '视频' } }), 'bilibili'),
		'',
	)
})

void test('duration evidence normalizes provider units and excludes unknown, zero and invalid durations', () => {
	const netease = importEntryDescription(
		entry({ track: { dt: 198500 } }),
		'netease',
	)
	const qq = importEntryDescription(entry({ interval: 198.5 }), 'qq')
	assert.equal(netease.duration, qq.duration)
	assert.deepEqual(importDurationComparison(netease.duration, 200), {
		originalSeconds: 198.5,
		selectedSeconds: 200,
		differenceSeconds: 1.5,
	})
	assert.equal(importDurationComparison(200, 198.5).differenceSeconds, -1.5)
	assert.equal(importDurationComparison(198.5, 198.5).differenceSeconds, 0)
	for (const invalid of [null, 0, -1, NaN, Infinity]) {
		assert.equal(importDurationComparison(invalid, 200).differenceSeconds, null)
		assert.equal(importDurationComparison(200, invalid).selectedSeconds, null)
	}
	assert.equal(importDurationComparison(null, null).differenceSeconds, null)
})
