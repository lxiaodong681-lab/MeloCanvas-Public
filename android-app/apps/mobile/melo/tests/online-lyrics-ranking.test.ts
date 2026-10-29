import assert from 'node:assert/strict'
import test from 'node:test'

import { LyricsStore, reviewLyricsVersion } from '../lyrics'
import {
	createOnlineLyricsService,
	OnlineLyricError,
	type OnlineLyricCandidate,
	type OnlineLyricProvider,
} from '../online-lyrics'
import { cacheOnlineLyrics } from '../online-lyrics-cache'
import {
	lyricCandidateEvidence,
	lyricSearchTitle,
	lyricTitleTags,
	loadedLyricVersionText,
	rankLyricCandidates,
} from '../online-lyrics-ranking'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const song = (
	source: OnlineLyricCandidate['source'],
	title: string,
	duration = 240,
	artist = '周深',
): OnlineLyricCandidate => ({
	source,
	title,
	artist,
	duration,
	remoteId: source === 'netease' ? 1 : 'test',
})
const provider = (
	source: OnlineLyricCandidate['source'],
	candidates: OnlineLyricCandidate[],
): OnlineLyricProvider => ({
	source,
	search: async () => candidates,
	load: async () => ({ lrc: '[00:01.00]test first\n[00:03.00]test second' }),
})

void test('a closer-duration translated rewrite cannot outrank the requested original song', () => {
	const ranked = rankLyricCandidates([
		song('netease', '风的来信-日语填词（風の便り）', 214, 'Moen'),
		song('netease', '风的来信', 197, '多多poi'),
	], { sourceId: 'test', title: '《原神》六周年主题曲《风的来信》', durationSeconds: 215 })
	assert.equal(ranked[0].candidate.title, '风的来信')
	assert.equal(ranked[1].evidence.eligible, false)
})

void test('Bilibili work titles do not replace the song title or erase concert context', async () => {
	assert.equal(lyricSearchTitle('《原神》六周年主题曲《风的来信》'), '风的来信')
	assert.equal(lyricSearchTitle('《原神》至冬交响音乐现场'), '原神 至冬交响音乐现场')
	assert.equal(lyricSearchTitle('周深《耀眼的我们》'), '耀眼的我们')
	const queries: string[] = []
	const p = provider('netease', [song('netease', '风的来信', 220, '歌手')])
	p.search = async (query) => {
		queries.push(query)
		return query === '风的来信' ? [song('netease', '风的来信', 220, '歌手')] : []
	}
	const result = await createOnlineLyricsService([p]).match({
		sourceId: 'test', title: '《原神》六周年主题曲《风的来信》', durationSeconds: 220,
	})
	assert.equal(result.candidate.title, '风的来信')
	assert.deepEqual(queries, ['风的来信'])
})

void test('automatic matching does not let the fastest unrelated provider win', async () => {
	const wrong = provider('netease', [song('netease', '別の歌')])
	const correct = provider('qqmusic', [song('qqmusic', '耀眼的我们')])
	correct.search = async () => {
		await new Promise((resolve) => setTimeout(resolve, 10))
		return [song('qqmusic', '耀眼的我们')]
	}
	const result = await createOnlineLyricsService([wrong, correct]).match({
		sourceId: 'test',
		title: '周深《耀眼的我们》',
		durationSeconds: 240,
	})
	assert.equal(result.candidate.source, 'qqmusic')
})

void test('Netease candidates use duration evidence as well as search order', async () => {
	const first = { ...song('netease', '同一首歌', 80), remoteId: 1 }
	const second = { ...song('netease', '同一首歌', 240), remoteId: 2 }
	const result = await createOnlineLyricsService([
		provider('netease', [first, second]),
	]).match({ sourceId: 'test', title: '同一首歌', durationSeconds: 240 })
	assert.equal(result.candidate.remoteId, 2)
})

void test('live or cover ambiguity does not silently save studio lyrics; manual choice remains possible', async () => {
	const source = provider('netease', [song('netease', '耀眼的我们')])
	const service = createOnlineLyricsService([source])
	await assert.rejects(
		service.match({ sourceId: 'test', title: '周深《耀眼的我们》演唱會' }),
		(error: unknown) =>
			error instanceof Error && 'code' in error && error.code === 'unmatched',
	)
	assert.equal(
		(await service.load('test', song('netease', '耀眼的我们'))).candidate.title,
		'耀眼的我们',
	)
})

