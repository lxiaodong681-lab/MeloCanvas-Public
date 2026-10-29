import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { PlaybackProgress } from '../playback-progress'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

function visibleText(value: unknown): string {
	if (Array.isArray(value)) return value.map(visibleText).join('')
	if (value && typeof value === 'object' && 'children' in value)
		return visibleText(value.children)
	return typeof value === 'string' || typeof value === 'number'
		? String(value)
		: ''
}

function setup() {
	const f = controlFixture()
	const progress = new PlaybackProgress()
	progress.update(120, 300)
	let subscriptions = 0
	const subscribe = progress.subscribe
	progress.subscribe = (listener) => {
		subscriptions++
		const stop = subscribe(listener)
		return () => {
			subscriptions--
			stop()
		}
	}
	const seeks: number[] = []
	let toggles = 0,
		closes = 0
	const player = {
		progress,
		position: 120,
		duration: 300,
		playing: true,
		error: '',
		track: { title: '候选曲', artist: '测试歌手' },
		seek: async (value: number) => {
			seeks.push(value)
		},
		toggle: async () => {
			toggles++
		},
	}
	const Panel = f.load('candidate-audition-ui')
		.CandidateAuditionPanel as ControlNode['type']
	const render = (returnToImport = true) =>
		f.render(
			f.element(Panel, {
				player,
				bottomInset: 24,
				returnToImport,
				onClose: () => {
					closes++
				},
			}),
		)
	const press = (tree: unknown, label: string) => {
		const button = controlNodes(tree).find(
			(node) => node.props.accessibilityRole === 'button' && visibleText(node) === label,
		)
		assert.ok(button, label)
		;(button.props.onPress as () => void)()
	}
	return {
		f,
		player,
		progress,
		render,
		press,
		seeks,
		counts: () => ({ subscriptions, toggles, closes }),
	}
}

void test('audition time and relative seeks follow live ticks while the shell snapshot stays unchanged', () => {
	const h = setup()
	try {
		h.render()
		h.progress.update(124, 360)
		const tree = h.render()
		assert.match(visibleText(tree), /124 \/ 360 秒/)
		h.press(tree, '前进 15 秒')
		h.press(tree, '后退 15 秒')
		assert.deepEqual(h.seeks, [139, 109])
		assert.equal(h.player.position, 120)
		assert.equal(h.player.duration, 300)
		assert.equal(h.counts().subscriptions, 1)
		h.progress.update(20, 200)
		h.press(h.render(), '前进 15 秒')
		assert.equal(h.seeks.at(-1), 35)
	} finally {
		h.f.unmount()
	}
	assert.equal(h.counts().subscriptions, 0)
})

void test('audition retains pause, error and both exit paths with an isolated progress subscription', () => {
	const h = setup()
	try {
		h.press(h.render(), '暂停试听')
		h.player.playing = false
		h.player.error = '暂时无法播放'
		assert.match(visibleText(h.render()), /暂时无法播放/)
		h.press(h.render(), '播放试听')
		h.press(h.render(), '返回选择音源')
		h.press(h.render(false), '结束试听，恢复原播放')
		assert.deepEqual(h.counts(), { subscriptions: 1, toggles: 2, closes: 2 })
	} finally {
		h.f.unmount()
	}
	const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
	assert.match(app, /<CandidateAuditionPanel\s+player=\{player\}/)
	assert.doesNotMatch(app, /usePlaybackProgress\(/)
})
