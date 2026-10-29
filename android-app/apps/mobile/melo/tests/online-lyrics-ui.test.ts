import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	activeLyric,
	LyricsStore,
	savedLyricsParsed,
	validateSavedLyrics,
} from '../lyrics'
import type { OnlineLyricResult } from '../online-lyrics'
import { cacheOnlineLyrics } from '../online-lyrics-cache'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'
const id = 'bilibili:BV1234567890:42'
const other = 'bilibili:BV1234567890:43'
const candidate = {
	source: 'netease' as const,
	title: '合成歌',
	artist: '合成歌手',
	duration: 20,
	remoteId: 1,
}
const result = (sourceId = id): OnlineLyricResult => ({
	sourceId,
	candidate,
	raw: { lrc: '[00:01]合成正文' },
	lines: [
		{
			startTime: 1000,
			endTime: 2000,
			content: '合成正文',
			translation: '合成译文',
			romaji: 'test',
			translations: ['合成译文'],
			isDynamic: false,
			spans: [],
		},
	],
})
const tick = () => new Promise((resolve) => setImmediate(resolve))
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}
function setup(service: Record<string, unknown>, dependencies: Record<string, unknown> = {}) {
	const data = new Map<string, string>()
	const library = {
		setting: (key: string) => data.get(key) ?? null,
		setSetting: (key: string, value: string) => {
			data.set(key, value)
		},
	}
	let access = {onlineAllowed:true,sessionGeneration:1}
	const f = controlFixture({}, {
		'./online-lyrics-mobile': { onlineLyricsService: service },
		'./account-access': {useAccountAccess:()=>access,getAccountAccess:()=>access},
		...dependencies,
	})
	const m = f.load('lyrics-ui')
	let sourceId = id
	const render = () =>
		f.render(
			f.element(m.LyricsReader as ControlNode['type'], {
				library,
				sourceId,
				title: '合成歌',
				position: 1.5,
				duration: 20,
				height: 300,
				onClose: () => {},
				onSeek: () => {},
			}),
		)
	const find = (label: string) => {
		const node = controlNodes(render()).find(
			(n) => n.props.accessibilityLabel === label,
		)
		assert.ok(node, label)
		return node
	}
	const press = (label: string) => (find(label).props.onPress as () => void)()
	return {
		f,
		setAccess: (onlineAllowed:boolean,sessionGeneration:number)=>{access={onlineAllowed,sessionGeneration}},
		render,
		find,
		press,
		library,
		setSource: (value: string) => {
			sourceId = value
		},
	}
}
void test('online cache retains provider identity, translations, end-time gaps and excludes arbitrary fields', () => {
	const saved = cacheOnlineLyrics(result(), 123)
	assert.equal(saved.online?.provider, 'netease')
	assert.equal(saved.online?.remoteId, 1)
	assert.equal(savedLyricsParsed(saved).lines[0].translation, '合成译文')
	assert.equal(activeLyric(savedLyricsParsed(saved), 1500, 0), 0)
	assert.equal(activeLyric(savedLyricsParsed(saved), 2000, 0), -1)
	assert.equal(activeLyric(savedLyricsParsed(saved), 2300, 500), 0)
	assert.equal(activeLyric(savedLyricsParsed(saved), 2500, 500), -1)
	assert.equal(
		'credential' in
			validateSavedLyrics({ ...saved, credential: 'fixture' }, id),
		false,
	)
	assert.throws(() =>
		validateSavedLyrics(
			{
				...saved,
				online: {
					...saved.online,
					lines: [{ atMs: 1000, endMs: 0, text: 'bad' }],
				},
			},
			id,
		),
	)
})
void test('reader auto-fetches and caches by source; song-name search has its own page', async () => {
	const f = setup({
		match: async () => result(),
		search: async () => ({ candidates: [], unavailable: [] }),
	})
	f.render()
	await tick()
	f.render()
	assert.equal(new LyricsStore(f.library).get(id)?.online?.remoteId, 1)
	f.press('歌词版本与设置')
	f.press('搜索歌词')
	f.find('搜索歌词歌名')
	const text = JSON.stringify(f.render())
	assert.ok(text.includes('合成译文'))
	f.f.unmount()
})
void test('late auto result after source switch or close never writes old or new song', async () => {
	const pending = deferred<OnlineLyricResult>()
	const f = setup({ match: () => pending.promise })
	f.render()
	f.setSource(other)
	f.render()
	pending.resolve(result())
	await tick()
	f.render()
	assert.equal(new LyricsStore(f.library).get(id), null)
	assert.equal(new LyricsStore(f.library).get(other), null)
	f.f.unmount()
	const later = deferred<OnlineLyricResult>()
	const closed = setup({ match: () => later.promise })
	closed.render()
	closed.press('返回封面')
	later.resolve(result())
	await tick()
	assert.equal(new LyricsStore(closed.library).get(id), null)
	closed.f.unmount()
})
void test('manual candidate wins over pending auto and newer search discards stale result', async () => {
	const auto = deferred<OnlineLyricResult>()
	const first = deferred<{
		candidates: (typeof candidate)[]
		unavailable: string[]
	}>()
	let count = 0
	const f = setup({
		match: () => auto.promise,
		search: () =>
			++count === 1
				? first.promise
				: Promise.resolve({ candidates: [candidate], unavailable: [] }),
		load: async () => result(),
	})
	f.render()
	f.press('歌词版本与设置')
	f.press('搜索歌词')
	const search = () => {
		const n = controlNodes(f.render()).find((node) => node.type === 'TextInput')!
		;(n.props.onSubmitEditing as () => void)()
	}
	search()
	search()
	await tick()
	f.render()
	first.resolve({ candidates: [], unavailable: [] })
	await tick()
	f.press('选择歌词 合成歌 合成歌手 网易云，0:20，候选 1')
	await tick()
	f.render()
	auto.resolve({ ...result(), candidate: { ...candidate, remoteId: 99 } })
	await tick()
	assert.equal(new LyricsStore(f.library).get(id), null)
	assert.ok(JSON.stringify(f.render()).includes('候选歌词'))
	;(controlNodes(f.render()).find((node) => node.props.testID === 'lyrics-confirm-candidate')!.props.onPress as () => void)()
	assert.equal(new LyricsStore(f.library).get(id)?.online?.remoteId, 1)
	f.f.unmount()
})
void test('cached local lyrics are preserved without automatic replacement', async () => {
	let calls = 0
	const f = setup({
		match: async () => {
			calls++
			return result()
		},
	})
	new LyricsStore(f.library).save({
		version: 1,
		sourceId: id,
		filename: 'original.lrc',
		raw: '[00:01]原有合成歌词',
		importedAt: 1,
		offsetMs: 500,
	})
	f.render()
	await tick()
	assert.equal(calls, 0)
	assert.equal(new LyricsStore(f.library).get(id)?.offsetMs, 500)
	f.f.unmount()
})

