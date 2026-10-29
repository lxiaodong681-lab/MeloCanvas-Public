import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { BilibiliContentScopeReader } from '../core/bilibili-content-scope'
import {
	CreatorPostCache,
	type CreatorPostCacheResponse,
} from '../core/creator-post-cache'
import { CreatorStore, type Creator } from '../core/creators'
import { Library, migrate, type Database } from '../core/database'
import { builtInThemes } from '../core/theme'
import type { CreatorPostCandidate } from '../creator-api'
import {
	CreatorRemoteSession,
	type CreatorRemoteState,
} from '../creator-remote-session'
import { CreatorSession } from '../creator-session'

const post = (index = 1, mid = '88'): CreatorPostCandidate => ({
	bvid: `BV${String(index).padStart(10, '0')}`,
	title: `真实投稿${index}`,
	artwork: 'https://example.invalid/cover',
	duration: 120,
	publishedAt: 1700000000000,
	queryCreatorMid: mid,
	ownerMid: '99',
})
const profile = (mid = '88'): Creator => ({
	source: 'bilibili',
	mid,
	name: `UP${mid}`,
	fetchedAt: 1000,
})
const page = (
	number = 1,
	total = 32,
	offset = 0,
	mid = '88',
): CreatorPostCacheResponse => ({
	page: number,
	total,
	more: number < Math.ceil(total / 30),
	items: Array.from(
		{ length: Math.max(0, Math.min(30, total - (number - 1) * 30)) },
		(_, index) => post(offset + index + 1, mid),
	),
})
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
function fixture(file = ':memory:') {
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
	const scopes = new BilibiliContentScopeReader(db),
		cache = new CreatorPostCache(db),
		calls: number[] = []
	const api = {
		profile: async (mid: string) => profile(mid),
		posts: async (mid: string, number: number, _signal: AbortSignal) => {
			calls.push(number)
			return page(number, 32, number === 1 ? 0 : 29, mid)
		},
	}
	let now = 5000
	const remote = new CreatorRemoteSession(
		api,
		() => {},
		cache,
		scopes,
		() => now,
	)
	const seed = () => {
		const first = cache.savePage('88', page(), 1000, null)
		return cache.savePage('88', page(2, 32, 29), 2000, first.revision)
	}
	return {
		raw,
		db,
		cache,
		scopes,
		api,
		remote,
		calls,
		seed,
		now: (value: number) => {
			now = value
		},
	}
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
function render(
	remote: CreatorRemoteSession,
	theme = builtInThemes.modern,
	readDetailsOpen = false,
) {
	let stateIndex = 0
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
		useState: () => [stateIndex++ === 0 ? readDetailsOpen : false, () => {}],
	}
	const output: { CreatorPostsRead?: (props: unknown) => Node } = {}
	runInNewContext(
		compile(
			readFileSync(
				new URL('../creator-remote-ui.tsx', import.meta.url),
				'utf8',
			),
		),
		{
			exports: output,
			require: (name: string) =>
				name === 'react'
					? { __esModule: true, default: react, ...react }
					: name === 'react-native'
						? { Pressable: 'Pressable', View: 'View' }
						: name === './creator-ui'
							? { CreatorAvatar: 'CreatorAvatar' }
							: {
									Artwork: 'Artwork',
									Button: 'Button',
									Card: 'Card',
									State: 'State',
									T: 'T',
									useTheme: () => theme,
									ControlRow: 'View',
									ControlTarget: 'Pressable',
									shape: () => ({}),
									time: () => '2:00',
								},
		},
	)
	return output.CreatorPostsRead!({
		state: remote.getSnapshot(),
		session: remote,
		playbackBusy: false,
		onPlay: () => assert.fail('render cannot play'),
	})
}
function nodes(value: unknown): Node[] {
	if (Array.isArray(value)) return value.flatMap(nodes)
	return value && typeof value === 'object' && 'children' in value
		? [value as Node, ...nodes((value as Node).children)]
		: []
}
function labels(value: unknown): string {
	if (Array.isArray(value)) return value.map(labels).join('')
	if (value && typeof value === 'object' && 'children' in value)
		return labels((value as Node).children)
	return typeof value === 'string' || typeof value === 'number'
		? String(value)
		: ''
}

