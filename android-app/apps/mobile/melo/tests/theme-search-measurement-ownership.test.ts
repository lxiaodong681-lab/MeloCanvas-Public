import assert from 'node:assert/strict'
import { test } from 'node:test'

import { packageTheme } from './theme-import-fixture'
import { searchHost, native, measure } from './theme-search-fixture'

function ready() {
	const f = searchHost(),
		calls: unknown[][] = []
	const element = f.pack(
		f.query({
			query: '草稿',
			placeholder: '关键词',
			onQueryChange: (value: string) => calls.push(['change', value]),
			onSubmit: (...args: unknown[]) => calls.push(['submit', ...args]),
		}),
		packageTheme(),
	)
	const render = () => f.render(element)
	let tree = render()
	measure(native(tree, 'search-query-width'), 211)
	tree = render()
	measure(native(tree, 'search-query-input-width'), 96)
	measure(native(tree, 'search-query-submit-width'), 96)
	tree = render()
	assert.equal(native(tree, 'search-input').props.editable, true)
	return { f, calls, tree, render }
}
function submit(tree: unknown) {
	;(native(tree, '提交搜索').props.onPress as () => void)()
	;(
		native(tree, 'search-input').props.onSubmitEditing as (
			event: unknown,
		) => void
	)({ nativeEvent: { text: 'IME文本' } })
}
function assertSubmitted(calls: unknown[][]) {
	assert.deepEqual(calls, [
		['submit'],
		['change', 'IME文本'],
		['submit', 'IME文本'],
	])
}

void test('parent actual width changes revoke submission before React commit, even when the next strategy still fits', () => {
	for (const width of [124, 163]) {
		const h = ready()
		measure(native(h.tree, 'search-query-width'), width)
		submit(h.tree)
		assert.deepEqual(h.calls, [])
		const next = h.render()
		assert.equal(native(next, 'search-input').props.editable, false)
		if (width === 163) {
			measure(native(next, 'search-query-input-width'), 72)
			measure(native(next, 'search-query-submit-width'), 72)
			submit(h.render())
			assertSubmitted(h.calls)
		}
	}
})

void test('an undersized current input or submit slot revokes both IME and button synchronously', () => {
	for (const slot of ['input', 'submit']) {
		const h = ready()
		measure(native(h.tree, `search-query-${slot}-width`), 40)
		submit(h.tree)
		assert.deepEqual(h.calls, [])
		assert.equal(native(h.render(), 'search-input').props.editable, false)
	}
})

void test('equal parent and still-fitting slot reports cannot strand ready controls disabled', () => {
	const h = ready()
	measure(native(h.tree, 'search-query-width'), 211)
	measure(native(h.tree, 'search-query-input-width'), 96)
	measure(native(h.tree, 'search-query-submit-width'), 96)
	submit(h.tree)
	assertSubmitted(h.calls)
	h.calls.length = 0
	submit(h.render())
	assertSubmitted(h.calls)
})

void test('invalid then valid slot in one native batch stays blocked until commit and recovers although final ready is unchanged', () => {
	const h = ready(),
		slot = native(h.tree, 'search-query-submit-width')
	measure(slot, 40)
	measure(slot, 96)
	submit(h.tree)
	assert.deepEqual(h.calls, [])
	const next = h.render()
	assert.equal(native(next, 'search-input').props.editable, true)
	submit(next)
	assertSubmitted(h.calls)
})

void test('separate invalid and recovery commits re-enable only after both owned slot values fit', () => {
	const h = ready()
	measure(native(h.tree, 'search-query-input-width'), 40)
	let tree = h.render()
	assert.equal(native(tree, 'search-input').props.editable, false)
	measure(native(tree, 'search-query-input-width'), 96)
	submit(tree)
	assert.deepEqual(h.calls, [])
	tree = h.render()
	submit(tree)
	assertSubmitted(h.calls)
})

void test('old-round invalid parent and slot callbacks cannot revoke a newer ready round', () => {
	const h = ready(),
		old = h.tree
	measure(native(old, 'search-query-width'), 163)
	let next = h.render()
	measure(native(next, 'search-query-input-width'), 72)
	measure(native(next, 'search-query-submit-width'), 72)
	next = h.render()
	measure(native(old, 'search-query-width'), 1)
	measure(native(old, 'search-query-input-width'), 1)
	measure(native(old, 'search-query-submit-width'), 1)
	submit(next)
	assertSubmitted(h.calls)
	h.calls.length = 0
	submit(h.render())
	assertSubmitted(h.calls)
})

void test('known invalid layout still forwards the queued native change draft without submitting', () => {
	const h = ready()
	measure(native(h.tree, 'search-query-width'), 124)
	;(
		native(h.tree, 'search-input').props.onChangeText as (value: string) => void
	)('末尾草稿')
	submit(h.tree)
	assert.deepEqual(h.calls, [['change', '末尾草稿']])
})

void test('batched parent width ABA requires new marker and slot evidence and never revives old handlers', () => {
	const h = ready(),
		old = h.tree
	const oldParent = native(old, 'search-query-width')
	measure(oldParent, 163)
	measure(oldParent, 211)
	submit(old)
	assert.deepEqual(h.calls, [])
	let tree = h.render()
	assert.notEqual(native(tree, 'search-query-width').key, oldParent.key)
	assert.equal(native(tree, 'search-input').props.editable, false)
	measure(native(old, 'search-query-input-width'), 96)
	measure(native(old, 'search-query-submit-width'), 96)
	tree = h.render()
	assert.equal(native(tree, 'search-input').props.editable, false)
	measure(native(tree, 'search-query-input-width'), 96)
	tree = h.render()
	assert.equal(native(tree, 'search-input').props.editable, false)
	measure(native(tree, 'search-query-submit-width'), 96)
	tree = h.render()
	assert.equal(native(tree, 'search-input').props.editable, true)
	submit(old)
	assert.deepEqual(h.calls, [])
	submit(tree)
	assertSubmitted(h.calls)
})