void test('existing performer evidence is respected and uploader is never substituted', () => {
	const candidate = song('qqmusic', '同一首歌', 240, '原唱歌手')
	assert.equal(
		lyricCandidateEvidence(candidate, {
			sourceId: 'x',
			title: '同一首歌',
			performer: '翻唱歌手',
		}).eligible,
		false,
	)
	assert.equal(
		lyricCandidateEvidence(candidate, { sourceId: 'x', title: '同一首歌' })
			.eligible,
		true,
	)
})

void test('quoted bilingual title and traditional title are ranked with visible evidence', () => {
	const track = {
		sourceId: 'x',
		title: '高清混剪-周深Zhou Shen《耀眼的我們The Shining Us》雙語歌詞',
	}
	assert.equal(lyricSearchTitle(track.title), '耀眼的我們The Shining Us')
	assert.equal(
		rankLyricCandidates(
			[song('netease', '別の歌'), song('qqmusic', '耀眼的我们')],
			track,
		)[0].candidate.source,
		'qqmusic',
	)
	assert.equal(
		lyricCandidateEvidence(song('qqmusic', '耀眼的我们'), track).eligible,
		true,
	)
})

// Public metadata observed on device; IDs and loaded text below are test fixtures.
const idolTrack = {
	sourceId: 'bilibili:BV1234567890:42',
	title: '【中文字幕】我推的孩子「アイドル」官方MV（4K 60帧/Hi-Res）',
	performer: null,
	durationSeconds: 226,
}
const idolCandidates = [
	song('qqmusic', 'アイドル', 225, 'hanser'),
	{ ...song('netease', 'アイドル', 213, 'YOASOBI'), remoteId: 2 },
	{ ...song('netease', 'アイドル', 290, 'KyotoJam'), remoteId: 3 },
]
const failed = (code: 'unmatched' | 'unavailable') => (error: unknown) =>
	error instanceof OnlineLyricError && error.code === code
function idolService(candidates = idolCandidates) {
	const loads: string[] = [],
		searches: string[] = []
	const providers = (['netease', 'qqmusic'] as const).map((source) => ({
		...provider(
			source,
			candidates.filter((candidate) => candidate.source === source),
		),
		search: async (keyword: string) => {
			searches.push(keyword)
			return candidates.filter((candidate) => candidate.source === source)
		},
		load: async (candidate: OnlineLyricCandidate) => {
			loads.push(candidate.artist)
			return { lrc: '[00:01.00]仅用于解析回归\n[00:03.00]非真实歌词内容' }
		},
	}))
	return {
		service: createOnlineLyricsService(providers),
		providers,
		loads,
		searches,
	}
}

void test('observed official MV metadata cannot automatically choose the closest same-title cover singer', async () => {
	const { service, loads } = idolService()
	await assert.rejects(service.match(idolTrack), failed('unmatched'))
	assert.deepEqual(loads, [])
	const manual = await service.search('アイドル')
	assert.equal(manual.candidates.length, 3)
	assert.equal(
		rankLyricCandidates(manual.candidates, idolTrack)[0].candidate.artist,
		'hanser',
	)
	assert.equal(
		(await service.load(idolTrack.sourceId, idolCandidates[1])).candidate
			.artist,
		'YOASOBI',
	)
	assert.equal(
		(await service.load(idolTrack.sourceId, idolCandidates[2])).candidate
			.artist,
		'KyotoJam',
	)
})

void test('known performer and unique title singer evidence retain automatic matching with MV intro tolerance', async () => {
	for (const track of [
		{ ...idolTrack, performer: 'YOASOBI' },
		{ ...idolTrack, title: `YOASOBI ${idolTrack.title}` },
	]) {
		const { service, loads } = idolService()
		assert.equal((await service.match(track)).candidate.artist, 'YOASOBI')
		assert.deepEqual(loads, ['YOASOBI'])
	}
	await assert.rejects(
		idolService().service.match({
			...idolTrack,
			title: `YOASOBI hanser ${idolTrack.title}`,
		}),
		failed('unmatched'),
	)
})

void test('known singer load failure never falls back to unknown singer metadata', async () => {
	const { service, providers, loads } = idolService([
		idolCandidates[1],
		song('qqmusic', 'アイドル', 226, ''),
	])
	providers[0].load = async (candidate) => {
		loads.push(candidate.artist)
		throw new Error('fixture failure')
	}
	await assert.rejects(
		service.match({ ...idolTrack, performer: 'YOASOBI' }),
		failed('unavailable'),
	)
	assert.deepEqual(loads, ['YOASOBI'])
})

