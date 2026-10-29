import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { controlFixture, controlNodes, type ControlNode } from './theme-control-fixture'

const source = readFileSync(new URL('../player.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('player.ts', source, ts.ScriptTarget.Latest, true)
let cycle = ''
function visit(node: ts.Node) {
	if (ts.isFunctionDeclaration(node) && node.name?.text === 'cyclePlaybackOrder') cycle = node.getText(ast)
	ts.forEachChild(node, visit)
}
visit(ast)

void test('mode cycles call one native transaction with current occurrence and block duplicate pending clicks', async () => {
	for (const [before, after] of [['sequential', 'repeat-one'], ['repeat-one', 'shuffle'], ['shuffle', 'sequential']]) {
		const calls: unknown[] = [], busy: boolean[] = []
		let finish!: () => void
		const scope = {
			track: { id: 'same-song-second-occurrence' }, mode: 'music', fmContext: null, auditionId: null,
			switching: false, orderPending: { current: false }, alive: { current: true }, playbackOrder: before,
			setOrderBusy: (value: boolean) => busy.push(value),
			command: (action: () => Promise<void>) => action(),
			Orpheus: { setMusicPlaybackOrder: (...args: unknown[]) => { calls.push(args); return new Promise<void>(r => { finish = r }) } },
		}
		const action = runInNewContext(ts.transpileModule(cycle + '\ncyclePlaybackOrder', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, scope) as () => Promise<void>
		const pending = action(); await action()
		assert.deepEqual(calls, [[after, 'same-song-second-occurrence']])
		assert.deepEqual(busy, [true]); finish(); await pending
		assert.deepEqual(busy, [true, false])
		assert.equal(scope.orderPending.current, false)
	}
})

void test('transport exposes actual mode, invokes cycle and keeps 48dp target', () => {
	const f = controlFixture(), controls = f.load('host-controls')
	let calls = 0
	for (const [mode, label] of [['sequential', '顺序播放'], ['repeat-one', '单曲循环'], ['shuffle', '随机播放']]) {
		const tree = f.render(f.element(controls.MusicTransportControls as ControlNode['type'], {
			playbackOrder: mode, playing: false, previousDisabled: false, nextDisabled: false,
			onOrderInfo: () => calls++, onPrevious() {}, onNext() {}, onToggle() {}, onQueue() {},
		}))
		const button = controlNodes(tree).find(n => n.props.accessibilityLabel === `切换播放模式：${label}`)!
		assert.ok(button); (button.props.onPress as () => void)()
		const style = typeof button.props.style === 'function' ? button.props.style({ pressed: false }) : button.props.style
		assert.ok(Number(f.flatten(style).minHeight) >= 48)
	}
	assert.equal(calls, 3)
	f.unmount()
})
