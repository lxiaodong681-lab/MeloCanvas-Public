import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { bindPlayerDeepLinks, isPlayerDeepLink } from '../player-deep-link'

function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
function fixture() {
	const initial = deferred<string | null>()
	let listener!: (event: { url: string }) => void,
		removed = 0,
		opened = 0
	const linking = {
		getInitialURL: () => initial.promise,
		addEventListener: (_: 'url', value: typeof listener) => {
			listener = value
			return {
				remove: () => {
					removed++
				},
			}
		},
	}
	return {
		linking,
		initial,
		open: () => {
			opened++
		},
		event: (url: string) => listener({ url }),
		opened: () => opened,
		removed: () => removed,
	}
}
const settle = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve()
}
const compile = (code: string) =>
	ts.transpileModule(code, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.None,
		},
	}).outputText

void test('only exact legacy notification/player and new widget routes are accepted', () => {
	for (const route of ['orpheus://player', 'melocanvas://player'])
		assert.equal(isPlayerDeepLink(route), true)
	for (const route of [
		null,
		'',
		'melocanvas://player-malicious',
		'melocanvas://player/other',
		'melocanvas://player?play=true',
		'melocanvas://player#anything',
		'https://player',
		'orpheus://player-other',
	])
		assert.equal(isPlayerDeepLink(route), false)
})

void test('cold initial link and warm events open without playback; a late initial link cannot override an already delivered warm event', async () => {
	for (const route of ['orpheus://player', 'melocanvas://player']) {
		const cold = fixture(),
			stop = bindPlayerDeepLinks(cold.linking, cold.open)
		cold.initial.resolve(route)
		await settle()
		assert.equal(cold.opened(), 1)
		stop()
		const warm = fixture(),
			clean = bindPlayerDeepLinks(warm.linking, warm.open)
		warm.event(route)
		warm.initial.resolve(route)
		await settle()
		assert.equal(warm.opened(), 1)
		warm.event(route)
		assert.equal(warm.opened(), 2)
		clean()
	}
})

void test('unmount ignores initial URL and retained event callbacks; initial URL read failure has no navigation effect', async () => {
	const f = fixture(),
		stop = bindPlayerDeepLinks(f.linking, f.open)
	stop()
	f.initial.resolve('melocanvas://player')
	f.event('melocanvas://player')
	await settle()
	assert.equal(f.opened(), 0)
	assert.equal(f.removed(), 1)
	const failed = fixture(),
		clean = bindPlayerDeepLinks(failed.linking, failed.open)
	failed.initial.reject(new Error('initial URL unavailable'))
	await settle()
	assert.equal(failed.opened(), 0)
	clean()
})

void test('actual App effect only opens the existing mode player, preserving paused cold state, queue and playback intent', async () => {
	const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
	const tree = ts.createSourceFile(
		'App.tsx',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	let effect = ''
	const conditions = new Map<string, string>()
	function visit(node: ts.Node) {
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(tree) === 'useEffect' &&
			node.arguments[0].getText(tree).includes('bindPlayerDeepLinks')
		)
			effect = node.arguments[0].getText(tree)
		if (ts.isConditionalExpression(node)) {
			for (const component of [
				'ListeningPlayer',
				'ListeningUnavailable',
				'MusicPlayer',
			])
				if (
					new RegExp(`^\\(\\s*<${component}\\b`).test(
						node.whenTrue.getText(tree),
					)
				)
					conditions.set(component, node.condition.getText(tree))
		}
		ts.forEachChild(node, visit)
	}
	visit(tree)
	assert.ok(effect)
	assert.equal(conditions.size, 3)
	for (const mode of ['music', 'listening']) {
		const f = fixture(),
			queue = Object.freeze(['A', 'B', 'A']),
			state = { fullPlayer: false }
		const player = Object.freeze({
			mode,
			track: Object.freeze({ id: 'third-A' }),
			playing: false,
			position: 80,
			queue,
		})
		const setup = runInNewContext(compile(`(${effect})`), {
			bindPlayerDeepLinks,
			Linking: f.linking,
			followingFeed: { session: { cancelPending: () => {} } },
			setFullPlayer: (open: boolean) => {
				state.fullPlayer = open
			},
			player,
		}) as () => () => void
		const stop = setup()
		f.initial.resolve('melocanvas://player')
		await settle()
		assert.equal(state.fullPlayer, true)
		assert.equal(player.playing, false)
		assert.equal(player.position, 80)
		assert.equal(player.queue, queue)
		const listening = runInNewContext(
			compile(conditions.get('ListeningPlayer')!),
			{ fullPlayer: state.fullPlayer, current: {}, player },
		)
		assert.equal(!!listening, mode === 'listening')
		assert.doesNotMatch(
			effect,
			/\.play\(|\.reserve|\.seek|\.sync\(|playbackIntent|queue/,
		)
		stop()
	}
})
