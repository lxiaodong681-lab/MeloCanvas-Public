import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { BilibiliRequestRestrictedError } from '../bilibili-request-error'
import * as preferences from '../core/music-preferences'
import type { MusicPreferencesDialog } from '../music-preferences-ui'
import { PreferenceDiscoverySession } from '../preference-discovery-session'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const content = (v: unknown): string =>
	Array.isArray(v)
		? v.map(content).join('')
		: typeof v === 'string'
			? v
			: v && typeof v === 'object' && 'children' in v
				? content(v.children)
				: ''
function fixture(firstRun = true) {
	let stored = preferences.emptyMusicPreferences()
	const events: string[] = []
	const f = controlFixture(
		{},
		{
			'./core/music-preferences': preferences,
			'./preference-discovery-session': { PreferenceDiscoverySession },
			'./bilibili': {
				search: () => {
					throw new Error('No automatic request allowed')
				},
			},
		},
	)
	const module = f.load('music-preferences-ui')
	const props: Parameters<typeof MusicPreferencesDialog>[0] = {
		store: {
			load: () => stored,
			save: (value: preferences.MusicPreferences) => {
				stored = value
			},
		} as preferences.MusicPreferencesStore,
		initial: stored,
		firstRun,
		onClose: () => events.push('closed'),
		onSaved: () => events.push('saved'),
		onSearch: () => events.push('search'),
		onImport: () => events.push('import'),
	}
	const root = f.element(
		module.MusicPreferencesDialog as ControlNode['type'],
		props,
	)
	const render = () => f.render(root)

	const press = (label: string) => {
		const node = controlNodes(render()).find(
			(n) => n.type === 'Pressable' && content(n.children) === label,
		)
		assert.ok(node, label)
		;(node.props.onPress as () => void)()
	}
	return { f, render, press, events, stored: () => stored }
}
void test('welcome direct search persists completion and never requests music or login automatically', () => {
	const f = fixture()
	const welcome = content(f.render())
	assert.ok(welcome.includes('偏好可以稍后设置，先找一首喜欢的歌。'))
	assert.doesNotMatch(welcome, /不必登录|无需登录/)
	assert.equal(f.events.length, 0)
	f.press('我想先搜一首歌')
	assert.deepEqual(f.events, ['saved', 'closed', 'search'])
	assert.equal(f.stored().welcomeCompleted, true)
	f.f.unmount()
})
void test('skippable three-step flow saves actual genre and manually entered artist seeds', () => {
	const f = fixture()
	f.press('选一点音乐偏好')
	f.press('爵士')
	const input = controlNodes(f.render()).find((n) => n.type === 'TextInput')!
	;(input.props.onChangeText as (v: string) => void)('合成甲、合成乙、合成甲')
	f.press('继续')
	f.press('保存偏好，开始探索')
	assert.deepEqual(JSON.parse(JSON.stringify(f.stored())), {
		version: 1,
		welcomeCompleted: true,
		genres: ['爵士'],
		artists: ['合成甲', '合成乙'],
	})
	f.f.unmount()
})
void test('skip keeps no draft choices and editing cancel does not save', () => {
	const first = fixture()
	first.press('选一点音乐偏好')
	first.press('摇滚')
	first.press('暂时跳过，进入发现')
	assert.deepEqual(first.stored().genres, [])
	first.f.unmount()
	const edit = fixture(false)
	edit.press('流行')
	edit.press('取消')
	assert.deepEqual(edit.events, ['closed'])
	assert.equal(edit.stored().welcomeCompleted, false)
	edit.f.unmount()
})

void test('App restore reloads persistent preferences, closes the editor, and preserves other restore hooks', () => {
	const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
	const callback = source.slice(
		source.indexOf('onRestored={() => {'),
		source.indexOf('onRestored={() => {') + 500,
	)
	assert.match(callback, /setPreferencesOpen\(false\)/)
	assert.match(
		callback,
		/setMusicPreferences\(musicPreferencesStore.load\(\)\)/,
	)
	assert.match(callback, /searchHistory.session.reload\(\)/)
	assert.match(callback, /playlists.session.refresh\(\)/)
})
void test('preferences uses a keyboard-resizing scroll surface with safe-area padding', () => {
	const f = fixture(false)
	f.f.viewport.width = 320
	f.f.viewport.fontScale = 2
	const tree = f.render()
	const shell = controlNodes(tree).find(
		(n) => n.type === 'KeyboardAvoidingView',
	)!
	assert.equal(shell.props.behavior, 'height')
	assert.equal((shell.props.style as { paddingTop: number }).paddingTop, 24)
	const scroll = controlNodes(tree).find((n) => n.type === 'ScrollView')!
	assert.equal(scroll.props.keyboardShouldPersistTaps, 'handled')
	assert.equal(controlNodes(scroll).some((n) => n.type === 'Pressable' && content(n.children) === '保存偏好'), false)
	assert.equal((scroll.props.style as { flex: number }).flex, 1)
	const genres = controlNodes(tree).filter((n) => n.type === 'Pressable' && n.props.accessibilityRole === 'checkbox')
	assert.ok(genres.length > 8)
	f.press('爵士')
	const selected = controlNodes(f.render()).find((n) => n.type === 'Pressable' && n.props.accessibilityLabel === '爵士')!
	assert.equal((selected.props.accessibilityState as { checked: boolean }).checked, true)
	assert.ok(
		controlNodes(tree).some(
			(n) => n.type === 'Pressable' && content(n.children) === '保存偏好',
		),
	)
	f.f.unmount()
})

