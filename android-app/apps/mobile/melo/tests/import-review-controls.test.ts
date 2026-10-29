import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'

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

void test('automatic import exposes progress and pause without per-song review in every theme', () => {
	for (const theme of Object.values(builtInThemes)) {
		const h = importHost()
		const state = importState({
			route: 'task',
			task: task(),
			batch: {
				phase: 'running',
				eligible: 50,
				skipped: 0,
				budget: 50,
				requested: 21,
				completed: 20,
				empty: 2,
			},
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
		assert.match(text(tree), /已处理 20 \/ 50 首/)
		assert.match(text(tree), /暂未匹配 2 首/)
		assert.doesNotMatch(text(tree), /核对版本|本轮最多20首|保存选中/)
		assert.equal(label(tree, '正在匹配 20/50').props.disabled, true)
		press(tree, '暂停导入')
		assert.ok(h.calls.some((call) => call[0] === 'pauseBatch'))
		h.unmount()
	}
})

void test('multipart source selection and original-video action remain available', () => {
	const h = importHost(),
		state = importState({
			route: 'entry',
			task: task(),
			entryId: 'e0',
			video,
			selectedCid: null,
		})
	const tree = settle(h, h.page('ImportPage', state), 320)
	assert.equal(label(tree, '使用这个音源').props.disabled, true)
	press(tree, `选择分P ${video.parts[1].page} ${video.parts[1].title}`)
	assert.ok(
		h.calls.some(
			(call) =>
				call[0] === 'selectCid' && call[1] === video.parts[1].source.cid,
		),
	)
	assert.ok(label(tree, '查看原视频'))
	press(tree, '返回搜索结果')
	assert.ok(h.calls.some((call) => call[0] === 'showSearchResults'))
	h.unmount()
})

void test('paused import can resume and unavailable sources remain represented', async () => {
	const h = importHost(),
		state = importState({
			route: 'task',
			task: task(),
			batch: {
				phase: 'paused',
				eligible: 50,
				skipped: 0,
				budget: 50,
				requested: 21,
				completed: 20,
				empty: 2,
			},
		})
	const tree = settle(h, h.page('ImportPage', state), 320)
	press(tree, '继续导入')
	await new Promise((resolve) => setImmediate(resolve))
	assert.ok(h.calls.some((call) => call[0] === 'importPlaylist'))
	assert.match(text(tree), /暂未匹配 2 首/)
	h.unmount()
})