void test('search lives outside the reader and returning cancels a late result without changing saved lyrics', async () => {
	const pending = deferred<{ candidates: (typeof candidate)[]; unavailable: string[] }>()
	const f = setup({ search: () => pending.promise })
	const original = cacheOnlineLyrics(result(), 1)
	new LyricsStore(f.library).save(original)
	const hasInput = () => controlNodes(f.render()).some(n => n.type === 'TextInput')
	assert.equal(hasInput(), false)
	f.press('歌词版本与设置')
	assert.equal(hasInput(), false)
	f.press('搜索歌词')
	;(f.find('搜索歌词歌名').props.onSubmitEditing as () => void)()
	f.press('返回歌词上一级')
	assert.equal(hasInput(), false)
	pending.resolve({ candidates: [candidate], unavailable: [] })
	await tick()
	f.press('搜索歌词')
	assert.equal(controlNodes(f.render()).some(n => String(n.props.accessibilityLabel).startsWith('选择歌词 ')), false)
	assert.deepEqual(new LyricsStore(f.library).get(id), original)
	f.f.unmount()
})
void test('online candidate cancellation and failed confirmation preserve saved lyrics and offset', async () => {
	const f = setup({
		match: async () => result(),
		search: async () => ({ candidates: [candidate], unavailable: [] }),
		load: async () => result(),
	})
	const original = { ...cacheOnlineLyrics(result(), 1), offsetMs: 500 }
	new LyricsStore(f.library).save(original)
	f.press('歌词版本与设置')
	f.press('搜索歌词')
	const searchAndSelect = async () => {
		;(controlNodes(f.render()).find((node) => node.type === 'TextInput')!.props.onSubmitEditing as () => void)()
		await tick()
		f.press('选择歌词 合成歌 合成歌手 网易云，0:20，候选 1')
		await tick()
		f.render()
	}
	const pressId = (testID: string) => (controlNodes(f.render()).find((node) => node.props.testID === testID)!.props.onPress as () => void)()
	await searchAndSelect()
	pressId('lyrics-cancel-candidate')
	assert.deepEqual(new LyricsStore(f.library).get(id), original)
	const hasCandidates = () => controlNodes(f.render()).some((node) => String(node.props.accessibilityLabel).startsWith('选择歌词 '))
	assert.equal(hasCandidates(), true, 'cancel keeps candidates available for correction')
	await searchAndSelect()
	const write = f.library.setSetting
	f.library.setSetting = () => { throw new Error('fixture write failed') }
	pressId('lyrics-confirm-candidate')
	assert.ok(JSON.stringify(f.render()).includes('fixture write failed'))
	assert.deepEqual(new LyricsStore(f.library).get(id), original)
	assert.equal(hasCandidates(), false, 'review keeps candidates off-screen while confirmation can be retried')
	assert.ok(controlNodes(f.render()).some(n => n.props.testID === 'lyrics-confirm-candidate'))
	f.library.setSetting = write
	pressId('lyrics-confirm-candidate')
	assert.equal(new LyricsStore(f.library).get(id)?.offsetMs, 0)
	assert.equal(hasCandidates(), false, 'successful confirmation returns the reading space to lyrics')
	f.f.unmount()
})
void test('offline never calls provider and account generation rejects a response before React rerenders', async()=>{
 let calls=0;const pending=deferred<OnlineLyricResult>()
 const f=setup({match:()=>{calls++;return pending.promise},search:()=>{calls++;return Promise.resolve({candidates:[],unavailable:[]})}})
 f.setAccess(false,1);f.render();await tick();assert.equal(calls,0)
 f.press('歌词版本与设置');f.press('搜索歌词');const field=controlNodes(f.render()).find(n=>n.type==='TextInput')!;(field.props.onSubmitEditing as ()=>void)();await tick();assert.equal(calls,0)
 f.setAccess(true,2);f.render();assert.equal(calls,1)
 f.setAccess(false,3);pending.resolve(result());await tick()
 assert.equal(new LyricsStore(f.library).get(id),null)
 f.render();assert.ok(JSON.stringify(f.render()).includes('离线模式'));f.f.unmount()
})
for (const state of [
	{ name: 'offline before React rerenders', onlineAllowed: false, generation: 1, rerender: false },
	{ name: 'another account generation before React rerenders', onlineAllowed: true, generation: 2, rerender: false },
	{ name: 'another account generation after React rerenders', onlineAllowed: true, generation: 2, rerender: true },
]) {
	void test(`completed online preview cannot replace saved lyrics after ${state.name}`, async () => {
		const f = setup({
			search: async () => ({ candidates: [candidate], unavailable: [] }),
			load: async () => result(),
		})
		const original = {
			...cacheOnlineLyrics({ ...result(), candidate: { ...candidate, remoteId: 99 } }, 1),
			offsetMs: 500,
		}
		new LyricsStore(f.library).save(original)
		try {
			f.press('歌词版本与设置'); f.press('搜索歌词')
			const field = controlNodes(f.render()).find((node) => node.type === 'TextInput')!
			;(field.props.onSubmitEditing as () => void)()
			await tick()
			f.press('选择歌词 合成歌 合成歌手 网易云，0:20，候选 1')
			await tick()
			const confirm = controlNodes(f.render()).find((node) => node.props.testID === 'lyrics-confirm-candidate')!
			assert.ok(confirm, 'online preview must have completed before access changes')
			assert.deepEqual(new LyricsStore(f.library).get(id), original)
			f.setAccess(state.onlineAllowed, state.generation)
			if (state.rerender) f.render()
			;(confirm.props.onPress as () => void)()
			assert.deepEqual(new LyricsStore(f.library).get(id), original)
		} finally {
			f.f.unmount()
		}
	})
}
void test('local file preview remains confirmable offline across an account generation change', async () => {
	let calls = 0
	const raw = '[00:01]本地候选歌词'
	const f = setup({ match: () => { calls++; throw new Error('offline provider must not run') } }, {
		'./lyrics-mobile': { pickLyrics: async () => ({ filename: 'local.lrc', raw }) },
	})
	f.setAccess(false, 1)
	try {
		f.render()
		f.press('歌词版本与设置')
		const importFile = controlNodes(f.render()).find((node) =>
			typeof node.props.onPress === 'function' && JSON.stringify(node.children).includes('导入本地歌词（可选）'),
		)
		assert.ok(importFile)
		;(importFile.props.onPress as () => void)()
		await tick()
		const confirm = controlNodes(f.render()).find((node) => node.props.testID === 'lyrics-confirm-candidate')!
		assert.ok(confirm)
		f.setAccess(false, 2)
		f.render()
		;(confirm.props.onPress as () => void)()
		assert.equal(new LyricsStore(f.library).get(id)?.raw, raw)
		assert.equal(new LyricsStore(f.library).get(id)?.online, undefined)
		assert.equal(calls, 0)
	} finally {
		f.f.unmount()
	}
})
void test('editing a query cancels previous search results without removing cached lyrics',async()=>{
 const pending=deferred<{candidates:typeof candidate[];unavailable:string[]}>()
 const f=setup({match:async()=>result(),search:()=>pending.promise})
 f.render();await tick();f.render()
 f.press('歌词版本与设置');f.press('搜索歌词');let field=controlNodes(f.render()).find(n=>n.type==='TextInput')!;(field.props.onSubmitEditing as ()=>void)()
 field=controlNodes(f.render()).find(n=>n.type==='TextInput')!;(field.props.onChangeText as (text:string)=>void)('新的关键词')
 pending.resolve({candidates:[candidate],unavailable:[]});await tick()
 assert.equal(controlNodes(f.render()).some(n=>String(n.props.accessibilityLabel).startsWith('选择歌词')),false)
 assert.equal(new LyricsStore(f.library).get(id)?.online?.remoteId,1);f.f.unmount()
})