void test('preference copy explains local opt-in search and related results without internal assurances', () => {
	const f = fixture(false)
	const text = content(f.render())
	assert.ok(
		text.includes(
			'最多选择 8 种曲风，也可以填上喜欢的歌手。偏好只保存在本机，点击“查找推荐”后才会搜索。',
		),
	)
	assert.ok(
		text.includes(
			'最多填写 8 位，用逗号分隔。搜索结果也可能包含翻唱或相关作品。',
		),
	)
	assert.ok(!text.includes('虚构歌手目录'))
	assert.ok(!text.includes('不会把 UP'))
	f.f.unmount()
})

void test('discovery renders preserved results and an explicit remaining-only retry without automatic fetch', async () => {
	const calls: string[] = []
	let offline = true
	const f = controlFixture(
		{},
		{
			'./core/music-preferences': preferences,
			'./preference-discovery-session': { PreferenceDiscoverySession },
			'./bilibili': {
				search: async (seed: string) => {
					calls.push(seed)
					if (seed === '乙' && offline) throw new Error('offline')
					return {
						items: [
							{
								bvid: seed,
								originalTitle: `${seed} 翻唱 Live`,
								uploader: '上传者',
								uploaderId: 1,
								artwork: '',
								duration: 120,
								category: '翻唱',
							},
						],
						more: false,
					}
				},
			},
		},
	)
	const module = f.load('music-preferences-ui')
	const root = f.element(module.PreferenceDiscovery as ControlNode['type'], {
		preferences: {
			...preferences.emptyMusicPreferences(),
			artists: ['甲', '乙'],
		},
		onEdit: () => {},
		onPlay: () => {},
		onSearch: () => {},
	})
	const render = () => f.render(root)
	const press = (label: string) => {
		const node = controlNodes(render()).find(
			(n) => n.type === 'Pressable' && content(n.children) === label,
		)
		assert.ok(node, label)
		;(node.props.onPress as () => void)()
	}
	render()
	assert.deepEqual(calls, [])
	press('查找推荐')
	await new Promise((done) => setImmediate(done))
	assert.ok(content(render()).includes('甲 翻唱 Live'))
	assert.ok(content(render()).includes('继续查找剩余 1 项'))
	assert.deepEqual(calls, ['甲', '乙'])
	offline = false
	press('继续查找剩余 1 项')
	await new Promise((done) => setImmediate(done))
	assert.deepEqual(calls, ['甲', '乙', '乙'])
	assert.ok(content(render()).includes('乙 翻唱 Live'))
	assert.ok(!content(render()).includes('继续查找剩余'))
	f.unmount()
})

void test('discovery shows a restriction and later retry while retaining earlier results', async () => {
	const calls: string[] = []
	let offline = true
	const f = controlFixture(
		{},
		{
			'./core/music-preferences': preferences,
			'./preference-discovery-session': { PreferenceDiscoverySession },
			'./bilibili': {
				search: async (seed: string) => {
					calls.push(seed)
					if (seed === '乙' && offline)
						throw new BilibiliRequestRestrictedError()
					return {
						items: [
							{
								bvid: seed,
								originalTitle: `${seed} 翻唱 Live`,
								uploader: '上传者',
								uploaderId: 1,
								artwork: '',
								duration: 120,
								category: '翻唱',
							},
						],
						more: false,
					}
				},
			},
		},
	)
	const module = f.load('music-preferences-ui')
	const root = f.element(module.PreferenceDiscovery as ControlNode['type'], {
		preferences: {
			...preferences.emptyMusicPreferences(),
			artists: ['甲', '乙', '丙'],
		},
		onEdit: () => {},
		onPlay: () => {},
		onSearch: () => {},
	})
	const render = () => f.render(root)
	const press = (label: string) => {
		const node = controlNodes(render()).find(
			(n) => n.type === 'Pressable' && content(n.children) === label,
		)
		assert.ok(node, label)
		;(node.props.onPress as () => void)()
	}
	render()
	assert.deepEqual(calls, [])
	press('查找推荐')
	await new Promise((done) => setImmediate(done))
	assert.ok(content(render()).includes('甲 翻唱 Live'))
	assert.ok(content(render()).includes('继续查找剩余 2 项'))
	assert.deepEqual(calls, ['甲', '乙'])
	assert.ok(content(render()).includes('请求受限，已停止本轮查找，请稍后再试'))
	offline = false
	press('继续查找剩余 2 项')
	await new Promise((done) => setImmediate(done))
	assert.deepEqual(calls, ['甲', '乙', '乙', '丙'])
	assert.ok(content(render()).includes('乙 翻唱 Live'))
	assert.ok(!content(render()).includes('继续查找剩余'))
	f.unmount()
})

