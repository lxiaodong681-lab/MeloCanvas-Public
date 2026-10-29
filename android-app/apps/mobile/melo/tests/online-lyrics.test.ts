import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
	createOnlineLyricsService,
	OnlineLyricError,
	type OnlineLyricCandidate,
	type OnlineLyricProvider,
	type OnlineLyricSource,
} from '../online-lyrics'

const candidate = (
	source: OnlineLyricSource,
	id?: number | string,
): OnlineLyricCandidate => ({
	source,
	title: 'Synthetic tune',
	artist: 'Test',
	duration: 90,
	remoteId: id ?? (source === 'netease' ? 123 : 'test123'),
})
const provider = (
	source: OnlineLyricSource,
	lrc = '[00:01.00]Synthetic first\n[00:03.00]Synthetic second',
): OnlineLyricProvider => ({
	source,
	async search() {
		return [candidate(source)]
	},
	async load() {
		return { lrc }
	},
})
const hasCode = (code: string) => (error: unknown) =>
	error instanceof OnlineLyricError && error.code === code

for (const respectsAbort of [true, false]) {
	void test(`automatic fallback survives a stalled preferred body (respects abort: ${respectsAbort})`, async () => {
		const loads: string[] = []
		let pendingSignal: AbortSignal | undefined
		let finish: ((value: { lrc: string }) => void) | undefined
		const preferred = provider('netease')
		preferred.load = (_candidate, signal) => {
			loads.push('netease')
			pendingSignal = signal
			return new Promise((resolve, reject) => {
				finish = resolve
				if (respectsAbort)
					signal.addEventListener('abort', () => reject(new Error('aborted')), {
						once: true,
					})
			})
		}
		const fallback = provider('qqmusic')
		fallback.load = async () => {
			loads.push('qqmusic')
			return { lrc: '[00:01.00]Fallback first\n[00:03.00]Fallback second' }
		}
		try {
			const result = await createOnlineLyricsService([preferred, fallback]).match(
				{
					sourceId: 'stable',
					title: 'Synthetic tune',
					performer: 'Test',
					durationSeconds: 90,
				},
				{ timeoutMs: 120 },
			)
			assert.equal(result.candidate.source, 'qqmusic')
			assert.equal(result.sourceId, 'stable')
			assert.equal(result.lines.length, 2)
			assert.equal(result.lines[0].content, 'Fallback first')
			assert.equal(pendingSignal?.aborted, true)
			finish?.({ lrc: '[00:01.00]Late preferred body' })
			await new Promise((resolve) => setImmediate(resolve))
			assert.equal(result.lines[0].content, 'Fallback first')
		} finally {
			assert.deepEqual(loads, ['netease', 'qqmusic'])
		}
	})
}

const matchTrack = {
	sourceId: 'stable',
	title: 'Synthetic tune',
	performer: 'Test',
	durationSeconds: 90,
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => { resolve = done })
	return { promise, resolve }
}

void test('default automatic body budget reaches a healthy fallback after three seconds', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
	const started = deferred<void>()
	const preferred = provider('netease')
	preferred.load = () => {
		started.resolve()
		return new Promise(() => {})
	}
	const request = createOnlineLyricsService([preferred, provider('qqmusic')]).match(matchTrack)
	await started.promise
	t.mock.timers.tick(3000)
	assert.equal((await request).candidate.source, 'qqmusic')
	assert.equal(Date.now(), 3000)
})

void test('body budgets use time left after search and still reserve fallback time', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
	const searching = deferred<void>()
	const searchResult = deferred<OnlineLyricCandidate[]>()
	const loading = deferred<void>()
	let fallbackLoads = 0
	const preferred = provider('netease')
	preferred.search = () => {
		searching.resolve()
		return searchResult.promise
	}
	preferred.load = () => {
		loading.resolve()
		return new Promise(() => {})
	}
	const fallback = provider('qqmusic')
	fallback.load = async () => {
		fallbackLoads++
		return { lrc: '[00:01.00]Fallback' }
	}
	const controller = new AbortController()
	const request = createOnlineLyricsService([preferred, fallback]).match(
		matchTrack, { signal: controller.signal, timeoutMs: 120 },
	)
	try {
		await searching.promise
		t.mock.timers.tick(90)
		searchResult.resolve([candidate('netease')])
		await loading.promise
		t.mock.timers.tick(11)
		await new Promise((resolve) => setImmediate(resolve))
		assert.equal(fallbackLoads, 1, 'fallback must start before the global 120ms deadline')
		assert.equal((await request).candidate.source, 'qqmusic')
	} finally {
		controller.abort()
	}
})

