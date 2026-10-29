import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import * as accountErrors from '../account-session'
import * as restriction from '../bilibili-request-error'
import * as subtitles from '../bilibili-subtitles'
import * as sessions from '../listening-subtitles-session'

import {
	deferred,
	settleSubtitles,
	subtitleFixture,
	subtitleMetadata,
	subtitlePayload,
	subtitleTarget,
	subtitleTracks,
	subtitleView,
} from './listening-subtitles-fixture'

void test('subtitle discovery is explicit, lists actual languages and never auto-selects; close/reopen retains the chosen track', async () => {
	const f = subtitleFixture()
	assert.equal(f.api.length, 0)
	assert.equal(f.accountListeners, 0)
	await f.session.open(subtitleTarget)
	assert.equal(f.api.length, 2)
	assert.equal(f.session.getSnapshot().status, 'choice')
	assert.equal(f.session.getSnapshot().selectedTrackId, null)
	assert.deepEqual(
		f.session.getSnapshot().tracks.map((track) => track.label),
		['中文', 'English'],
	)
	assert.equal(f.bodies.length, 0)
	await f.session.selectTrack('102')
	const doc = f.session.getSnapshot().document!
	assert.equal(doc.track.label, 'English')
	assert.equal(f.session.seekPosition(doc.lines[1]), 4)
	f.session.hide()
	assert.equal(f.session.seekPosition(doc.lines[1]), null)
	await f.session.open(subtitleTarget)
	assert.equal(f.session.getSnapshot().document, doc)
	assert.equal(f.api.length, 2)
	assert.equal(f.bodies.length, 1)
	f.session.showTracks()
	await f.session.selectTrack('102')
	assert.equal(f.bodies.length, 1)
	f.session.dispose()
	assert.equal(f.accountListeners, 0)
	assert.equal(f.session.getSnapshot().document, null)
})

void test('late subtitle body cannot cross P changes; closing a pending read aborts delivery and preserves language choice', async () => {
	const f = subtitleFixture(),
		old = deferred<unknown>()
	await f.session.open(subtitleTarget)
	f.setBody(() => old.promise)
	const load = f.session.selectTrack('101')
	assert.equal(f.session.getSnapshot().status, 'loading')
	f.session.setTarget({ ...subtitleTarget, page: 2, cid: 456 })
	assert.equal(f.bodies[0].signal?.aborted, true)
	await settleSubtitles()
	assert.equal(f.session.getSnapshot().status, 'choice')
	old.resolve(subtitlePayload)
	await load
	assert.equal(f.session.getSnapshot().document, null)
	assert.equal(f.session.getSnapshot().target?.cid, 456)
	const next = deferred<unknown>()
	f.setBody(() => next.promise)
	const pending = f.session.selectTrack('102')
	f.session.hide()
	assert.equal(f.session.getSnapshot().status, 'choice')
	assert.equal(f.bodies.at(-1)?.signal?.aborted, true)
	next.resolve(subtitlePayload)
	await pending
	assert.equal(f.session.getSnapshot().document, null)
	await f.session.open({ ...subtitleTarget, page: 2, cid: 456 })
	f.setBody(() => subtitlePayload)
	await f.session.selectTrack('102')
	assert.equal(f.session.getSnapshot().document?.target.cid, 456)
	f.session.dispose()
})

void test('account generation revokes visible and retained subtitles; offline access never requests online data', async () => {
	const f = subtitleFixture(),
		pending = deferred<unknown>()
	await f.session.open(subtitleTarget)
	f.setBody(() => pending.promise)
	const load = f.session.selectTrack('101')
	f.setAccount('offline')
	assert.equal(f.session.getSnapshot().error, 'offline')
	assert.equal(f.session.getSnapshot().tracks.length, 0)
	assert.equal(f.bodies[0].signal?.aborted, true)
	pending.resolve(subtitlePayload)
	await load
	const requests = f.api.length
	await f.session.open(subtitleTarget)
	assert.equal(f.api.length, requests)
	assert.equal(f.session.getSnapshot().document, null)
	f.setAccount('authenticated')
	f.setBody(() => subtitlePayload)
	await f.session.retry()
	await f.session.selectTrack('101')
	const line = f.session.getSnapshot().document!.lines[0]
	f.session.hide()
	f.setAccount('signed-out')
	assert.equal(f.session.getSnapshot().error, 'login-required')
	assert.equal(f.session.seekPosition(line), null)
	f.session.dispose()
})

