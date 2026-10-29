import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	BilibiliPreviewSession,
	type PreviewPlayerIdentity,
} from '../bilibili-preview-session'
import { parseListeningVideo } from '../listening-source'
import { PlaybackIntent } from '../playback-intent'

const video = parseListeningVideo(
	{
		bvid: 'BV1vT411i7ET',
		title: '原视频',
		owner: { mid: 88, name: 'UP' },
		pic: 'https://example.invalid/cover',
		pages: [{ page: 1, cid: 11, part: '真实P', duration: 200 }],
	},
	'BV1vT411i7ET',
)
const source = video.parts[0].source
const identity = (
	entryId = 'actual-new-queue-item',
): PreviewPlayerIdentity => ({ mode: 'music', sourceId: source.id, entryId })
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
function fixture() {
	let lost = 0
	const session = new BilibiliPreviewSession(() => {
			lost++
		}),
		intent = new PlaybackIntent()
	const start = (entryId?: string) =>
		session.play(source, 'music', video, async (_, __, ___, own) => {
			own(intent.begin())
			return identity(entryId)
		})
	return { session, intent, start, lost: () => lost }
}

void test('activation native identity wins over stale React identity; genuine later native queue entry change loses return ownership', async () => {
	const f = fixture()
	await f.start()
	const oldHook: PreviewPlayerIdentity = {
		mode: 'listening',
		sourceId: 'old-source',
		entryId: 'old-entry',
	}
	let reads = 0
	await f.session.observeCurrent(oldHook, async () => {
		reads++
		return identity()
	})
	assert.equal(reads, 1)
	assert.equal(f.session.getSnapshot().suspended, true)
	assert.equal(f.lost(), 0)
	// Pause/seek do not change the identity and never require fake return rebinding.
	f.session.observe(identity())
	assert.equal(f.session.getSnapshot().suspended, true)
	await f.session.observeCurrent(
		identity('second-occurrence-of-same-source'),
		async () => identity('second-occurrence-of-same-source'),
	)
	assert.equal(f.session.getSnapshot().suspended, false)
	assert.equal(f.lost(), 1)
})

void test('late native identity verification cannot close or overwrite a newer preview owner', async () => {
	const f = fixture(),
		check = deferred<PreviewPlayerIdentity>()
	await f.start('first')
	const pending = f.session.observeCurrent(
		identity('stale-hook'),
		() => check.promise,
	)
	f.session.cancel()
	await f.start('new-owner')
	check.resolve(identity('unrelated-old-native-item'))
	await pending
	assert.equal(f.session.getSnapshot().suspended, true)
	assert.equal(f.lost(), 0)
	assert.equal(
		await f.session.resumeCurrent(async () => identity('new-owner')),
		true,
	)
})

void test('return rereads native identity, refuses genuine changes and retains player when authority cannot be read', async () => {
	const f = fixture()
	await f.start()
	assert.equal(
		await f.session.resumeCurrent(async () => {
			throw new Error('snapshot read failed')
		}),
		false,
	)
	assert.equal(f.session.getSnapshot().suspended, true)
	assert.match(f.session.getSnapshot().error, /snapshot read failed/)
	assert.equal(
		await f.session.resumeCurrent(async () => identity('actual-other-item')),
		false,
	)
	assert.equal(f.lost(), 1)
	assert.equal(f.session.getSnapshot().suspended, false)
})
