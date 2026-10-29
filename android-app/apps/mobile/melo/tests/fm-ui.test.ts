import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { builtInThemes } from '../core/theme'
import type { FmPage } from '../fm-ui'

import { fmFixture } from './fm-test-fixture'
import {
	compile,
	node,
	nodes,
	react,
	text,
	type ViewNode,
} from './search-page-fixture'
import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

type Props = Parameters<typeof FmPage>[0]
const source = compile(
	readFileSync(new URL('../fm-ui.tsx', import.meta.url), 'utf8'),
)
function render(pageProps: Props, theme = builtInThemes.modern) {
	const output: { FmPage?: (value: Props) => ViewNode } = {}
	runInNewContext(source, {
		exports: output,
		require: (name: string) => {
			if (name === 'react')
				return { __esModule: true, default: react, ...react }
			if (name === 'react-native')
				return { ScrollView: 'ScrollView', View: 'View' }
			if (name === './ui')
				return {
					Artwork: 'Artwork',
					Button: 'Button',
					Card: 'Card',
					IconButton: 'IconButton',
					State: 'State',
					T: 'T',
					useTheme: () => theme,
				}
			throw new Error(`Unexpected dependency ${name}`)
		},
	})
	assert.ok(output.FmPage)
	return output.FmPage(pageProps)
}
function props(f: ReturnType<typeof fmFixture>) {
	const actions: string[] = []
	const value: Props = {
		state: f.session.getSnapshot(),
		session: f.session,
		onClose: () => {
			actions.push('close')
			f.session.close()
		},
		onStart: () => {
			void f.session.start(() => {
				actions.push('started')
			})
		},
		onExit: () => {
			void f.session.exit(() => {
				actions.push('exited')
			})
		},
		onPlayer: () => {
			actions.push('player')
		},
		onResume: () => {
			actions.push('resume')
		},
		onSearch: () => {
			actions.push('search')
		},
		onLibrary: () => {
			actions.push('library')
		},
		playbackError: '',
	}
	return { value, actions }
}
const button = (view: unknown, label: string) =>
	node(view, (value) => value.type === 'Button' && text(value) === label)
const press = (view: { props: Record<string, unknown> }) =>
	(view.props.onPress as () => void)()

void test('actual FM page is silent, labels the batch honestly and starts only after explicit confirmation', async (t) => {
	const f = fmFixture(t),
		p = props(f)
	f.session.open()
	p.value.state = f.session.getSnapshot()
	const view = render(p.value)
	assert.ok(text(view).includes('本批 20 首本机候选'))
	assert.ok(!text(view).includes('新歌'))
	assert.equal(f.reserves(), 0)
	assert.equal(f.starts.length, 0)
	assert.equal(button(view, '确认开始私人 FM').props.disabled, false)
	press(button(view, '确认开始私人 FM'))
	await new Promise<void>((resolve) => setImmediate(resolve))
	assert.equal(f.starts.length, 1)
	assert.deepEqual(p.actions, ['started'])
})

void test('the single actual FM confirmation follows the real count and precedes every retained candidate in all three themes', async (t) => {
	const f = fmFixture(t)
	f.session.open()
	const p = props(f)
	const ui = controlFixture()
	t.after(() => ui.unmount())
	ui.viewport.width = 320
	ui.viewport.fontScale = 1.4
	const Page = ui.load('fm-ui').FmPage as ControlNode['type']
	const Provider = ui.load('ui').ThemeRendererProvider as ControlNode['type']
	let tree: unknown
	for (const theme of Object.values(builtInThemes)) {
		tree = ui.render(
			ui.element(
				Provider,
				{ theme, adapted: null, allowedImageUris: [], reducedMotion: true },
				ui.element(Page, p.value),
			),
		)
		const nativeNodes = controlNodes(tree)
		const start = nativeNodes.filter(
			(entry) =>
				entry.type === 'Pressable' && text(entry) === '确认开始私人 FM',
		)
		assert.equal(start.length, 1)
		const countAt = nativeNodes.findIndex(
			(entry) =>
				entry.type === 'Text' &&
				text(entry) === '本批 20 首本机候选 · 候选耗尽后停止',
		)
		assert.ok(countAt >= 0)
		const startAt = nativeNodes.indexOf(start[0])
		assert.ok(countAt < startAt)
		const titleNodes = nativeNodes.filter(
			(entry) =>
				entry.type === 'Text' &&
				f.session
					.getSnapshot()
					.candidates.some(
						({ source: candidate }) => candidate.originalTitle === text(entry),
					),
		)
		assert.equal(titleNodes.length, 20)
		assert.deepEqual(
			titleNodes.map(text),
			f.session
				.getSnapshot()
				.candidates.map(({ source: candidate }) => candidate.originalTitle),
		)
		assert.ok(titleNodes.every((entry) => nativeNodes.indexOf(entry) > startAt))
		assert.equal(f.starts.length, 0)
		assert.equal(f.reserves(), 0)
	}
	const start = controlNodes(tree).find(
		(entry) => entry.type === 'Pressable' && text(entry) === '确认开始私人 FM',
	)!
	press(start)
	await new Promise<void>((resolve) => setImmediate(resolve))
	assert.equal(f.starts.length, 1)
	assert.deepEqual(p.actions, ['started'])
})

