import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import type { PlaybackSnapshot, Track } from '@bbplayer/orpheus'

import { sourceId, type Source } from '../core/model'
import {
	PlaybackIntent,
	playMusicIntent,
	type PlaybackRequest,
} from '../playback-intent'
import { PlaybackController, type PlaybackNative } from '../playbackController'

const candidate: Source = {
	id: sourceId('BV1vT411i7ET', 99),
	bvid: 'BV1vT411i7ET',
	cid: 99,
	originalTitle: '翻唱 Live · 第 99 P',
	uploader: 'UP',
	uploaderId: 1,
	performer: null,
	artwork: '',
	duration: 300,
	domain: 'unclassified',
	audioAvailability: 'unknown',
}
const original: PlaybackSnapshot = {
	mode: 'music',
	tracks: [],
	currentEntryId: null,
	currentSourceId: null,
	positionSeconds: 0,
	durationSeconds: 0,
	speed: 1,
	playing: false,
	updatedAt: 1,
	inactiveSession: null,
	resumePoints: [],
}
const fail = async (): Promise<never> => {
	throw new Error('ordinary playback must not be used')
}

function fixture() {
	let snapshot = structuredClone(original),
		token = 0,
		writes = 0,
		starts = 0
	let startedTrack: Track | null = null

	const native: PlaybackNative = {
		getPlaybackSnapshot: async () => structuredClone(snapshot),
		cancelPlaybackReplacement: async () => ++token,
		cancelPlaybackReplacementIfCurrent: async (value) => {
			if (value !== token) return false
			token++
			if (snapshot.auditionId === `audition-${value}`)
				snapshot = structuredClone(original)
			return true
		},
		isPlaybackReplacementCurrent: async (value) => value === token,
		finishPlaybackPreparationIfCurrent: async (value) => value === token,
		replacePlayback: fail,
		startFm: fail,
		exitFm: fail,
		appendFm: fail,
		startCandidateAudition: async (track, value) => {
			assert.equal(value, token)
			starts++
			startedTrack = track
			snapshot = {
				...original,
				tracks: [track],
				currentEntryId: track.id,
				currentSourceId: track.sourceId ?? track.id,
				auditionId: `audition-${value}`,
			}
			return structuredClone(snapshot)
		},
		endCandidateAudition: async () => {
			snapshot = structuredClone(original)
			return snapshot
		},
	}
	const controller = new PlaybackController(
		native,
		{
			save: () => {
				throw new Error('candidate metadata must not be saved')
			},
			get: () => null,
		},
		{
			getResumePoint: () => null,
			saveResumePoint: () => {
				throw new Error('candidate resume must not be saved')
			},
		},
		{
			getSession: () => null,
			saveSession: () => {
				writes++
			},
		},
	)
	return {
		native,
		controller,
		counts: () => ({ starts, writes }),
		track: () => startedTrack,
	}
}

void test('candidate activation uses isolated native path and preserves exact source/cid/version title', async () => {
	const f = fixture(),
		preparation = await f.controller.reservePlayback()
	const snapshot = await f.controller.playCandidateAudition(
		candidate,
		preparation,
	)
	assert.ok(snapshot?.auditionId)
	assert.equal(f.track()?.sourceId, candidate.id)
	assert.match(f.track()!.url, /cid=99/)
	assert.equal(f.track()?.title, candidate.originalTitle)
	const writes = f.counts().writes
	await f.controller.sync()
	assert.equal(
		f.counts().writes,
		writes,
		'audition cannot project into normal session',
	)
	assert.equal(f.controller.canReturnMusic(snapshot), false)
	await f.controller.endCandidateAudition(snapshot.auditionId)
	assert.ok(f.counts().writes > writes)
})

void test('cancelled or obsolete intent never starts audition', async () => {
	const f = fixture(),
		first = await f.controller.reservePlayback()
	await f.controller.reservePlayback()
	assert.equal(await f.controller.playCandidateAudition(candidate, first), null)
	assert.equal(f.counts().starts, 0)
})

void test('old native version fails closed instead of using ordinary player', async () => {
	const f = fixture()
	delete f.native.startCandidateAudition
	await assert.rejects(
		f.controller.playCandidateAudition(
			candidate,
			await f.controller.reservePlayback(),
		),
		/更新原生/,
	)
	assert.equal(f.counts().starts, 0)
})

