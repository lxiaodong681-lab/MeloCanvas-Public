import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ResumePoint } from '../core/listening'
import { sourceId, type Source } from '../core/model'
import { readPlaybackMetadata } from '../playback-metadata'

const source: Source = {
	id: sourceId('BV1vT411i7ET', 123),
	bvid: 'BV1vT411i7ET',
	cid: 123,
	originalTitle: '原标题',
	uploader: 'UP',
	uploaderId: 8,
	performer: null,
	artwork: 'https://i0.hdslb.com/a.jpg',
	duration: 300,
	domain: 'unclassified',
	audioAvailability: 'unknown',
}
const point: ResumePoint = {
	sourceId: source.id,
	positionSeconds: 50,
	durationSeconds: 300,
	completed: false,
	updatedAt: 300,
}

void test('冷启动原生断点暂为空时仍显示SQLite已保存续听，较新记录优先', () => {
	const library = { get: () => source }
	const listening = { listResumePoints: () => [point] }
	assert.deepEqual(
		readPlaybackMetadata(library, listening, source.id, []).items,
		[{ source, point }],
	)
	assert.equal(
		readPlaybackMetadata(library, listening, source.id, [
			{ ...point, updatedAt: 100, positionSeconds: 1 },
		]).items[0].point.positionSeconds,
		50,
	)
	assert.equal(
		readPlaybackMetadata(library, listening, source.id, [
			{ ...point, updatedAt: 400, positionSeconds: 80 },
		]).items[0].point.positionSeconds,
		80,
	)
})

void test('SQLite续听副本读失败时仍展示可用的原生断点并返回非阻塞提示', () => {
	const metadata = readPlaybackMetadata(
		{ get: () => source },
		{
			listResumePoints: () => {
				throw new Error('disk error')
			},
		},
		source.id,
		[point],
	)
	assert.equal(metadata.current, source)
	assert.deepEqual(metadata.items, [{ source, point }])
	assert.match(metadata.error, /当前音频仍保留/)
})

void test('音源资料读取错误或失效引用不会崩页或虚构来源', () => {
	const failed = readPlaybackMetadata(
		{
			get: () => {
				throw new Error('disk error')
			},
		},
		{ listResumePoints: () => [point] },
		source.id,
		[point],
	)
	assert.equal(failed.current, null)
	assert.deepEqual(failed.items, [])
	assert.match(failed.error, /音源信息暂时无法读取/)
	const missing = readPlaybackMetadata(
		{ get: () => null },
		{ listResumePoints: () => [point] },
		source.id,
		[],
	)
	assert.equal(missing.current, null)
	assert.deepEqual(missing.items, [])
})