void test('empty candidates disable start while search/library/close stay usable; render has no hidden reads', (t) => {
	const f = fmFixture(t, 0)
	f.session.open()
	const p = props(f),
		before = f.reads(),
		view = render(p.value)
	assert.ok(
		nodes(view).some((value) => value.props.title === '暂时没有合格的本机候选'),
	)
	assert.equal(button(view, '确认开始私人 FM').props.disabled, true)
	press(button(view, '搜索歌曲'))
	press(button(view, '打开音乐库'))
	press(node(view, (value) => value.props.label === '返回私人 FM 之前的页面'))
	assert.deepEqual(p.actions, ['search', 'library', 'close'])
	assert.equal(f.reads(), before)
	assert.equal(f.starts.length, 0)
})

void test('existing FM offers resume rather than a second start, with original-context exit and visible bounded refill state', async (t) => {
	const f = fmFixture(t, 2)
	f.activateFm(2)
	await f.session.observe()
	f.session.open()
	let p = props(f),
		view = render(p.value)
	assert.ok(text(view).includes('当前内容结束后将停止'))
	assert.ok(
		!nodes(view).some(
			(value) => value.type === 'Button' && text(value) === '确认开始私人 FM',
		),
	)
	press(button(view, '打开 FM 播放器'))
	assert.deepEqual(p.actions, ['player'])
	f.frame.mode = 'listening'
	await f.session.observe()
	p = props(f)
	view = render(p.value)
	assert.ok(text(view).includes('私人 FM 已暂存'))
	press(button(view, '返回音乐并继续 FM'))
	assert.deepEqual(p.actions, ['resume'])
	press(button(view, '退出私人 FM 并恢复原播放'))
	await new Promise<void>((resolve) => setImmediate(resolve))
	assert.deepEqual(f.exits, ['fm-context'])
	assert.deepEqual(p.actions, ['resume', 'exited'])
})

void test('three themes reuse host Card/Button and their error token; preparation has explicit owned cancel', (t) => {
	const f = fmFixture(t)
	f.session.open()
	for (const theme of Object.values(builtInThemes)) {
		const p = props(f)
		p.value = {
			...p.value,
			state: { ...p.value.state, busy: true, error: '真实操作失败' },
			playbackError: '音频读取失败',
		}
		const view = render(p.value, theme)
		assert.ok(nodes(view).some((value) => value.type === 'Card'))
		assert.ok(
			nodes(view).some(
				(value) =>
					value.type === 'State' && value.props.message === '真实操作失败',
			),
		)
		assert.equal(
			(
				node(
					view,
					(value) => value.type === 'T' && text(value) === '音频读取失败',
				).props.style as { color: string }
			).color,
			theme.tokens.state.error,
		)
		assert.equal(button(view, '正在准备 FM…').props.disabled, true)
		press(button(view, '取消本次播放准备'))
		assert.equal(f.reserves(), 0)
	}
})

void test('a synchronized context during a pending start uses neutral busy copy rather than claiming a restore', async (t) => {
	const f = fmFixture(t)
	f.activateFm()
	await f.session.observe()
	f.session.open()
	const p = props(f)
	p.value.state = { ...p.value.state, busy: true }
	const view = render(p.value)
	assert.equal(button(view, '正在处理…').props.disabled, true)
	assert.ok(!text(view).includes('正在恢复'))
})
