import assert from 'node:assert/strict'
import { test } from 'node:test'
import { biliState, importHost, importState, task, mixedTask, press, settle, text } from './theme-import-fixture'
import { controlNodes } from './theme-control-fixture'

void test('Bili task hub separates entries and history, preserves return context, and clears its hardware-back handler', () => {
	const h = importHost()
	const directory = mixedTask()
	const backRef = { current: null as (() => boolean) | null }
	const render = (route: 'task' | 'entry' = 'task') => {
		const page = h.page('BilibiliImportPage', biliState({ route, task: directory, entryId: route === 'entry' ? 'e0' : null }))
		page.props.backRef = backRef
		return settle(h, page, 320)
	}
	try {
		let tree = render()
		assert.doesNotMatch(text(tree), /查看原条目并人工核对|暂无导入历史/)
		press(tree, '调整导入条目')
		tree = render()
		assert.ok(controlNodes(tree).some(n => n.props.accessibilityRole === 'checkbox'))
		assert.doesNotMatch(text(tree), /导入歌单|本机处理历史/)
		render('entry')
		assert.equal(backRef.current?.(), false)
		tree = render()
		assert.ok(controlNodes(tree).some(n => n.props.accessibilityRole === 'checkbox'))
		assert.equal(backRef.current?.(), true)
		tree = render()
		press(tree, '导入历史')
		tree = render()
		assert.match(text(tree), /暂无导入历史/)
		assert.equal(controlNodes(tree).some(n => n.props.accessibilityRole === 'checkbox'), false)
		press(tree, '返回B站导入上一步')
		tree = render()
		assert.equal(backRef.current?.(), false)
		press(tree, '导入歌单')
		assert.deepEqual(h.calls.filter(c => c[0] === 'importCurrentTask'), [['importCurrentTask']])
	} finally {
		h.unmount()
		assert.equal(backRef.current, null)
	}
})

void test('import hub keeps history in a virtualized child page and returns to it after viewing a saved task', () => {
	const h = importHost()
	const record = task()
	const render = (route: 'home' | 'task' = 'home') => settle(h, h.page('ImportPage', importState({ route, tasks: [record], task: route === 'task' ? record : null })))
	try {
		let tree = render()
		assert.equal(controlNodes(tree).some(n => n.type === 'FlatList'), false)
		press(tree, '导入记录')
		tree = render()
		assert.ok(controlNodes(tree).some(n => n.type === 'FlatList'))
		press(tree, '网易云歌单，3 首')
		assert.deepEqual(h.calls.at(-1), ['openTask', record.taskId])
		tree = render('task')
		assert.equal(controlNodes(tree).some(n => n.type === 'FlatList'), false)
		tree = render()
		assert.ok(controlNodes(tree).some(n => n.type === 'FlatList'))
		press(tree, '返回导入记录的上一级')
		assert.equal(controlNodes(render()).some(n => n.type === 'FlatList'), false)
	} finally { h.unmount() }
})
