import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ThemeControlRowPolicy } from '../core/theme-layout'
import type { ThemeControlRowStatus } from '../theme-control-layout'

import {
	controlFixture,
	controlNodes,
	measureControl,
	type ControlNode,
} from './theme-control-fixture'

type Receiver = (status: ThemeControlRowStatus) => void
function fixture() {
	const f = controlFixture(),
		row = f.load('theme-control-layout').MeasuredThemeControlRow
	const policy: ThemeControlRowPolicy = {
		minTouchDp: 72,
		narrowFallback: 'reject',
	}
	const widths = [48]
	return {
		f,
		policy,
		render(receiver?: Receiver, revision = 'A', activePolicy = policy) {
			return f.render(
				f.element(
					row as ControlNode['type'],
					{
						policy: activePolicy,
						controlMinWidthsDp: widths,
						layoutRevision: revision,
						onStatusChange: receiver,
					},
					f.element('Pressable', { accessibilityLabel: 'test control' }),
				),
			)
		},
	}
}
function layoutHandler(view: unknown) {
	const node = controlNodes(view).find(
		(item) => typeof item.props.onLayout === 'function',
	)
	assert.ok(node)
	return node.props.onLayout as (event: {
		nativeEvent: { layout: { width: number } }
	}) => void
}

void test('actual status receiver A→B→A gets the current ready/rejected state once per binding', () => {
	const f = fixture(),
		a: string[] = [],
		b: string[] = []
	const receiveA: Receiver = (status) => a.push(status.kind),
		receiveB: Receiver = (status) => b.push(status.kind)
	let view = f.render(receiveA)
	measureControl(view, 120)
	view = f.render(receiveA)
	assert.deepEqual(a, ['pending', 'ready'])
	f.render(receiveB)
	assert.deepEqual(
		b,
		['ready'],
		'a new receiver needs ready even when status did not change',
	)
	f.render(receiveA)
	f.render(receiveA)
	assert.deepEqual(a, ['pending', 'ready', 'ready'])
	measureControl(view, 40)
	f.render(receiveA)
	f.render(receiveB)
	f.render(receiveA)
	assert.deepEqual(a, ['pending', 'ready', 'ready', 'rejected', 'rejected'])
	assert.deepEqual(b, ['ready', 'rejected'])
})

void test('actual ready measured without a receiver reports when bound and after temporary removal', () => {
	const f = fixture(),
		reports: string[] = []
	const receive: Receiver = (status) => reports.push(status.kind)
	let view = f.render()
	measureControl(view, 120)
	view = f.render()
	assert.equal(
		controlNodes(view).some((node) => node.type === 'Pressable'),
		true,
	)
	f.render(receive)
	assert.deepEqual(reports, ['ready'])
	f.render()
	f.render(receive)
	f.render(receive)
	assert.deepEqual(reports, ['ready', 'ready'])
})

void test('actual new measurement token reports pending even with same receiver and serialized state', () => {
	const f = fixture(),
		reports: string[] = []
	const receive: Receiver = (status) => reports.push(status.kind)
	f.render(receive)
	f.render(receive, 'B')
	f.render(receive, 'A')
	const newPolicy = { ...f.policy }
	f.render(receive, 'A', newPolicy)
	f.f.viewport.fontScale = 2
	f.render(receive, 'A', newPolicy)
	f.render(receive, 'A', newPolicy)
	assert.deepEqual(reports, [
		'pending',
		'pending',
		'pending',
		'pending',
		'pending',
	])
})

void test('actual same receiver/token/state stays quiet; a changed fit still reports', () => {
	const f = fixture(),
		reports: string[] = []
	const receive: Receiver = (status) => reports.push(status.kind)
	let view = f.render(receive)
	f.render(receive)
	assert.deepEqual(reports, ['pending'])
	measureControl(view, 120)
	view = f.render(receive)
	f.render(receive)
	measureControl(view, 120)
	view = f.render(receive)
	assert.deepEqual(reports, ['pending', 'ready'])
	measureControl(view, 40)
	f.render(receive)
	f.render(receive)
	assert.deepEqual(reports, ['pending', 'ready', 'rejected'])
})

void test('actual old native events and unmount cannot publish a stale report or write state', () => {
	const f = fixture(),
		reports: string[] = []
	const receive: Receiver = (status) => reports.push(status.kind)
	let view = f.render(receive)
	const oldLayout = layoutHandler(view)
	measureControl(view, 120)
	f.render(receive)
	view = f.render(receive, 'B')
	const freshLayout = layoutHandler(view)
	const before = reports.length
	oldLayout({ nativeEvent: { layout: { width: 40 } } })
	view = f.render(receive, 'B')
	assert.equal(reports.length, before)
	assert.equal(
		controlNodes(view).some((node) => node.type === 'Pressable'),
		false,
	)
	measureControl(view, 120)
	f.render(receive, 'B')
	assert.deepEqual(reports, ['pending', 'ready', 'pending', 'ready'])
	f.f.unmount()
	freshLayout({ nativeEvent: { layout: { width: 40 } } })
	oldLayout({ nativeEvent: { layout: { width: 120 } } })
	assert.equal(f.f.writesAfterUnmount, 0)
	assert.deepEqual(reports, ['pending', 'ready', 'pending', 'ready'])
})
