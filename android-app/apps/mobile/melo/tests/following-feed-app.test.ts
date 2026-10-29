import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { sourceId, type Source } from '../core/model'
import type { CreatorPostCandidate } from '../creator-api'
import {
	resolveCreatorPost,
	verifyCreatorPost,
} from '../creator-post-selection'
import { CreatorSession } from '../creator-session'
import type { ListeningVideo } from '../listening-source'
import {
	PlaybackIntent,
	playMusicIntent,
	type PlaybackRequest,
} from '../playback-intent'

import { feedFixture } from './following-feed-fixture'
import { preparationPort } from './playback-preparation-fixture'

const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile(
	'App.tsx',
	source,
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TSX,
)
function declaration(name: string) {
	let found = ''
	const visit = (node: ts.Node) => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name)
			found = node.getText(tree)
		if (
			ts.isVariableDeclaration(node) &&
			node.name.getText(tree) === name &&
			node.initializer
		) {
			const initializer =
				ts.isCallExpression(node.initializer) &&
				node.initializer.expression.getText(tree) === 'useCallback'
					? node.initializer.arguments[0]
					: node.initializer
			found = `const ${name} = ${initializer.getText(tree)};`
		}
		ts.forEachChild(node, visit)
	}
	visit(tree)
	assert.ok(found, `Missing actual App declaration ${name}`)
	return found
}
function actualHandler(kind: 'back' | 'navigation' | 'mini' | 'widget') {
	let found = ''
	const visit = (node: ts.Node) => {
		if (
			kind === 'back' &&
			ts.isCallExpression(node) &&
			node.expression.getText(tree) === 'BackHandler.addEventListener'
		)
			found = node.arguments[1].getText(tree)
		if (
			kind === 'widget' &&
			ts.isCallExpression(node) &&
			node.expression.getText(tree) === 'bindPlayerDeepLinks'
		)
			found = node.arguments[1].getText(tree)
		if (
			(kind === 'navigation' || kind === 'mini') &&
			ts.isJsxSelfClosingElement(node) &&
			node.tagName.getText(tree) === 'HostPlaybackFooter'
		) {
			const attribute = node.attributes.properties.find(
				(property) =>
					ts.isJsxAttribute(property) &&
					property.name.getText(tree) ===
						(kind === 'navigation' ? 'onNavigate' : 'mini'),
			)
			assert.ok(
				attribute &&
					ts.isJsxAttribute(attribute) &&
					attribute.initializer &&
					ts.isJsxExpression(attribute.initializer),
			)
			const expression = attribute.initializer.expression
			assert.ok(expression)
			if (kind === 'navigation') {
				found = expression.getText(tree)
				assert.match(found, /setTab\(destination\)/)
				assert.match(found, /fm\.session\.close\(\)/)
			} else {
				assert.ok(
					ts.isConditionalExpression(expression) &&
						ts.isObjectLiteralExpression(expression.whenTrue),
				)
				const open = expression.whenTrue.properties.find(
					(property) =>
						ts.isPropertyAssignment(property) &&
						property.name.getText(tree) === 'onOpen',
				)
				assert.ok(open && ts.isPropertyAssignment(open))
				found = open.initializer.getText(tree)
				assert.match(found, /followingFeed\.session\.cancelPending\(\)/)
				assert.match(found, /setFullPlayer\(true\)/)
			}
		}
		ts.forEachChild(node, visit)
	}
	visit(tree)
	assert.ok(found)
	return found
}
const compile = (value: string) =>
	ts.transpileModule(value, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
		},
	}).outputText
