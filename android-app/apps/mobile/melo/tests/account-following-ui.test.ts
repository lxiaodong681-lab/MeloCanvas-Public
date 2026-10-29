import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	AccountFollowingSession,
	parseAccountFollowings,
} from '../account-following-session'
import type { AccountSnapshot } from '../account-session'
import type { CreatorSubscription } from '../core/creators'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

void test('真实选择控件默认未选，选择→审核→确认才写本地，返回选择不写入', async () => {
	const subscriptions: CreatorSubscription[] = []
	const account: AccountSnapshot = {
		status: 'authenticated',
		generation: 1,
		account: { mid: '88', name: '合成账号' },
		error: null,
		reason: null,
	}
	const session = new AccountFollowingSession(
		{
			listSubscriptions: () => subscriptions,
			saveCreator: (creator) => creator,
			follow: (input) => {
				const subscription: CreatorSubscription = {
					...input,
					createdAt: 0,
					notifications: false,
				}
				subscriptions.push(subscription)
				return { subscription, created: true }
			},
		},
		{
			getSnapshot: () => account,
			getGeneration: () => 1,
			subscribe: () => () => {},
		},
		async () =>
			parseAccountFollowings(
				{
					list: [{ mid: 11, uname: '测试 UP', face: '', sign: '简介' }],
					total: 1,
				},
				1,
				0,
			),
	)
	const dependencies: Record<string, unknown> = {}
	const fixture = controlFixture({}, dependencies)
	dependencies['./creator-ui'] = fixture.load('creator-ui')
	const page = fixture.load('account-following-ui')
	let imported = 0
	const render = () =>
		fixture.render(
			fixture.element(page.AccountFollowingPage as ControlNode['type'], {
				state: session.getSnapshot(),
				session,
				onImported: () => {
					imported++
				},
			}),
		)
	const byId = (id: string) => {
		const node = controlNodes(render()).find((item) => item.props.testID === id)
		assert.ok(node, id)
		return node
	}
	const pressId = (id: string) => (byId(id).props.onPress as () => void)()
	try {
		await session.open()
		let checkbox = controlNodes(render()).find(
			(node) => node.props.accessibilityRole === 'checkbox',
		)!
		assert.equal(
			(checkbox.props.accessibilityState as { checked: boolean }).checked,
			false,
		)
		assert.equal(byId('review-account-following-import').props.disabled, true)
		assert.equal(subscriptions.length, 0)
		;(checkbox.props.onPress as () => void)()
		checkbox = controlNodes(render()).find(
			(node) => node.props.accessibilityRole === 'checkbox',
		)!
		assert.equal(
			(checkbox.props.accessibilityState as { checked: boolean }).checked,
			true,
		)
		pressId('review-account-following-import')
		assert.ok(byId('confirm-account-following-import'))
		assert.equal(subscriptions.length, 0)
		const back = controlNodes(render()).find(
			(node) => node.props.accessibilityLabel === '返回关注选择',
		)!
		;(back.props.onPress as () => void)()
		assert.equal(session.getSnapshot().review, null)
		assert.equal(subscriptions.length, 0)
		pressId('review-account-following-import')
		pressId('confirm-account-following-import')
		assert.equal(subscriptions.length, 1)
		assert.equal(subscriptions[0].origin, 'biliImport')
		assert.equal(imported, 1)
		checkbox = controlNodes(render()).find(
			(node) => node.props.accessibilityRole === 'checkbox',
		)!
		assert.equal(checkbox.props.disabled, true)
		assert.match(String(checkbox.props.accessibilityLabel), /已在音绘关注/)
	} finally {
		session.close()
		fixture.unmount()
	}
})