void test('the real lyric reader switches translation and romaji separately without deleting original or cached extras', async () => {
	const bilingual = result()
	bilingual.lines[0].romaji = 'Synthetic_Romaji_Unique42'
	const f = setup({ match: async () => bilingual })
	f.render()
	await tick()
	const shown = () => JSON.stringify(f.render())
	assert.ok(shown().includes('合成正文'))
	assert.ok(shown().includes('合成译文'))
	assert.ok(shown().includes('Synthetic_Romaji_Unique42'))
	const before = new LyricsStore(f.library).get(id)
	f.press('歌词版本与设置')
	f.press('歌词显示')
	assert.equal((f.find('显示歌词翻译').props.accessibilityState as { checked: boolean }).checked, true)
	assert.equal((f.find('显示歌词罗马音').props.accessibilityState as { checked: boolean }).checked, true)
	f.press('显示歌词翻译')
	assert.equal((f.find('显示歌词翻译').props.accessibilityState as { checked: boolean }).checked, false)
	assert.ok(!shown().includes('合成译文'))
	assert.ok(shown().includes('Synthetic_Romaji_Unique42'))
	f.press('显示歌词罗马音')
	assert.equal((f.find('显示歌词罗马音').props.accessibilityState as { checked: boolean }).checked, false)
	assert.ok(!shown().includes('Synthetic_Romaji_Unique42'))
	assert.ok(shown().includes('合成正文'))
	f.press('显示歌词翻译')
	assert.ok(shown().includes('合成译文'))
	assert.ok(!shown().includes('Synthetic_Romaji_Unique42'))
	assert.deepEqual(new LyricsStore(f.library).get(id), before)
	assert.equal(
		f.library.setting('melo.lyrics.display.v1'),
		'{"version":1,"translation":true,"romaji":false}',
	)
	f.f.unmount()
})