void test('recommendation card rotates first six and shows merged keyword evidence without automatic playback', async () => {
	const calls: string[] = []
	const played: unknown[] = []
	const f = controlFixture(
		{},
		{
			'./core/music-preferences': preferences,
			'./preference-discovery-session': { PreferenceDiscoverySession },
			'./bilibili': {
				search: async (seed: string) => {
					calls.push(seed)
					return {
						items: Array.from({ length: 8 }, (_, i) => ({
							bvid: i === 0 ? 'shared' : `${seed}${i}`,
							originalTitle:
								i === 0 ? '同曲 翻唱 Live' : `${seed}${i} 原始标题`,
							uploader: '上传者',
							uploaderId: 1,
							artwork: '',
							duration: 120,
							category: '翻唱',
						})),
						more: true,
					}
				},
			},
		},
	)
	const module = f.load('music-preferences-ui')
	const root = f.element(module.PreferenceDiscovery as ControlNode['type'], {
		preferences: {
			...preferences.emptyMusicPreferences(),
			artists: ['甲', '乙', '丙', '不发出'],
		},
		onEdit: () => {},
		onPlay: (item: unknown) => played.push(item),
		onSearch: () => {},
	})
	const render = () => f.render(root)
	const press = (label: string) => {
		const node = controlNodes(render()).find(
			(n) => n.type === 'Pressable' && content(n.children) === label,
		)
		assert.ok(node, label)
		;(node.props.onPress as () => void)()
	}
	render()
	assert.deepEqual(calls, [])
	press('查找推荐')
	await new Promise((done) => setImmediate(done))
	const cards = controlNodes(render()).filter(
		(n) =>
			n.type === 'Pressable' &&
			String(n.props.accessibilityLabel).startsWith('播放 '),
	)
	assert.deepEqual(
		cards.map((n) => n.props.accessibilityLabel),
		[
			'播放 同曲 翻唱 Live',
			'播放 乙1 原始标题',
			'播放 丙1 原始标题',
			'播放 甲1 原始标题',
			'播放 乙2 原始标题',
			'播放 丙2 原始标题',
		],
	)
	assert.ok(content(cards[0]).includes('因关键词“甲”、“乙”、“丙”找到'))
	assert.ok(content(cards[0]).includes('取得于'))
	assert.ok(content(render()).includes('未核验歌手身份或曲风'))
	assert.deepEqual(calls, ['甲', '乙', '丙'])
	assert.deepEqual(played, [])
	;(cards[0].props.onPress as () => void)()
	assert.equal(played.length, 1)
	press('查看其余 16 条')
	assert.equal(
		controlNodes(render()).filter(
			(n) =>
				n.type === 'Pressable' &&
				String(n.props.accessibilityLabel).startsWith('播放 '),
		).length,
		22,
	)
	assert.deepEqual(calls, ['甲', '乙', '丙'])
	f.unmount()
})

void test('later preference editing offers more styles while onboarding stays short and caps eight choices', () => {
 const first = fixture(true)
 first.press('选一点音乐偏好')
 assert.ok(!content(first.render()).includes('VOCALOID'))
 first.f.unmount()
 const later = fixture(false)
 assert.ok(content(later.render()).includes('VOCALOID'))
 for (const genre of ['流行', '摇滚', '民谣', '电子', '爵士', '古典', '国风', 'VOCALOID']) later.press(genre)
 later.press('游戏音乐')
 assert.ok(content(later.render()).includes('最多选择 8 种曲风，请先取消一项'))
 later.press('保存偏好')
 assert.equal(later.stored().genres.length, 8)
 assert.ok(later.stored().genres.includes('VOCALOID'))
 assert.ok(!later.stored().genres.includes('游戏音乐'))
 later.f.unmount()
})
