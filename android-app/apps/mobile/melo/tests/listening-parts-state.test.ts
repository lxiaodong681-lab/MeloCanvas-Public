import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import type { PlaybackMode } from '../core/listening'
import type { Source } from '../core/model'
import {
	ListeningPartsOwner,
	acceptExplicitListeningParts,
	readCurrentListeningParts,
} from '../listening-parts-state'
import * as listeningSelection from '../listening-selection'
import { parseListeningVideo, type ListeningVideo } from '../listening-source'
import { PlaybackIntent, type PlaybackRequest } from '../playback-intent'

import { preparationPort } from './playback-preparation-fixture'

type Hook = typeof import('../useListening').useListening
const A = 'BV1vT411i7ET',
	B = 'BV1Z9pb6MEwT'
function video(bvid = A, cids = [11, 22]): ListeningVideo {
	return parseListeningVideo(
		{
			bvid,
			title: `原视频${bvid}`,
			owner: { name: 'UP', mid: 88 },
			pic: 'https://example.invalid/a',
			videos: cids.length,
			pages: cids.map((cid, index) => ({
				cid,
				page: index + 1,
				part: `P${index + 1}`,
				duration: 90,
			})),
		},
		bvid,
	)
}
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}
async function settle() {
	for (let index = 0; index < 8; index++) await Promise.resolve()
}
function publisher() {
	const state = {
			video: null as ListeningVideo | null,
			loading: false,
			error: '',
		},
		events: string[] = []
	return {
		state,
		events,
		publish: {
			video: (value: ListeningVideo | null) => {
				state.video = value
				events.push(`video:${value?.bvid ?? 'null'}`)
			},
			loading: (value: boolean) => {
				state.loading = value
				events.push(`loading:${value}`)
			},
			error: (value: string) => {
				state.error = value
				events.push(`error:${value}`)
			},
		},
	}
}

/** Runs the actual hook source with deterministic hook/effect ports, not a React Native renderer. */
function hookHarness(options: {
	load: (bvid: string, signal: AbortSignal) => Promise<ListeningVideo>
	mode?: PlaybackMode
	playing?: boolean
	current?: Source | null
	play?: () => Promise<boolean>
	confirm?: boolean
	baseline?: boolean
}) {
	const source = readFileSync(
		options.baseline && process.env.MELO_LISTENING_PARTS_BASELINE
			? process.env.MELO_LISTENING_PARTS_BASELINE
			: new URL('../useListening.ts', import.meta.url),
		'utf8',
	)
	const stateSlots: unknown[] = [],
		refSlots: unknown[] = [],
		effects: { deps: readonly unknown[]; cleanup?: () => void }[] = []
	let stateIndex = 0,
		refIndex = 0,
		effectIndex = 0,
		dirty = false,
		unmounted = false,
		afterUnmount = 0,
		confirmations = 0,
		cancelledNative = 0
	const scheduled: (() => void)[] = []
	const react = {
		useState: (initial: unknown) => {
			const index = stateIndex++
			if (!(index in stateSlots)) stateSlots[index] = initial
			return [
				stateSlots[index],
				(next: unknown) => {
					if (unmounted) afterUnmount++
					const value =
						typeof next === 'function'
							? (next as (old: unknown) => unknown)(stateSlots[index])
							: next
					if (!Object.is(value, stateSlots[index])) {
						stateSlots[index] = value
						dirty = true
					}
				},
			]
		},
		useRef: (initial: unknown) => {
			const index = refIndex++
			if (!(index in refSlots)) refSlots[index] = { current: initial }
			return refSlots[index]
		},
		useEffect: (
			effect: () => void | (() => void),
			deps: readonly unknown[],
		) => {
			const index = effectIndex++,
				old = effects[index]
			if (
				old &&
				old.deps.length === deps.length &&
				deps.every((value, offset) => Object.is(value, old.deps[offset]))
			)
				return
			scheduled.push(() => {
				old?.cleanup?.()
				effects[index] = { deps, cleanup: effect() ?? undefined }
			})
		},
	}
	const exported = {} as { useListening: Hook }
	const compiled = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2023,
		},
	}).outputText
	runInNewContext(compiled, {
		exports: exported,
		AbortController,
		Error,
		Map,
		require: (name: string) => {
			if (name === 'react') return react
			if (name === 'react-native')
				return {
					Alert: {
						alert: (
							_title: string,
							_message: string,
							buttons: { onPress: () => void }[],
						) => {
							confirmations++
							buttons[options.confirm === false ? 0 : 1].onPress()
						},
					},
				}
			if (name === './listening-selection') return listeningSelection
			if (name === './listening-source')
				return { listeningSourceDetails: options.load }
			if (name === './listening-parts-state')
				return {
					ListeningPartsOwner,
					readCurrentListeningParts,
					acceptExplicitListeningParts,
				}
			throw new Error(`Unexpected hook dependency ${name}`)
		},
	})
	const intent = new PlaybackIntent(),
		started: string[] = [],
		errors: string[] = [],
		played: Source[] = []
	let current =
		options.current === undefined ? video().parts[0].source : options.current
	const preparation = preparationPort(async () => {
		cancelledNative++
	})
	let player = {
		mode: options.mode ?? 'listening',
		playing: options.playing ?? true,
		...preparation,
		playListening: async (sourceValue: Source) => {
			played.push(sourceValue)
			return options.play ? options.play() : true
		},
	}
	let view!: ReturnType<Hook>
	const render = () => {
		let passes = 0
		do {
			if (++passes > 20) throw new Error('Hook did not settle')
			dirty = false
			stateIndex = 0
			refIndex = 0
			effectIndex = 0
			view = exported.useListening(
				player,
				current,
				() => started.push('started'),
				(message) => errors.push(message),
				intent,
			)
			for (const effect of scheduled.splice(0)) effect()
		} while (dirty)
		return view
	}
	render()
	return {
		render,
		intent,
		started,
		errors,
		played,
		confirmations: () => confirmations,
		cancelledNative: () => cancelledNative,
		invalidateNative: () => preparation.reservePlayback(),
		afterUnmount: () => afterUnmount,
		setCurrent: (mode: PlaybackMode, value: Source | null, playing = true) => {
			player = { ...player, mode, playing }
			current = value
			return render()
		},
		unmount: () => {
			unmounted = true
			for (const effect of effects) effect.cleanup?.()
		},
		get view() {
			return view
		},
	}
}

