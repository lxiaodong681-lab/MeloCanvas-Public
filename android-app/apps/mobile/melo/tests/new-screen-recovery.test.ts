import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import * as offline from '../offline-state'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'
const text = (v: unknown): string =>
	Array.isArray(v)
		? v.map(text).join('')
		: typeof v === 'string'
			? v
			: v && typeof v === 'object' && 'children' in v
				? text(v.children)
				: ''
void test('offline first read failure exits spinner, keeps diagnostics collapsed and permits recovery', async (t) => {
	let fail = true
	const f = controlFixture(
		process.env.MELO_BASELINE_OFFLINE
			? {
					'offline-ui': readFileSync(process.env.MELO_BASELINE_OFFLINE, 'utf8'),
				}
			: {},
		{
			'./offline-state': offline,
			'@bbplayer/orpheus': {
				Orpheus: {
					getDownloads: async () => {
						if (fail) throw new Error('Synthetic ENOSPC diagnostic')
						return []
					},
					getOfflineStorage: async () => ({
						usedBytes: 0,
						freeBytes: 99999,
						limitBytes: 1024 ** 3,
					}),
				},
			},
		},
	)
	t.after(() => f.unmount())
	const module = f.load('offline-ui')
	const root = f.element(module.OfflineManager as ControlNode['type'], {
		visible: true,
		onClose: () => {},
		track: null,
		onPlay: async () => {},
		bottomInset: 24,
	})
	const render = () => f.render(root)
	render()
	await new Promise((resolve) => setImmediate(resolve))
	let tree = render()
	assert.ok(!text(tree).includes('正在读取离线内容'))
	assert.ok(text(tree).includes('离线内容暂时无法读取'))
	assert.ok(!text(tree).includes('Synthetic ENOSPC'))
	assert.ok(!text(tree).includes('还没有离线保存'))
	const press = (label: string) => {
		const button = controlNodes(render()).find(
			(n) => n.type === 'Pressable' && text(n.children) === label,
		)
		assert.ok(button, label)
		;(button.props.onPress as () => void)()
	}
	press('查看错误详情')
	assert.ok(text(render()).includes('Synthetic ENOSPC'))
	root.props.visible = false
	render()
	root.props.visible = true
	render()
	await new Promise((resolve) => setImmediate(resolve))
	assert.ok(!text(render()).includes('Synthetic ENOSPC'))
	assert.ok(text(render()).includes('查看错误详情'))
	fail = false
	press('重新读取')
	await new Promise((resolve) => setImmediate(resolve))
	tree = render()
	assert.ok(text(tree).includes('还没有离线保存'))
	assert.ok(!text(tree).includes('离线内容暂时无法读取'))
	const keyboard = controlNodes(tree).find(
		(n) => n.type === 'KeyboardAvoidingView',
	)
	assert.equal(keyboard?.props.behavior, 'height')
	f.unmount()
})