const equal = (left: unknown[], right: unknown[]) =>
	left.length === right.length &&
	left.every((value, index) => value === right[index])

function hookFixture(f: ReturnType<typeof fixture>) {
	const memo: { deps: unknown[]; value: unknown }[] = [],
		effects: {
			deps: unknown[]
			setup: () => () => void
			cleanup: () => void
		}[] = []
	let memoIndex = 0,
		effectIndex = 0,
		listeners = 0,
		lag: CreatorRemoteState | null = null
	class ObservedSession extends CreatorSession {
		constructor(...args: ConstructorParameters<typeof CreatorSession>) {
			super(...args)
			const subscribe = this.subscribe
			this.subscribe = (listener) => {
				listeners++
				const unsubscribe = subscribe(listener)
				let live = true
				return () => {
					if (live) {
						live = false
						listeners--
						unsubscribe()
					}
				}
			}
		}
	}
	const output: { useCreators?: typeof import('../useCreators').useCreators } =
		{}
	runInNewContext(
		compile(
			readFileSync(new URL('../useCreators.ts', import.meta.url), 'utf8'),
		),
		{
			exports: output,
			require: (name: string) =>
				name === 'react'
					? {
							useMemo: (create: () => unknown, deps: unknown[]) => {
								const index = memoIndex++
								if (!memo[index] || !equal(memo[index].deps, deps))
									memo[index] = { deps, value: create() }
								return memo[index].value
							},
							useSyncExternalStore: (
								_: unknown,
								get: () => Record<string, unknown>,
							) => {
								const value = get()
								return lag && 'postsLoading' in value ? lag : value
							},
							useEffect: (setup: () => () => void, deps: unknown[]) => {
								const index = effectIndex++
								if (!effects[index] || !equal(effects[index].deps, deps)) {
									effects[index]?.cleanup()
									effects[index] = { deps, setup, cleanup: setup() }
								}
							},
						}
					: name === './creator-api'
						? {
								creatorPosts: (...args: Parameters<typeof f.api.posts>) =>
									f.api.posts(...args),
								creatorProfile: (mid: string) => f.api.profile(mid),
							}
						: name === './creator-session'
							? { CreatorSession: ObservedSession }
							: { CreatorRemoteSession },
		},
	)
	const store = new CreatorStore(f.db),
		library = new Library(f.db)
	const renderHook = () => {
		memoIndex = 0
		effectIndex = 0
		return output.useCreators!(store, library, f.cache, f.scopes)
	}
	return {
		renderHook,
		store,
		listeners: () => listeners,
		setLag: (value: CreatorRemoteState | null) => {
			lag = value
		},
		replay: () => {
			for (const effect of effects) {
				effect.cleanup()
				effect.cleanup = effect.setup()
			}
		},
		dispose: () => {
			for (const effect of effects) effect.cleanup()
		},
	}
}

void test('opening/reopening restores real pages/timestamps without network, deduplicates display only and never saves a Source', () => {
	const dir = mkdtempSync(join(tmpdir(), 'melo-post-ui-')),
		file = join(dir, 'cache.sqlite')
	let f = fixture(file)
	try {
		f.seed()
		f.raw.close()
		f = fixture(file)
		const before = f.raw.prepare('SELECT total_changes() n').get()!.n
		f.remote.select('88')
		assert.equal(f.raw.prepare('SELECT total_changes() n').get()!.n, before)
		assert.deepEqual(f.calls, [])
		assert.equal(f.remote.getSnapshot().posts.length, 31)
		assert.equal(f.remote.getSnapshot().page, 2)
		assert.deepEqual(f.remote.getSnapshot().postsReadTimes, [
			{ page: 1, fetchedAt: 1000 },
			{ page: 2, fetchedAt: 2000 },
		])
		assert.equal(f.remote.getSnapshot().posts[0].ownerMid, '99')
		const displayed = labels(render(f.remote, builtInThemes.modern, true))
		assert.match(displayed, /第\s*2\s*页读取时间/)
		assert.doesNotMatch(displayed, /第\s*1\s*页读取时间/)
		assert.equal(
			f.cache.load('88')!.pages[1].items[0].bvid,
			f.cache.load('88')!.pages[0].items[29].bvid,
		)
		assert.equal(f.raw.prepare('SELECT count(*) n FROM sources').get()!.n, 0)
	} finally {
		f.raw.close()
		rmSync(dir, { recursive: true })
	}
})