void test('audition UI is independent from music queue, favourite and download actions', () => {
	const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
	const preview = app.slice(
		app.indexOf('function playImportPreview()'),
		app.indexOf('function openImportedPlaylist'),
	)
	assert.match(preview, /activate: player.playCandidateAudition/)
	assert.doesNotMatch(preview, /activate: player.playSource/)
	const ui = app.slice(
		app.indexOf('{player.auditionId ? ('),
		app.indexOf(") : fullPlayer && current && player.mode === 'listening'"),
	) + readFileSync(new URL('../candidate-audition-ui.tsx', import.meta.url), 'utf8')
	assert.match(ui, /返回选择音源/)
	assert.doesNotMatch(ui, /MusicPlayer|onLike|onOffline|onFm|onQueue/)
})

void test('legacy native queue mutators fail closed before cancelling or writing the candidate', () => {
	const module = readFileSync(
		new URL(
			'../../../../packages/orpheus/android/src/main/java/expo/modules/orpheus/ExpoOrpheusModule.kt',
			import.meta.url,
		),
		'utf8',
	)
	for (const method of [
		'clear',
		'removeTrack',
		'moveTrack',
		'reverseRemainingQueue',
		'addToEnd',
		'playNext',
	]) {
		const start = module.indexOf(`AsyncFunction("${method}")`)
		const block = module.slice(
			start,
			module.indexOf('AsyncFunction(', start + 1),
		)
		assert.ok(
			block.indexOf('service.requireNotCandidateAudition()') >= 0,
			method,
		)
		assert.ok(
			block.indexOf('service.requireNotCandidateAudition()') <
				block.indexOf('playbackReplacement.cancel()'),
			method,
		)
	}
})

void test('cancellation after native commit but before publication restores original without projecting candidate', async () => {
	const f = fixture(),
		intent = new PlaybackIntent()
	let request: PlaybackRequest | undefined, release!: () => void
	const blocked = new Promise<void>((resolve) => {
		release = resolve
	})
	const start = f.native.startCandidateAudition!.bind(f.native)
	let committed!: () => void
	const didCommit = new Promise<void>((resolve) => {
		committed = resolve
	})
	f.native.startCandidateAudition = async (...args) => {
		const value = await start(...args)
		committed()
		await blocked
		return value
	}
	const work = playMusicIntent(intent, candidate, {
		resolve: async () => candidate,
		preparation: f.controller,
		activate: async (source, preparation) =>
			!!(await f.controller.playCandidateAudition(source, preparation)),
		onPending() {},
		onStarted() {
			assert.fail('cancelled audition must not open the old player')
		},
		onRequest(value) {
			request = value
		},
	})
	await didCommit
	assert.ok((await f.native.getPlaybackSnapshot()).auditionId)
	request!.cancel()
	release()
	assert.equal(await work, false)
	assert.deepEqual(await f.native.getPlaybackSnapshot(), original)
})

void test('replacing a candidate and late cancellation cannot cancel the newer audition', async () => {
	const f = fixture(),
		first = await f.controller.reservePlayback()
	const one = await f.controller.playCandidateAudition(candidate, first)
	const second = await f.controller.reservePlayback()
	const two = await f.controller.playCandidateAudition(
		{ ...candidate, id: sourceId(candidate.bvid, 100), cid: 100 },
		second,
	)
	assert.notEqual(one?.auditionId, two?.auditionId)
	await f.controller.cancelPreparation(first)
	assert.equal(
		(await f.native.getPlaybackSnapshot()).auditionId,
		two?.auditionId,
	)
})

void test('native activation and exit failures remain visible and never fall back to ordinary playback', async () => {
	const f = fixture()
	f.native.startCandidateAudition = async () => {
		throw new Error('试听资源不可用')
	}
	await assert.rejects(
		f.controller.playCandidateAudition(
			candidate,
			await f.controller.reservePlayback(),
		),
		/试听资源不可用/,
	)
	f.native.endCandidateAudition = async () => {
		throw new Error('恢复失败，请重试')
	}
	await assert.rejects(
		f.controller.endCandidateAudition('audition'),
		/恢复失败/,
	)
	assert.deepEqual(await f.native.getPlaybackSnapshot(), original)
})