void test('title singer evidence cannot fall through to a different singer when its only version fails duration validation', async () => {
	const { service, loads } = idolService([
		idolCandidates[0],
		{ ...idolCandidates[1], duration: 290 },
	])
	await assert.rejects(
		service.match({ ...idolTrack, title: `YOASOBI ${idolTrack.title}` }),
		failed('unmatched'),
	)
	assert.deepEqual(loads, [])
})

void test('single singer across providers remains automatic while conflicting duration never becomes load fallback', async () => {
	const same = idolService([
		idolCandidates[1],
		song('qqmusic', 'アイドル', 214, ' yoasobi '),
	])
	same.providers[0].load = async (candidate) => {
		same.loads.push(candidate.artist)
		throw new Error('fixture failure')
	}
	assert.equal(
		(await same.service.match(idolTrack)).candidate.source,
		'qqmusic',
	)
	assert.deepEqual(same.loads, ['YOASOBI', ' yoasobi '])
	const duration = idolService([
		idolCandidates[1],
		song('qqmusic', 'アイドル', 290, 'YOASOBI'),
	])
	duration.providers[0].load = async (candidate) => {
		duration.loads.push(candidate.artist)
		throw new Error('fixture failure')
	}
	await assert.rejects(duration.service.match(idolTrack), failed('unavailable'))
	assert.deepEqual(duration.loads, ['YOASOBI'])
})

void test('automatic duration rejects beyond the larger of 15 seconds or 10 percent; manual candidates remain visible', () => {
	for (const [duration, candidateDuration, eligible] of [
		[100, 85, true],
		[100, 84, false],
		[226, 204, true],
		[226, 203, false],
	] as const)
		assert.equal(
			lyricCandidateEvidence(
				song('netease', 'アイドル', candidateDuration, 'YOASOBI'),
				{ ...idolTrack, durationSeconds: duration },
			).eligible,
			eligible,
		)
	assert.equal(
		lyricCandidateEvidence(idolCandidates[1], {
			...idolTrack,
			durationSeconds: 0,
		}).eligible,
		true,
	)
	assert.equal(
		lyricCandidateEvidence(idolCandidates[1], {
			...idolTrack,
			durationSeconds: undefined,
		}).eligible,
		true,
	)
})

void test('blank singer fields cannot remove known cross-singer ambiguity or become a trusted singer group', async () => {
	await assert.rejects(
		idolService([
			...idolCandidates,
			song('qqmusic', 'アイドル', 226, ''),
		]).service.match(idolTrack),
		failed('unmatched'),
	)
	await assert.rejects(
		idolService([song('qqmusic', 'アイドル', 226, '')]).service.match(
			idolTrack,
		),
		failed('unmatched'),
	)
})

void test('real reader preserves explicitly saved online version and offset without automatic search or replacement', async () => {
	const { service, searches } = idolService()
	const stored = new Map<string, string>()
	const library = {
		setting: (key: string) => stored.get(key) ?? null,
		setSetting: (key: string, value: string) => {
			stored.set(key, value)
		},
	}
	const store = new LyricsStore(library)
	const selected = await service.load(idolTrack.sourceId, idolCandidates[1])
	const original = { ...cacheOnlineLyrics(selected, 123), offsetMs: 750 }
	store.save(original)
	const access = { onlineAllowed: true, sessionGeneration: 1 }
	const f = controlFixture(
		{},
		{
			'./online-lyrics-mobile': { onlineLyricsService: service },
			'./account-access': {
				useAccountAccess: () => access,
				getAccountAccess: () => access,
			},
		},
	)
	try {
		const ui = f.load('lyrics-ui')
		f.render(
			f.element(ui.LyricsReader as ControlNode['type'], {
				library,
				sourceId: idolTrack.sourceId,
				title: idolTrack.title,
				position: 0,
				duration: 226,
				height: 300,
				onClose() {},
				onSeek() {},
			}),
		)
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.deepEqual(searches, [])
		assert.deepEqual(store.get(idolTrack.sourceId), original)
	} finally {
		f.unmount()
	}
})

