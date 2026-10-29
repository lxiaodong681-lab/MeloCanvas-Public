import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'
import { LyricsStore } from '../lyrics'
import { cacheOnlineLyrics } from '../online-lyrics-cache'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

void test('short windows and large text keep a useful lyrics region, real transport actions and cover return in every builtin theme', () => {
	for (const theme of Object.values(builtInThemes)) {
		const f = controlFixture()
		f.viewport.width = 320
		f.viewport.height = 640
		f.viewport.fontScale = 1.4
		let toggled = 0
		let closed = 0
		const track = {
			id: 'entry',
			sourceId: 'local:12345678-1234-1234-1234-123456789abc',
			title: '长标题阅读与播放',
			duration: 180,
		}
		const original = '静かな朝の光を探し続けた'
		const translation = '寻找清晨安静的光'
		const romaji = 'shi zu ka na a sa no hi ka ri wo sa ga shi tsu zu ke ta'
		const settings = new Map<string, string>()
		const library = {
			setting: (key: string) => settings.get(key) ?? null,
			setSetting: (key: string, value: string) => {
				settings.set(key, value)
			},
		}
		new LyricsStore(library).save(
			cacheOnlineLyrics(
				{
					sourceId: track.sourceId,
					candidate: {
						source: 'netease',
						remoteId: 123,
						title: track.title,
						artist: '受控测试',
						duration: 180,
					},
					lines: [
						{
							startTime: 10000,
							endTime: 30000,
							content: original,
							translation,
							romaji,
							translations: [translation],
							isDynamic: false,
							spans: [],
						},
					],
					raw: { lrc: '[00:10.000]静かな朝の光を探し続けた' },
				},
				1,
			),
		)
		const root = f.element(
			f.load('ui').ThemeProvider as ControlNode['type'],
			{ value: theme },
			f.element(f.load('music-ui').MusicPlayer as ControlNode['type'], {
				library,
				player: {
					track,
					queue: [track],
					position: 20,
					duration: 180,
					playing: false,
					error: '',
					buffering: false,
					toggle: () => {
						toggled++
					},
				},
				current: null,
				isLiked: () => false,
				busyBv: '',
				onLike: () => {},
				onClose: () => {
					closed++
				},
				onTheme: () => {},
				onSource: () => {},
				onQueue: () => {},
				onNotice: () => {},
				onNotificationSettings: () => {},
				notifications: true,
				bottomInset: 0,
				onFm: () => {},
				fmMessage: '',
			}),
		)
		const render = () => f.render(root)
		const find = (name: string) => {
			const item = controlNodes(render()).find(
				(n) => n.type === 'Pressable' && n.props.accessibilityLabel === name,
			)
			assert.ok(item, name)
			return item
		}
		const press = (name: string) => {
			;(find(name).props.onPress as () => void)()
		}
		const style = (node: ControlNode) =>
			f.flatten(
				typeof node.props.style === 'function'
					? node.props.style({ pressed: false })
					: node.props.style,
			)
		try {
			const cover = controlNodes(render()).find(
				(n) => n.props.testID === 'player-cover-shadow',
			)!
			assert.ok(
				Number(f.flatten(cover.props.style).height) < 200,
				'large text leaves room below the cover',
			)
			assert.equal(
				controlNodes(render()).find((n) => n.props.testID === 'player-page')
					?.type,
				'ScrollView',
			)
			press('展开歌词')
			const region = controlNodes(render()).find(
				(n) => n.props.testID === 'player-lyrics-region',
			)!
			assert.ok(
				Number(f.flatten(region.props.style).height) >= 370,
				'320dp / 1.4 text leaves room for the focused wrapped original, translation and romaji after the header/search rows',
			)
			for (const [content, fontSize] of [
				[original, 20],
				[translation, 12],
				[romaji, 11],
			] as const) {
				const line = controlNodes(render()).find(
					(node) => node.type === 'Text' && node.children?.includes(content),
				)
				assert.ok(line, content)
				assert.equal(
					f.flatten(line.props.style).fontSize,
					fontSize,
					'available auxiliary lyrics are retained without shrinking text',
				)
			}
			for (const name of ['上一首', '继续播放', '下一首', '播放队列'])
				assert.ok(
					Number(style(find(name)).minHeight ?? style(find(name)).height) >= 48,
					name,
				)
			press('继续播放')
			assert.equal(toggled, 1)
			press('返回播放器封面')
			assert.ok(
				controlNodes(render()).some(
					(n) => n.props.testID === 'player-cover-shadow',
				),
			)
			assert.equal(closed, 0)
			press('收起播放器')
			assert.equal(closed, 1)
		} finally {
			f.unmount()
		}
	}
})
