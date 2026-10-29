import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

/** Run actual App hardware navigation and the actual page header callbacks. */
function fixture(route: string) {
	const app = ts.createSourceFile(
		'App.tsx',
		readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	const page = ts.createSourceFile(
		'bilibili-import-ui.tsx',
		readFileSync(new URL('../bilibili-import-ui.tsx', import.meta.url), 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	let hub = '',
		hardware = '',
		header = '',
		close = ''
	function visitApp(node: ts.Node) {
		if (ts.isFunctionDeclaration(node) && node.name?.text === 'openImportHub')
			hub = node.getText(app)
		if (
			ts.isVariableDeclaration(node) &&
			node.name.getText(app) === 'openImportHub' &&
			node.initializer &&
			ts.isCallExpression(node.initializer)
		)
			hub = `const openImportHub = ${node.initializer.arguments[0].getText(app)}`
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(app) === 'BackHandler.addEventListener'
		)
			hardware = node.arguments[1].getText(app)
		ts.forEachChild(node, visitApp)
	}
	function visitPage(node: ts.Node) {
		if (ts.isJsxSelfClosingElement(node)) {
			const props = node.attributes.properties
			const label = props.find(
				(prop) =>
					ts.isJsxAttribute(prop) && prop.name.getText(page) === 'label',
			)
			const press = props.find(
				(prop) =>
					ts.isJsxAttribute(prop) && prop.name.getText(page) === 'onPress',
			)
			if (
				label &&
				ts.isJsxAttribute(label) &&
				label.initializer &&
				ts.isStringLiteral(label.initializer) &&
				press &&
				ts.isJsxAttribute(press) &&
				press.initializer &&
				ts.isJsxExpression(press.initializer) &&
				press.initializer.expression
			) {
				if (label.initializer.text === '返回B站导入上一步')
					header = press.initializer.expression.getText(page)
				if (label.initializer.text === '关闭B站收藏夹导入')
					close = press.initializer.expression.getText(page)
			}
		}
		ts.forEachChild(node, visitPage)
	}
	visitApp(app)
	visitPage(page)
	assert(hub && hardware && header && close)
	const events: string[] = [],
		state = { route }
	const player = { auditionId: null as string | null }
	const session = {
		back: () => events.push('bili.back'),
		close: () => events.push('bili.close'),
	}
	const compiled = ts.transpileModule(
		`${hub}\nconst onHub = openImportHub; globalThis.actions = {hardware:${hardware},header:${header},close:${close}}`,
		{
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.None,
			},
		},
	).outputText
	const actions = runInNewContext(compiled + '\nactions', {
		sheet: null,
		fullPlayer: false,
		player,
		playerReadingBack: { current: null },
		biliImportBack: { current: null },
		videoLibraryBack: { current: null },
		closePlayer: () => events.push('audition.close'),
		fm: { state: { open: false } },
		followingFeed: { state: { open: false }, session: { close: () => {} } },
		state,
		taskPage: 'home',
		session,
		biliImports: { state, session },
		recommendations: { state: { open: false } },
		videoLibrary: { session: { close: () => events.push('saved.close') } },
		imports: { session: { open: () => events.push('hub.open') } },
	}) as { hardware: () => boolean; header: () => void; close: () => void }
	return { actions, events, player }
}

void test('temporary audition owns hardware Back before import navigation even without an open full player', () => {
	const f = fixture('task')
	f.player.auditionId = 'temporary-candidate'
	assert.equal(f.actions.hardware(), true)
	assert.deepEqual(f.events, ['audition.close'])
	f.events.length = 0
	f.player.auditionId = null
	assert.equal(f.actions.hardware(), true)
	assert.deepEqual(f.events, ['bili.close', 'saved.close', 'hub.open'])
})

void test('hardware Back follows the existing Bilibili header: root pages return to import hub, child pages go back', () => {
	for (const route of [
		'folders',
		'task',
		'result',
		'collection',
		'entry',
		'destination',
		'organization',
		'organized',
	]) {
		const hardware = fixture(route),
			header = fixture(route)
		assert.equal(hardware.actions.hardware(), true)
		header.actions.header()
		const expected = ['folders', 'task', 'result'].includes(route)
			? ['bili.close', 'saved.close', 'hub.open']
			: ['bili.back']
		assert.deepEqual(hardware.events, expected, route)
		assert.deepEqual(hardware.events, header.events, `${route}: header parity`)
	}
})

void test('Bilibili close X still closes the current workflow without opening the hub', () => {
	for (const route of ['folders', 'task', 'result', 'entry']) {
		const f = fixture(route)
		f.actions.close()
		assert.deepEqual(f.events, ['bili.close'])
	}
})
