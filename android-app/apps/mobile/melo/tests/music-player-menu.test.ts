import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { builtInThemes } from '../core/theme'
import type { MusicPlayerMenu } from '../music-player-menu'
import { compile, nodes, react, text, type ViewNode } from './search-page-fixture'

function fixture(local = false, fm = false) {
	let open = false
	const events: string[] = []
	const output = {} as { MusicPlayerMenu: (p: Parameters<typeof MusicPlayerMenu>[0]) => ViewNode }
	runInNewContext(compile(readFileSync(new URL('../music-player-menu.tsx', import.meta.url), 'utf8')), {
		exports: output,
		require: (name: string) => {
			if (name === 'react') return { __esModule: true, default: react, ...react, useState: () => [open, (value: boolean) => { open = value }] }
			if (name === 'react-native') return { View: 'View', Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView' }
			if (name === './ui') return { ControlTarget: 'ControlTarget', T: 'T', useTheme: () => builtInThemes.modern }
			throw new Error(`Unexpected dependency ${name}`)
		},
	})
	const render = () => output.MusicPlayerMenu({ local, fm, bvid: 'BV1234567890', notifications: false,
		bottomInset: 34, onSource: () => events.push(`source:${open}`), onParts: () => events.push(`parts:${open}`), onTheme: () => events.push(`theme:${open}`),
		onFm: () => events.push(`fm:${open}`), onNotificationSettings: () => events.push(`notification:${open}`) })
	const find = (label: string) => nodes(render()).find((n) => n.props.accessibilityLabel === label)
	const press = (label: string) => { const node = find(label); assert.ok(node); (node.props.onPress as () => void)() }
	const modal = () => nodes(render()).find((n) => n.type === 'Modal')!
	return { render, find, press, modal, events }
}
void test('music overflow closes before a secondary action, while dismiss and Android Back do not act', () => {
	const f = fixture(false, true)
	assert.equal(f.modal().props.visible, false)
	for (const [label, expected] of [['查看音源信息', 'source:false'], ['切换主题', 'theme:false'], ['媒体通知不可用 · 前往设置', 'notification:false'], ['管理与退出私人 FM', 'fm:false']]) {
		f.press('更多播放选项'); assert.equal(f.modal().props.visible, true)
		f.press(label); assert.equal(f.modal().props.visible, false)
		assert.equal(f.events.at(-1), expected)
	}
	f.press('更多播放选项'); f.press('关闭播放选项')
	f.press('更多播放选项'); (f.modal().props.onRequestClose as () => void)()
	f.press('更多播放选项'); f.press('取消播放选项')
	assert.equal(f.modal().props.visible, false); assert.equal(f.events.length, 4)
	assert.match(text(f.render()), /UP 主不等于歌手/)
	assert.match(text(f.render()), /播放片段缓存不等于完整离线下载/)
})
void test('local music keeps provenance and notifications without B站 action or irrelevant FM management', () => {
	const f = fixture(true)
	assert.equal(f.find('查看音源信息'), undefined)
	assert.equal(f.find('管理与退出私人 FM'), undefined)
	assert.match(text(f.render()), /私有副本，可离线播放/)
	assert.doesNotMatch(text(f.render()), /Bilibili|UP 主/)
	assert.ok(f.find('媒体通知不可用 · 前往设置'))
})
void test('ordinary music offers part selection; FM and local audio keep their own playback semantics', () => {
	const f = fixture()
	f.press('更多播放选项'); f.press('切换分 P')
	assert.deepEqual(f.events, ['parts:false'])
	assert.equal(f.modal().props.visible, false)
	assert.equal(fixture(false, true).find('切换分 P'), undefined)
	assert.equal(fixture(true).find('切换分 P'), undefined)
})