void test('explicit page-one refresh replaces cached tail and uses committed return without a post-write read', async () => {
	const f = fixture()
	try {
		f.seed()
		f.remote.select('88')
		f.api.posts = async () => ({ ...page(1, 1, 80), items: [post(81)] })
		f.cache.load = () => {
			throw new Error('forbidden post-commit read')
		}
		await f.remote.readPosts()
		assert.equal(f.remote.getSnapshot().page, 1)
		assert.equal(f.remote.getSnapshot().posts[0].bvid, post(81).bvid)
		assert.deepEqual(f.remote.getSnapshot().postsReadTimes, [
			{ page: 1, fetchedAt: 5000 },
		])
		assert.equal(f.remote.getSnapshot().cacheError, '')
	} finally {
		f.raw.close()
	}
})

void test('network/restriction and cancellation preserve old cache/page/time; no retry happens automatically', async () => {
	const f = fixture()
	try {
		const original = f.seed()
		f.remote.select('88')
		f.api.posts = async () => {
			f.calls.push(1)
			throw new Error('HTTP 412')
		}
		await f.remote.readPosts()
		assert.deepEqual(f.cache.load('88'), original)
		assert.equal(f.remote.getSnapshot().page, 2)
		assert.match(f.remote.getSnapshot().postsError, /412/)
		assert.equal(f.remote.getSnapshot().cacheError, '')
		assert.deepEqual(f.calls, [1])
		const waiting = deferred<CreatorPostCacheResponse>()
		f.api.posts = () => waiting.promise
		const cancelled = f.remote.readPosts()
		f.remote.cancel()
		waiting.resolve(page(1, 1, 90))
		await cancelled
		assert.deepEqual(f.cache.load('88'), original)
		assert.equal(f.remote.getSnapshot().postsLoading, false)
	} finally {
		f.raw.close()
	}
})

void test('leave/reenter same mid rejects late old success/error/finally before cache.savePage', async () => {
	const f = fixture()
	try {
		const old = deferred<CreatorPostCacheResponse>(),
			current = deferred<CreatorPostCacheResponse>()
		let requests = 0,
			saves = 0
		const save = f.cache.savePage.bind(f.cache)
		f.cache.savePage = (...args) => {
			saves++
			return save(...args)
		}
		f.api.posts = () => (++requests === 1 ? old.promise : current.promise)
		f.remote.select('88')
		const first = f.remote.readPosts()
		f.remote.select(null)
		f.remote.select('88')
		const second = f.remote.readPosts()
		old.resolve(page(1, 1, 80))
		await first
		assert.equal(saves, 0)
		assert.equal(f.remote.getSnapshot().postsLoading, true)
		current.resolve(page(1, 1, 90))
		await second
		assert.equal(saves, 1)
		assert.equal(f.cache.load('88')!.pages[0].items[0].bvid, post(91).bvid)
	} finally {
		f.raw.close()
	}
})

