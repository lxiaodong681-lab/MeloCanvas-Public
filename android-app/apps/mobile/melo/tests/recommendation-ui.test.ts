import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { sourceId, type Source } from '../core/model'
import type {
	RecommendationReason,
	RecommendationSnapshot,
} from '../core/recommendations'
import { builtInThemes } from '../core/theme'
import { PlaybackIntent, playMusicIntent } from '../playback-intent'
import { RecommendationSession } from '../recommendation-session'

import { preparationPort } from './playback-preparation-fixture'

const A: Source = {
	id: sourceId('BV1vT411i7ET', 11),
	bvid: 'BV1vT411i7ET',
	cid: 11,
	originalTitle: '真实音源',
	uploader: '原UP',
	uploaderId: 88,
	performer: null,
	artwork: 'https://example.invalid/not-fetched',
	duration: 200,
	domain: 'music',
	audioAvailability: 'unknown',
}
function fixture(reasons: RecommendationReason[] = ['liked', 'playlist']) {
	let snapshot: RecommendationSnapshot = {
		localDate: '2026-10-18',
		revision: 0,
		items: [{ source: A, reasons }],
		canUndo: false,
	}
	let reads = 0
	const session = new RecommendationSession({
		load: () => {
			reads++
			return snapshot
		},
		refresh: () => snapshot,
		dismiss: () => {
			snapshot = { ...snapshot, items: [], canUndo: true }
			return snapshot
		},
		undo: () => snapshot,
		listDismissed: () => ({
			items: [],
			page: 1,
			pageSize: 20,
			total: 0,
			totalPages: 0,
		}),
		restoreSource: () => snapshot,
		resetLocalRecommendations: () => snapshot,
	})
	return { session, reads: () => reads }
}
function compile(text: string) {
	return ts.transpileModule(text, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
			jsx: ts.JsxEmit.React,
		},
	}).outputText
}
type Node = {
	type: string
	props: Record<string, unknown>
	children: unknown[]
}
const react = {
	createElement: (
		type: string,
		props: Record<string, unknown>,
		...children: unknown[]
	): Node => ({ type, props: props ?? {}, children }),
	Fragment: 'Fragment',
}
function nodes(value: unknown): Node[] {
	if (Array.isArray(value)) return value.flatMap(nodes)
	if (
		value &&
		typeof value === 'object' &&
		'type' in value &&
		'children' in value
	)
		return [value as Node, ...nodes((value as Node).children)]
	return []
}
function labels(value: unknown): string {
	if (Array.isArray(value)) return value.map(labels).join('')
	if (value && typeof value === 'object' && 'children' in value)
		return labels((value as Node).children)
	return typeof value === 'string' || typeof value === 'number'
		? String(value)
		: ''
}
function render(session: RecommendationSession, theme = builtInThemes.modern) {
	const output: { RecommendationPage?: (props: unknown) => Node } = {}
	runInNewContext(
		compile(
			readFileSync(
				new URL('../recommendation-ui.tsx', import.meta.url),
				'utf8',
			),
		),
		{
			exports: output,
			require: (name: string) =>
				name === 'react'
					? { __esModule: true, default: react, ...react }
					: name === 'react-native'
						? { Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View' }
						: {
								Artwork: 'Artwork',
								Button: 'Button',
								Card: 'Card',
								IconButton: 'IconButton',
								State: 'State',
								T: 'T',
								time: () => '3:20',
								useTheme: () => theme,
								useThemeRendering: () => null,
								ControlRow: 'View',
								ControlTarget: 'Pressable',
							},
		},
	)
	return output.RecommendationPage!({
		state: session.getSnapshot(),
		session,
		onPlay: () => {},
	})
}
async function settle() {
	for (let index = 0; index < 20; index++) await Promise.resolve()
}

/** Actual App functions, header, native activation and navigation callbacks share the real session/intent. */
function appFixture() {
	const f = fixture(),
		tree = ts.createSourceFile(
			'App.tsx',
			readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		)
	const functions = new Map<string, string>()
	let hardware = '',
		navigation = '',
		card = ''
	function visit(node: ts.Node) {
		if (ts.isFunctionDeclaration(node) && node.name)
			functions.set(node.name.text, node.getText(tree))
		if (
			ts.isVariableDeclaration(node) &&
			node.initializer &&
			ts.isCallExpression(node.initializer) &&
			node.initializer.expression.getText(tree) === 'useCallback'
		)
			functions.set(
				node.name.getText(tree),
				`const ${node.name.getText(tree)} = ${node.initializer.arguments[0].getText(tree)}`,
			)
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(tree) === 'BackHandler.addEventListener'
		)
			hardware = node.arguments[1].getText(tree)
		if (
			ts.isJsxOpeningElement(node) &&
			['Pressable', 'ControlTarget'].includes(node.tagName.getText(tree))
		) {
			const props = node.attributes.properties
			const label = props.find(
				(prop) =>
					ts.isJsxAttribute(prop) &&
					prop.name.getText(tree) === 'accessibilityLabel',
			)
			const press = props.find(
				(prop) =>
					ts.isJsxAttribute(prop) && prop.name.getText(tree) === 'onPress',
			)
			if (
				label &&
				press &&
				ts.isJsxAttribute(label) &&
				ts.isJsxAttribute(press) &&
				press.initializer &&
				ts.isJsxExpression(press.initializer) &&
				press.initializer.expression
			) {
				if (
					label.initializer &&
					ts.isStringLiteral(label.initializer) &&
					label.initializer.text === '打开每日推荐'
				)
					card = press.initializer.expression.getText(tree)
			}
		}
		if (
			ts.isJsxSelfClosingElement(node) &&
			node.tagName.getText(tree) === 'HomeLocalFeatures'
		) {
			const press = node.attributes.properties.find(
				(prop) =>
					ts.isJsxAttribute(prop) &&
					prop.name.getText(tree) === 'onRecommendations',
			)
			assert(
				press &&
					ts.isJsxAttribute(press) &&
					press.initializer &&
					ts.isJsxExpression(press.initializer) &&
					press.initializer.expression,
			)
			card = press.initializer.expression.getText(tree)
		}
		if (
			ts.isJsxSelfClosingElement(node) &&
			node.tagName.getText(tree) === 'HostPlaybackFooter'
		) {
			const navigate = node.attributes.properties.find(
				(prop) =>
					ts.isJsxAttribute(prop) && prop.name.getText(tree) === 'onNavigate',
			)
			assert(
				navigate &&
					ts.isJsxAttribute(navigate) &&
					navigate.initializer &&
					ts.isJsxExpression(navigate.initializer) &&
					navigate.initializer.expression,
			)
			navigation = navigate.initializer.expression.getText(tree)
			assert.match(navigation, /recommendations\.session\.close\(\)/)
			assert.match(navigation, /setTab\(destination\)/)
		}
		ts.forEachChild(node, visit)
	}
	visit(tree)
	assert(hardware && navigation && card)
	let nativeEpoch = 0,
		release!: () => void
	const activation = new Promise<void>((yes) => {
			release = yes
		}),
		activated: string[] = [],
		opened: boolean[] = [],
		notices: string[] = []
	const recommendations = {
		get state() {
			return f.session.getSnapshot()
		},
		session: f.session,
	}
	const context = {
		recommendations,
		fm: { state: { open: false }, session: { close: () => {} } },
		followingFeed: { state: { open: false }, session: { close: () => {} } },
		playbackIntent: new PlaybackIntent(),
		playMusicIntent,
		fullPlayer: false,
		sheet: null,
		playerPresentation: { current: 0 },
		setFullPlayerState: (value: boolean) => {
			context.fullPlayer = value
			opened.push(value)
		},
		setNotice: (message: string) => notices.push(message),
		setSourceRequestBv: () => {},
		profileSettingsOpen: false,
		setProfileSettingsOpen: () => {},
		setCollectionOrigin: () => {},
		setLibraryCollection: () => {},
		setTab: () => {},
		setListeningLibraryOpen: () => {},
		imports: { state: { suspended: false }, session: { close: () => {} } },
		biliImports: {
			session: {
				close: () => {},
				preview: { getSnapshot: () => ({ suspended: false }) },
			},
		},
		videoLibrary: {
			session: {
				close: () => {},
				preview: { getSnapshot: () => ({ suspended: false }) },
			},
		},
		creators: { state: { suspended: false } },
		player: {
			...preparationPort(
				async () => {
					nativeEpoch++
				},
				async () => {
					nativeEpoch++
				},
			),
			cancelPending: async () => {
				nativeEpoch++
			},
			playSource: async (...args: unknown[]) => {
				assert.equal(
					args.length,
					2,
					'only the explicitly clicked Source reaches the existing music path',
				)
				assert.equal(args[0], A)
				activated.push(A.id)
				const epoch = nativeEpoch
				await activation
				return epoch === nativeEpoch
			},
		},
	}
	const names = [
		'setFullPlayer',
		'closePlayer',
		'openRecommendations',
		'playRecommendation',
	]
	for (const name of names) assert(functions.has(name), name)
	const code =
		names.map((name) => functions.get(name)).join('\n') +
		`\nglobalThis.actions = {card:${card},play:playRecommendation,hardware:${hardware},navigation:${navigation},closePlayer}`
	const actions = runInNewContext(compile(code) + '\nactions', {
		...context,
		exports: {},
	}) as {
		card: () => void
		play: (id: string) => void
		hardware: () => boolean
		navigation: (destination: string) => void
		closePlayer: () => Promise<void>
	}
	return {
		...f,
		actions,
		context,
		release,
		activated,
		opened,
		notices,
		epoch: () => nativeEpoch,
	}
}

