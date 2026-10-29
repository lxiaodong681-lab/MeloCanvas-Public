import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const text = (value: unknown): string =>
	Array.isArray(value)
		? value.map(text).join('')
		: typeof value === 'string' || typeof value === 'number'
			? String(value)
			: value && typeof value === 'object' && 'children' in value
				? text((value as ControlNode).children)
				: ''
const settle = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve()
}
const tracks = ['current', 'next', 'later'].map((id) => ({
	id,
	title: id,
	url: 'orpheus://test',
}))
const button = (tree: unknown, label: string) =>
	controlNodes(tree).find((n) => n.type === 'Pressable' && (text(n) === label || n.props.accessibilityLabel === label))!
const press = (node: ControlNode) => (node.props.onPress as () => void)()
function fixture(
	refresh: (
		receiveFailure?: (cause: unknown) => void,
		owns?: () => boolean,
	) => Promise<unknown>,
) {
	const f = controlFixture(),
		Queue = f.load('music-queue-ui').MusicQueue as ControlNode['type']
	const calls = { remove: 0, move: 0, undo: 0, select: 0 }
	let failMutation = false
	const render = (switching = false) =>
		f.render(
			f.element(Queue, {
				tracks,
				currentEntryId: 'current',
				switching,
				onRefresh: refresh,
				onSelect: () => {
					calls.select++
				},
				onMoveNext: async () => {
					calls.move++
				},
				onRemove: async () => {
					calls.remove++
					if (failMutation)
						throw new Error('条目已移出队列，但状态暂时无法读取')
				},
				undo: { token: 'receipt', title: 'removed' },
				onUndo: async () => {
					calls.undo++
				},
			}),
		)
	return {
		f,
		render,
		calls,
		fail: () => {
			failMutation = true
		},
	}
}
void test('queue read failure exposes read-only retry, blocks stale actions and deduplicates pending retry', async () => {
	let reads = 0,
		finish!: (result: string) => void
	const q = fixture(async (receiveFailure) => {
		reads++
		if (reads === 1) {
			receiveFailure?.(new Error('offline'))
			return 'failed'
		}
		return new Promise<string>((resolve) => {
			finish = resolve
		})
	})
	let tree = q.render()
	const staleRemove = button(tree, '移出队列 · next')
	await settle()
	tree = q.render()
	assert.match(text(tree), /队列状态暂时无法读取/)
	for (const label of [
		'移出队列 · next',
		'撤销移除：removed',
	])
		assert.equal(button(tree, label).props.disabled, true)
	press(staleRemove)
	press(
		controlNodes(tree).find(
			(n) => n.props.accessibilityLabel === '队列第2项 next',
		)!,
	)
	const retry = button(tree, '重新读取队列')
	press(retry)
	press(retry)
	assert.equal(reads, 2)
	assert.equal(button(q.render(), '正在读取队列…').props.disabled, true)
	assert.deepEqual(q.calls, { remove: 0, move: 0, undo: 0, select: 0 })
	finish('applied')
	await settle()
	tree = q.render()
	assert.equal(button(tree, '重新读取队列'), undefined)
	assert.equal(button(tree, '移出队列 · next').props.disabled, false)
	press(button(tree, '移出队列 · next'))
	await settle()
	assert.equal(q.calls.remove, 1)
	q.f.unmount()
})
void test('committed mutation read failure is recovered without replay; superseded read stays blocked', async () => {
	let status = 'applied',
		reads = 0
	const q = fixture(async () => {
		reads++
		return status
	})
	q.render()
	await settle()
	q.fail()
	press(button(q.render(), '移出队列 · next'))
	await settle()
	assert.equal(q.calls.remove, 1)
	status = 'superseded'
	press(button(q.render(), '重新读取队列'))
	await settle()
	assert.match(text(q.render()), /播放状态已变化/)
	assert.equal(button(q.render(), '移出队列 · next').props.disabled, true)
	status = 'failed'
	press(button(q.render(), '重新读取队列'))
	await settle()
	assert.match(text(q.render()), /队列状态暂时无法读取/)
	status = 'applied'
	press(button(q.render(), '重新读取队列'))
	await settle()
	assert.equal(reads, 4)
	assert.deepEqual(q.calls, { remove: 1, move: 0, undo: 0, select: 0 })
	q.f.unmount()
})
void test('closing queue invalidates pending retry ownership and ignores late rejection', async () => {
	let reads = 0,
		reject!: (cause: Error) => void,
		owns!: () => boolean
	const q = fixture(async (_receiveFailure, isCurrent) => {
		reads++
		if (reads === 1) return 'failed'
		owns = isCurrent!
		return new Promise((_resolve, no) => {
			reject = no
		})
	})
	q.render()
	await settle()
	press(button(q.render(), '重新读取队列'))
	assert.equal(owns(), true)
	q.f.unmount()
	assert.equal(owns(), false)
	reject(new Error('late read failure'))
	await settle()
	assert.equal(q.f.writesAfterUnmount, 0)
	assert.deepEqual(q.calls, { remove: 0, move: 0, undo: 0, select: 0 })
})

void test('new playback intent invalidates a pending queue read, even when switching ends before it resolves', async () => {
	let reads = 0,
		finish!: (result: string) => void,
		owns!: () => boolean
	const q = fixture(async (_receiveFailure, isCurrent) => {
		reads++
		if (reads === 1) return 'failed'
		owns = isCurrent!
		return new Promise<string>((resolve) => {
			finish = resolve
		})
	})
	q.render()
	await settle()
	const retry = button(q.render(), '重新读取队列')
	press(retry)
	q.render(true)
	assert.equal(owns(), false)
	press(retry)
	assert.equal(reads, 2)
	q.render(false)
	assert.equal(owns(), false)
	finish('applied')
	await settle()
	assert.equal(button(q.render(), '移出队列 · next').props.disabled, true)
	assert.deepEqual(q.calls, { remove: 0, move: 0, undo: 0, select: 0 })
	q.f.unmount()
})

void test('old opening read cannot overwrite a newer committed-action failure', async () => {
	let reject!: (cause: Error) => void
	const q = fixture(
		() =>
			new Promise((_resolve, no) => {
				reject = no
			}),
	)
	q.render()
	q.fail()
	press(button(q.render(), '移出队列 · next'))
	await settle()
	assert.match(text(q.render()), /条目已移出队列/)
	reject(new Error('old opening failure'))
	await settle()
	assert.match(text(q.render()), /条目已移出队列/)
	q.f.unmount()
})
