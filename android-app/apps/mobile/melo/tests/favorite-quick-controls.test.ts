import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'

import { controlNodes } from './theme-control-fixture'
import {
	biliState,
	component,
	flat,
	importHost,
	label,
	mixedTask,
	press,
	settle,
	text,
} from './theme-import-fixture'

void test('all three themes offer one folder action and clear progress/results instead of item checkboxes', () => {
	for (const theme of Object.values(builtInThemes)) {
		const h = importHost()
		const render = (state: ReturnType<typeof biliState>) =>
			settle(
				h,
				h.element(
					component(h.ui.ThemeProvider),
					{ value: theme },
					h.page('BilibiliImportPage', state),
				),
				320,
			)
		try {
			let tree = render(
				biliState({
					folders: {
						userMid: '88',
						observedCount: 1,
						reportedCount: 1,
						originalEnvelope: {},
						originalData: {},
						folders: [
							{
								index: 0,
								folderId: '123',
								title: '原收藏夹',
								mediaCount: 41,
								favState: 0,
								original: {},
							},
						],
					},
				}),
			)
			press(tree, '导入收藏夹 原收藏夹，41 项')
			assert.deepEqual(h.calls.at(-1), ['importFolder', '123'])
			assert.equal(
				controlNodes(tree).some(
					(node) => node.props.accessibilityRole === 'checkbox',
				),
				false,
			)
			const progress = {
				phase: 'loading' as const,
				title: '原收藏夹',
				total: 41,
				processed: 12,
				skipped: 0,
				unavailable: [],
				playlistId: null,
			}
			tree = render(
				biliState({
					route: 'collection',
					task: mixedTask(),
					busy: true,
					quick: progress,
				}),
			)
			assert.match(text(tree), /已处理 12 \/ 41 项/)
			assert.doesNotMatch(text(tree), /核对保存|逐项|显式读取下一页/)
			press(tree, '取消本次读取')
			assert.deepEqual(h.calls.at(-1), ['cancelRead'])
			tree = render(
				biliState({
					route: 'collection',
					task: mixedTask(),
					quick: { ...progress, phase: 'paused' },
					error: '网络连接失败',
				}),
			)
			press(tree, '继续导入')
			assert.deepEqual(h.calls.at(-1), ['continueFavoriteImport'])
			tree = render(
				biliState({
					route: 'result',
					task: mixedTask(),
					quick: {
						...progress,
						phase: 'done',
						processed: 41,
						playlistId: 'saved',
						unavailable: [
							{ entryId: 'e1', title: '原失效视频', reason: '视频暂不可用' },
						],
					},
				}),
			)
			press(tree, '播放歌单')
			assert.deepEqual(h.calls.at(-1), ['play-playlist', 'saved'])
			press(tree, '查看歌单')
			assert.deepEqual(h.calls.at(-1), ['playlist', 'saved'])
			assert.match(text(tree), /原失效视频/)
			assert.ok(Number(flat(h, label(tree, '播放歌单')).minHeight) >= 48)
			assert.equal(
				controlNodes(tree).some(
					(node) => node.props.accessibilityRole === 'checkbox',
				),
				false,
			)
		} finally {
			h.unmount()
		}
	}
})
