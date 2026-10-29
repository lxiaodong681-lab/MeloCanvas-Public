import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { Library, migrate, type Database } from '../core/database'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import { PlaylistSession } from '../playlist-session'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const source = ts.createSourceFile(
	'App.tsx',
	readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TSX,
)
const effects: ts.CallExpression[] = []
let host: ts.JsxElement | undefined
function visit(node: ts.Node) {
	if (
		ts.isCallExpression(node) &&
		node.expression.getText(source) === 'useEffect' &&
		node.arguments[0].getText(source).includes('playlists.session.clearNotice')
	)
		effects.push(node)
	if (
		ts.isJsxSelfClosingElement(node) &&
		node.tagName.getText(source) === 'IconButton' &&
		node.attributes.getText(source).includes("label='关闭歌单操作提示'")
	) {
		let parent = node.parent
		while (
			!ts.isJsxElement(parent) ||
			parent.openingElement.tagName.getText(source) !== 'Card'
		)
			parent = parent.parent
		host = parent
	}
	ts.forEachChild(node, visit)
}
visit(source)
assert.ok(host)
let hostParent: ts.Node = host.parent
while (!ts.isJsxExpression(hostParent)) hostParent = hostParent.parent
assert.ok(hostParent.expression)
const hostExpression = hostParent.expression.getText(source)
const hostModule = `import React from 'react';
import {View} from 'react-native';import {Card,IconButton,T} from './ui';
export function NoticeHost({session,tab}) {
 const playlists={session,state:session.getSnapshot()};
 const s={row:{flexDirection:'row',alignItems:'center'}};
 return (${hostExpression});
}`

const item: Source = {
	id: sourceId('BV1vT411i7ET', 123),
	bvid: 'BV1vT411i7ET',
	cid: 123,
	originalTitle: '受控测试音源',
	uploader: '测试 UP',
	uploaderId: 8,
	performer: null,
	artwork: '',
	duration: 100,
	domain: 'music',
	audioAvailability: 'unknown',
}
function fixture() {
	const raw = new DatabaseSync(':memory:')
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
	migrate(db)
	const library = new Library(db),
		store = new PlaylistStore(db)
	store.create('p', '受控歌单')
	let sequence = 0
	const session = new PlaylistSession(store, library, () => `i-${++sequence}`)
	session.open('p')
	const append = () => {
		session.openAdd([item])
		session.toggleSource(item.id)
		session.setDuplicatePolicy('keep-all')
		assert.equal(session.appendSelected(), true)
		assert.equal(session.getSnapshot().notice, '已添加 1 项')
	}
	return { raw, db, session, append }
}

// Execute the actual App effects, replacing only React's effect scheduling and time.
function lifetime(session: PlaylistSession) {
	const tasks = new Map<number, { due: number; run: () => void }>()
	const slots: { deps: readonly unknown[]; cleanup?: () => void }[] = []
	let time = 0,
		sequence = 0,
		index = 0
	const scope = {
		playlists: { session, state: session.getSnapshot() },
		tab: 'search',
		filter: 'all',
		homeChannel: 'music',
		fullPlayer: false,
		importsVisible: false,
	}
	const exports: { render?: (value: typeof scope) => void } = {}
	runInNewContext(
		ts.transpileModule(
			`exports.render=(scope)=>{const {playlists,tab,filter,homeChannel,fullPlayer,importsVisible}=scope;${effects.map((effect) => effect.getText(source)).join(';')}}`,
			{ compilerOptions: { module: ts.ModuleKind.CommonJS } },
		).outputText,
		{
			exports,
			setTimeout: (run: () => void, delay: number) => {
				const id = ++sequence
				tasks.set(id, { due: time + delay, run })
				return id
			},
			clearTimeout: (id: number) => tasks.delete(id),
			useEffect: (
				setup: () => void | (() => void),
				deps: readonly unknown[],
			) => {
				const slot = index++,
					previous = slots[slot]
				if (
					previous &&
					previous.deps.length === deps.length &&
					previous.deps.every((value, i) => Object.is(value, deps[i]))
				)
					return
				previous?.cleanup?.()
				slots[slot] = { deps: [...deps], cleanup: setup() || undefined }
			},
		},
	)
	const render = (change: Partial<typeof scope> = {}) => {
		Object.assign(scope, change)
		scope.playlists = { session, state: session.getSnapshot() }
		index = 0
		exports.render!(scope)
	}
	return {
		render,
		advance(milliseconds: number) {
			time += milliseconds
			for (const [id, task] of tasks)
				if (task.due <= time) {
					tasks.delete(id)
					task.run()
				}
		},
		get pending() {
			return tasks.size
		},
		unmount() {
			for (const slot of slots) slot.cleanup?.()
		},
	}
}

function noticeHost(session: PlaylistSession, tab = 'search') {
	const f = controlFixture({ 'playlist-notice-host': hostModule })
	const ui = f.load('playlist-notice-host')
	return {
		render: () =>
			f.render(
				f.element(ui.NoticeHost as ControlNode['type'], { session, tab }),
			),
		unmount: () => f.unmount(),
	}
}

