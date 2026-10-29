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
const tracks = ['before', 'current', 'next', 'later'].map((id) => ({
	id,
	title: id,
	url: 'orpheus://test',
}))
const queueRows = (value: unknown) => controlNodes(value).filter(node =>
	node.type === 'Pressable' && String(node.props.accessibilityLabel).startsWith('队列第'))
void test('large queues render a bounded window and preserve absolute selection and removal identities', async () => {
	const window = { start: 0, count: 12 }
	const f = controlFixture({}, {}, window)
	const Queue = f.load('music-queue-ui').MusicQueue as ControlNode['type']
	const items = Array.from({ length: 2000 }, (_, index) => ({
		id: `entry-${index}`, title: `song-${index}`, url: 'orpheus://test',
	}))
	const selected: unknown[] = [], removed: string[] = []
	const render = () => f.render(f.element(Queue, {
		tracks: items, currentEntryId: items[0].id, switching: false,
		onRefresh: async () => {},
		onSelect: (index: number, id: string) => selected.push([index, id]),
		onRemove: async (id: string) => { removed.push(id) },
	}))
	let tree = render()
	assert.equal(queueRows(tree).length, 12)
	assert.equal(controlNodes(tree).find(node => node.type === 'FlatList')?.props.data, items)
	window.start = 1200
	tree = render()
	assert.equal(queueRows(tree).length, 12)
	;(queueRows(tree)[0].props.onPress as () => void)()
	const remove = controlNodes(tree).find(node => node.props.accessibilityLabel === '移出队列 · song-1200')!
	;(remove.props.onPress as () => void)()
	await settle()
	assert.deepEqual(selected, [[1200, 'entry-1200']])
	assert.deepEqual(removed, ['entry-1200'])
	f.unmount()
})
function nextButton(tree: unknown, id: string) {
	return controlNodes(tree).find(
		(n) => n.type === 'Pressable' && n.props.accessibilityLabel === `队列第${tracks.findIndex(t => t.id === id) + 1}项 ${id}` && !!n.props.onLongPress,
	)
}
void test('ordinary queue next action is separate from selecting playback and excludes current/already-next rows', async () => {
	const f = controlFixture(),
		Queue = f.load('music-queue-ui').MusicQueue as ControlNode['type']
	const moved: string[] = [],
		selected: number[] = []
	const render = () =>
		f.render(
			f.element(Queue, {
				tracks,
				currentEntryId: 'current',
				onRefresh: async () => {},
				switching: false,
				onSelect: (index: number) => selected.push(index),
				onMoveNext: async (id: string) => {
					moved.push(id)
				},
			}),
		)
	let tree = render()
	assert.equal(nextButton(tree, 'current'), undefined)
	assert.equal(nextButton(tree, 'next'), undefined)
	;(nextButton(tree, 'before')!.props.onLongPress as () => void)()
	await settle()
	tree = render()
	;(nextButton(tree, 'later')!.props.onLongPress as () => void)()
	await settle()
	assert.deepEqual(moved, ['before', 'later'])
	assert.deepEqual(selected, [])
	const current = controlNodes(render()).find(
		(n) => n.props.accessibilityLabel === '队列第2项 current',
	)!
	;(current.props.onPress as () => void)()
	assert.deepEqual(selected, [1])
	f.unmount()
})
void test('queue next action blocks repeated taps while pending and presents native rejection without claiming reorder', async () => {
	const f = controlFixture(),
		Queue = f.load('music-queue-ui').MusicQueue as ControlNode['type']
	let selected = 0
	let count = 0,
		reject!: (cause: Error) => void
	const pending = new Promise<void>((_yes, no) => {
		reject = no
	})
	const render = (switching = false) =>
		f.render(
			f.element(Queue, {
				tracks,
				currentEntryId: 'current',
				onRefresh: async () => {},
				switching,
				onSelect: () => {
					selected++
				},
				onMoveNext: () => {
					count++
					return pending
				},
			}),
		)
	let tree = render(true)
	assert.equal(nextButton(tree, 'before')!.props.disabled, true)
	tree = render()
	const press = nextButton(tree, 'before')!.props.onLongPress as () => void
	press()
	press()
	assert.equal(count, 1)
	const row = controlNodes(render()).find(
		(n) => n.props.accessibilityLabel === '队列第2项 current',
	)!
	;(row.props.onPress as () => void)()
	assert.equal(selected, 0)
	assert.equal(nextButton(render(), 'later')!.props.disabled, true)
	reject(new Error('队列已变化，请重试'))
	await settle()
	assert.match(text(render()), /队列已变化，请重试/)
	f.unmount()
	press()
	assert.equal(count, 1)
})
void test('queue hook binds current entry and ordered queue, rereads native after commit and distinguishes refresh failure', async () => {
	const source = readFileSync(new URL('../player.ts', import.meta.url), 'utf8'),
		tree = ts.createSourceFile(
			'player.ts',
			source,
			ts.ScriptTarget.Latest,
			true,
		)
	let code = ''
	function visit(node: ts.Node) {
		if (
			ts.isFunctionDeclaration(node) &&
			['moveMusicQueueEntryNext', 'mutateMusicQueue'].includes(
				node.name?.text ?? '',
			)
		)
			code += node.getText(tree) + '\n'
		ts.forEachChild(node, visit)
	}
	visit(tree)
	const calls: unknown[][] = []
	let fail = false
	const scope = {
		Error,
		track: tracks[1],
		queue: tracks,
		mode: 'music',
		queueIsSequential: true,
		fmContext: null as unknown,
		auditionId: null as string | null,
		switching: false,
		Orpheus: {
			moveMusicQueueEntryNext: async (...args: unknown[]) => {
				calls.push(args)
			},
		},
		sync: async (receive: (e: Error) => void) => {
			calls.push(['read'])
			if (fail) {
				receive(new Error('read failed'))
				return 'failed'
			}
			return 'applied'
		},
	}
	const action = runInNewContext(
		ts.transpileModule(code + ';moveMusicQueueEntryNext', {
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.None,
			},
		}).outputText,
		scope,
	) as (id: string) => Promise<void>
	await action('before')
	assert.deepEqual(calls, [
		['current', 'before', ['before', 'current', 'next', 'later']],
		['read'],
	])
	scope.fmContext = { id: 'fm' }
	await assert.rejects(action('before'), /当前不是可调整/)
	assert.equal(calls.length, 2)
	scope.fmContext = null
	scope.auditionId = 'temporary-candidate'
	await assert.rejects(action('before'), /当前不是可调整/)
	assert.equal(calls.length, 2)
	scope.auditionId = null
	fail = true
	await assert.rejects(action('later'), /队列已调整，但状态暂时无法读取/)
})