void test('three host themes render real date/reasons/cover, Source feedback and honest empty/error without play-all', () => {
	for (const theme of Object.values(builtInThemes)) {
		const f = fixture()
		f.session.open()
		const page = render(f.session, theme),
			list = nodes(page)
		assert.match(labels(page), /继续听熟悉的音乐/)
		assert.match(labels(page), /2026-10-18/)
		assert.match(labels(page), /你喜欢的音源.*来自你的本地歌单/)
		assert(
			list.some(
				(node) =>
					node.type === 'Artwork' &&
					node.props.uri === A.artwork &&
					node.props.size === 48,
			),
		)
		assert(!labels(page).includes('播放全部'))
		const row = list.find(
			(node) =>
				node.props.accessibilityLabel === `播放每日推荐音源 ${A.originalTitle}`,
		)!
		assert.equal((row.props.style as { minHeight: number }).minHeight, 64)
		assert(
			list.some(
				(node) => node.props.label === `对此音源不感兴趣 ${A.originalTitle}`,
			),
		)
		f.session.dismiss(A.id)
		assert(
			nodes(render(f.session, theme)).some(
				(node) => node.props.title === '暂时没有可推荐的本机音源',
			),
		)
	}
	const error = new RecommendationSession({
		load: () => {
			throw new Error('local failed')
		},
		refresh: () => {
			throw new Error('unexpected')
		},
		dismiss: () => {
			throw new Error('unexpected')
		},
		undo: () => {
			throw new Error('unexpected')
		},
		listDismissed: () => {
			throw new Error('unexpected')
		},
		restoreSource: () => {
			throw new Error('unexpected')
		},
		resetLocalRecommendations: () => {
			throw new Error('unexpected')
		},
	})
	const imported = fixture(['imported-song'])
	imported.session.open()
	assert.match(labels(render(imported.session)), /已核对导入歌曲/)
	error.open()
	const page = render(error)
	assert.match(labels(page), /本地推荐暂时无法读取.*local failed/)
	assert(
		!nodes(page).some(
			(node) => node.props.title === '暂时没有可推荐的本机音源',
		),
	)
})

