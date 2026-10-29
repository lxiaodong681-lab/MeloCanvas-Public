import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { builtInThemes } from '../core/theme'
import type { RecentMusicList } from '../recent-music-ui'

import {
	compile,
	nodes,
	react,
	text,
	type ViewNode,
} from './search-page-fixture'

const dependencies = (name: string): unknown => {
	if (name === '@bbplayer/orpheus') return {}
	if (name === 'react')
		return {
			__esModule: true,
			default: react,
			...react,
			useState: (value: unknown) => [value, () => {}],
		}
	if (name === 'react-native')
		return {
			View: 'View',
			Modal: 'Modal',
			Pressable: 'Pressable',
			ScrollView: 'ScrollView',
		}
	if (name === './recent-music-session') return {}
	if (name === './ui')
		return {
			Button: 'Button',
			Card: 'Card',
			T: 'T',
			Artwork: 'Artwork',
			ControlRow: 'ControlRow',
			ControlTarget: 'ControlTarget',
			useTheme: () => builtInThemes.modern,
			shape: () => ({}),
		}
	if (name === './library-collection-ui' || name === './theme-dialog') {
		const exports = {}
		runInNewContext(
			compile(
				readFileSync(
					new URL(`../${name.slice(2)}.tsx`, import.meta.url),
					'utf8',
				),
			),
			{ exports, require: dependencies },
		)
		return exports
	}
	throw new Error(`Unexpected dependency ${name}`)
}

void test('actual recent-music view replays stable identities, labels sources, and preserves busy state', () => {
	const output: {
		RecentMusicList?: (props: Parameters<typeof RecentMusicList>[0]) => ViewNode
	} = {}

	runInNewContext(
		compile(
			readFileSync(new URL('../recent-music-ui.tsx', import.meta.url), 'utf8'),
		),
		{ exports: output, require: dependencies },
	)
	assert.ok(output.RecentMusicList)
	const played: string[] = []
	const props: Parameters<typeof RecentMusicList>[0] = {
		state: {
			open: true,
			loading: false,
			clearing: false,
			confirmClear: false,
			error: '',
			visibleCount: 20,
			items: [
				{
					sourceId: 'bilibili:BV1vT411i7ET:55',
					title: '同名歌曲',
					artist: 'UP，原UP',
					artwork: '',
					playedAt: 100,
				},
				{
					sourceId: 'local:00000000-0000-4000-8000-000000000001',
					title: '同名歌曲',
					artist: '本地歌手',
					artwork: '',
					playedAt: 90,
				},
			],
		},
		onRefresh: () => {},
		onRequestClear: () => {},
		onCancelClear: () => {},
		onConfirmClear: () => {},
		onClose: () => {},
		onMore: () => {},
		onPlay: (id) => played.push(id),
		playbackBusy: false,
	}
	const tree = output.RecentMusicList(props)
	assert.match(text(tree), /B站音源/)
	assert.match(text(tree), /本地音频/)
	const buttons = nodes(tree).filter(
		(node) => node.props.accessibilityLabel === '播放 同名歌曲',
	)
	assert.equal(buttons.length, 2)
	for (const button of buttons) (button.props.onPress as () => void)()
	assert.deepEqual(
		played,
		props.state.items.map((item) => item.sourceId),
	)
	const embedded = output.RecentMusicList({ ...props, embedded: true })
	assert.ok(
		!nodes(embedded).some(
			(node) => node.props.accessibilityLabel === '收起最近播放',
		),
	)
	const busy = output.RecentMusicList({ ...props, playbackBusy: true })
	assert.ok(
		nodes(busy)
			.filter((node) => node.props.accessibilityLabel === '播放 同名歌曲')
			.every((node) => node.props.disabled === true),
	)
	let requested = 0
	let confirmed = 0
	let cancelled = 0
	const clearProps = {
		...props,
		onRequestClear: () => {
			requested++
		},
		onConfirmClear: () => {
			confirmed++
		},
		onCancelClear: () => {
			cancelled++
		},
	}
	const initial = output.RecentMusicList(clearProps)
	const request = nodes(initial).find(
		(node) => node.props.accessibilityLabel === '清空最近播放，音乐',
	)
	assert.ok(request)
	;(request.props.onPress as () => void)()
	assert.equal(requested, 1)
	assert.equal(confirmed, 0)
	assert.doesNotMatch(text(initial), /确认清空音乐记录/)
	const confirmation = output.RecentMusicList({
		...clearProps,
		state: { ...props.state, confirmClear: true },
	})
	assert.match(text(confirmation), /歌曲、歌单和音频文件会保留/)
	const modal = nodes(confirmation).findLast(node => node.type === 'Modal')!
	assert.ok(modal, 'clear history must be a separate modal')
	;(modal.props.onRequestClose as () => void)()
	assert.equal(cancelled, 1)
	assert.equal(confirmed, 0)
	for (const label of ['取消清空', '确认清空音乐记录']) {
		const button = nodes(modal).find(
			(node) => node.type === 'Button' && text(node) === label,
		)
		assert.ok(button)
		;(button.props.onPress as () => void)()
	}
	assert.equal(cancelled, 2)
	assert.equal(confirmed, 1)
	const error = output.RecentMusicList({
		...props,
		state: { ...props.state, items: [], error: '读取失败' },
	})
	assert.match(text(error), /读取失败/)
	assert.doesNotMatch(text(error), /还没有音乐播放记录/)
})