void test('real SQLite save failure is distinct from successful network read and cannot advance page/time', async () => {
	const f = fixture()
	try {
		const original = f.seed()
		f.remote.select('88')
		f.raw.exec(
			"CREATE TRIGGER fail_post_cache BEFORE UPDATE ON creator_post_cache_heads BEGIN SELECT RAISE(ABORT,'local cache full'); END",
		)
		await f.remote.readPosts()
		assert.equal(f.remote.getSnapshot().postsError, '')
		assert.match(
			f.remote.getSnapshot().cacheError,
			/网络已返回第 1 页.*本地投稿缓存保存失败/,
		)
		assert.equal(f.remote.getSnapshot().failedPage, 1)
		assert.equal(f.remote.getSnapshot().page, 2)
		assert.deepEqual(f.remote.getSnapshot().postsReadTimes, [
			{ page: 1, fetchedAt: 1000 },
			{ page: 2, fetchedAt: 2000 },
		])
		assert.deepEqual(f.cache.load('88'), original)
		assert.deepEqual(f.calls, [1])
		f.raw.exec('DROP TRIGGER fail_post_cache')
		f.now(6000)
		await f.remote.retryPosts()
		assert.deepEqual(f.calls, [1, 1])
		assert.deepEqual(f.remote.getSnapshot().postsReadTimes, [
			{ page: 1, fetchedAt: 6000 },
		])
	} finally {
		f.raw.close()
	}
})

void test('CAS conflict reloads newer local cache, rejects the old response and requires explicit page-one refresh', async () => {
	const f = fixture()
	try {
		f.seed()
		f.remote.select('88')
		const old = deferred<CreatorPostCacheResponse>()
		f.api.posts = () => old.promise
		const reading = f.remote.readPosts()
		const newer = f.cache.savePage(
			'88',
			page(1, 1, 70),
			7000,
			f.cache.load('88')!.revision,
		)
		old.resolve(page(1, 1, 80))
		await reading
		assert.deepEqual(f.cache.load('88'), newer)
		assert.equal(f.remote.getSnapshot().posts[0].bvid, post(71).bvid)
		assert.equal(f.remote.getSnapshot().restartRequired, true)
		assert.equal(f.remote.getSnapshot().failedPage, null)
		assert.match(f.remote.getSnapshot().postsNotice, /本次旧结果未写入/)
		f.api.posts = async () => page(1, 1, 90)
		await f.remote.readPosts()
		assert.equal(f.remote.getSnapshot().restartRequired, false)
		assert.equal(f.remote.getSnapshot().posts[0].bvid, post(91).bvid)
	} finally {
		f.raw.close()
	}
})

void test('conflict reload failure preserves usable old rows and blocks network/save until a local reload succeeds', async () => {
	const f = fixture()
	try {
		f.seed()
		f.remote.select('88')
		const oldRows = f.remote.getSnapshot().posts,
			read = f.cache.load.bind(f.cache)
		let calls = 0
		f.api.posts = async () => {
			calls++
			return page(1, 1, 80)
		}
		f.cache.savePage('88', page(1, 1, 70), 7000, read('88')!.revision)
		f.cache.load = () => {
			throw new Error('cannot reload latest')
		}
		await f.remote.readPosts()
		assert.equal(f.remote.getSnapshot().cacheStatus, 'failed')
		assert.equal(f.remote.getSnapshot().posts, oldRows)
		await f.remote.readPosts()
		assert.equal(calls, 1)
		f.cache.load = read
		assert.equal(f.remote.reloadPostsCache(), true)
		assert.equal(calls, 1)
		await f.remote.readPosts()
		assert.equal(calls, 2)
	} finally {
		f.raw.close()
	}
})