const nightTrack = {
	sourceId: 'bilibili:BV1234567890:43',
	title: 'YOASOBI 夜に駆ける (Yoru ni Kakeru) Official Music Video',
	durationSeconds: 275,
}
const liveHeading =
	'[00:00.00]夜に駆ける (Live) - YOASOBI (ヨアソビ)\n[00:17.80]回归正文'
const ordinaryLyrics =
	'[00:17.80]普通歌词 live 不是标题标注\n[00:25.20]回归正文'
function nightService(first = liveHeading, second = ordinaryLyrics) {
	const loads: string[] = []
	const firstCandidate = {
		...song('qqmusic', '夜に駆ける', 275, 'YOASOBI'),
		remoteId: 'body-title-version',
	}
	const nextCandidate = {
		...song('netease', '夜に駆ける', 261, 'YOASOBI'),
		remoteId: 42,
	}
	const firstProvider = provider('qqmusic', [firstCandidate])
	firstProvider.load = async () => {
		loads.push('qqmusic')
		return { lrc: first }
	}
	const nextProvider = provider('netease', [nextCandidate])
	nextProvider.load = async () => {
		loads.push('netease')
		return { lrc: second }
	}
	return {
		service: createOnlineLyricsService([firstProvider, nextProvider]),
		loads,
		firstCandidate,
	}
}

void test('loaded explicit Live title contradicting official MV skips the metadata winner and loads same-singer fallback', async () => {
	const { service, loads } = nightService()
	assert.equal((await service.match(nightTrack)).candidate.source, 'netease')
	assert.deepEqual(loads, ['qqmusic', 'netease'])
})

void test('loaded version check ignores ordinary lyric verbs and leaves unmarked versions unchanged', async () => {
	for (const raw of [
		ordinaryLyrics,
		'[00:01.00]无版本标注的回归正文',
		'[00:01.00]作词：夜に駆ける (Live)\n[00:02.00]回归正文',
		'[00:01.00]普通歌词夜に駆ける (Live) 的歌词句\n[00:02.00]回归正文',
		'[00:01.00]正文一\n[00:02.00]正文二\n[00:03.00]正文三\n[00:04.00]夜に駆ける (Live)',
	]) {
		const { service, loads } = nightService(raw)
		assert.equal((await service.match(nightTrack)).candidate.source, 'qqmusic')
		assert.deepEqual(loads, ['qqmusic'])
	}
})

void test('loaded title evidence is limited to 64 header lines, 16384 characters and three explicit title lines', () => {
	assert.deepEqual(
		lyricTitleTags(
			'\uFEFF[ti:夜に駆ける (Live)]\n[ar:作者 Live]\n[00:01.00]正文',
		),
		['夜に駆ける (Live)'],
	)
	assert.deepEqual(
		lyricTitleTags('\n'.repeat(64) + '[ti:夜に駆ける (Live)]'),
		[],
	)
	assert.deepEqual(
		lyricTitleTags('x'.repeat(16_384) + '\n[ti:夜に駆ける (Live)]'),
		[],
	)
	assert.equal(
		loadedLyricVersionText('夜に駆ける', '[ar:作者 Live]', [
			'作词：夜に駆ける (Live)',
			'普通 live 歌词',
		]),
		'夜に駆ける',
	)
	assert.equal(
		loadedLyricVersionText('夜に駆ける', '', [
			'夜に駆ける (Live)' + 'x'.repeat(1024),
		]),
		'夜に駆ける',
	)
	assert(loadedLyricVersionText('夜に駆ける', '', ['夜に駆ける [Live] - YOASOBI']).includes('[Live]'))
})

void test('old online caches without ti retain exact generated raw content and their saved offset', async () => {
	const { service, firstCandidate } = nightService(ordinaryLyrics)
	const saved = cacheOnlineLyrics(
		await service.load(nightTrack.sourceId, firstCandidate),
		123,
	)
	assert.equal(
		saved.raw,
		'[00:17.800]普通歌词 live 不是标题标注\n[00:25.200]回归正文',
	)
	assert.equal(saved.offsetMs, 0)
	const existing = { ...saved, offsetMs: 500 }
	const text = JSON.stringify(existing)
	const store = new LyricsStore({
		setting: () => text,
		setSetting: () => assert.fail('review cannot rewrite existing cache'),
	})
	const reopened = store.get(nightTrack.sourceId)!
	assert.equal(reopened.raw, saved.raw)
	assert.equal(reopened.offsetMs, 500)
	assert.deepEqual(reviewLyricsVersion(nightTrack, reopened).candidateHints, [])
})