const settle = async () => {
	for (let index = 0; index < 90; index++) await Promise.resolve()
}
// Individual live slots let the actual App callbacks prove mutual exclusion.
function slot() {
	const value = {
		state: { open: false, route: 'closed', suspended: false },
		session: {
			open: () => {
				value.state.open = true
				value.state.route = 'open'
			},
			openTask: () => {
				value.state.open = true
				value.state.route = 'open'
			},
			close: () => {
				value.state.open = false
				value.state.route = 'closed'
			},
		},
	}
	return value
}
function fixture() {
	const f = feedFixture(),
		playbackIntent = new PlaybackIntent(),
		preparation = preparationPort()
	const creatorSession = new CreatorSession(f.creators, {
		sourcesByUploader: () => [],
	})
	const activated: { mode: string; source: Source }[] = [],
		toggles: boolean[] = []
	let video: ListeningVideo = {
		bvid: f.post.bvid,
		title: 'view已核验标题',
		uploader: 'view上传者',
		parts: [
			{
				page: 1,
				title: '真实P',
				source: {
					id: sourceId(f.post.bvid, 11),
					bvid: f.post.bvid,
					cid: 11,
					originalTitle: 'view已核验标题',
					uploader: 'view上传者',
					uploaderId: 99,
					performer: null,
					artwork: 'https://example.invalid/view.jpg',
					duration: 300,
					domain: 'unclassified',
					audioAvailability: 'unknown',
				},
			},
		],
	}
	let load: () => Promise<ListeningVideo> = async () => video
	const imports = slot(),
		biliImports = slot(),
		videoLibrary = slot(),
		recommendations = slot(),
		fm = slot()
	const preview = { getSnapshot: () => ({ suspended: false }) }
	Object.assign(biliImports.session, { preview })
	Object.assign(videoLibrary.session, { preview })
	const scope = {
		followingFeed: {
			session: f.session,
			get state() {
				return f.session.getSnapshot()
			},
		},
		creators: { session: creatorSession, state: creatorSession.getSnapshot() },
		imports,
		biliImports,
		videoLibrary,
		recommendations,
		fm,
		playbackIntent,
		playMusicIntent,
		player: {
			...preparation,
			track: null,
			mode: 'music',
			playSource: async (value: Source) => {
				activated.push({ mode: 'music', source: value })
				return true
			},
		},
		resolveCreatorPost: (
			candidate: CreatorPostCandidate,
			signal: AbortSignal,
		) => resolveCreatorPost(candidate, signal, load),
		verifyCreatorPost,
		listening: {
			start: (
				_candidate: CreatorPostCandidate,
				options: {
					onRequest: (request: PlaybackRequest) => void
					validateVideo: (video: ListeningVideo) => void
				},
			) =>
				playbackIntent.run({
					preparation,
					onRequest: options.onRequest,
					prepare: async () => {
						const actual = await load()
						options.validateVideo(actual)
						return actual.parts[0].source
					},
					activate: async (value) => {
						activated.push({ mode: 'listening', source: value })
						return true
					},
					onSuccess: () => {},
				}),
		},
		setSourceRequestBv: () => {},
		setNotice: () => {},
		setFullPlayer: (value: boolean) => {
			scope.fullPlayer = value
			toggles.push(value)
		},
		playerPresentation: { current: 0 },
		playerReadingBack: { current: null as (() => boolean) | null },
		creatorPlayerReturn: { current: false },
		fmPlayerReturn: { current: false },
		readNativePlayerIdentity: async () => ({
			mode: 'music',
			sourceId: null,
			entryId: null,
		}),
		fullPlayer: false,
		sheet: null,
		tab: 'library',
		searchReturnTab: null,
		listeningLibraryOpen: false,
		homeChannel: 'music',
		playlists: {
			state: { currentId: null, editing: false },
			session: { close: () => {}, setEditing: () => {} },
		},
		setListeningLibraryOpen: () => {},
		setSearchReturnTab: () => {},
		setFilter: (value: string) => {
			filters.push(value)
		},
		setQuery: () => {},
		find: () => assert.fail('No implicit search request'),
		profileSettingsOpen: false,
		setProfileSettingsOpen: () => {},
		setCollectionOrigin: () => {},
		setLibraryCollection: () => {},
		setTab: (value: string) => {
			scope.tab = value
		},
		query: '',
		filter: 'all',
		setHomeChannel: () => {},
		workshop: { session: { close: () => {} } },
		setSheet: () => {},
		closeFm: () => {},
	}
	const filters: string[] = []
	const functions = [
		'playFollowingPost',
		'openFollowingFeed',
		'openFollowingCreator',
		'navigateSearch',
		'closePlayer',
		'openRecommendations',
		'openFm',
		'openImportHub',
		'openBilibiliImport',
		'openBilibiliTask',
		'openVideoLibrary',
	]
		.map(declaration)
		.join('\n')
	const api = runInNewContext(
		compile(
			`${functions}\n({playFollowingPost,openFollowingFeed,openFollowingCreator,navigateSearch,closePlayer,openRecommendations,openFm,openImportHub,openBilibiliImport,openBilibiliTask,openVideoLibrary,back:${actualHandler('back')},navigation:${actualHandler('navigation')},mini:${actualHandler('mini')},widget:${actualHandler('widget')}})`,
		),
		scope,
	) as {
		playFollowingPost: (bvid: string, mode: 'music' | 'listening') => void
		openFollowingFeed: () => void
		openFollowingCreator: (creator?: typeof f.creator) => void
		navigateSearch: (value?: string, mode?: string, returnTab?: string) => void
		closePlayer: () => Promise<void>
		openRecommendations: () => void
		openFm: () => void
		openImportHub: () => void
		openBilibiliImport: () => void
		openBilibiliTask: (taskId: string) => void
		openVideoLibrary: (bucket: string) => void
		back: () => boolean
		navigation: (destination: string) => void
		mini: () => void
		widget: () => void
	}
	return {
		...f,
		api,
		scope,
		filters,
		activated,
		toggles,
		changeVideo: (value: ListeningVideo) => {
			video = value
		},
		video: () => video,
		deferLoad: (value: () => Promise<ListeningVideo>) => {
			load = value
		},
	}
}