void test('three themes distinguish uncached, real cached-empty, network error and cache-save failure without fake owners', async () => {
	const f = fixture()
	try {
		f.remote.select('88')
		for (const theme of Object.values(builtInThemes)) {
			const initial = render(f.remote, theme)
			assert.match(labels(initial), /尚无本地投稿缓存/)
			assert(
				!nodes(initial).some((node) =>
					String(node.props.title).includes('没有投稿'),
				),
			)
		}
		f.api.posts = async () => {
			throw new Error('voucher restricted')
		}
		await f.remote.readPosts()
		assert.match(labels(render(f.remote)), /voucher restricted/)
		assert(
			!nodes(render(f.remote)).some((node) =>
				String(node.props.title).includes('没有投稿'),
			),
		)
		f.api.posts = async () => page(1, 0)
		f.cache.savePage = () => {
			throw new Error('storage unavailable')
		}
		await f.remote.readPosts()
		assert.match(labels(render(f.remote)), /网络已返回.*本地投稿缓存保存失败/)
		assert(
			!nodes(render(f.remote)).some((node) =>
				String(node.props.title).includes('没有投稿'),
			),
		)
		const empty = fixture()
		try {
			empty.cache.savePage('88', page(1, 0), 1234, null)
			empty.remote.select('88')
			const view = render(empty.remote, builtInThemes.modern, true)
			assert(
				nodes(view).some(
					(node) => node.props.title === '已缓存的读取结果没有投稿',
				),
			)
			assert.match(labels(view), /本地缓存/)
			assert(labels(view).includes(new Date(1234).toLocaleString()))
			assert.match(labels(view), /不代表实时或完整投稿列表/)
		} finally {
			empty.raw.close()
		}
	} finally {
		f.raw.close()
	}
})

void test('actual useCreators selects cache only on explicit profile route and injects it without any network request', () => {
	const f = fixture(),
		hook = hookFixture(f)
	try {
		f.seed()
		const first = hook.renderHook()
		first.session.openSummary(profile())
		const selected = hook.renderHook()
		assert.equal(selected.remote.getSnapshot().page, 2)
		assert.deepEqual(f.calls, [])
		selected.session.back()
		hook.renderHook()
		assert.equal(selected.remote.getSnapshot().mid, null)
		assert.deepEqual(f.calls, [])
	} finally {
		hook.dispose()
		f.raw.close()
	}
})

void test('actual hook synchronously invalidates A→A, A→B→A and exit before React rerenders; late profile/posts never write', async () => {
	for (const transition of ['same', 'roundtrip', 'exit'] as const) {
		const f = fixture(),
			hook = hookFixture(f)
		try {
			const original = f.seed(),
				oldProfile = deferred<Creator>(),
				freshProfile = deferred<Creator>(),
				oldPosts = deferred<CreatorPostCacheResponse>(),
				freshPosts = deferred<CreatorPostCacheResponse>()
			let profiles = 0,
				posts = 0
			f.api.profile = () =>
				++profiles === 1 ? oldProfile.promise : freshProfile.promise
			f.api.posts = () =>
				++posts === 1 ? oldPosts.promise : freshPosts.promise
			const state = hook.renderHook()
			state.session.openSummary(profile())
			const visit = state.remote.getSnapshot().visit
			const before = [state.remote.refreshProfile(), state.remote.readPosts()]
			if (transition === 'exit') state.session.back()
			else {
				if (transition === 'roundtrip') state.session.openSummary(profile('99'))
				state.session.openSummary(profile())
			}
			assert.notEqual(state.remote.getSnapshot().visit, visit)
			assert.equal(state.remote.getSnapshot().postsLoading, false)
			const after =
				transition === 'exit'
					? []
					: [state.remote.refreshProfile(), state.remote.readPosts()]
			if (transition === 'roundtrip') {
				oldProfile.reject(new Error('old profile failure'))
				oldPosts.reject(new Error('old posts 412'))
			} else {
				oldProfile.resolve({ ...profile(), fetchedAt: 99999 })
				oldPosts.resolve(page(1, 1, 80))
			}
			await Promise.all(before)
			assert.deepEqual(f.cache.load('88'), original)
			assert.equal(hook.store.getCreator('88'), null)
			assert.equal(
				state.remote.getSnapshot().profileLoading,
				transition !== 'exit',
			)
			assert.equal(
				state.remote.getSnapshot().postsLoading,
				transition !== 'exit',
			)
			assert.equal(state.remote.getSnapshot().postsError, '')
			assert.equal(state.remote.getSnapshot().profileError, '')
			if (transition !== 'exit') {
				freshProfile.resolve({ ...profile(), fetchedAt: 2000 })
				freshPosts.resolve(page(1, 1, 90))
				await Promise.all(after)
				assert.equal(hook.store.getCreator('88')!.fetchedAt, 2000)
				assert.equal(f.cache.load('88')!.pages[0].items[0].bvid, post(91).bvid)
			}
		} finally {
			hook.dispose()
			f.raw.close()
		}
	}
})