const flatten = (value: unknown): Record<string, unknown> =>
	Array.isArray(value)
		? Object.assign({}, ...value.map(flatten))
		: value && typeof value === 'object'
			? (value as Record<string, unknown>)
			: {}

void test('actual App success notice expires after 3.5 seconds without changing the playlist', () => {
	const f = fixture(),
		h = lifetime(f.session),
		ui = noticeHost(f.session)
	try {
		h.render()
		f.append()
		h.render()
		assert.equal(
			controlNodes(ui.render()).filter(
				(node) => node.props.accessibilityLabel === '关闭歌单操作提示',
			).length,
			1,
		)
		h.advance(3499)
		assert.equal(f.session.getSnapshot().notice, '已添加 1 项')
		h.advance(1)
		assert.equal(f.session.getSnapshot().notice, '')
		assert.equal(controlNodes(ui.render()).length, 0)
		assert.equal(f.session.getSnapshot().detail?.items.length, 1)
	} finally {
		h.unmount()
		ui.unmount()
		f.raw.close()
	}
})

void test('actual App route transitions clear old success instead of carrying it into search, home or listening', () => {
	const changes = [
		{ tab: 'home' },
		{ tab: 'library' },
		{ tab: 'profile' },
		{ filter: 'listening' },
		{ homeChannel: 'listening' },
		{ fullPlayer: true },
		{ importsVisible: true },
	]
	for (const change of changes) {
		const f = fixture(),
			h = lifetime(f.session)
		try {
			h.render()
			f.append()
			h.render()
			h.advance(100)
			h.render(change)
			assert.equal(f.session.getSnapshot().notice, '', JSON.stringify(change))
			assert.equal(f.session.getSnapshot().detail?.items.length, 1)
		} finally {
			h.unmount()
			f.raw.close()
		}
	}
})

void test('success expiry or navigation preserves a real SQL error and removal undo', () => {
	const f = fixture(),
		h = lifetime(f.session)
	try {
		h.render()
		f.append()
		f.session.setEditing(true)
		f.session.toggleItem(f.session.getSnapshot().detail!.items[0].itemId)
		assert.equal(f.session.removeSelected(), true)
		assert.equal(f.session.getSnapshot().undoAvailable, true)
		f.session.requestName('rename')
		f.session.setName('保留失败输入')
		f.db.execSync(
			"CREATE TRIGGER fail_name BEFORE UPDATE ON playlists BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
		)
		assert.equal(f.session.saveName(), false)
		assert.match(f.session.getSnapshot().error, /disk failure/)
		h.render()
		h.advance(3500)
		h.render({ tab: 'home' })
		assert.equal(f.session.getSnapshot().notice, '')
		assert.match(f.session.getSnapshot().error, /disk failure/)
		assert.equal(f.session.getSnapshot().nameForm?.value, '保留失败输入')
		assert.equal(f.session.getSnapshot().undoAvailable, true)
		f.db.execSync('DROP TRIGGER fail_name')
		assert.equal(f.session.undoRemove(), true)
		assert.equal(f.session.getSnapshot().detail?.items.length, 1)
	} finally {
		h.unmount()
		f.raw.close()
	}
})

void test('closing the actual success host keeps its accessible target and cancels the pending timer', () => {
	const f = fixture(),
		h = lifetime(f.session),
		ui = noticeHost(f.session)
	try {
		h.render()
		f.append()
		h.render()
		const close = controlNodes(ui.render()).find(
			(node) => node.props.accessibilityLabel === '关闭歌单操作提示',
		)!
		assert.ok(close)
		const style = flatten(
			typeof close.props.style === 'function'
				? (close.props.style as (state: { pressed: boolean }) => unknown)({
						pressed: false,
					})
				: close.props.style,
		)
		assert.ok(Number(style.minWidth) >= 48)
		assert.ok(Number(style.minHeight) >= 48)
		const nodes = controlNodes(ui.render())
		assert.equal(flatten(nodes[0].props.style).paddingVertical, 4)
		assert.ok(
			nodes.some((node) => node.props.accessibilityLiveRegion === 'polite'),
		)
		;(close.props.onPress as () => void)()
		h.render()
		assert.equal(f.session.getSnapshot().notice, '')
		assert.equal(h.pending, 0)
		f.append()
		h.render()
		assert.equal(h.pending, 1)
		h.unmount()
		assert.equal(h.pending, 0)
	} finally {
		ui.unmount()
		f.raw.close()
	}
})

void test('opening a new picker cancels the old timer and an identical subsequent success receives its full interval', () => {
	const f = fixture(),
		h = lifetime(f.session),
		ui = noticeHost(f.session)
	try {
		h.render()
		f.append()
		h.render()
		h.advance(3000)
		f.session.openAdd([item])
		h.render()
		assert.equal(h.pending, 0)
		assert.equal(controlNodes(ui.render()).length, 0)
		h.advance(10000)
		f.append()
		h.render()
		h.advance(3499)
		assert.equal(f.session.getSnapshot().notice, '已添加 1 项')
		h.advance(1)
		assert.equal(f.session.getSnapshot().notice, '')
		assert.equal(f.session.getSnapshot().detail?.items.length, 2)
	} finally {
		h.unmount()
		ui.unmount()
		f.raw.close()
	}
})
