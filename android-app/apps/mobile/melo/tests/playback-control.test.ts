import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import type { PlaybackSnapshot } from '@bbplayer/orpheus'
import ts from 'typescript'

import { Library, migrate } from '../core/database'
import { ListeningLibrary } from '../core/listening'
import { LocalAudioStore } from '../core/local-audio'
import { sourceId, sourceUri, type Source } from '../core/model'
import { SessionStore } from '../core/sessions'
import { PlaybackIntent, playMusicIntent } from '../playback-intent'
import { PlaybackController, type PlaybackNative } from '../playbackController'

const file = (path: string) =>
	readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = (text: string) =>
	ts.transpileModule(text, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.None,
		},
	}).outputText
function declarations(text: string) {
	const tree = ts.createSourceFile(
		'App.tsx',
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	const result = new Map<string, string>()
	function visit(node: ts.Node) {
		if (ts.isFunctionDeclaration(node) && node.name)
			result.set(node.name.text, node.getText(tree))
		ts.forEachChild(node, visit)
	}
	visit(tree)
	return result
}
function deferred<T = void>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

interface TestNative extends PlaybackNative {
	snapshot: PlaybackSnapshot
	prepare: (() => Promise<void>) | null
	replacements: number
}

// Models the native author's atomic invalidate+transport boundary; not an IPC proof.
function primitive(native: TestNative, change: () => void): Promise<void> {
	void native.cancelPlaybackReplacement()
	change()
	return Promise.resolve()
}
interface Fixture {
	raw: DatabaseSync
	native: TestNative
	controller: PlaybackController
}
// Use the existing player test double verbatim. It models the native contract;
// no Android Module, MediaSession dispatcher or Widget runs in this JS test.
const fixtureTree = ts.createSourceFile(
	'player.test.ts',
	file('tests/player.test.ts'),
	ts.ScriptTarget.Latest,
	true,
)
const required = new Set([
	'source',
	'track',
	'music',
	'p1',
	'p2',
	'initial',
	'Native',
	'setup',
])
const fixtureCode =
	fixtureTree.statements
		.filter(
			(node) =>
				((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
					required.has(node.name?.text ?? '')) ||
				(ts.isVariableStatement(node) &&
					node.declarationList.declarations.some((item) =>
						required.has(item.name.getText(fixtureTree)),
					)),
		)
		.map((node) => node.getText(fixtureTree))
		.join('\n') + '\n({setup,p1})'
const fixtures = runInNewContext(compile(fixtureCode), {
	DatabaseSync,
	Library,
	migrate,
	ListeningLibrary,
	LocalAudioStore,
	SessionStore,
	sourceId,
	sourceUri,
	PlaybackController,
	structuredClone,
	Error,
}) as { setup: () => Fixture; p1: Source }
const app = declarations(file('App.tsx')),
	hook = declarations(file('player.ts'))
const controls = new Map<string, string>()
const hookTree = ts.createSourceFile(
	'player.ts',
	file('player.ts'),
	ts.ScriptTarget.Latest,
	true,
)
function controlVisitor(node: ts.Node) {
	if (
		ts.isPropertyAssignment(node) &&
		['toggle', 'seek'].includes(node.name.getText(hookTree))
	)
		controls.set(
			node.name.getText(hookTree),
			node.initializer.getText(hookTree),
		)
	ts.forEachChild(node, controlVisitor)
}
controlVisitor(hookTree)

for (const stage of ['metadata', 'native-precheck', 'commit-return'] as const) {
	for (const control of ['pause', 'seek'] as const) {
		for (const route of [
			'app-command',
			'native-token-invalidation-model',
		] as const) {
			void test(`actual App/usePlayer ${stage}/${control}/${route}: later control wins; a new click still works`, async () => {
				const f = fixtures.setup(),
					waiting = deferred(),
					entered = deferred()
				let opened = 0,
					held = true
				const notices: unknown[] = [],
					intent = new PlaybackIntent()
				const sourceDetails = async () => {
					if (stage === 'metadata' && held) {
						entered.resolve()
						await waiting.promise
					}
					return fixtures.p1
				}
				if (stage === 'native-precheck')
					f.native.prepare = async () => {
						if (held) {
							entered.resolve()
							await waiting.promise
						}
					}
				if (stage === 'commit-return') {
					const replace = f.native.replacePlayback.bind(f.native)
					f.native.replacePlayback = async (...args) => {
						const result = await replace(...args)
						if (held) {
							entered.resolve()
							await waiting.promise
						}
						return result
					}
				}
				const player = {
					reservePlayback: () => f.controller.reservePlayback(),
					isPreparationCurrent: f.controller.isPreparationCurrent.bind(
						f.controller,
					),
					cancelPreparation: f.controller.cancelPreparation.bind(f.controller),
					playSource: async (
						...args: Parameters<PlaybackController['playSource']>
					) => (await f.controller.playSource(...args)) !== null,
				}
				const actions = runInNewContext(
					compile(
						[
							app.get('resolveSource'),
							app.get('start'),
							hook.get('cancelPending'),
							hook.get('command'),
							`({start,toggle:${controls.get('toggle')},seek:${controls.get('seek')}})`,
						].join('\n'),
					),
					{
						playbackIntent: intent,
						playMusicIntent,
						sourceDetails,
						player,
						controller: f.controller,
						operationVersion: { current: 0 },
						alive: { current: true },
						setFullPlayer: (value: boolean) => {
							if (value) opened++
						},
						setSourceRequestBv() {},
						setNotice: (value: unknown) => notices.push(value),
						setSwitching() {},
						setError: (value: unknown) => notices.push(value),
						setErrorCause() {},
						sync: () => f.controller.sync(),
						Error,
						playing: true,
						duration: 300,
						Orpheus: {
							pause: () =>
								primitive(f.native, () => {
									f.native.snapshot.playing = false
								}),
							play: () =>
								primitive(f.native, () => {
									f.native.snapshot.playing = true
								}),
							seekTo: (seconds: number) =>
								primitive(f.native, () => {
									f.native.snapshot.positionSeconds = seconds
								}),
						},
					},
				) as {
					start: (item: { bvid: string }) => Promise<void>
					toggle: () => Promise<void>
					seek: (seconds: number) => Promise<void>
				}
				try {
					const work = actions.start({ bvid: fixtures.p1.bvid })
					await entered.promise
					if (route === 'app-command') {
						if (control === 'pause') await actions.toggle()
						else await actions.seek(95)
					} else {
						// The native author owns verifying that real controls perform this
						// invalidation; this test verifies JS honors an already-invalid token.
						await f.native.cancelPlaybackReplacement()
						if (control === 'pause') f.native.snapshot.playing = false
						else f.native.snapshot.positionSeconds = 95
					}
					const controlled = structuredClone(f.native.snapshot)
					held = false
					waiting.resolve()
					await work
					assert.deepEqual(structuredClone(f.native.snapshot), controlled)
					assert.equal(opened, 0, 'late success cannot open a stale player')
					assert.deepEqual(notices, [])
					await actions.start({ bvid: fixtures.p1.bvid })
					assert.equal(
						opened,
						1,
						'a subsequent explicit click reserves a new token',
					)
					assert.equal(f.native.snapshot.currentSourceId, fixtures.p1.id)
					assert.equal(f.native.snapshot.playing, true)
				} finally {
					f.raw.close()
				}
			})
		}
	}
}

void test('stale owned abort cannot cancel a newer preparation, including a reservation reply arriving late', async () => {
	const f = fixtures.setup(),
		intent = new PlaybackIntent()
	try {
		const firstReply = deferred(),
			metadata = deferred(),
			entered = deferred()
		let reservations = 0
		const preparation = {
			reservePlayback: async () => {
				const value = await f.controller.reservePlayback()
				if (++reservations === 1) {
					entered.resolve()
					await firstReply.promise
				}
				return value
			},
			isPreparationCurrent: f.controller.isPreparationCurrent.bind(
				f.controller,
			),
			cancelPreparation: f.controller.cancelPreparation.bind(f.controller),
		}
		const old = intent.run({
			preparation,
			prepare: () => metadata.promise,
			activate: async () => {
				assert.fail('obsolete activation')
			},
			onSuccess: () => assert.fail('obsolete UI'),
		})
		await entered.promise
		const newer = await f.controller.reservePlayback()
		intent.cancel()
		firstReply.resolve()
		assert.equal(await old, false)
		assert.equal(await f.controller.isPreparationCurrent(newer), true)
		assert.equal(
			(await f.controller.playSource(fixtures.p1, newer))?.currentSourceId,
			fixtures.p1.id,
		)
	} finally {
		f.raw.close()
	}
})

void test('hook cleanup cancels only its own token even when reserve resolves after unmount or a newer owner', async () => {
	for (const newerOwner of [false, true]) {
		const f = fixtures.setup(),
			reply = deferred()
		try {
			const reserve = f.native.cancelPlaybackReplacement.bind(f.native)
			let first = true
			f.native.cancelPlaybackReplacement = async () => {
				const token = await reserve()
				if (first) {
					first = false
					await reply.promise
				}
				return token
			}
			const old = f.controller.reservePlayback()
			const cleanup = f.controller.disposePending()
			const newer = newerOwner ? await f.controller.reservePlayback() : null
			reply.resolve()
			const previous = await old
			await cleanup
			assert.equal(await f.controller.isPreparationCurrent(previous), false)
			if (newer) {
				assert.equal(await f.controller.isPreparationCurrent(newer), true)
				assert.ok(await f.controller.playSource(fixtures.p1, newer))
			}
			assert.match(file('player.ts'), /controller\.disposePending\(\)/)
			assert.doesNotMatch(
				file('player.ts'),
				/void controller\.cancelPending\(\)/,
			)
		} finally {
			f.raw.close()
		}
	}
})

void test('actual usePlayer.operation suppresses an obsolete non-cancellation error but retains a current failure', async () => {
	for (const obsolete of [true, false]) {
		const f = fixtures.setup(),
			waiting = deferred()
		try {
			const preparation = await f.controller.reservePlayback(),
				errors: unknown[] = []
			const operation = runInNewContext(
				compile(hook.get('operation')! + '\noperation'),
				{
					controller: f.controller,
					operationVersion: { current: 0 },
					alive: { current: true },
					setSwitching() {},
					setError: (value: string) => {
						if (value) errors.push(value)
					},
					setErrorCause() {},
					setSyncError() {},
					setSyncCause() {},
					syncVersion: { current: 0 },
					apply: () => assert.fail('failed action cannot apply'),
					playbackError: (value: string) => value,
					Error,
				},
			) as (
				action: () => Promise<null>,
				preparation: { token: number },
			) => Promise<boolean>
			const result = operation(async () => {
				await waiting.promise
				throw new Error('真实失败')
			}, preparation)
			if (obsolete) await f.native.cancelPlaybackReplacement()
			waiting.resolve()
			assert.equal(await result, false)
			assert.deepEqual(errors, obsolete ? [] : ['真实失败'])
		} finally {
			f.raw.close()
		}
	}
})

void test('actual Bili App wrapper rechecks the same token after its extra native snapshot await', async () => {
	const tree = ts.createSourceFile(
		'App.tsx',
		file('App.tsx'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	let expression = ''
	function visit(node: ts.Node) {
		if (
			ts.isVariableDeclaration(node) &&
			node.name.getText(tree) === 'activateBilibiliPreview'
		)
			expression = node.initializer!.getText(tree)
		ts.forEachChild(node, visit)
	}
	visit(tree)
	assert.ok(expression)
	for (const invalidate of [true, false]) {
		const f = fixtures.setup(),
			entered = deferred(),
			snapshot = deferred<PlaybackSnapshot>()
		try {
			const intent = new PlaybackIntent(),
				owner: { request: ReturnType<PlaybackIntent['begin']> | null } = {
					request: null,
				}
			const player = {
				reservePlayback: f.controller.reservePlayback.bind(f.controller),
				isPreparationCurrent: f.controller.isPreparationCurrent.bind(
					f.controller,
				),
				cancelPreparation: f.controller.cancelPreparation.bind(f.controller),
				playSource: async (
					...args: Parameters<PlaybackController['playSource']>
				) => !!(await f.controller.playSource(...args)),
			}
			const activate = runInNewContext(compile(`(${expression})`), {
				playbackIntent: intent,
				player,
				playMusicIntent,
				setSourceRequestBv() {},
				Orpheus: {
					getPlaybackSnapshot: () => {
						entered.resolve()
						return snapshot.promise
					},
				},
			}) as (
				source: Source,
				mode: 'music',
				video: null,
				own: (request: ReturnType<PlaybackIntent['begin']>) => void,
			) => Promise<unknown>
			const work = activate(fixtures.p1, 'music', null, (request) => {
				owner.request = request
			})
			await entered.promise
			const committed = structuredClone(f.native.snapshot)
			if (invalidate) await f.native.cancelPlaybackReplacement()
			snapshot.resolve(committed)
			const result = await work
			assert.equal(result === null, invalidate)
			assert.equal(owner.request!.isCurrent(), !invalidate)
		} finally {
			f.raw.close()
		}
	}
})

void test('actual command sends native control synchronously before a newer reserve; delayed acknowledgement cannot undo new playback', async () => {
	const f = fixtures.setup(),
		acknowledge = deferred()
	try {
		let entered = false,
			separateCancels = 0
		const command = runInNewContext(
			compile(hook.get('command')! + '\ncommand'),
			{
				operationVersion: { current: 0 },
				alive: { current: true },
				setSwitching() {},
				cancelPending: async () => {
					separateCancels++
					await f.controller.cancelPending()
				},
				sync: () => f.controller.sync(),
				setError: () => assert.fail('unexpected control error'),
				setErrorCause() {},
			},
		) as (action: () => Promise<void>) => Promise<void>
		const older = command(() => {
			entered = true
			void primitive(f.native, () => {
				f.native.snapshot.playing = false
			})
			return acknowledge.promise
		})
		assert.equal(
			entered,
			true,
			'no preliminary bridge await may delay the earlier native control',
		)
		assert.equal(separateCancels, 0)
		const preparation = await f.controller.reservePlayback()
		assert.ok(await f.controller.playSource(fixtures.p1, preparation))
		acknowledge.resolve()
		await older
		assert.equal(await f.controller.isPreparationCurrent(preparation), true)
		assert.equal(f.native.snapshot.currentSourceId, fixtures.p1.id)
		assert.equal(f.native.snapshot.playing, true)
	} finally {
		acknowledge.resolve()
		f.raw.close()
	}
})

void test('actual command ignores a late rejected control after a newer operation and keeps current control errors', async () => {
	for (const obsolete of [true, false]) {
		const action = deferred(),
			operationVersion = { current: 0 },
			errors: string[] = []
		const command = runInNewContext(
			compile(hook.get('command')! + '\ncommand'),
			{
				operationVersion,
				alive: { current: true },
				setSwitching() {},
				sync: async () => {},
				setError: (value: string) => errors.push(value),
				setErrorCause() {},
			},
		) as (action: () => Promise<void>) => Promise<void>
		const work = command(() => action.promise)
		if (obsolete) operationVersion.current++
		action.reject(new Error('late bridge failure'))
		await work
		assert.deepEqual(errors, obsolete ? [] : ['播放操作失败，请稍后重试'])
	}
})