void test('actual hook StrictMode cleanup/setup has one live listener and cancels discarded work; form/player state keeps the visit', async () => {
	const f = fixture(),
		hook = hookFixture(f)
	try {
		const original = f.seed(),
			profileRead = deferred<Creator>(),
			postsRead = deferred<CreatorPostCacheResponse>()
		f.api.profile = () => profileRead.promise
		f.api.posts = () => postsRead.promise
		const state = hook.renderHook()
		state.session.openSummary(profile())
		const before = [state.remote.refreshProfile(), state.remote.readPosts()]
		assert.equal(hook.listeners(), 1)
		hook.replay()
		hook.replay()
		assert.equal(hook.listeners(), 1)
		profileRead.resolve({ ...profile(), fetchedAt: 9999 })
		postsRead.resolve(page(1, 1, 80))
		await Promise.all(before)
		assert.deepEqual(f.cache.load('88'), original)
		assert.equal(hook.store.getCreator('88'), null)
		const currentProfile = deferred<Creator>(),
			currentPosts = deferred<CreatorPostCacheResponse>()
		f.api.profile = () => currentProfile.promise
		f.api.posts = () => currentPosts.promise
		const current = [state.remote.refreshProfile(), state.remote.readPosts()],
			visit = state.remote.getSnapshot().visit
		state.session.requestScope()
		state.session.closeForm()
		await state.session.presentPlayback(
			async () => true,
			() => {},
		)
		state.session.resumeFromPlayer()
		assert.equal(state.remote.getSnapshot().visit, visit)
		assert.equal(state.remote.getSnapshot().postsLoading, true)
		currentProfile.resolve({ ...profile(), fetchedAt: 3000 })
		currentPosts.resolve(page(1, 1, 90))
		await Promise.all(current)
		assert.equal(hook.store.getCreator('88')!.fetchedAt, 3000)
		assert.equal(f.cache.load('88')!.pages[0].items[0].bvid, post(91).bvid)
		hook.dispose()
		assert.equal(hook.listeners(), 0)
		state.session.openSummary(profile('99'))
		assert.equal(state.remote.getSnapshot().mid, null)
	} finally {
		hook.dispose()
		f.raw.close()
	}
})

void test('actual App readiness gates reject same-mid old React remote state until the precise visit catches up', () => {
	const f = fixture(),
		hook = hookFixture(f)
	try {
		f.seed()
		const initial = hook.renderHook()
		initial.session.openSummary(profile())
		const current = hook.renderHook(),
			stale = current.remoteState
		current.session.openSummary(profile())
		hook.setLag(stale)
		const lagged = hook.renderHook()
		assert.equal(lagged.remoteState.mid, lagged.state.creator!.mid)
		assert.equal(lagged.remoteReady, false)
		const tree = ts.createSourceFile(
			'App.tsx',
			readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		)
		const gates: string[] = []
		function visit(node: ts.Node) {
			if (
				ts.isConditionalExpression(node) &&
				/^\(\s*<Creator(?:Profile|Posts)Read/.test(node.whenTrue.getText(tree))
			)
				gates.push(node.condition.getText(tree))
			ts.forEachChild(node, visit)
		}
		visit(tree)
		assert.equal(gates.length, 2)
		for (const gate of gates)
			assert.equal(runInNewContext(compile(gate), { creators: lagged }), false)
		hook.setLag(null)
		const ready = hook.renderHook()
		assert.equal(ready.remoteReady, true)
		for (const gate of gates)
			assert.equal(runInNewContext(compile(gate), { creators: ready }), true)
	} finally {
		hook.dispose()
		f.raw.close()
	}
})
