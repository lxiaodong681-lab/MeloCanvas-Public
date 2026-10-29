import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { CreatorStore, type CreatorSubscription } from '../core/creators'
import { Library, migrate, type Database } from '../core/database'
import { creatorSearchView } from '../creator-search-selection'
import { CreatorSearchSession } from '../creator-search-session'
import { CreatorSession } from '../creator-session'
import { readSearchLocalFollowing } from '../search-local-following'
import type { useCreatorSearch } from '../useCreatorSearch'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const renderedText = (node: unknown): string =>
	Array.isArray(node)
		? node.map(renderedText).join('')
		: node && typeof node === 'object' && 'children' in node
			? renderedText(node.children)
			: typeof node === 'string'
				? node
				: ''

void test('real local subscriptions retain scope and exact mid, reflect follow/unfollow, and ignore another profile', (t) => {
	const raw = new DatabaseSync(':memory:')
	t.after(() => raw.close())
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, args) => raw.prepare(sql).run(...args),
		getFirstSync: <T>(sql: string, args: (string | number | null)[]) =>
			(raw.prepare(sql).get(...args) as T) ?? null,
		getAllSync: <T>(sql: string, args: (string | number | null)[]) =>
			raw.prepare(sql).all(...args) as T[],
	}
	migrate(db)
	const store = new CreatorStore(db),
		session = new CreatorSession(store, new Library(db))
	const creator = {
		source: 'bilibili' as const,
		mid: '9007199254740993',
		name: '本地UP',
		fetchedAt: 1,
	}
	store.saveCreator(creator)
	store.follow({
		profileId: 'other',
		creatorMid: creator.mid,
		scope: 'all',
		origin: 'manual',
	})
	assert.equal(readSearchLocalFollowing(store).scopes!.size, 0)
	session.openProfile(creator.mid)
	session.requestScope()
	session.setScope('music')
	assert.equal(session.saveScope(), true)
	assert.equal(
		readSearchLocalFollowing(store).scopes!.get(creator.mid),
		'music',
	)
	session.requestScope()
	session.setScope('listening')
	assert.equal(session.saveScope(), true)
	assert.equal(
		readSearchLocalFollowing(store).scopes!.get(creator.mid),
		'listening',
	)
	session.requestUnfollow()
	assert.equal(session.unfollow(), true)
	assert.equal(readSearchLocalFollowing(store).scopes!.size, 0)
	assert.ok(store.getSubscription('other', creator.mid))
})