void test('no subtitles, restricted access, malformed response and missing P remain different and retryable', async () => {
	const f = subtitleFixture()
	await f.session.open(null)
	assert.equal(f.session.getSnapshot().error, 'missing-target')
	assert.equal(f.api.length, 0)
	f.setMetadata((cid) => ({
		...subtitleMetadata(cid),
		subtitle: { subtitles: [] },
	}))
	await f.session.open(subtitleTarget)
	assert.equal(f.session.getSnapshot().status, 'no-tracks')
	f.setMetadata(() => {
		throw new Error('not shown')
	})
	f.setFailure('restricted')
	await f.session.discover()
	assert.equal(f.session.getSnapshot().status, 'error')
	assert.equal(f.session.getSnapshot().error, 'restricted')
	assert.equal(
		JSON.stringify(f.session.getSnapshot()).includes('not shown'),
		false,
	)
	f.setMetadata((cid) => ({ ...subtitleMetadata(cid), subtitle: {} }))
	await f.session.retry()
	assert.equal(f.session.getSnapshot().error, 'invalid-response')
	f.setMetadata(subtitleMetadata)
	await f.session.retry()
	assert.equal(f.session.getSnapshot().status, 'choice')
	f.session.dispose()
})

void test('new language choice supersedes pending track without persisting URLs or a previous document', async () => {
	const f = subtitleFixture(),
		old = deferred<unknown>()
	await f.session.open(subtitleTarget)
	f.setBody(() => old.promise)
	const first = f.session.selectTrack('101')
	f.setBody(() => subtitlePayload)
	await f.session.selectTrack('102')
	old.resolve(subtitlePayload)
	await first
	assert.equal(f.session.getSnapshot().document?.track.id, '102')
	assert.equal(
		JSON.stringify(f.session.getSnapshot()).includes('/bfs/subtitle/'),
		false,
	)
	assert.equal(
		f.session.seekPosition({ ...f.session.getSnapshot().document!.lines[0] }),
		null,
	)
	f.session.dispose()
})

void test('an authenticated account generation change leaves a visible retry state instead of an endless loading view', async () => {
	const f = subtitleFixture()
	await f.session.open(subtitleTarget)
	await f.session.selectTrack('101')
	f.setAccount('authenticated')
	assert.equal(f.session.getSnapshot().status, 'error')
	assert.equal(f.session.getSnapshot().error, 'stale')
	assert.equal(f.session.getSnapshot().document, null)
	await f.session.retry()
	assert.equal(f.session.getSnapshot().status, 'choice')
	f.session.dispose()
})

void test('production bridge uses existing account request/WBI and calls native CDN reader with only its allowlisted URL', async () => {
	const f = subtitleFixture(),
		api: string[] = [],
		signed: Record<string, string>[] = [],
		bodyArgs: unknown[][] = []
	const exports: Record<string, unknown> = {}
	const source = readFileSync(
		new URL('../listening-subtitles.ts', import.meta.url),
		'utf8',
	)
	runInNewContext(
		ts.transpileModule(source, {
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
			},
		}).outputText,
		{
			exports,
			URLSearchParams,
			require(path: string) {
				if (path === '@bbplayer/orpheus')
					return {
						Orpheus: {
							bilibiliSubtitleRequest: async (...args: unknown[]) => {
								bodyArgs.push(args)
								return {
									status: 200,
									body: JSON.stringify(subtitlePayload),
									url: args[0],
								}
							},
						},
					}
				if (path === './account-runtime') return { accountSession: f.account }
				if (path === './account-session') return accountErrors
				if (path === './bilibili-request-error') return restriction
				if (path === './bilibili-subtitles') return subtitles
				if (path === './listening-subtitles-session') return sessions
				if (path === './bilibili')
					return {
						signed: async (params: Record<string, string>) => {
							signed.push(params)
							return 'aid=100&cid=123&w_rid=fixture'
						},
						request: async (endpoint: string) => {
							api.push(endpoint)
							return endpoint.startsWith('/x/web-interface/view?')
								? subtitleView()
								: subtitleMetadata()
						},
					}
				throw new Error(`Unexpected production subtitle dependency ${path}`)
			},
		},
	)
	const session = (
		exports.createListeningSubtitlesSession as () => sessions.ListeningSubtitlesSession
	)()
	await session.open(subtitleTarget)
	assert.deepEqual(signed, [{ aid: '100', cid: '123' }])
	assert.equal(api[0], '/x/web-interface/view?bvid=BV1vT411i7ET')
	assert.equal(api[1], '/x/player/wbi/v2?aid=100&cid=123&w_rid=fixture')
	await session.selectTrack('101')
	assert.deepEqual(bodyArgs, [[subtitleTracks[0].subtitle_url]])
	assert.equal(
		session.getSnapshot().document?.lines[0].text,
		subtitlePayload.body[0].content,
	)
	session.dispose()
})
