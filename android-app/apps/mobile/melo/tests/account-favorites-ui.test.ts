import assert from 'node:assert/strict'
import { test } from 'node:test'

import { controlNodes } from './theme-control-fixture'
import { biliState, importHost, text } from './theme-import-fixture'

void test('现有收藏夹页面显示本人入口，只有显式点击读取；公开mid入口和读取状态保留', () => {
	const host = importHost()
	try {
		let tree = host.render(
			host.page(
				'BilibiliImportPage',
				biliState({ mineAvailable: true, mid: '55' }),
			),
		)
		assert.deepEqual(host.calls, [])
		const mine = controlNodes(tree).find(
			(node) => node.props.testID === 'read-my-bilibili-favorites',
		)!
		assert.ok(mine)
		assert.equal(mine.props.disabled, false)
		;(mine.props.onPress as () => void)()
		assert.deepEqual(host.calls, [['keyboard'], ['readMyFolders']])
		tree = host.render(
			host.page(
				'BilibiliImportPage',
				biliState({
					mineAvailable: true,
					folderAccess: 'account',
					folderAccount: { mid: '88', name: '合成账号', generation: 1 },
					mid: '55',
				}),
			),
		)
		assert.match(text(tree), /合成账号/)
		assert.match(text(tree), /不会修改 B 站收藏/)
		assert.equal(
			controlNodes(tree).some(
				(node) => node.props.accessibilityLabel === 'B站收藏夹所属UP的mid',
			),
			false,
		)
		const publicMode = controlNodes(tree).find(
			(node) => node.props.testID === 'show-public-bilibili-favorites',
		)!
		;(publicMode.props.onPress as () => void)()
		assert.deepEqual(host.calls.at(-1), ['usePublicFolders'])
		tree = host.render(
			host.page(
				'BilibiliImportPage',
				biliState({ mineAvailable: true, mid: '55', busy: true }),
			),
		)
		assert.equal(
			controlNodes(tree).find(
				(node) => node.props.testID === 'read-my-bilibili-favorites',
			)!.props.disabled,
			true,
		)
		const field = controlNodes(tree).find(
			(node) => node.props.accessibilityLabel === 'B站收藏夹所属UP的mid',
		)!
		assert.equal(field.props.value, '55')
		assert.equal(field.props.editable, false)
	} finally {
		host.unmount()
	}
})