void test('a lyric option write failure leaves displayed state and saved lyrics unchanged', async () => {
	const bilingual = result()
	const f = setup({ match: async () => bilingual })
	f.render()
	await tick()
	f.press('歌词版本与设置')
	f.press('歌词显示')
	const realWrite = f.library.setSetting
	f.library.setSetting = (key: string, value: string) => {
		if (key === 'melo.lyrics.display.v1') throw new Error('synthetic database error')
		realWrite(key, value)
	}
	f.press('显示歌词翻译')
	assert.equal((f.find('显示歌词翻译').props.accessibilityState as { checked: boolean }).checked, true)
	assert.ok(JSON.stringify(f.render()).includes('歌词显示设置保存失败'))
	assert.ok(JSON.stringify(f.render()).includes('合成译文'))
	f.f.unmount()
})

void test('display preferences are loaded for a new lyric reader and apply to the saved bilingual source', async () => {
	const bilingual = result()
	bilingual.lines[0].romaji = 'Romaji_Persisted_42'
	const f = setup({ match: async () => bilingual })
	f.library.setSetting('melo.lyrics.display.v1', '{"version":1,"translation":false,"romaji":true}')
	f.render()
	await tick()
	const tree = JSON.stringify(f.render())
	assert.ok(tree.includes('合成正文'))
	assert.ok(!tree.includes('合成译文'))
	assert.ok(tree.includes('Romaji_Persisted_42'))
	f.press('歌词版本与设置')
	f.press('歌词显示')
	assert.equal((f.find('显示歌词翻译').props.accessibilityState as { checked: boolean }).checked, false)
	assert.equal((f.find('显示歌词罗马音').props.accessibilityState as { checked: boolean }).checked, true)
	f.f.unmount()
})

void test('no auxiliary provider fields means no invented translation or romaji even when switches are on', async () => {
	const plain = result()
	delete plain.lines[0].translation
	delete plain.lines[0].romaji
	const f = setup({ match: async () => plain })
	f.render()
	await tick()
	const tree = JSON.stringify(f.render())
	assert.ok(tree.includes('合成正文'))
	assert.ok(!tree.includes('合成译文'))
	f.press('歌词版本与设置')
	f.press('歌词显示')
	const state = JSON.stringify(f.render())
	assert.ok(state.includes('暂无翻译'))
	assert.ok(state.includes('暂无罗马音'))
	f.f.unmount()
})
