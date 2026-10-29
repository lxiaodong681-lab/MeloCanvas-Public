import assert from 'node:assert/strict'
import test from 'node:test'

import { builtInThemes } from '../core/theme'
import { cosmosTheme } from '../core/theme-appearance'
import { controlFixture, controlNodes, type ControlNode } from './theme-control-fixture'

function button(tree: unknown, label: string) {
	const node = controlNodes(tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === label)
	assert.ok(node, label)
	return node.props.onPress as () => void
}

void test('logout always requires a modal confirmation, cancellation is harmless and confirmation runs once', () => {
	for (const theme of [...Object.values(builtInThemes), cosmosTheme]) {
		const f = controlFixture()
		let signedOut = 0
		const root = f.element(f.load('ui').ThemeProvider as ControlNode['type'], { value: theme },
			f.element(f.load('account-settings-ui').AccountSignOut as ControlNode['type'], { onSignOut: () => signedOut++ }))
		const draw = () => f.render(root)
		for (const exit of ['取消', 'back', '退出账号', '取消']) {
			const before = signedOut
			assert.ok(!controlNodes(draw()).some(n => n.type === 'Modal'))
			button(draw(), '退出 B 站账号')()
			const tree = draw()
			const modal = controlNodes(tree).find(n => n.type === 'Modal')!
			assert.ok(modal)
			assert.equal(signedOut, before)
			if (exit === 'back') (modal.props.onRequestClose as () => void)()
			else {
				const press = button(modal, exit)
				press(); press()
			}
			assert.equal(signedOut, before + (exit === '退出账号' ? 1 : 0))
			assert.ok(!controlNodes(draw()).some(n => n.type === 'Modal'))
		}
		f.unmount()
		assert.equal(f.writesAfterUnmount, 0)
	}
})