void test('all loaded Live headings reject automatic association while an explicitly Live source still matches', async () => {
	const { service, loads } = nightService(liveHeading, liveHeading)
	await assert.rejects(service.match(nightTrack), failed('unmatched'))
	assert.deepEqual(loads, ['qqmusic', 'netease'])
	const liveCandidate = song('qqmusic', '夜に駆ける (Live)', 275, 'YOASOBI')
	const liveProvider = provider('qqmusic', [liveCandidate])
	liveProvider.load = async () => ({ lrc: liveHeading })
	assert.equal(
		(
			await createOnlineLyricsService([liveProvider]).match({
				...nightTrack,
				title: `${nightTrack.title} (Live)`,
			})
		).candidate.source,
		'qqmusic',
	)
})

void test('real LRC ti version survives manual cache round trip and warns without changing existing offset', async () => {
	const raw = '[ti:夜に駆ける (Live)]\n[00:17.80]回归正文'
	const { service, firstCandidate } = nightService(raw)
	const result = await service.load(nightTrack.sourceId, firstCandidate)
	const saved = { ...cacheOnlineLyrics(result, 123), offsetMs: 750 }
	assert.match(saved.raw, /^\[ti:夜に駆ける \(Live\)\]/)
	const values = new Map<string, string>()
	const store = new LyricsStore({
		setting: (key) => values.get(key) ?? null,
		setSetting: (key, value) => {
			values.set(key, value)
		},
	})
	store.save(saved)
	const reopened = store.get(nightTrack.sourceId)!
	assert.equal(reopened.offsetMs, 750)
	assert.deepEqual(reviewLyricsVersion(nightTrack, reopened).candidateHints, [
		'现场 / Live',
	])
	assert(
		reviewLyricsVersion(nightTrack, reopened).warnings.some((warning) =>
			warning.includes('版本标注不同'),
		),
	)
	assert.deepEqual(store.get(nightTrack.sourceId), saved)
})

void test('real manual preview exposes a loaded Live heading and cancellation preserves prior online cache and offset', async () => {
	const { service, firstCandidate } = nightService()
	const values = new Map<string, string>()
	const library = {
		setting: (key: string) => values.get(key) ?? null,
		setSetting: (key: string, value: string) => {
			values.set(key, value)
		},
	}
	const store = new LyricsStore(library)
	const original = {
		...cacheOnlineLyrics(
			await service.load(nightTrack.sourceId, {
				...song('netease', '夜に駆ける', 261, 'YOASOBI'),
				remoteId: 42,
			}),
			123,
		),
		offsetMs: 750,
	}
	store.save(original)
	const access = { onlineAllowed: true, sessionGeneration: 1 }
	const f = controlFixture(
		{},
		{
			'./online-lyrics-mobile': { onlineLyricsService: service },
			'./account-access': {
				useAccountAccess: () => access,
				getAccountAccess: () => access,
			},
		},
	)
	try {
		const ui = f.load('lyrics-ui')
		const render = () =>
			f.render(
				f.element(ui.LyricsReader as ControlNode['type'], {
					library,
					sourceId: nightTrack.sourceId,
					title: nightTrack.title,
					position: 0,
					duration: 275,
					height: 300,
					onClose() {},
					onSeek() {},
				}),
			)
		for (const label of ['歌词版本与设置', '搜索歌词']) {
			const action = controlNodes(render()).find((node) => node.props.accessibilityLabel === label)
			assert.ok(action, label)
			;(action.props.onPress as () => void)()
		}
		const search = controlNodes(render()).find(
			(node) => node.type === 'TextInput',
		)!
		;(search.props.onSubmitEditing as () => void)()
		await new Promise<void>((resolve) => setImmediate(resolve))
		const candidate = controlNodes(render()).find((node) =>
			String(node.props.accessibilityLabel).includes(
				`选择歌词 ${firstCandidate.title} YOASOBI QQ 音乐`,
			),
		)!
		assert(candidate)
		;(candidate.props.onPress as () => void)()
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert(JSON.stringify(render()).includes('现场 / Live'))
		const cancel = controlNodes(render()).find(
			(node) => node.props.testID === 'lyrics-cancel-candidate',
		)!
		;(cancel.props.onPress as () => void)()
		assert.deepEqual(store.get(nightTrack.sourceId), original)
	} finally {
		f.unmount()
	}
})
