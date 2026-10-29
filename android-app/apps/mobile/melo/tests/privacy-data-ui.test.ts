import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import type { MusicPreferences } from '../core/music-preferences'

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
function fixture() {
	let stored: MusicPreferences = {
		version: 1,
		welcomeCompleted: true,
		genres: ['合成曲风'],
		artists: ['合成歌手'],
	}
	let fail = false
	let reads = 0
	const events: string[] = []
	const f = controlFixture()
	const module = f.load('privacy-data-ui')
	const root = f.element(module.PrivacyDataEntry as ControlNode['type'], {
		store: {
			load: () => {
				reads++
				if (fail) throw new Error('synthetic read failure')
				return stored
			},
		},
		onPreferences: () => events.push('preferences'),
		onSearchHistory: () => events.push('search'),
		onRecentMusic: () => events.push('recent'),
		onRecommendations: () => events.push('recommendations'),
	})
	const render = () => f.render(root)
	const press = (label: string) => {
		const node = controlNodes(render()).find(
			(n) => n.type === 'Pressable' && (content(n.children) === label || n.props.accessibilityLabel === label),
		)
		assert.ok(node, label)
		;(node.props.onPress as () => void)()
	}
	return {
		f,
		render,
		press,
		events,
		reads: () => reads,
		fail: (v: boolean) => {
			fail = v
		},
		replace: () => {
			stored = { ...stored, genres: [], artists: [] }
		},
	}
}
void test('overview reads fresh manual preferences on opening without writes or navigation', () => {
	const f = fixture()
	f.render()
	assert.equal(f.reads(), 0)
	f.press('隐私与本机数据')
	assert.match(content(f.render()), /合成曲风/)
	assert.match(content(f.render()), /合成歌手/)
	assert.doesNotMatch(content(f.render()), /打开此页面不会发起搜索/)
	f.press('数据保存与联网说明')
	assert.match(content(f.render()), /继续查找、重新查找或点击关键词/)
	assert.match(content(f.render()), /打开此页面不会发起搜索/)
	assert.deepEqual(f.events, [])
	f.press('返回设置')
	f.replace()
	f.press('隐私与本机数据')
	assert.match(content(f.render()), /尚未选择/)
	assert.doesNotMatch(content(f.render()), /合成歌手/)
	assert.equal(f.reads(), 2)
	f.f.unmount()
})
void test('failed read never presents stale preferences and retry recovers', () => {
	const f = fixture()
	f.press('隐私与本机数据')
	f.press('返回设置')
	f.fail(true)
	f.press('隐私与本机数据')
	assert.match(content(f.render()), /原记录已保留/)
	assert.doesNotMatch(content(f.render()), /合成歌手/)
	f.fail(false)
	f.press('重试读取偏好')
	assert.match(content(f.render()), /合成歌手/)
	f.f.unmount()
})
void test('each management link dismisses overview and invokes only its existing destination', () => {
	const f = fixture()
	for (const [label, event] of [
		['编辑音乐偏好', 'preferences'],
		['管理搜索历史', 'search'],
		['管理音乐最近播放', 'recent'],
		['管理本地推荐', 'recommendations'],
	]) {
		f.press('隐私与本机数据')
		f.press(label)
		assert.equal(f.events.at(-1), event)
		assert.equal(
			controlNodes(f.render()).some((n) => n.type === 'Modal'),
			false,
		)
	}
	assert.equal(f.events.length, 4)
	f.press('隐私与本机数据')
	const modal = controlNodes(f.render()).find((n) => n.type === 'Modal')!
	;(modal.props.onRequestClose as () => void)()
	assert.equal(
		controlNodes(f.render()).some((n) => n.type === 'Modal'),
		false,
	)
	assert.equal(f.events.length, 4)
	f.f.unmount()
})
void test('App wires existing destinations without adding destructive or network operations', () => {
	const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
	assert.match(
		source,
		/onSearchHistory=\{\(\) =>\s+navigateSearch\(undefined, undefined, 'profile'\)\s*\}/,
	)
	assert.match(source, /openLibraryCollection\('recent'\)/)
	assert.match(source, /onRecommendations=\{openRecommendations\}/)
})