void test('actual daily card, feedback and refresh only read/write local state; header, hardware and navigation close consistently', () => {
	for (const route of ['header', 'hardware', 'navigation']) {
		const f = appFixture()
		f.actions.card()
		assert.equal(f.session.getSnapshot().open, true)
		f.session.refresh()
		f.session.dismiss(A.id)
		assert.deepEqual(f.activated, [])
		assert.deepEqual(f.opened, [])
		assert.equal(f.epoch(), 0)
		if (route === 'header')
			(
				nodes(render(f.session)).find(
					(node) => node.props.label === '返回发现页',
				)!.props.onPress as () => void
			)()
		else if (route === 'hardware') assert.equal(f.actions.hardware(), true)
		else f.actions.navigation('library')
		assert.equal(f.session.getSnapshot().open, false)
	}
})

void test('actual clicked Source uses shared intent/music path; closing preparation cannot activate or reopen a stale page', async () => {
	const f = appFixture()
	f.actions.card()
	f.actions.play(A.id)
	await settle()
	assert.deepEqual(f.activated, [A.id])
	assert.equal(f.epoch(), 1)
	f.actions.navigation('library')
	assert.equal(f.epoch(), 2)
	f.release()
	await settle()
	assert.deepEqual(f.opened, [])
	assert.equal(f.session.getSnapshot().open, false)
})

