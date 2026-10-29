import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Source } from '../core/model'
import { builtInThemes } from '../core/theme'

import {
	deferred,
	settleSubtitles,
	subtitleFixture,
	subtitleMetadata,
	subtitlePayload,
	subtitleTarget,
} from './listening-subtitles-fixture'
import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const text = (value: unknown): string => {
	if (Array.isArray(value)) return value.map(text).join('')
	if (typeof value === 'string' || typeof value === 'number')
		return String(value)
	if (value && typeof value === 'object' && 'children' in value)
		return text((value as ControlNode).children)
	return ''
}
const byLabel = (tree: unknown, label: string) => {
	const found = controlNodes(tree).find(
		(node) =>
			node.props.accessibilityLabel === label ||
			(typeof node.props.onPress === 'function' && text(node) === label),
	)
	assert.ok(found, label)
	return found
}
const press = (tree: unknown, label: string) =>
	(byLabel(tree, label).props.onPress as () => void)()
const noop = () => {}
const source: Source = {
	id: `bilibili:${subtitleTarget.bvid}:${subtitleTarget.cid}`,
	bvid: subtitleTarget.bvid,
	cid: subtitleTarget.cid,
	originalTitle: '测试讲解',
	uploader: '测试 UP',
	uploaderId: 88,
	performer: null,
	artwork: '',
	duration: 100,
	domain: 'unclassified',
	audioAvailability: 'unknown',
}
const nextSource: Source = {
	...source,
	id: `bilibili:${subtitleTarget.bvid}:456`,
	cid: 456,
}

void test('actual subtitle controls require an explicit language and reflect real position, overlaps and gaps; clicks only seek seconds', async () => {
	const data = subtitleFixture(),
		ui = controlFixture(),
		seeks: number[] = []
	await data.session.open(subtitleTarget)
	const Panel = ui.load('listening-subtitles-ui')
		.ListeningSubtitlesPanel as ControlNode['type']
	const render = (position = 4.5, switching = false) =>
		ui.render(
			ui.element(Panel, {
				session: data.session,
				position,
				switching,
				onSeek: (value: number) => seeks.push(value),
			}),
		)
	let tree = render()
	const choices = controlNodes(tree).filter(
		(node) => node.props.accessibilityRole === 'radio',
	)
	assert.equal(choices.length, 2)
	assert.ok(
		choices.every(
			(node) =>
				!(node.props.accessibilityState as { checked: boolean }).checked,
		),
	)
	assert.equal(data.bodies.length, 0)
	press(tree, '选择字幕 中文')
	await settleSubtitles()
	tree = render()
	let rows = controlNodes(tree).filter((node) =>
		String(node.props.testID).startsWith('listening-subtitle-line-'),
	)
	assert.equal(rows.length, 3)
	assert.deepEqual(
		rows.map(
			(node) =>
				(node.props.accessibilityState as { selected: boolean }).selected,
		),
		[false, true, true],
	)
	;(rows[1].props.onPress as () => void)()
	assert.deepEqual(seeks, [4])
	rows = controlNodes(render(3)).filter((node) =>
		String(node.props.testID).startsWith('listening-subtitle-line-'),
	)
	assert.ok(
		rows.every(
			(node) =>
				!(node.props.accessibilityState as { selected: boolean }).selected,
		),
	)
	assert.match(text(render(3)), /此刻没有字幕/)
	const disabled = controlNodes(render(4.5, true)).find(
		(node) => node.props.testID === 'listening-subtitle-line-1',
	)!
	assert.equal(disabled.props.disabled, true)
	;(disabled.props.onPress as () => void)()
	assert.deepEqual(seeks, [4])
	data.session.hide()
	;(rows[0].props.onPress as () => void)()
	assert.deepEqual(seeks, [4])
	data.session.dispose()
	ui.unmount()
})