void test('a ranked preferred body keeps precedence while its own budget remains', async () => {
	const started = deferred<void>()
	const body = deferred<{ lrc: string }>()
	const preferred = provider('netease')
	preferred.load = () => {
		started.resolve()
		return body.promise
	}
	const fallback = provider('qqmusic')
	fallback.load = async () => assert.fail('a healthy ranked winner must not be raced away')
	const request = createOnlineLyricsService([preferred, fallback]).match(matchTrack)
	await started.promise
	body.resolve({ lrc: '[00:01.00]Preferred body' })
	assert.equal((await request).candidate.source, 'netease')
})

void test('fallback after a stalled body still rejects a loaded Live version', async () => {
	const loads: string[] = []
	const preferred = provider('netease')
	preferred.load = () => {
		loads.push('netease')
		return new Promise(() => {})
	}
	const live = provider('qqmusic')
	live.load = async () => {
		loads.push('qqmusic')
		return { lrc: '[ti:Synthetic tune (Live)]\n[00:01.00]Live body' }
	}
	const fallback = provider('kugou')
	fallback.load = async () => {
		loads.push('kugou')
		return { lrc: '[00:01.00]Studio body' }
	}
	const result = await createOnlineLyricsService([preferred, live, fallback]).match(
		matchTrack, { timeoutMs: 200 },
	)
	assert.equal(result.candidate.source, 'kugou')
	assert.deepEqual(loads, ['netease', 'qqmusic', 'kugou'])
})

void test('all automatic body failures stay unavailable and clean up every request', async () => {
	const signals: AbortSignal[] = []
	const sources = (['netease', 'qqmusic', 'kugou'] as const).map((source) => {
		const item = provider(source)
		item.load = async (_candidate, signal) => {
			signals.push(signal)
			if (source === 'qqmusic') return { lrc: '' }
			throw new Error('raw provider failure')
		}
		return item
	})
	await assert.rejects(createOnlineLyricsService(sources).match(matchTrack), hasCode('unavailable'))
	assert.equal(signals.length, 3)
	assert.ok(signals.every((signal) => signal.aborted))
})

void test('overall deadline still rejects timeout during body work and discards late completion', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
	const started = deferred<void>()
	const body = deferred<{ lrc: string }>()
	let signal: AbortSignal | undefined
	const source = provider('netease')
	source.load = (_candidate, value) => {
		signal = value
		started.resolve()
		return body.promise
	}
	const request = createOnlineLyricsService([source]).match(matchTrack, { timeoutMs: 120 })
	await started.promise
	// Simulate the event loop resuming after the entire deadline has elapsed.
	t.mock.timers.tick(120)
	await assert.rejects(request, hasCode('timeout'))
	assert.equal(signal?.aborted, true)
	body.resolve({ lrc: '[00:01.00]Too late' })
	await new Promise((resolve) => setImmediate(resolve))
})

void test('cancelling an active fallback aborts it and starts no later candidate', async () => {
	const started = deferred<void>()
	const body = deferred<{ lrc: string }>()
	let signal: AbortSignal | undefined
	const preferred = provider('netease')
	preferred.load = async () => { throw new Error('unavailable') }
	const fallback = provider('qqmusic')
	fallback.load = (_candidate, value) => {
		signal = value
		started.resolve()
		return body.promise
	}
	const later = provider('kugou')
	later.load = async () => assert.fail('cancellation must not start another fallback')
	const controller = new AbortController()
	const request = createOnlineLyricsService([preferred, fallback, later]).match(
		matchTrack, { signal: controller.signal },
	)
	await started.promise
	controller.abort()
	await assert.rejects(request, hasCode('cancelled'))
	assert.equal(signal?.aborted, true)
	body.resolve({ lrc: '[00:01.00]Late cancelled fallback' })
	await new Promise((resolve) => setImmediate(resolve))
})