void test('queue removal targets only non-current occurrences and undo uses the native receipt after rerender', async () => {
	const f = controlFixture(),
		Queue = f.load('music-queue-ui').MusicQueue as ControlNode['type']
	const removed: string[] = [],
		undone: string[] = []
	const render = (
		remaining = tracks,
		undo: { token: string; title: string } | null = null,
	) =>
		f.render(
			f.element(Queue, {
				key: JSON.stringify(remaining.map((t) => t.id)),
				tracks: remaining,
				currentEntryId: 'current',
				onRefresh: async () => {},
				switching: false,
				onSelect: () => {},
				onMoveNext: async () => {},
				onRemove: async (id: string) => {
					removed.push(id)
				},
				undo,
				onUndo: async (token: string) => {
					undone.push(token)
				},
			}),
		)
	let tree = render()
	const action = (label: string) =>
		controlNodes(tree).find((n) => n.type === 'Pressable' && (text(n) === label || n.props.accessibilityLabel === label))
	assert.equal(action('移出队列 · current'), undefined)
	;(action('移出队列 · next')!.props.onPress as () => void)()
	await settle()
	assert.deepEqual(removed, ['next'])
	tree = render(
		tracks.filter((t) => t.id !== 'next'),
		{ token: 'native-receipt', title: 'next' },
	)
	assert.equal(action('移出队列 · next'), undefined)
	;(action('撤销移除：next')!.props.onPress as () => void)()
	await settle()
	assert.deepEqual(undone, ['native-receipt'])
	tree = render(tracks.filter((t) => t.id !== 'next'))
	assert.equal(action('撤销移除：next'), undefined)
	f.unmount()
})

