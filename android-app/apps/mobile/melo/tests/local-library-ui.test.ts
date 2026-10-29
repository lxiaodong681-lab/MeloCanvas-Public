import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { builtInThemes } from '../core/theme'
import type { LocalAudioSection } from '../local-audio-ui'

import { compile, nodes, react, type ViewNode } from './search-page-fixture'

const localId = 'local:12345678-1234-1234-1234-123456789abc'
class ImportSession {
	state = {
		busy: false,
		error: '',
		notice: '',
		items: [
			{
				id: localId,
				title: '离线歌曲',
				artist: '作者',
				originalName: 'song.flac',
			},
		],
	}
	dispose() {}
}
const hooks = {
	...react,
	useReducer: () => [0, () => {}],
	useMemo: (factory: () => unknown) => factory(),
	useEffect: () => {},
	useState: (value: unknown) => [value, () => {}],
}
const dependencies = (name: string): unknown => {
	if (name === 'react') return { __esModule: true, default: hooks, ...hooks }
	if (name === 'react-native')
		return {
			View: 'View',
			Modal: 'Modal',
			Pressable: 'Pressable',
			ScrollView: 'ScrollView',
		}
	if (name === './local-audio-import')
		return { LocalAudioImport: ImportSession }
	if (name === './local-audio-mobile') return { localAudioFiles: {} }
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
	if (name === './library-collection-ui') {
		const exports = {}
		runInNewContext(
			compile(
				readFileSync(
					new URL('../library-collection-ui.tsx', import.meta.url),
					'utf8',
				),
			),
			{ exports, require: dependencies },
		)
		return exports
	}
	throw new Error(`Unexpected dependency ${name}`)
}
void test('actual local list exposes like/unlike and saved-playlist action using real local ID', () => {
	const output: {
		LocalAudioSection?: (
			props: Parameters<typeof LocalAudioSection>[0],
		) => ViewNode
	} = {}
	runInNewContext(
		compile(
			readFileSync(new URL('../local-audio-ui.tsx', import.meta.url), 'utf8'),
		),
		{ exports: output, require: dependencies },
	)
	assert.ok(output.LocalAudioSection)
	const calls: string[] = []
	const props: Parameters<typeof LocalAudioSection>[0] = {
		store: {} as Parameters<typeof LocalAudioSection>[0]['store'],
		playbackBusy: true,
		onPlay: (id) => calls.push(`play:${id}`),
		likedIds: [],
		onToggleLiked: (id) => calls.push(`like:${id}`),
		onAddToPlaylist: (id) => calls.push(`playlist:${id}`),
	}
	const first = output.LocalAudioSection(props)
	const like = nodes(first).find((n) => n.props.accessibilityLabel === '喜欢')!
	const add = nodes(first).find(
		(n) => n.props.accessibilityLabel === '添加到歌单',
	)!
	const play = nodes(first).find(
		(n) => n.props.accessibilityLabel === '播放 离线歌曲',
	)!
	assert.equal(play.props.disabled, true)
	;(like.props.onPress as () => void)()
	;(add.props.onPress as () => void)()
	assert.deepEqual(calls, [`like:${localId}`, `playlist:${localId}`])
	const second = output.LocalAudioSection({ ...props, likedIds: [localId] })
	assert.ok(
		nodes(second).some((n) => n.props.accessibilityLabel === '取消喜欢'),
	)
})