void test('actual hook: 同BV成功显式start后旧自动读取晚success不能覆盖新parts/cache', async () => {
	const old = deferred<ListeningVideo>(),
		fresh = video(),
		legacy = video(A, [11])
	let loads = 0
	const h = hookHarness({
		baseline: true,
		load: () => (++loads === 1 ? old.promise : Promise.resolve(fresh)),
	})
	assert.equal(h.view.partsLoading, true)
	assert.equal(
		await h.view.start(fresh.parts[1].source, { verifiedVideo: fresh }),
		true,
	)
	assert.deepEqual(
		h.render().parts.map((part) => part.source.cid),
		[11, 22],
	)
	old.resolve(legacy)
	await settle()
	assert.deepEqual(
		h.render().parts.map((part) => part.source.cid),
		[11, 22],
	)
	assert.equal(h.view.partsLoading, false)
	assert.equal(h.view.partsError, '')
	h.setCurrent('music', null)
	h.setCurrent('listening', fresh.parts[1].source)
	assert.deepEqual(
		h.view.parts.map((part) => part.source.cid),
		[11, 22],
	)
	h.unmount()
})

void test('actual hook: 已核验快照的native失败或音乐确认取消不提前接纳cache/video', async () => {
	for (const failure of ['native', 'confirmation'] as const) {
		const legacy = video(A, [11]),
			fresh = video()
		let loads = 0
		const h = hookHarness({
			load: async () => {
				loads++
				return legacy
			},
			mode: failure === 'confirmation' ? 'music' : 'listening',
			current: legacy.parts[0].source,
			play: async () => false,
			confirm: false,
		})
		if (failure === 'confirmation') {
			h.setCurrent('listening', legacy.parts[0].source)
			await settle()
			h.render()
			h.setCurrent('music', legacy.parts[0].source)
		} else {
			await settle()
			h.render()
		}
		assert.equal(
			await h.view.start(fresh.parts[1].source, { verifiedVideo: fresh }),
			false,
		)
		h.setCurrent('music', null)
		h.setCurrent('listening', legacy.parts[0].source)
		assert.deepEqual(
			h.view.parts.map((part) => part.source.cid),
			[11],
		)
		assert.equal(h.view.partsLoading, false)
		assert.equal(loads, 1)
		h.unmount()
	}
})

void test('actual readCurrent/acceptExplicit: 旧error和finally晚到不能改新目录/错误/loading', async () => {
	const owner = new ListeningPartsOwner(),
		cache = new Map<string, ListeningVideo>(),
		old = deferred<ListeningVideo>(),
		p = publisher(),
		fresh = video()
	readCurrentListeningParts(owner, A, cache, () => old.promise, p.publish)
	acceptExplicitListeningParts(owner, cache, fresh, p.publish)
	const events = [...p.events]
	old.reject(new Error('旧网络错误'))
	await settle()
	assert.deepEqual(p.events, events)
	assert.equal(cache.get(A), fresh)
	assert.equal(p.state.video, fresh)
	assert.equal(p.state.error, '')
	assert.equal(p.state.loading, false)
})