void test('actual App feed entry/Back/nav are mutually exclusive and UP search routes without implicit remote reads', () => {
	const f = fixture()
	try {
		for (const other of [
			f.scope.imports,
			f.scope.biliImports,
			f.scope.videoLibrary,
			f.scope.recommendations,
			f.scope.fm,
		]) {
			other.state.open = true
			other.state.route = 'open'
		}
		f.api.openFollowingFeed()
		assert.equal(f.session.getSnapshot().open, true)
		assert.ok(
			[
				f.scope.imports,
				f.scope.biliImports,
				f.scope.videoLibrary,
				f.scope.recommendations,
				f.scope.fm,
			].every((value) => !value.state.open && value.state.route === 'closed'),
		)
		assert.equal(f.activated.length, 0)
		for (const destination of [
			f.api.openRecommendations,
			f.api.openFm,
			f.api.openImportHub,
			f.api.openBilibiliImport,
			() => f.api.openBilibiliTask('task'),
			() => f.api.openVideoLibrary('listening'),
		]) {
			f.api.openFollowingFeed()
			destination()
			assert.equal(f.session.getSnapshot().open, false)
		}
		f.api.openFollowingFeed()
		assert.equal(f.api.back(), true)
		assert.equal(f.session.getSnapshot().open, false)
		f.api.openFollowingFeed()
		f.api.navigation('home')
		assert.equal(f.session.getSnapshot().open, false)
		assert.equal(f.scope.tab, 'home')
		f.api.openFollowingFeed()
		f.api.navigateSearch(undefined, 'creator', 'library')
		assert.deepEqual(f.filters, ['creator'])
		assert.equal(f.scope.tab, 'search')
		assert.equal(f.session.getSnapshot().open, false)
	} finally {
		f.raw.close()
	}
})

void test('actual App music/listening callbacks validate the original BV and never require a profile route; closing player preserves feed filter/scroll', async () => {
	const f = fixture()
	try {
		f.api.openFollowingFeed()
		f.session.rememberScroll(420)
		f.api.playFollowingPost(f.post.bvid, 'music')
		await settle()
		assert.equal(f.scope.fullPlayer, true)
		assert.equal(
			f.activated[0].source.uploaderId,
			99,
			'query mid 88 must not impersonate the verified view owner',
		)
		assert.equal(f.activated[0].source.originalTitle, 'view已核验标题')
		assert.equal(f.scope.creators.session.getSnapshot().routes.length, 0)
		await f.api.closePlayer()
		assert.equal(f.scope.fullPlayer, false)
		assert.equal(f.session.getSnapshot().open, true)
		assert.equal(f.session.getScrollOffset(), 420)
		f.api.playFollowingPost(f.post.bvid, 'listening')
		await settle()
		assert.deepEqual(
			f.activated.map((value) => value.mode),
			['music', 'listening'],
		)
		assert.equal(f.scope.fullPlayer, true)
		assert.equal(f.api.back(), true)
		await settle()
		assert.equal(f.scope.fullPlayer, false)
		assert.equal(f.session.getSnapshot().open, true)
		assert.equal(
			f.activated.length,
			2,
			'header/system close must never call playback controls',
		)
		f.changeVideo({ ...f.video(), bvid: 'BV11UBfBMEfQ' })
		f.api.playFollowingPost(f.post.bvid, 'listening')
		await settle()
		assert.equal(f.scope.fullPlayer, false)
		assert.equal(f.activated.length, 2)
		assert.match(f.session.getSnapshot().playError, /身份不匹配/)
	} finally {
		f.raw.close()
	}
})

void test('actual App opening UP profile or management cancels a late feed activation rather than letting it open the player', async () => {
	for (const management of [false, true]) {
		const f = fixture()
		let resolve!: (value: ListeningVideo) => void
		const metadata = new Promise<ListeningVideo>((yes) => {
			resolve = yes
		})
		try {
			f.api.openFollowingFeed()
			f.deferLoad(() => metadata)
			f.api.playFollowingPost(f.post.bvid, 'music')
			await settle()
			f.api.openFollowingCreator(management ? undefined : f.creator)
			assert.equal(f.session.getSnapshot().overlay, true)
			resolve(f.video())
			await settle()
			assert.equal(f.activated.length, 0)
			assert.equal(f.scope.fullPlayer, false)
			assert.equal(f.session.getSnapshot().playingBvid, null)
		} finally {
			f.raw.close()
		}
	}
})

void test('actual mini-player and Widget navigation cancel only the pending feed preparation and keep the browsing page', async () => {
	for (const target of ['mini', 'widget'] as const) {
		const f = fixture()
		let resolve!: (value: ListeningVideo) => void
		const metadata = new Promise<ListeningVideo>((yes) => {
			resolve = yes
		})
		try {
			f.api.openFollowingFeed()
			f.session.rememberScroll(270)
			f.deferLoad(() => metadata)
			f.api.playFollowingPost(f.post.bvid, 'music')
			await settle()
			f.api[target]()
			assert.equal(f.scope.fullPlayer, true)
			resolve(f.video())
			await settle()
			assert.equal(f.activated.length, 0)
			assert.equal(f.session.getSnapshot().open, true)
			assert.equal(f.session.getSnapshot().playingBvid, null)
			await f.api.closePlayer()
			assert.equal(f.session.getScrollOffset(), 270)
		} finally {
			f.raw.close()
		}
	}
})