void test('actual hook refreshes on local edits and return, clears stale badges on read error, and retries only local reads', () => {
	let reads = 0,
		network = 0,
		fail = false
	let scope = 'music' as CreatorSubscription['scope']
	const store = {
		listSubscriptions: (profile: string) => {
			assert.equal(profile, 'local')
			reads++
			if (fail) throw Error('disk')
			return [{ creatorMid: '88', scope }] as CreatorSubscription[]
		},
	}
	const f = controlFixture(
		{
			hook: readFileSync(
				new URL('../useCreatorSearch.ts', import.meta.url),
				'utf8',
			),
		},
		{
			'./creator-api': {
				searchCreators: async () => {
					network++
					return { items: [], page: 1, more: false }
				},
			},
			'./creator-search-session': { CreatorSearchSession },
			'./search-local-following': { readSearchLocalFollowing },
		},
	)
	const hook = f.load('hook').useCreatorSearch as typeof useCreatorSearch
	const Host = (props: Record<string, unknown>) =>
		f.element('Snapshot', {
			value: hook(props.active as boolean, store, props.revision),
		})
	const render = (active: boolean, revision: number) =>
		controlNodes(f.render(f.element(Host, { active, revision }))).find(
			(x) => x.type === 'Snapshot',
		)!.props.value as ReturnType<typeof useCreatorSearch>
	assert.equal(render(false, 0).following.scopes, null)
	assert.equal(reads, 0)
	assert.equal(render(true, 0).following.scopes!.get('88'), 'music')
	scope = 'listening'
	assert.equal(render(true, 1).following.scopes!.get('88'), 'listening')
	render(false, 1)
	scope = 'all'
	assert.equal(render(true, 1).following.scopes!.get('88'), 'all')
	fail = true
	const bad = render(true, 2)
	assert.equal(bad.following.scopes, null)
	assert.match(bad.following.error, /暂不可用/)
	fail = false
	bad.following.refresh()
	assert.equal(render(true, 2).following.scopes!.get('88'), 'all')
	assert.equal(network, 0)
	const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
	assert.match(
		app,
		/useCreatorSearch\(\s*tab === 'search' && \(filter === 'creator' \|\| filter === 'all'\),\s*creatorStore,\s*creators\.state,/,
	)
	f.unmount()
})

void test('actual UP result rows show local scopes accessibly without following anyone, and local read errors keep rows usable', () => {
	const deps: Record<string, unknown> = {
		'./creator-search-selection': { creatorSearchView },
	}
	const f = controlFixture({}, deps)
	deps['./creator-ui'] = f.load('creator-ui')
	const Results = f.load('creator-remote-ui')
		.CreatorSearchResults as ControlNode['type']
	const session = new CreatorSearchSession(async () => ({
		items: [],
		page: 1,
		more: false,
	}))
	const creators = ['88', '99', '100', '101'].map((mid) => ({
		source: 'bilibili' as const,
		mid,
		name: `UP${mid}`,
		fetchedAt: 0,
	}))
	let opened = '',
		retried = 0
	const state = {
		...session.getSnapshot(),
		keyword: 'UP',
		items: creators,
		page: 1,
	}
	const following = {
		scopes: new Map([
			['88', 'all'],
			['99', 'music'],
			['100', 'listening'],
		] as const),
		error: '',
		refresh: () => {
			retried++
		},
	}
	const view = f.render(
		f.element(Results, {
			state,
			session,
			following,
			onOpen: (c: { mid: string }) => {
				opened = c.mid
			},
		}),
	)
	const labels = controlNodes(view)
		.map((x) => x.props.accessibilityLabel)
		.filter((x): x is string => typeof x === 'string')
	for (const text of [
		'已本地关注 · 全部投稿',
		'已本地关注 · 音乐投稿',
		'已本地关注 · 听视频内容',
	])
		assert.ok(labels.some((x) => x.includes(text)))
	const unknown = controlNodes(view).find(
		(x) => x.props.accessibilityLabel === '查看搜索 UP 主 UP101，mid 101',
	)!
	assert.ok(unknown)
	;(unknown.props.onPress as () => void)()
	assert.equal(opened, '101')
	assert.equal(retried, 0)
	const error = f.render(
		f.element(Results, {
			state,
			session,
			following: {
				scopes: null,
				error: '本地关注状态暂不可用，搜索结果仍可浏览。',
				refresh: following.refresh,
			},
			onOpen: () => {},
		}),
	)
	assert.equal(
		controlNodes(error).filter(
			(x) =>
				typeof x.props.accessibilityLabel === 'string' &&
				x.props.accessibilityLabel.startsWith('查看搜索 UP 主'),
		).length,
		4,
	)
	assert.equal(
		controlNodes(error).some(
			(x) =>
				typeof x.props.accessibilityLabel === 'string' &&
				x.props.accessibilityLabel.includes('已本地关注'),
		),
		false,
	)

	assert.match(renderedText(error), /本地关注状态暂不可用/)
	assert.doesNotMatch(renderedText(error), /未关注/)
	let viewedAll = false
	const preview = f.render(
		f.element(Results, {
			state: { ...state, more: true },
			session,
			following,
			onOpen: () => {},
			preview: {
				onViewAll: () => {
					viewedAll = true
				},
			},
		}),
	)
	assert.equal(
		controlNodes(preview).filter(
			(x) =>
				typeof x.props.accessibilityLabel === 'string' &&
				x.props.accessibilityLabel.startsWith('查看搜索 UP 主'),
		).length,
		2,
	)
	assert.doesNotMatch(renderedText(preview), /加载更多 UP 主/)
	const allButton = controlNodes(preview).find(
		(x) => x.props.onPress && renderedText(x) === '查看全部 UP 主',
	)!
	assert.ok(allButton)
	;(allButton.props.onPress as () => void)()
	assert.equal(viewedAll, true)
	f.unmount()
})