void test('remove and undo hooks bind occurrence identity and native token, and distinguish rejected from committed actions', async () => {
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
			[
				'mutateMusicQueue',
				'removeMusicQueueEntry',
				'undoMusicQueueRemoval',
			].includes(node.name?.text ?? '')
		)
			code += node.getText(tree) + '\n'
		ts.forEachChild(node, visit)
	}
	visit(tree)
	const calls: unknown[][] = []
	let nativeFails = false,
		refreshFails = false
	const scope = {
		Error,
		track: { id: 'occurrence:local' },
		queue: [{ id: 'occurrence:local' }, { id: 'occurrence:remote' }],
		mode: 'music',
		queueIsSequential: true,
		fmContext: null as unknown,
		auditionId: null as string | null,
		switching: false,
		Orpheus: {
			removeMusicQueueEntry: async (...args: unknown[]) => {
				calls.push(['remove', ...args])
				if (nativeFails) throw new Error('stale queue')
			},
			undoMusicQueueRemoval: async (...args: unknown[]) => {
				calls.push(['undo', ...args])
				if (nativeFails) throw new Error('expired token')
			},
		},
		sync: async (receive: (e: Error) => void) => {
			calls.push(['read'])
			if (refreshFails) {
				receive(new Error('read failed'))
				return 'failed'
			}
			return 'applied'
		},
	}
	const actions = runInNewContext(
		ts.transpileModule(
			code +
				';({ remove: removeMusicQueueEntry, undo: undoMusicQueueRemoval })',
			{
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					module: ts.ModuleKind.None,
				},
			},
		).outputText,
		scope,
	) as {
		remove: (id: string) => Promise<void>
		undo: (token: string) => Promise<void>
	}
	await actions.remove('occurrence:remote')
	await actions.undo('native-only-token')
	assert.deepEqual(calls, [
		[
			'remove',
			'occurrence:local',
			'occurrence:remote',
			['occurrence:local', 'occurrence:remote'],
		],
		['read'],
		['undo', 'native-only-token'],
		['read'],
	])
	for (const blocked of [
		{ mode: 'listening' },
		{ fmContext: { id: 'fm' } },
		{ auditionId: 'temporary-candidate' },
		{ switching: true },
	]) {
		Object.assign(
			scope,
			{
				mode: 'music',
				fmContext: null,
				auditionId: null,
				switching: false,
				queueIsSequential: true,
			},
			blocked,
		)
		await assert.rejects(actions.remove('occurrence:remote'), /当前不是可调整/)
		await assert.rejects(actions.undo('native-only-token'), /当前不是可调整/)
	}
	assert.equal(calls.length, 4)
	Object.assign(scope, {
		mode: 'music',
		fmContext: null,
		auditionId: null,
		switching: false,
		queueIsSequential: true,
	})
	nativeFails = true
	await assert.rejects(actions.remove('occurrence:remote'), /队列调整失败/)
	await assert.rejects(actions.undo('native-only-token'), /队列调整失败/)
	assert.equal(calls.filter((call) => call[0] === 'read').length, 2)
	nativeFails = false
	refreshFails = true
	await assert.rejects(
		actions.remove('occurrence:remote'),
		/条目已移出队列，但状态暂时无法读取/,
	)
	await assert.rejects(
		actions.undo('native-only-token'),
		/移除已撤销，但状态暂时无法读取/,
	)
})

void test('removal and undo share the pending guard, refresh on open, and ignore callbacks after close', async () => {
	const f = controlFixture(),
		Queue = f.load('music-queue-ui').MusicQueue as ControlNode['type']
	let removed = 0,
		undone = 0,
		refreshed = 0,
		reject!: (cause: Error) => void
	const pending = new Promise<void>((_yes, no) => {
		reject = no
	})
	const refresh = async () => {
		refreshed++
	}
	const render = () =>
		f.render(
			f.element(Queue, {
				tracks,
				currentEntryId: 'current',
				switching: false,
				onRefresh: refresh,
				onSelect: () => {},
				onMoveNext: async () => {},
				onRemove: () => {
					removed++
					return pending
				},
				undo: { token: 'receipt', title: 'previous' },
				onUndo: async () => {
					undone++
				},
			}),
		)
	const button = (label: string) =>
		controlNodes(render()).find(
			(n) => n.type === 'Pressable' && (text(n) === label || n.props.accessibilityLabel === label),
		)!
	const remove = button('移出队列 · next').props.onPress as () => void
	const undo = button('撤销移除：previous').props.onPress as () => void
	assert.equal(refreshed, 1)
	remove()
	remove()
	undo()
	assert.equal(removed, 1)
	assert.equal(undone, 0)
	assert.equal(button('撤销移除：previous').props.disabled, true)
	reject(new Error('原生队列已变化'))
	await settle()
	assert.match(text(render()), /原生队列已变化/)
	f.unmount()
	remove()
	undo()
	assert.equal(removed, 1)
	assert.equal(undone, 0)
})

void test('transport hook passes direction rather than its stale rendered current index', () => {
	const source = readFileSync(new URL('../player.ts', import.meta.url), 'utf8')
	const tree = ts.createSourceFile(
		'player.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
	)
	const callbacks = new Map<string, string>()
	function visit(node: ts.Node) {
		if (
			ts.isPropertyAssignment(node) &&
			['next', 'previous'].includes(node.name.getText(tree))
		)
			callbacks.set(node.name.getText(tree), node.initializer.getText(tree))
		ts.forEachChild(node, visit)
	}
	visit(tree)
	const calls: unknown[] = []
	for (const direction of ['next', 'previous']) {
		const action = runInNewContext(callbacks.get(direction)!, {
			currentIndex: 1,
			mode: 'listening',
			select: (target: unknown) => calls.push(target),
		}) as () => void
		action()
	}
	assert.deepEqual(calls, ['next', 'previous'])
})
