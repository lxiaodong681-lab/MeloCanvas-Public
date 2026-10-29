import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { verifyCreatorPost } from '../creator-post-selection'
import * as parts from '../listening-parts-state'
import * as selection from '../listening-selection'
import { parseListeningVideo } from '../listening-source'
import { PlaybackIntent, type PlaybackPreparation } from '../playback-intent'
import type { useListening } from '../useListening'

import { feedFixture } from './following-feed-fixture'

const compile = (source: string) =>
	ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
		},
	}).outputText
const flush = async () => {
	for (let index = 0; index < 50; index++) await Promise.resolve()
}
interface SwitchAlert {
	buttons: { text: string; onPress: () => void }[]
	options: { onDismiss: () => void }
}
function fixture(activate: boolean | Error = true) {
	const f = feedFixture(),
		intent = new PlaybackIntent(),
		alerts: SwitchAlert[] = []
	const video = parseListeningVideo(
		{
			bvid: f.post.bvid,
			title: '原视频',
			pic: f.post.artwork,
			owner: { mid: 88, name: '真实UP' },
			pages: [{ cid: 11, page: 1, part: '真实P', duration: 100 }],
		},
		f.post.bvid,
	)
	let token = 0,
		pending: number | null = null,
		activations = 0,
		presented = 0
	const player = {
		mode: 'music' as const,
		playing: true,
		reservePlayback: async () => {
			pending = ++token
			return { token }
		},
		isPreparationCurrent: async (value: PlaybackPreparation) =>
			value.token === token,
		cancelPreparation: async (value: PlaybackPreparation) => {
			if (value.token === token) {
				token++
				pending = null
			}
		},
		finishPreparation: async (value: PlaybackPreparation) => {
			if (value.token === pending) pending = null
		},
		playListening: async () => {
			activations++
			if (activate instanceof Error) throw activate
			return activate
		},
	}
	const output: { useListening?: typeof useListening } = {}
	runInNewContext(
		compile(
			readFileSync(new URL('../useListening.ts', import.meta.url), 'utf8'),
		),
		{
			exports: output,
			Error,
			require: (name: string) => {
				if (name === 'react')
					return {
						useEffect: () => {},
						useRef: (value: unknown) => ({ current: value }),
						useState: (value: unknown) => [value, () => {}],
					}
				if (name === 'react-native')
					return {
						Alert: {
							alert: (
								_title: string,
								_message: string,
								buttons: SwitchAlert['buttons'],
								options: SwitchAlert['options'],
							) => alerts.push({ buttons, options }),
						},
					}
				if (name === './listening-parts-state') return parts
				if (name === './listening-selection') return selection
				if (name === './listening-source')
					return { listeningSourceDetails: async () => video }
				throw new Error(name)
			},
		},
	)
	assert.ok(output.useListening)
	const listening = output.useListening(
		player,
		null,
		() => assert.fail('App owns the presentation'),
		() => assert.fail('App owns the error'),
		intent,
	)
	const app = ts.createSourceFile(
		'App.tsx',
		readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	let callback = ''
	const visit = (node: ts.Node) => {
		if (
			ts.isFunctionDeclaration(node) &&
			node.name?.text === 'playFollowingPost'
		)
			callback = node.getText(app)
		ts.forEachChild(node, visit)
	}
	visit(app)
	assert.ok(callback)
	const actualPlay = f.session.play.bind(f.session),
		work: Promise<boolean>[] = []
	f.session.play = (...args: Parameters<typeof actualPlay>) => {
		const result = actualPlay(...args)
		work.push(result)
		return result
	}
	const start = runInNewContext(compile(`${callback}\nplayFollowingPost`), {
		followingFeed: { session: f.session },
		Error,
		listening,
		verifyCreatorPost,
		setFullPlayer: (open: boolean) => {
			if (open) presented++
		},
	}) as (bvid: string, mode: 'listening') => void
	f.session.open()
	return {
		...f,
		start: () => start(f.post.bvid, 'listening'),
		alerts,
		work,
		activations: () => activations,
		presented: () => presented,
		pending: () => pending,
		token: () => token,
	}
}

for (const choice of ['refusal', 'dismiss'] as const)
	void test(`actual App + listening Hook ${choice} is silent user cancellation, with no native activation`, async () => {
		const f = fixture()
		try {
			f.start()
			await flush()
			assert.equal(f.alerts.length, 1)
			if (choice === 'refusal')
				f.alerts[0].buttons
					.find((button) => button.text === '继续听音乐')!
					.onPress()
			else f.alerts[0].options.onDismiss()
			assert.equal(await f.work[0], false)
			assert.equal(f.activations(), 0)
			assert.equal(f.presented(), 0)
			assert.equal(f.pending(), null)
			assert.equal(f.session.getSnapshot().playingBvid, null)
			assert.equal(f.session.getSnapshot().playError, '')
		} finally {
			f.raw.close()
		}
	})

void test('actual Hook affirmative confirmation still presents successful playback once', async () => {
	const f = fixture()
	try {
		f.start()
		await flush()
		f.alerts[0].buttons.find((button) => button.text === '开始收听')!.onPress()
		assert.equal(await f.work[0], true)
		assert.equal(f.activations(), 1)
		assert.equal(f.presented(), 1)
		assert.equal(f.pending(), null)
		assert.equal(f.session.getSnapshot().playError, '')
	} finally {
		f.raw.close()
	}
})

void test('actual Hook native activation false remains a visible failure rather than user cancellation', async () => {
	const f = fixture(false)
	try {
		f.start()
		await flush()
		f.alerts[0].buttons.find((button) => button.text === '开始收听')!.onPress()
		assert.equal(await f.work[0], false)
		assert.equal(f.activations(), 1)
		assert.equal(f.presented(), 0)
		assert.equal(f.pending(), null)
		assert.match(f.session.getSnapshot().playError, /未能开始播放/)
	} finally {
		f.raw.close()
	}
})

void test('actual Hook native activation error preserves the real error', async () => {
	const f = fixture(new Error('native preflight failed'))
	try {
		f.start()
		await flush()
		f.alerts[0].buttons.find((button) => button.text === '开始收听')!.onPress()
		assert.equal(await f.work[0], false)
		assert.equal(f.presented(), 0)
		assert.equal(f.pending(), null)
		assert.equal(f.session.getSnapshot().playError, 'native preflight failed')
	} finally {
		f.raw.close()
	}
})

void test('late old Alert refusal cannot cancel the next feed request or clear its busy state', async () => {
	const f = fixture()
	try {
		f.start()
		await flush()
		f.session.cancelPending()
		f.start()
		await flush()
		assert.equal(f.alerts.length, 2)
		const current = f.pending()
		f.alerts[0].buttons
			.find((button) => button.text === '继续听音乐')!
			.onPress()
		assert.equal(await f.work[0], false)
		assert.equal(f.pending(), current)
		assert.equal(f.session.getSnapshot().playingBvid, f.post.bvid)
		assert.equal(f.session.getSnapshot().playError, '')
		f.alerts[1].buttons.find((button) => button.text === '开始收听')!.onPress()
		assert.equal(await f.work[1], true)
		assert.equal(f.activations(), 1)
		assert.equal(f.presented(), 1)
	} finally {
		f.raw.close()
	}
})
