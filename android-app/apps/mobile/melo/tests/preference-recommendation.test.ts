import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SearchItem } from '../core/model'
import { preferenceCandidates } from '../preference-recommendation'

const item = (bvid: string, originalTitle = bvid): SearchItem => ({
	bvid,
	originalTitle,
	uploader: '上传者',
	uploaderId: 1,
	artwork: '',
	duration: 120,
	category: '翻唱',
})
void test('first six rotate across three bounded query batches without changing titles or input', () => {
	const seeds = ['甲', '乙', '丙']
	const batches = new Map(
		seeds.map((seed, i) => [
			seed,
			{
				items: Array.from({ length: 8 }, (_, n) =>
					item(`${seed}${n}`, `同曲 翻唱 Live ${seed}${n}`),
				),
				retrievedAt: i + 100,
			},
		]),
	)
	const before = JSON.stringify([...batches])
	const result = preferenceCandidates(seeds, batches)
	assert.deepEqual(
		result.slice(0, 6).map((v) => v.item.bvid),
		['甲0', '乙0', '丙0', '甲1', '乙1', '丙1'],
	)
	assert.equal(result.length, 24)
	assert.equal(result[1].item.originalTitle, '同曲 翻唱 Live 乙0')
	assert.deepEqual(result[1].hits, [{ seed: '乙', retrievedAt: 101 }])
	assert.equal(result[1].retrievedAt, 101)
	assert.equal(JSON.stringify([...batches]), before)
})
void test('shared BV merges query evidence once and skips overlaps to fill each turn', () => {
	const result = preferenceCandidates(
		['甲', '乙', '丙'],
		new Map([
			[
				'甲',
				{ items: [item('shared', '原始 翻唱'), item('a')], retrievedAt: 10 },
			],
			[
				'乙',
				{
					items: [item('shared', '另一个搜索标题'), item('shared'), item('b')],
					retrievedAt: 20,
				},
			],
			['丙', { items: [item('shared'), item('c')], retrievedAt: 30 }],
		]),
	)
	assert.deepEqual(
		result.map((v) => v.item.bvid),
		['shared', 'b', 'c', 'a'],
	)
	assert.equal(result[0].item.originalTitle, '原始 翻唱')
	assert.deepEqual(result[0].hits, [
		{ seed: '甲', retrievedAt: 10 },
		{ seed: '乙', retrievedAt: 20 },
		{ seed: '丙', retrievedAt: 30 },
	])
	assert.equal(result[0].retrievedAt, 10)
})
void test('empty or absent queries and stale foreign buckets do not invent candidates', () => {
	assert.deepEqual(
		preferenceCandidates(
			['甲', '乙'],
			new Map([
				['甲', { items: [], retrievedAt: 10 }],
				['旧偏好', { items: [item('stale')], retrievedAt: 1 }],
			]),
		),
		[],
	)
})
