import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { Library, migrate, type Database } from '../core/database'
import { sourceId, type Source } from '../core/model'
import {
	RecommendationStore,
	recommendationSettingKey,
	type DismissedRecommendation,
	type RecommendationSnapshot,
} from '../core/recommendations'
import { builtInThemes } from '../core/theme'
import { PlaybackIntent } from '../playback-intent'
import { RecommendationSession } from '../recommendation-session'

const source = (cid: number): Source => ({
	id: sourceId('BV1vT411i7ET', cid),
	bvid: 'BV1vT411i7ET',
	cid,
	originalTitle: `真实音源${cid}`,
	uploader: '原UP',
	uploaderId: 88,
	performer: null,
	artwork: 'https://example.invalid/cover',
	duration: 120,
	domain: 'music',
	audioAvailability: 'unknown',
})
const snapshot = (): RecommendationSnapshot => ({
	localDate: '2026-10-19',
	revision: 1,
	items: [{ source: source(99), reasons: ['liked'] }],
	canUndo: true,
})
function fixture(count = 21) {
	let entries: DismissedRecommendation[] = Array.from(
		{ length: count },
		(_, index) => ({
			sourceId: source(index + 1).id,
			source: index === 0 ? null : source(index + 1),
			dismissedAt: 1700000000000 - index,
		}),
	)
	const pages: number[] = [],
		restored: string[] = []
	let loads = 0,
		resets = 0
	const store = {
		load: () => {
			loads++
			return snapshot()
		},
		refresh: () => snapshot(),
		dismiss: () => snapshot(),
		undo: () => snapshot(),
		listDismissed: (page = 1, pageSize = 20) => {
			pages.push(page)
			return {
				items: entries.slice((page - 1) * pageSize, page * pageSize),
				page,
				pageSize,
				total: entries.length,
				totalPages: Math.ceil(entries.length / pageSize),
			}
		},
		restoreSource: (id: string) => {
			restored.push(id)
			entries = entries.filter((item) => item.sourceId !== id)
			return snapshot()
		},
		resetLocalRecommendations: () => {
			resets++
			entries = []
			return { ...snapshot(), revision: 0, canUndo: false }
		},
	}
	const session = new RecommendationSession(store)
	session.open()
	return {
		session,
		store,
		pages,
		restored,
		loads: () => loads,
		resets: () => resets,
	}
}
function restore(f: ReturnType<typeof fixture>, id: string) {
	return f.session.restoreSource(id, f.session.getSnapshot().feedbackRevision)
}
function compile(input: string) {
	return ts.transpileModule(input, {
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
type AlertButton = { text: string; onPress: () => void }
function render(f: ReturnType<typeof fixture>, theme = builtInThemes.modern) {
	const alerts: { title: string; message: string; buttons: AlertButton[] }[] =
		[]
	const react = {
		createElement: (
			type: string | ((props: unknown) => Node),
			props: Record<string, unknown>,
			...children: unknown[]
		): Node =>
			typeof type === 'function'
				? type({ ...props, children })
				: { type, props: props ?? {}, children },
		Fragment: 'Fragment',
	}
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
				name === './theme-dialog'
					? { useThemeDialog: () => ({ dialog: null, show: (title: string, message: string, buttons: AlertButton[]) => alerts.push({ title, message, buttons }) }) }
					: name === 'react'
					? { __esModule: true, default: react, ...react }
					: name === 'react-native'
						? {
								Pressable: 'Pressable',
								ScrollView: 'ScrollView',
								View: 'View',
							}
						: {
								Artwork: 'Artwork',
								Button: 'Button',
								Card: 'Card',
								IconButton: 'IconButton',
								State: 'State',
								T: 'T',
								time: () => '2:00',
								useTheme: () => theme,
								useThemeRendering: () => null,
								ControlRow: 'View',
								ControlTarget: 'Pressable',
							},
		},
	)
	const tree = output.RecommendationPage!({
		state: f.session.getSnapshot(),
		session: f.session,
		onPlay: () => assert.fail('management cannot play'),
	})
	return { tree, alerts }
}
function nodes(value: unknown): Node[] {
	if (Array.isArray(value)) return value.flatMap(nodes)
	return value && typeof value === 'object' && 'children' in value
		? [value as Node, ...nodes((value as Node).children)]
		: []
}
function text(value: unknown): string {
	if (Array.isArray(value)) return value.map(text).join('')
	if (value && typeof value === 'object' && 'children' in value)
		return text((value as Node).children)
	return typeof value === 'string' || typeof value === 'number'
		? String(value)
		: ''
}
const press = (node: Node) => (node.props.onPress as () => void)()

void test('feedback management reads real 20-item pages and revalidates the daily snapshot on return', () => {
	const f = fixture()
	assert.equal(f.session.openDismissed(), true)
	assert.equal(f.session.getSnapshot().feedbackPage!.items.length, 20)
	assert.equal(f.session.getSnapshot().feedbackPage!.items[0].source, null)
	assert.equal(f.session.loadDismissed(2), true)
	assert.equal(f.session.getSnapshot().feedbackPage!.items.length, 1)
	assert.deepEqual(f.pages, [1, 2])
	f.session.back()
	assert.equal(f.session.getSnapshot().view, 'daily')
	assert.equal(f.session.getSnapshot().open, true)
	assert.equal(f.loads(), 2)
	f.session.back()
	assert.equal(f.session.getSnapshot().open, false)
})

void test('failed initial/list pagination keeps an honest unknown or prior list; retry reads the requested page', () => {
	const f = fixture(),
		read = f.store.listDismissed
	f.store.listDismissed = () => {
		throw new Error('local list unavailable')
	}
	assert.equal(f.session.openDismissed(), false)
	assert.equal(f.session.getSnapshot().feedbackPage, null)
	assert.match(f.session.getSnapshot().feedbackError, /local list unavailable/)
	f.store.listDismissed = read
	assert.equal(f.session.loadDismissed(), true)
	const previous = f.session.getSnapshot().feedbackPage
	f.store.listDismissed = () => {
		throw new Error('page two failed')
	}
	assert.equal(f.session.loadDismissed(2), false)
	assert.equal(f.session.getSnapshot().feedbackPage, previous)
	assert.equal(f.session.getSnapshot().feedbackStale, true)
	f.store.listDismissed = read
	assert.equal(f.session.loadDismissed(), true)
	assert.equal(f.session.getSnapshot().feedbackPage!.page, 2)
})

void test('restoring the last second-page item succeeds without inserting it into the current daily snapshot', () => {
	const f = fixture()
	f.session.openDismissed()
	f.session.loadDismissed(2)
	const id = f.session.getSnapshot().feedbackPage!.items[0].sourceId
	assert.equal(restore(f, id), true)
	assert.deepEqual(f.restored, [id])
	assert.deepEqual(f.pages, [1, 2, 1])
	assert.equal(f.session.getSnapshot().feedbackPage!.total, 20)
	assert.equal(f.session.getSnapshot().feedbackPage!.page, 1)
	assert.deepEqual(
		f.session.getSnapshot().snapshot!.items.map((item) => item.source.id),
		[source(99).id],
	)
	assert.match(f.session.getSnapshot().notice, /不保证立即/)
})

void test('successful restoration followed by a list read failure stays successful and marks old pagination stale', () => {
	const f = fixture(2),
		read = f.store.listDismissed
	f.session.openDismissed()
	f.store.listDismissed = () => {
		throw new Error('post-commit read failed')
	}
	assert.equal(restore(f, source(1).id), true)
	assert.match(f.session.getSnapshot().notice, /已恢复/)
	assert.match(
		f.session.getSnapshot().feedbackError,
		/恢复已成功，列表刷新失败/,
	)
	assert.equal(f.session.getSnapshot().feedbackStale, true)
	const page = render(f).tree
	assert.match(text(page), /分页统计已过期/)
	assert(
		!nodes(page).some(
			(node) => node.props.label === `恢复此音源 ${source(1).id}`,
		),
	)
	assert(!text(page).includes('共 2 条反馈'))
	assert(
		!nodes(page).some((node) => node.props.title === '还没有不感兴趣的音源'),
	)
	assert.equal(restore(f, source(2).id), false)
	f.store.listDismissed = read
	assert.equal(f.session.loadDismissed(), true)
	assert.equal(f.session.getSnapshot().feedbackPage!.total, 1)
	assert.equal(f.session.getSnapshot().feedbackStale, false)
})

void test('failed restoration preserves successful contents and does not issue an extra page read', () => {
	const f = fixture(1)
	f.session.openDismissed()
	const page = f.session.getSnapshot().feedbackPage,
		value = f.session.getSnapshot().snapshot
	f.store.restoreSource = () => {
		throw new Error('write failed')
	}
	assert.equal(restore(f, source(1).id), false)
	assert.equal(f.session.getSnapshot().feedbackPage, page)
	assert.equal(f.session.getSnapshot().snapshot, value)
	assert.deepEqual(f.pages, [1])
	assert.equal(f.session.getSnapshot().notice, '')
})

void test('restoring the only feedback followed by a read failure is stale, not a falsely verified empty list', () => {
	const f = fixture(1),
		read = f.store.listDismissed
	f.session.openDismissed()
	f.store.listDismissed = () => {
		throw new Error('last-row refresh failed')
	}
	assert.equal(restore(f, source(1).id), true)
	const page = render(f).tree
	assert.match(text(page), /恢复已成功，列表刷新失败/)
	assert.match(text(page), /分页统计已过期/)
	assert(
		!nodes(page).some((node) => node.props.title === '还没有不感兴趣的音源'),
	)
	assert(!text(page).includes('共 0 条反馈'))
	f.store.listDismissed = read
	assert.equal(f.session.loadDismissed(), true)
	assert(
		nodes(render(f).tree).some(
			(node) => node.props.title === '还没有不感兴趣的音源',
		),
	)
})

void test('closed or reopened management rejects old restore callbacks even for the same Source', () => {
	const f = fixture(1)
	f.session.openDismissed()
	const old = nodes(render(f).tree).find(
		(node) => node.props.label === `恢复此音源 ${source(1).id}`,
	)!
	f.session.close()
	f.session.open()
	f.session.openDismissed()
	press(old)
	assert.deepEqual(f.restored, [])
	assert.equal(restore(f, source(1).id), true)
})

void test('reset confirmation cancellation, stale callbacks and duplicate confirmation cannot reset newer state', () => {
	const f = fixture(2)
	f.session.openDismissed()
	const cancel = f.session.prepareReset()!
	assert.equal(cancel(false), false)
	assert.equal(f.resets(), 0)
	const old = f.session.prepareReset()!
	f.session.close()
	f.session.open()
	f.session.openDismissed()
	const current = f.session.prepareReset()!
	assert.equal(old(true), false)
	assert.equal(old(false), false)
	assert.equal(f.session.getSnapshot().resetConfirming, true)
	const reads = f.pages.length
	assert.equal(current(true), true)
	assert.equal(current(true), false)
	assert.equal(f.resets(), 1)
	assert.equal(
		f.pages.length,
		reads,
		'committed reset needs no post-write list read',
	)
	assert.equal(f.session.getSnapshot().feedbackPage!.total, 0)
	assert.equal(f.session.getSnapshot().snapshot!.canUndo, false)
})

void test('failed reset retains the previous list and snapshot without a fake success notice', () => {
	const f = fixture(2)
	f.session.openDismissed()
	const page = f.session.getSnapshot().feedbackPage,
		value = f.session.getSnapshot().snapshot
	f.store.resetLocalRecommendations = () => {
		throw new Error('bad settings preserved')
	}
	assert.equal(f.session.prepareReset()!(true), false)
	assert.equal(f.session.getSnapshot().feedbackPage, page)
	assert.equal(f.session.getSnapshot().snapshot, value)
	assert.equal(f.session.getSnapshot().notice, '')
	assert.match(f.session.getSnapshot().error, /bad settings preserved/)
})

void test('entering management cancels only owned preparation and never stops completed playback or a newer intent', async () => {
	for (const stage of ['pending', 'completed', 'newer'] as const) {
		const f = fixture(),
			intent = new PlaybackIntent()
		let finish!: (value: boolean) => void,
			cancelled = 0,
			opened = 0
		const result = f.session.play(
			source(99).id,
			async (_, own) => {
				const request = intent.begin()
				own({
					...request,
					cancel: () => {
						const owned = request.cancel()
						if (owned) cancelled++
						return owned
					},
				})
				return new Promise<boolean>((yes) => {
					finish = yes
				})
			},
			() => {
				opened++
			},
		)
		if (stage === 'completed') {
			finish(true)
			await result
		}
		if (stage === 'newer') intent.begin()
		f.session.openDismissed()
		finish(true)
		await result
		assert.equal(cancelled, stage === 'pending' ? 1 : 0)
		assert.equal(opened, stage === 'completed' ? 1 : 0)
	}
})

void test('three themes show source-null identity, real titles, 20-row pagination, explicit reset scope and guarded confirmation', () => {
	for (const theme of Object.values(builtInThemes)) {
		const f = fixture()
		const daily = render(f, theme)
		press(
			nodes(daily.tree).find(
				(node) => node.props.testID === 'manage-dismissed-recommendations',
			)!,
		)
		const view = render(f, theme)
		assert.match(text(view.tree), /音源已不在本机/)
		assert.match(text(view.tree), /bilibili:BV1vT411i7ET:1/)
		assert.match(text(view.tree), /真实音源2/)
		assert.equal(
			nodes(view.tree).filter((node) =>
				String(node.props.label).startsWith('恢复此音源 '),
			).length,
			20,
		)
		assert(!text(view.tree).includes('清空行为历史'))
		press(
			nodes(view.tree).find(
				(node) => node.type === 'Button' && text(node) === '重置本地推荐',
			)!,
		)
		assert.equal(view.alerts.length, 1)
		assert.match(
			view.alerts[0].message,
			/不会删除喜欢、歌单、关注，也不会更改播放/,
		)
		assert.equal(f.resets(), 0)
		f.session.close()
		f.session.open()
		f.session.openDismissed()
		view.alerts[0].buttons
			.find((button) => button.text === '确认重置本地推荐')!
			.onPress()
		assert.equal(f.resets(), 0)
	}
})

void test('actual App hardware returns management to daily; the same header does so, while bottom navigation closes', () => {
	const tree = ts.createSourceFile(
		'App.tsx',
		readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	let hardware = '',
		navigation = ''
	function visit(node: ts.Node) {
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(tree) === 'BackHandler.addEventListener'
		)
			hardware = node.arguments[1].getText(tree)
		if (
			(ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
			node.tagName.getText(tree) === 'HostPlaybackFooter'
		) {
			const props = node.attributes.properties
			const handler = props.find(
				(prop) =>
					ts.isJsxAttribute(prop) && prop.name.getText(tree) === 'onNavigate',
			)
			if (
				handler &&
				ts.isJsxAttribute(handler) &&
				handler.initializer &&
				ts.isJsxExpression(handler.initializer) &&
				handler.initializer.expression
			)
				navigation = handler.initializer.expression.getText(tree)
		}
		ts.forEachChild(node, visit)
	}
	visit(tree)
	assert(hardware && navigation)
	for (const action of ['hardware', 'header', 'navigation']) {
		const f = fixture()
		const tabs: string[] = []
		f.session.openDismissed()
		const actions = runInNewContext(
			compile(
				`globalThis.actions = {hardware:${hardware},navigation:${navigation}}`,
			) + '\nactions',
			{
				exports: {},
				sheet: null,
				fullPlayer: false,
				player: { auditionId: null },
				fm: { state: { open: false }, session: { close: () => {} } },
				followingFeed: { state: { open: false }, session: { close: () => {} } },
				recommendations: {
					get state() {
						return f.session.getSnapshot()
					},
					session: f.session,
				},
				imports: { session: { close: () => {} } },
				biliImports: { session: { close: () => {} } },
				videoLibrary: { session: { close: () => {} } },
				setListeningLibraryOpen: () => {},
				profileSettingsOpen: false,
				setProfileSettingsOpen: () => {},
				setCollectionOrigin: () => {},
		setLibraryCollection: () => {},
		setTab: (tab: string) => tabs.push(tab),
			},
		) as { hardware: () => boolean; navigation: (tab: string) => void }
		if (action === 'hardware') assert.equal(actions.hardware(), true)
		else if (action === 'header')
			press(
				nodes(render(f).tree).find(
					(node) => node.props.label === '返回每日推荐',
				)!,
			)
		else actions.navigation('library')
		assert.deepEqual(tabs, action === 'navigation' ? ['library'] : [])
		assert.equal(f.session.getSnapshot().open, action !== 'navigation')
		if (action !== 'navigation')
			assert.equal(f.session.getSnapshot().view, 'daily')
	}
})

void test('real SQLite restore survives a post-commit list failure and reopening; corrupt reset preserves exact settings', () => {
	const folder = mkdtempSync(join(tmpdir(), 'melo-feedback-ui-')),
		file = join(folder, 'library.sqlite')
	function open() {
		const raw = new DatabaseSync(file)
		const db: Database = {
			execSync: (sql) => raw.exec(sql),
			runSync: (sql, values) => raw.prepare(sql).run(...values),
			getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
				(raw.prepare(sql).get(...values) as T) ?? null,
			getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
				raw.prepare(sql).all(...values) as T[],
		}
		migrate(db)
		return { raw, db }
	}
	let current = open()
	try {
		const library = new Library(current.db)
		library.setLiked(source(1), true)
		const store = new RecommendationStore(
			current.db,
			() => new Date(2026, 9, 19),
		)
		store.load()
		store.dismiss(source(1).id)
		let fail = false
		const session = new RecommendationSession({
			load: () => store.load(),
			refresh: () => store.refresh(),
			dismiss: (id) => store.dismiss(id),
			undo: () => store.undo(),
			restoreSource: (id) => store.restoreSource(id),
			resetLocalRecommendations: () => store.resetLocalRecommendations(),
			listDismissed: (page, size) => {
				if (fail) throw new Error('read after restore')
				return store.listDismissed(page, size)
			},
		})
		session.open()
		session.openDismissed()
		fail = true
		assert.equal(
			session.restoreSource(
				source(1).id,
				session.getSnapshot().feedbackRevision,
			),
			true,
		)
		assert.match(session.getSnapshot().feedbackError, /恢复已成功/)
		current.raw.close()
		current = open()
		let today = new Date(2026, 9, 19)
		const reopened = new RecommendationStore(current.db, () => today)
		assert.equal(reopened.listDismissed().total, 0)
		assert.equal(new Library(current.db).likes().length, 1)
		const clean = new RecommendationSession(reopened)
		clean.open()
		clean.openDismissed()
		today = new Date(2026, 9, 20)
		clean.back()
		assert.equal(clean.getSnapshot().snapshot!.localDate, '2026-10-20')
		clean.openDismissed()
		const previous = clean.getSnapshot().snapshot,
			load = reopened.load.bind(reopened)
		reopened.load = () => {
			throw new Error('daily return read failed')
		}
		clean.back()
		assert.equal(clean.getSnapshot().view, 'daily')
		assert.equal(clean.getSnapshot().snapshot, previous)
		assert.equal(clean.getSnapshot().error, 'daily return read failed')
		reopened.load = load
		clean.openDismissed()
		new Library(current.db).setSetting(
			recommendationSettingKey,
			'{broken retained bytes',
		)
		assert.equal(clean.prepareReset()!(true), false)
		assert.equal(
			new Library(current.db).setting(recommendationSettingKey),
			'{broken retained bytes',
		)
	} finally {
		current.raw.close()
		rmSync(folder, { recursive: true })
	}
})