void test('search preserves provider metadata and source IDs without account data', async () => {
	const service = createOnlineLyricsService([
		provider('netease'),
		provider('qqmusic'),
		provider('kugou'),
	])
	const result = await service.search('Synthetic')
	assert.equal(result.candidates.length, 3)
	assert.deepEqual(result.unavailable, [])
	assert.deepEqual(Object.keys(result.candidates[0]).sort(), [
		'artist',
		'duration',
		'remoteId',
		'source',
		'title',
	])
})
void test('partial search failure remains isolated and retryable', async () => {
	const broken = provider('qqmusic')
	broken.search = async () => {
		throw new Error('secret raw response')
	}
	const result = await createOnlineLyricsService([
		provider('netease'),
		broken,
	]).search('synthetic')
	assert.equal(result.candidates.length, 1)
	assert.deepEqual(result.unavailable, ['qqmusic'])
	assert.ok(!JSON.stringify(result).includes('secret'))
})
void test('manual load binds stable sourceId and reuses Splash translation/timing', async () => {
	const source = provider('netease')
	source.load = async () => ({
		lrc: '[00:01.00]Synthetic first\n[00:03.00]Synthetic last',
		tlyric: '[00:01.00]合成译文',
	})
	const result = await createOnlineLyricsService([source]).load(
		'bili:BV-test:456',
		candidate('netease'),
	)
	assert.equal(result.sourceId, 'bili:BV-test:456')
	assert.equal(result.lines[0].startTime, 1000)
	assert.equal(result.lines[0].endTime, 3000)
	assert.equal(result.lines[0].translation, '合成译文')
})
void test('empty successful provider cannot win automatic race', async () => {
	const result = await createOnlineLyricsService([
		provider('netease', ''),
		provider('qqmusic'),
	]).match({ sourceId: 'stable', title: 'Synthetic' })
	assert.equal(result.candidate.source, 'qqmusic')
	assert.ok(result.lines.length)
})
void test('all empty providers yield safe unavailable', async () => {
	await assert.rejects(
		createOnlineLyricsService([
			provider('netease', ''),
			provider('qqmusic', ' '),
		]).match({ sourceId: 'x', title: 'Synthetic' }),
		hasCode('unavailable'),
	)
})
void test('manual empty response is explicit empty, not cached success', async () => {
	await assert.rejects(
		createOnlineLyricsService([provider('netease', '')]).load(
			'x',
			candidate('netease'),
		),
		hasCode('empty'),
	)
})
void test('automatic QQ duration preference retains existing BBPlayer policy', async () => {
	const source = provider('qqmusic')
	source.search = async () => [
		{ ...candidate('qqmusic', 'first'), duration: 20 },
		{ ...candidate('qqmusic', 'second'), duration: 92 },
	]
	const result = await createOnlineLyricsService([source]).match({
		sourceId: 'x',
		title: 'Synthetic',
		durationSeconds: 90,
	})
	assert.equal(result.candidate.remoteId, 'second')
})
void test('automatic Netease considers duration before search order without claiming recording identity', async () => {
	const source = provider('netease')
	source.search = async () => [
		{ ...candidate('netease', 1), duration: 20 },
		{ ...candidate('netease', 2), duration: 90 },
	]
	assert.equal(
		(
			await createOnlineLyricsService([source]).match({
				sourceId: 'x',
				title: 'Synthetic',
				durationSeconds: 90,
			})
		).candidate.remoteId,
		2,
	)
})
void test('search bounds each provider and rejects malformed/cross-provider candidate', async () => {
	const source = provider('netease')
	source.search = async (_keyword, limit) => {
		assert.equal(limit, 20)
		return [
			candidate('qqmusic'),
			{ ...candidate('netease'), remoteId: -1 },
			...Array.from({ length: 30 }, (_, i) => candidate('netease', i + 1)),
		]
	}
	assert.equal(
		(await createOnlineLyricsService([source]).search('Synthetic')).candidates
			.length,
		20,
	)
})
void test('manual remote ID cannot become query injection', async () => {
	let called = false
	const source = provider('qqmusic')
	source.load = async () => {
		called = true
		return { lrc: '' }
	}
	await assert.rejects(
		createOnlineLyricsService([source]).load(
			'x',
			candidate('qqmusic', 'x&cookie=y'),
		),
		hasCode('invalid'),
	)
	assert.equal(called, false)
})
void test('pre-aborted request makes no provider call', async () => {
	let called = false
	const source = provider('netease')
	source.search = async () => {
		called = true
		return []
	}
	const c = new AbortController()
	c.abort()
	await assert.rejects(
		createOnlineLyricsService([source]).search('synthetic', {
			signal: c.signal,
		}),
		hasCode('cancelled'),
	)
	assert.equal(called, false)
})
void test('abort ends work even when a provider ignores cancellation', async () => {
	const source = provider('netease')
	source.load = () => new Promise(() => {})
	const c = new AbortController()
	const request = createOnlineLyricsService([source]).load(
		'x',
		candidate('netease'),
		{ signal: c.signal },
	)
	c.abort()
	await assert.rejects(request, hasCode('cancelled'))
})
void test('timeout is bounded even for a non-responsive native provider', async () => {
	const source = provider('netease')
	source.search = () => new Promise(() => {})
	await assert.rejects(
		createOnlineLyricsService([source]).match(
			{ sourceId: 'x', title: 'Synthetic' },
			{ timeoutMs: 5 },
		),
		hasCode('timeout'),
	)
})
void test('late load after cancellation never returns to consumer', async () => {
	let finish: ((value: { lrc: string }) => void) | undefined
	const source = provider('netease')
	source.load = () =>
		new Promise((resolve) => {
			finish = resolve
		})
	const c = new AbortController()
	const request = createOnlineLyricsService([source]).load(
		'old',
		candidate('netease'),
		{ signal: c.signal },
	)
	await Promise.resolve()
	c.abort()
	finish?.({ lrc: '[00:01]Synthetic' })
	await assert.rejects(request, hasCode('cancelled'))
})
void test('winning automatic result aborts remaining provider network tasks', async () => {
	let pendingSignal: AbortSignal | undefined
	const source = provider('qqmusic')
	source.search = (_k, _l, signal) => {
		pendingSignal = signal
		return new Promise(() => {})
	}
	await createOnlineLyricsService([provider('netease'), source]).match({
		sourceId: 'x',
		title: 'Synthetic',
	})
	assert.equal(pendingSignal?.aborted, true)
})
void test('oversized lyrics rejected without retaining raw provider error', async () => {
	await assert.rejects(
		createOnlineLyricsService([
			provider('netease', 'a'.repeat(1024 * 1024 + 1)),
		]).load('x', candidate('netease')),
		hasCode('invalid'),
	)
})
void test('empty/overlong keywords rejected and duplicate source rejected', async () => {
	const service = createOnlineLyricsService([provider('netease')])
	for (const query of [' ', 'a'.repeat(201)])
		await assert.rejects(service.search(query), hasCode('invalid'))
	assert.throws(
		() => createOnlineLyricsService([provider('netease'), provider('netease')]),
		hasCode('invalid'),
	)
})
void test('provider exceptions are reduced to discrete safe error codes', async () => {
	const source = provider('netease')
	source.load = async () => {
		throw new Error('SESSION_SECRET')
	}
	try {
		await createOnlineLyricsService([source]).load('x', candidate('netease'))
		assert.fail()
	} catch (e) {
		assert.ok(hasCode('unavailable')(e))
		assert.ok(!String(e).includes('SECRET'))
	}
})
void test('old provider requests use credential-less HTTPS, no downgrade fallback', () => {
	for (const path of ['qqmusic/api.ts', 'kugou/api.ts', 'netease/request.ts']) {
		const code = readFileSync(
			new URL(`../../src/lib/api/${path}`, import.meta.url),
			'utf8',
		)
		assert.match(code, /credentials: 'omit'/)
		assert.match(code, /redirect: 'error'/)
		if (path.startsWith('kugou')) assert.doesNotMatch(code, /http:\/\//)
	}
	const code = readFileSync(
		new URL('../online-lyrics-mobile.ts', import.meta.url),
		'utf8',
	)
	assert.doesNotMatch(code, /bilibili|useAppStore|Sentry|lyricService/)
})

void test('one stalled search provider cannot erase other provider candidates', async () => {
	const source = provider('qqmusic')
	source.search = () => new Promise(() => {})
	const result = await createOnlineLyricsService([
		provider('netease'),
		source,
	]).search('Synthetic', { timeoutMs: 10 })
	assert.equal(result.candidates.length, 1)
	assert.deepEqual(result.unavailable, ['qqmusic'])
})

void test('automatic title cleaning reuses old BBPlayer quote extraction, manual search stays exact', async () => {
	const queries: string[] = []
	const source = provider('netease')
	source.search = async (keyword) => {
		queries.push(keyword)
		return [{ ...candidate('netease'), title: 'Tune cover' }]
	}
	const service = createOnlineLyricsService([source])
	await service.match({ sourceId: 'x', title: '【Synthetic】《Tune》 cover' })
	await service.search('《Tune》 cover')
	assert.deepEqual(queries, ['Tune', '《Tune》 cover'])
})
