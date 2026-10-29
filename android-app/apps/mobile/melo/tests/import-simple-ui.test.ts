import assert from 'node:assert/strict'
import test from 'node:test'

import { builtInThemes } from '../core/theme'

import { controlNodes } from './theme-control-fixture'
import {
	component,
	importHost,
	importState,
	label,
	press,
	settle,
	task,
	text,
	video,
} from './theme-import-fixture'

void test('import action stays outside the scrolling content in every built-in theme, without review steps', async () => {
	for (const theme of Object.values(builtInThemes)) {
		const h = importHost(),
			state = importState({
				route: 'input',
				url: 'https://music.163.com/playlist?id=123',
				provider: 'netease',
			})
		const tree = settle(
			h,
			h.element(
				component(h.ui.ThemeProvider),
				{ value: theme },
				h.page('ImportPage', state),
			),
			320,
		)
		assert.ok(label(tree, '导入歌单'))
		const scrolling = controlNodes(tree).find(
			(node) => node.type === 'ScrollView',
		)!
		assert.ok(
			!controlNodes(scrolling).some(
				(node) => node.props.accessibilityLabel === '导入歌单',
			),
		)
		assert.doesNotMatch(text(tree), /核对版本|确认保存|保存选中|·/)
		press(tree, '导入歌单')
		await new Promise((resolve) => setImmediate(resolve))
		assert.ok(h.calls.some((call) => call[0] === 'importPlaylist'))
		h.unmount()
	}
})

void test('selected source has fixed audition and apply actions without an extra confirmation page', () => {
	const h = importHost(),
		detail = task()
	const state = importState({
		route: 'entry',
		task: detail,
		entryId: 'e0',
		video,
		selectedCid: video.parts[0].source.cid,
	})
	const tree = settle(h, h.page('ImportPage', state), 320)
	assert.ok(label(tree, '使用这个音源'))
	press(tree, '试听')
	assert.ok(h.calls.some((call) => call[0] === 'preview'))
	press(tree, '使用这个音源')
	assert.ok(h.calls.some((call) => call[0] === 'applySelectedSource'))
	h.unmount()
})