void test('actual playback success opens once; player close returns to the same daily page without a new read or cancellation', async () => {
	const f = appFixture()
	f.actions.card()
	f.actions.play(A.id)
	await settle()
	f.release()
	await settle()
	assert.deepEqual(f.opened, [true])
	const reads = f.reads(),
		epoch = f.epoch()
	await f.actions.closePlayer()
	assert.deepEqual(f.opened, [true, false])
	assert.equal(f.session.getSnapshot().open, true)
	assert.equal(f.reads(), reads)
	assert.equal(f.epoch(), epoch)
})

void test('actual App late recommendation cannot cancel or open over a subsequent global playback intent', async () => {
	const f = appFixture()
	f.actions.card()
	f.actions.play(A.id)
	await settle()
	const newer = f.context.playbackIntent.begin()
	await f.context.player.cancelPending()
	const epoch = f.epoch()
	f.actions.navigation('library')
	assert.equal(f.epoch(), epoch)
	f.release()
	await settle()
	assert.equal(newer.isCurrent(), true)
	assert.deepEqual(f.opened, [])
})

void test('native token expiry is a cancelled recommendation, not a failed recommendation; another explicit click works', async () => {
	const f = appFixture()
	f.actions.card()
	f.actions.play(A.id)
	await settle()
	await f.context.player.reservePlayback()
	f.release()
	await settle()
	assert.deepEqual(f.opened, [])
	assert.equal(f.session.getSnapshot().playError, '')
	f.actions.play(A.id)
	await settle()
	assert.deepEqual(f.opened, [true])
})

void test('actual hook checks local date on foreground only while the daily page is open, and cleans its listener', () => {
	let change!: (value: string) => void,
		cleanup!: () => void,
		removed = 0,
		reads = 0
	let localDate = '2026-10-18'
	const store = {
		load: () => {
			reads++
			return { localDate, revision: 0, items: [], canUndo: false }
		},
		refresh: () => assert.fail('no automatic rotation'),
		dismiss: () => assert.fail('no automatic feedback'),
		undo: () => assert.fail('no automatic undo'),
	}
	const output: {
		useRecommendations?: (value: unknown) => { session: RecommendationSession }
	} = {}
	runInNewContext(
		compile(
			readFileSync(
				new URL('../useRecommendations.ts', import.meta.url),
				'utf8',
			),
		),
		{
			exports: output,
			require: (name: string) =>
				name === 'react'
					? {
							useMemo: (create: () => unknown) => create(),
							useSyncExternalStore: (_: unknown, get: () => unknown) => get(),
							useEffect: (effect: () => () => void) => {
								cleanup = effect()
							},
						}
					: name === 'react-native'
						? {
								AppState: {
									addEventListener: (_: string, listener: typeof change) => {
										change = listener
										return {
											remove: () => {
												removed++
											},
										}
									},
								},
							}
						: { RecommendationSession },
		},
	)
	const { session } = output.useRecommendations!(store)
	change('active')
	assert.equal(reads, 0)
	session.open()
	assert.equal(reads, 1)
	localDate = '2026-10-19'
	change('background')
	assert.equal(reads, 1)
	change('active')
	assert.equal(reads, 2)
	assert.equal(session.getSnapshot().snapshot!.localDate, '2026-10-19')
	session.close()
	change('active')
	assert.equal(reads, 2)
	cleanup()
	assert.equal(removed, 1)
})