void test('actual listening player lazily opens subtitle session, retains it on close, and revokes old row callbacks after P change', async () => {
	const data = subtitleFixture(),
		dependencies: Record<string, unknown> = {}
	let creations = 0
	dependencies['./listening-subtitles'] = {
		createListeningSubtitlesSession: () => {
			creations++
			return data.session
		},
	}
	const ui = controlFixture({}, dependencies),
		seeks: number[] = [],
		events: string[] = []
	const Player = ui.load('listening-ui').ListeningPlayer as ControlNode['type']
	const props = {
		source,
		parts: [
			{ source, page: 1, title: '第一 P' },
			{ source: nextSource, page: 2, title: '第二 P' },
		],
		partsLoading: false,
		partsError: '',
		position: 4.5,
		duration: 100,
		speed: 1,
		playing: false,
		buffering: false,
		switching: false,
		error: '',
		bottomInset: 0,
		reducedMotion: true,
		canReturnMusic: true,
		onClose: noop,
		onTheme: noop,
		onSource: noop,
		onCreator: noop,
		onSeek: (value: number) => seeks.push(value),
		onToggle: () => events.push('toggle'),
		onSpeed: noop,
		onPart: () => events.push('part'),
		onRetryParts: noop,
		onRetry: noop,
		onReturnMusic: () => events.push('music'),
		onCancel: noop,
	}
	const render = (current: Source = source) =>
		ui.render(ui.element(Player, { ...props, source: current }))
	let tree = render()
	assert.equal(creations, 0)
	assert.equal(data.api.length, 0)
	press(tree, '视频字幕')
	render()
	await settleSubtitles()
	tree = render()
	assert.equal(creations, 1)
	press(tree, '选择字幕 中文')
	await settleSubtitles()
	tree = render()
	const oldRow = byLabel(tree, '跳转字幕 00:04 第二句字幕')
	;(oldRow.props.onPress as () => void)()
	assert.deepEqual(seeks, [4])
	assert.deepEqual(events, [])
	press(tree, '关闭字幕面板')
	tree = render()
	;(oldRow.props.onPress as () => void)()
	assert.deepEqual(seeks, [4])
	press(tree, '视频字幕')
	tree = render()
	assert.equal(creations, 1)
	assert.equal(data.api.length, 2)
	assert.equal(data.bodies.length, 1)
	assert.ok(byLabel(tree, '跳转字幕 00:04 第二句字幕'))
	render(nextSource)
	await settleSubtitles()
	tree = render(nextSource)
	assert.equal(data.session.getSnapshot().target?.cid, 456)
	assert.equal(data.session.getSnapshot().status, 'choice')
	assert.doesNotMatch(text(tree), /第二句字幕/)
	;(oldRow.props.onPress as () => void)()
	assert.deepEqual(seeks, [4])
	press(tree, '选择字幕 English')
	await settleSubtitles()
	render(nextSource)
	assert.equal(data.session.getSnapshot().document?.target.cid, 456)
	ui.unmount()
	assert.equal(data.session.getSnapshot().document, null)
	assert.equal(data.accountListeners, 0)
})

void test('actual subtitle panel distinguishes no tracks, restrictions, pending reads, retry and offline gating without raw server messages', async () => {
	const data = subtitleFixture(),
		ui = controlFixture()
	const Panel = ui.load('listening-subtitles-ui')
		.ListeningSubtitlesPanel as ControlNode['type']
	const render = () =>
		ui.render(
			ui.element(Panel, {
				session: data.session,
				position: 0,
				switching: false,
				onSeek: () => assert.fail('must not seek'),
			}),
		)
	data.setMetadata((cid) => ({
		...subtitleMetadata(cid),
		subtitle: { subtitles: [] },
	}))
	await data.session.open(subtitleTarget)
	assert.match(text(render()), /当前分 P 没有字幕/)
	data.setMetadata(() => {
		throw new Error('private raw response')
	})
	data.setFailure('restricted')
	press(render(), '重试')
	await settleSubtitles()
	assert.match(text(render()), /限制了这段内容的字幕访问/)
	assert.doesNotMatch(text(render()), /private raw response|没有字幕/)
	data.setMetadata(subtitleMetadata)
	press(render(), '重试')
	await settleSubtitles()
	const pending = deferred<unknown>()
	data.setBody(() => pending.promise)
	press(render(), '选择字幕 中文')
	assert.match(text(render()), /正在读取字幕/)
	data.setAccount('offline')
	assert.match(text(render()), /离线模式/)
	pending.resolve(subtitlePayload)
	await settleSubtitles()
	assert.doesNotMatch(text(render()), /第一句字幕/)
	data.session.dispose()
	ui.unmount()
})

void test('all three builtin themes retain subtitle controls and apply their own highlight and surface tokens', async () => {
	const data = subtitleFixture()
	await data.session.open(subtitleTarget)
	await data.session.selectTrack('101')
	for (const theme of Object.values(builtInThemes)) {
		const ui = controlFixture()
		const Panel = ui.load('listening-subtitles-ui')
			.ListeningSubtitlesPanel as ControlNode['type']
		const Provider = ui.load('ui').ThemeProvider as ControlNode['type']
		const tree = ui.render(
			ui.element(
				Provider,
				{ value: theme },
				ui.element(Panel, {
					session: data.session,
					position: 4.5,
					switching: false,
					onSeek: noop,
				}),
			),
		)
		const rows = controlNodes(tree).filter(
			(node) =>
				node.type === 'Pressable' &&
				node.props.testID === 'listening-subtitle-line-1',
		)
		assert.equal(rows.length, 1)
		const row = rows[0]
		assert.equal(row.props.accessibilityLabel, '跳转字幕 00:04 第二句字幕')
		const rowStyle = ui.flatten(
			typeof row.props.style === 'function'
				? row.props.style({ pressed: false })
				: row.props.style,
		)
		assert.equal(rowStyle.backgroundColor, theme.tokens.surface.tinted)
		assert.ok(Number(rowStyle.minHeight) >= 64)
		const highlighted = controlNodes(row).find(
			(node) => node.type === 'Text' && text(node) === '第二句字幕',
		)!
		assert.equal(
			ui.flatten(highlighted.props.style).color,
			theme.tokens.action.primary,
		)
		assert.ok(byLabel(tree, '更换字幕语言'))
		ui.unmount()
	}
	data.session.dispose()
})
