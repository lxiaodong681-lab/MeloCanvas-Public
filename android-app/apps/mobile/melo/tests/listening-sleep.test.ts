import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'
const text = (v: unknown): string =>
	Array.isArray(v)
		? v.map(text).join('')
		: typeof v === 'string' || typeof v === 'number'
			? String(v)
			: v && typeof v === 'object' && 'children' in v
				? text((v as ControlNode).children)
				: ''
const settle = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve()
}
function button(tree: unknown, label: string) {
	return controlNodes(tree).find(
		(n) => n.type === 'Pressable' && text(n) === label,
	)!
}
void test('sleep panel sends native presets with exact source identity and explicit off', async () => {
	const f = controlFixture(),
		Panel = f.load('listening-sleep-ui')
			.ListeningSleepTimerPanel as ControlNode['type']
	const calls: unknown[][] = []
	const render = () =>
		f.render(
			f.element(Panel, {
				sourceId: 'BV1:123',
				onRefresh: async () => {},
				timer: { mode: 'part', bvid: 'BV1' },
				switching: false,
				onSet: async (...args: unknown[]) => {
					calls.push(args)
				},
			}),
		)
	for (const [label, mode, ms] of [
		['15 分钟后暂停', 'duration', 900000],
		['30 分钟后暂停', 'duration', 1800000],
		['60 分钟后暂停', 'duration', 3600000],
		['播完当前 P 暂停', 'part', undefined],
		['关闭定时', 'off', undefined],
	]) {
		const tree = render()
		;(button(tree, String(label)).props.onPress as () => void)()
		await settle()
		assert.deepEqual(calls.at(-1), ['BV1:123', mode, ms])
	}
	f.unmount()
})
void test('sleep panel shows native remaining time and surfaces failures for retry', async () => {
	const f = controlFixture(),
		Panel = f.load('listening-sleep-ui')
			.ListeningSleepTimerPanel as ControlNode['type']
	let fail = true
	const render = () =>
		f.render(
			f.element(Panel, {
				sourceId: 'BV1:123',
				onRefresh: async () => {},
				timer: { mode: 'duration', bvid: 'BV1', remainingMs: 61000 },
				switching: false,
				onSet: async () => {
					if (fail) throw new Error('native unavailable')
				},
			}),
		)
	let tree = render()
	assert.match(text(tree), /约 2 分钟后暂停/)
	;(button(tree, '15 分钟后暂停').props.onPress as () => void)()
	await settle()
	tree = render()
	assert.match(text(tree), /native unavailable/)
	fail = false
	;(button(tree, '15 分钟后暂停').props.onPress as () => void)()
	await settle()
	assert.doesNotMatch(text(render()), /native unavailable/)
	f.unmount()
})
void test('pending and switching timer controls cannot dispatch duplicate commands', async () => {
	const f = controlFixture(),
		Panel = f.load('listening-sleep-ui')
			.ListeningSleepTimerPanel as ControlNode['type']
	let count = 0,
		resolve!: () => void
	const pending = new Promise<void>((yes) => {
		resolve = yes
	})
	const render = (switching = false) =>
		f.render(
			f.element(Panel, {
				sourceId: 'BV1:123',
				onRefresh: async () => {},
				timer: null,
				switching,
				onSet: () => {
					count++
					return pending
				},
			}),
		)
	let tree = render(true)
	assert.equal(button(tree, '15 分钟后暂停').props.disabled, true)
	tree = render()
	const press = button(tree, '15 分钟后暂停').props.onPress as () => void
	press()
	press()
	assert.equal(count, 1)
	tree = render()
	assert.equal(button(tree, '关闭定时').props.disabled, true)
	resolve()
	await settle()
	f.unmount()
	press()
	assert.equal(count, 1)
})

void test('timer hook reads current snapshot after native commit and reports refresh failure honestly', async () => {
	const source = readFileSync(new URL('../player.ts', import.meta.url), 'utf8')
	const tree = ts.createSourceFile(
		'player.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
	)
	let code = ''
	function visit(node: ts.Node) {
		if (
			ts.isFunctionDeclaration(node) &&
			node.name?.text === 'setListeningSleepTimer'
		)
			code = node.getText(tree)
		ts.forEachChild(node, visit)
	}
	visit(tree)
	const calls: unknown[][] = []
	let fail = false
	const action = runInNewContext(
		ts.transpileModule(code + ';setListeningSleepTimer', {
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.None,
			},
		}).outputText,
		{
			Error,
			Orpheus: {
				setListeningSleepTimer: async (...args: unknown[]) => {
					calls.push(args)
					return { sleepTimer: 'stale result' }
				},
			},
			sync: async (receive: (e: Error) => void) => {
				calls.push(['read current'])
				if (fail) {
					receive(new Error('bridge read'))
					return 'failed'
				}
				return 'applied'
			},
		},
	) as (sourceId: string, mode: string, durationMs?: number) => Promise<void>
	await action('BV1:123', 'duration', 900000)
	assert.deepEqual(calls, [['BV1:123', 'duration', 900000], ['read current']])
	fail = true
	await assert.rejects(
		action('BV1:123', 'off'),
		/定时已设置，但状态暂时无法读取/,
	)
})