void test('actual readCurrent: 换BV/retry的旧success/error/finally与旧cleanup不影响新owner', async () => {
	for (const outcome of ['success', 'error'] as const) {
		const owner = new ListeningPartsOwner(),
			cache = new Map<string, ListeningVideo>(),
			old = deferred<ListeningVideo>(),
			newer = deferred<ListeningVideo>(),
			p = publisher()
		const oldCleanup = readCurrentListeningParts(
			owner,
			A,
			cache,
			() => old.promise,
			p.publish,
		)
		readCurrentListeningParts(owner, B, cache, () => newer.promise, p.publish)
		oldCleanup()
		if (outcome === 'success') old.resolve(video(A, [11]))
		else old.reject(new Error('obsolete'))
		await settle()
		assert.equal(p.state.loading, true)
		assert.equal(p.state.error, '')
		assert.equal(p.state.video, null)
		assert.equal(cache.has(A), false)
		newer.resolve(video(B))
		await settle()
		assert.equal(p.state.loading, false)
		assert.equal(p.state.video!.bvid, B)
	}
})

void test('actual hook: 离开听视频清掉loading，unmount后旧读取不能再发布', async () => {
	const pending = deferred<ListeningVideo>(),
		h = hookHarness({ load: () => pending.promise })
	assert.equal(h.view.partsLoading, true)
	h.setCurrent('music', null)
	assert.equal(h.view.partsLoading, false)
	assert.equal(h.view.partsError, '')
	h.unmount()
	pending.resolve(video())
	await settle()
	assert.equal(h.afterUnmount(), 0)
})

void test('actual hook: verified必须明确CID，历史CID消失或坏supplied目录不能默认首P/调用native', async () => {
	const fresh = video()
	let loads = 0
	const h = hookHarness({
		mode: 'music',
		playing: false,
		current: null,
		load: async () => {
			loads++
			return fresh
		},
	})
	assert.equal(await h.view.start({ bvid: A }, { verifiedVideo: fresh }), false)
	assert.equal(
		await h.view.start(
			{ ...fresh.parts[0].source, cid: 99 },
			{ verifiedVideo: fresh },
		),
		false,
	)
	for (const bad of [
		video(B),
		{ ...fresh, parts: [fresh.parts[0], fresh.parts[0]] },
		{ ...fresh, parts: fresh.parts.toReversed() },
	]) {
		assert.equal(
			await h.view.start(fresh.parts[0].source, { verifiedVideo: bad }),
			false,
		)
	}
	assert.equal(loads, 0)
	assert.equal(h.played.length, 0)
	assert.equal(h.confirmations(), 0)
	assert.ok(h.errors.some((error) => error.includes('分 P 已变更')))
	h.unmount()
})

void test('actual hook: 旧非verified路径仍load/validate/确认音乐，再用同一意图播放明确CID', async () => {
	const fresh = video()
	let loads = 0,
		validated = 0
	const h = hookHarness({
		mode: 'music',
		current: null,
		load: async () => {
			loads++
			return fresh
		},
	})
	assert.equal(
		await h.view.start(fresh.parts[1].source, {
			validateVideo: (value) => {
				assert.equal(value, fresh)
				validated++
			},
		}),
		true,
	)
	assert.equal(loads, 1)
	assert.equal(validated, 1)
	assert.equal(h.confirmations(), 1)
	assert.equal(h.played[0].cid, 22)
	assert.equal(h.started.length, 1)
	h.unmount()
})

void test('actual hook: 新PlaybackIntent或取消使旧native成功不能接纳快照或触发onStarted', async () => {
	for (const invalidation of ['new-intent', 'cancel'] as const) {
		const activation = deferred<boolean>(),
			legacy = video(A, [11]),
			fresh = video()
		const h = hookHarness({
			load: async () => legacy,
			play: () => activation.promise,
		})
		await settle()
		h.render()
		let request: PlaybackRequest | null = null
		const work = h.view.start(fresh.parts[1].source, {
			verifiedVideo: fresh,
			onRequest: (value) => {
				request = value
			},
		})
		await settle()
		if (invalidation === 'new-intent') h.intent.begin()
		else (request as PlaybackRequest | null)?.cancel()
		activation.resolve(true)
		assert.equal(await work, false)
		h.setCurrent('music', null)
		h.setCurrent('listening', legacy.parts[0].source)
		assert.deepEqual(
			h.view.parts.map((part) => part.source.cid),
			[11],
		)
		assert.equal(h.started.length, 0)
		h.unmount()
	}
})

void test('actual hook: metadata arriving after native invalidation cannot validate, ask to switch, play or report failure', async () => {
	const loaded = deferred<ListeningVideo>(),
		entered = deferred<void>()
	let validated = 0
	const h = hookHarness({
		mode: 'music',
		current: null,
		playing: true,
		load: async () => {
			entered.resolve()
			return loaded.promise
		},
	})
	const work = h.view.start(video().parts[1].source, {
		validateVideo: () => {
			validated++
		},
	})
	await entered.promise
	await h.invalidateNative()
	loaded.resolve(video())
	assert.equal(await work, false)
	assert.equal(validated, 0)
	assert.equal(h.confirmations(), 0)
	assert.equal(h.played.length, 0)
	assert.equal(h.started.length, 0)
	assert.deepEqual(h.errors, [])
	h.unmount()
})
