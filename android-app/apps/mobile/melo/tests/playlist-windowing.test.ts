import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, type Database } from '../core/database'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import { playlistEntryId } from '../core/queue'
import { builtInThemes } from '../core/theme'
import * as importDisplay from '../import-display'
import * as selection from '../playlist-selection'
import { PlaylistSession } from '../playlist-session'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const component = (value: unknown) => value as ControlNode['type']
const source: Source = {
	id: sourceId('BV1234567890', 10),
	bvid: 'BV1234567890',
	cid: 10,
	originalTitle: '普通歌曲',
	uploader: '原 UP',
	uploaderId: 1,
	performer: null,
	artwork: '',
	duration: 120,
	domain: 'music',
	audioAvailability: 'unknown',
}
function fixture(count = 5000) {
	const raw = new DatabaseSync(':memory:')
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, args) => raw.prepare(sql).run(...args),
		getAllSync: <T>(sql: string, args: (string | number | null)[]) =>
			raw.prepare(sql).all(...args) as T[],
		getFirstSync: <T>(sql: string, args: (string | number | null)[]) =>
			(raw.prepare(sql).get(...args) as T) ?? null,
	}
	migrate(db)
	const library = new Library(db),
		store = new PlaylistStore(db)
	const last = {
		...source,
		id: sourceId('BV1234567891', 20),
		bvid: 'BV1234567891',
		cid: 20,
		originalTitle: '远处目标歌曲',
	}
	store.create('large', '连续滚动歌单')
	store.append(
		'large',
		Array.from({ length: count }, (_, index) => ({
			itemId: `item-${index}`,
			source: index >= count - 2 ? last : source,
		})),
		'keep-all',
	)
	store.create('other', '另一张歌单')
	store.append('other', [{ itemId: 'other-item', source }], 'keep-all')
	let id = 0
	const session = new PlaylistSession(store, library, () => `added-${++id}`)
	session.open('large')
	return { raw, library, store, session, last }
}
function ui(f: ReturnType<typeof fixture>, window = { start: 0, count: 16 }) {
	const dependencies: Record<string, unknown> = {
		'./core/queue': { playlistEntryId },
		'./playlist-selection': selection,
		'./import-display': importDisplay,
	}
	const h = controlFixture({}, dependencies, window)
	dependencies['./theme-input'] = h.load('theme-input')
	const playCalls: [string, string][] = []
	const draw = (theme = builtInThemes.modern) =>
		h.render(
			h.element(
				component(h.load('ui').ThemeProvider),
				{ value: theme },
				h.element(component(h.load('playlist-ui').PlaylistDetailPage), {
					state: f.session.getSnapshot(),
					session: f.session,
					onBack() {},
					onSearch() {},
					onPlay: async (id: string, itemId: string) => {
						playCalls.push([id, itemId])
						return true
					},
					playbackBusy: false,
					currentEntryId: null,
					bottomInset: 0,
					reducedMotion: true,
				}),
			),
		)
	return { h, draw, playCalls, window, dependencies }
}
function node(tree: unknown, id: string) {
	const result = controlNodes(tree).find((n) => n.props.testID === id)
	assert.ok(result, id)
	return result
}
function control(tree: unknown, label: string) {
	const result = controlNodes(tree).find(
		(n) =>
			n.props.accessibilityLabel === label &&
			typeof n.props.onPress === 'function',
	)
	assert.ok(result, label)
	return result
}
const text = (tree: unknown) => JSON.stringify(tree)

void test('5000 occurrence data is handed intact to FlatList; top search, global selection and full playback survive a modeled render window in all themes', () => {
	const f = fixture()
	const u = ui(f)
	try {
		for (const theme of Object.values(builtInThemes)) {
			f.session.clearDetailFilters()
			f.session.setEditing(false)
			u.window.start = 0
			let tree = u.draw(theme),
				list = node(tree, 'playlist-detail-list')
			assert.equal(list.type, 'FlatList')
			assert.equal((list.props.data as unknown[]).length, 5000)
			assert.equal(list.props.initialNumToRender, 16)
			assert.equal(list.props.maxToRenderPerBatch, 12)
			assert.equal(list.props.windowSize, 7)
			assert.equal(
				controlNodes(tree).filter((n) =>
					String(n.props.testID).startsWith('playlist-item-'),
				).length,
				16,
			)
			assert.ok(node(tree, 'playlist-detail-search-input'))
			assert.equal(controlNodes(list.props.ListHeaderComponent).length, 1) // no eager song rows in header
			;(
				node(tree, 'playlist-detail-search-input').props.onChangeText as (
					query: string,
				) => void
			)('目标歌曲')
			f.session.setEditing(true)
			tree = u.draw(theme)
			list = node(tree, 'playlist-detail-list')
			const data = list.props.data as ReturnType<
				typeof selection.selectPlaylistDetailItems
			>
			assert.deepEqual(
				data.map((row) => row.item.itemId),
				['item-4998', 'item-4999'],
			)
			;(control(tree, '全选全部筛选结果').props.onPress as () => void)()
			f.session.setDetailQuery('普通')
			tree = u.draw(theme)
			assert.match(text(tree), /筛选外 2 项/)
			;(control(tree, '全选全部筛选结果').props.onPress as () => void)()
			assert.equal(f.session.getSnapshot().selectedItemIds.length, 5000)
			f.session.setEditing(false)
			f.session.setDetailQuery('目标歌曲')
			tree = u.draw(theme)
			;(
				control(tree, '播放歌单第5000项 远处目标歌曲').props
					.onPress as () => void
			)()
			assert.deepEqual(u.playCalls.at(-1), ['large', 'item-4999'])
			const queue = selection.preparePlaylistPlayback(
				f.store,
				f.library,
				'large',
				'item-4999',
			)
			assert.equal(queue.entries.length, 5000)
			assert.equal(queue.startItemId, 'item-4999')
			assert.equal(queue.entries[4998].source.id, queue.entries[4999].source.id)
			assert.notEqual(queue.entries[4998].itemId, queue.entries[4999].itemId)
			assert.deepEqual(
				queue.entries.map((entry) => entry.itemId),
				Array.from({ length: 5000 }, (_, i) => `item-${i}`),
			)
		}
	} finally {
		u.h.unmount()
		f.raw.close()
	}
})

void test('variable-height restoration waits for native geometry, retries unmeasured anchors and rejects stale route/filter callbacks', () => {
	const f = fixture()
	const token = f.session.getSnapshot().detailViewToken
	f.session.recordDetailScroll(token, {
		itemId: 'item-4000',
		index: 4000,
		offset: 480000,
	})
	const u = ui(f)
	try {
		let list = node(u.draw(), 'playlist-detail-list')
		const calls: unknown[] = []
		const ref = list.props.ref as { current: unknown }
		ref.current = {
			scrollToIndex: (arg: unknown) => calls.push(['index', arg]),
			scrollToOffset: (arg: unknown) => calls.push(['offset', arg]),
		}
		;(list.props.onLayout as (event: unknown) => void)({
			nativeEvent: { layout: { height: 600 } },
		})
		u.h.flushAnimationFrames()
		assert.equal(calls.length, 0)
		;(
			list.props.onContentSizeChange as (width: number, height: number) => void
		)(360, 600000)
		u.h.flushAnimationFrames()
		assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), [
			'index',
			{ index: 4000, animated: false },
		])
		;(list.props.onScrollToIndexFailed as (event: unknown) => void)({
			index: 4000,
			averageItemLength: 120,
		})
		assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), [
			'offset',
			{ offset: 480000, animated: false },
		])
		;(list.props.onScroll as (event: unknown) => void)({
			nativeEvent: { contentOffset: { y: 480050 } },
		})
		const row = (
			list.props.data as ReturnType<typeof selection.selectPlaylistDetailItems>
		)[4000]
		;(list.props.onViewableItemsChanged as (event: unknown) => void)({
			viewableItems: [{ item: row, index: 4000, isViewable: true }],
		})
		assert.deepEqual(f.session.getDetailScroll(token), {
			itemId: 'item-4000',
			index: 4000,
			offset: 480050,
		})
		const oldScroll = list.props.onScroll as (event: unknown) => void
		const oldSize = list.props.onContentSizeChange as (
			width: number,
			height: number,
		) => void
		f.session.setDetailQuery('目标')
		list = node(u.draw(), 'playlist-detail-list')
		oldScroll({ nativeEvent: { contentOffset: { y: 999999 } } })
		oldSize(360, 999999)
		u.h.flushAnimationFrames()
		assert.deepEqual(
			f.session.getDetailScroll(f.session.getSnapshot().detailViewToken),
			{ itemId: null, index: 0, offset: 0 },
		)
		assert.equal((list.props.data as unknown[]).length, 2)
		f.session.open('other')
		u.draw()
		oldScroll({ nativeEvent: { contentOffset: { y: 500 } } })
		assert.equal(
			f.session.getDetailScroll(f.session.getSnapshot().detailViewToken).offset,
			0,
		)
		f.session.open('large')
		assert.equal(f.session.getSnapshot().detailQuery, '目标')
		u.draw()
		u.h.unmount()
		oldSize(360, 400000)
		u.h.flushAnimationFrames()
		assert.equal(u.h.pendingAnimationFrames, 0)
		assert.equal(u.h.writesAfterUnmount, 0)
	} finally {
		u.h.unmount()
		f.raw.close()
	}
})

void test('playlist detail owns the single native scroll host; ordinary routes retain their ScrollView props', () => {
	const h = controlFixture()
	const host = component(h.load('page-scroll-host').PageScrollHost)
	const scrollRef = { current: null }
	const props = {
		scrollRef,
		testID: 'library-page',
		contentContainerStyle: { padding: 22 },
		onScroll: () => {},
	}
	let tree = h.render(
		h.element(
			host,
			{ ...props, virtualized: true },
			h.element('FlatList', { data: [] }),
		),
	)
	assert.equal(
		controlNodes(tree).some((n) => n.type === 'ScrollView'),
		false,
	)
	assert.equal(node(tree, 'library-page').type, 'View')
	tree = h.render(
		h.element(host, { ...props, virtualized: false }, h.element('View', {})),
	)
	assert.equal(node(tree, 'library-page').type, 'ScrollView')
	assert.equal(node(tree, 'library-page').props.onScroll, props.onScroll)
	const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
	assert.match(
		app,
		/virtualized=\{tab === 'library' && !!playlists\.state\.currentId\}/,
	)
	h.unmount()
})

void test('query typing preserves the native list/input identity and resets offset without remounting; in-flight removal clamps the occurrence anchor', () => {
	const f = fixture(100)
	const token = f.session.getSnapshot().detailViewToken
	f.session.recordDetailScroll(token, {
		itemId: 'item-99',
		index: 99,
		offset: 12000,
	})
	const u = ui(f)
	try {
		const original = node(u.draw(), 'playlist-detail-list')
		const calls: [string, { index?: number; offset?: number }][] = []
		;(original.props.ref as { current: unknown }).current = {
			scrollToIndex: (arg: { index: number }) => calls.push(['index', arg]),
			scrollToOffset: (arg: { offset: number }) => calls.push(['offset', arg]),
		}
		;(original.props.onLayout as (event: unknown) => void)({
			nativeEvent: { layout: { height: 600 } },
		})
		;(
			original.props.onContentSizeChange as (
				width: number,
				height: number,
			) => void
		)(360, 13000)
		// Change the data after restore is scheduled, before the native command.
		f.session.setEditing(true)
		for (let i = 20; i < 100; i++) f.session.toggleItem(`item-${i}`)
		assert.equal(f.session.removeSelected(), true)
		u.draw()
		u.h.flushAnimationFrames()
		assert.equal(calls.at(-1)?.[0], 'index')
		assert.equal(calls.at(-1)?.[1].index, 19)
		assert.ok(calls.every(([kind, arg]) => kind !== 'index' || arg.index! < 20))
		f.session.setDetailQuery('普通')
		let updated = node(u.draw(), 'playlist-detail-list')
		assert.equal(
			updated.key,
			original.key,
			'typing must not remount TextInput in the header',
		)
		u.h.flushAnimationFrames()
		assert.equal(calls.at(-1)?.[0], 'offset')
		assert.equal(calls.at(-1)?.[1].offset, 0)
		f.session.setDetailQuery('普通歌曲')
		updated = node(u.draw(), 'playlist-detail-list')
		assert.equal(updated.key, original.key)
		u.h.flushAnimationFrames()
		assert.equal(
			f.session.getDetailScroll(f.session.getSnapshot().detailViewToken).offset,
			0,
		)
		// Accessibility/keyboard scroll after a zero-distance restoration is saved.
		;(updated.props.onScroll as (event: unknown) => void)({
			nativeEvent: { contentOffset: { y: 35 } },
		})
		assert.equal(
			f.session.getDetailScroll(f.session.getSnapshot().detailViewToken).offset,
			35,
		)
	} finally {
		u.h.unmount()
		f.raw.close()
	}
})

void test('5000-source add selector searches beyond the modeled window and keeps hidden explicit selections when appending', () => {
	const f = fixture(3)
	const u = ui(f, { start: 0, count: 12 })
	const sources = Array.from({ length: 5000 }, (_, index) => ({
		...source,
		id: sourceId(source.bvid, index + 1),
		cid: index + 1,
		originalTitle: index === 4999 ? '最后的歌名' : `添加歌曲 ${index}`,
	}))
	const draw = () =>
		u.h.render(
			u.h.element(
				component(u.h.load('ui').ThemeProvider),
				{ value: builtInThemes.modern },
				u.h.element(component(u.h.load('playlist-ui').PlaylistDialogs), {
					state: f.session.getSnapshot(),
					session: f.session,
					onSearch() {},
					bottomInset: 0,
					reducedMotion: true,
				}),
			),
		)
	try {
		f.session.openAdd(sources)
		let tree = draw(),
			list = node(tree, 'playlist-picker-list')
		assert.equal(list.type, 'FlatList')
		assert.equal((list.props.data as unknown[]).length, 5000)
		assert.equal(list.props.initialNumToRender, 12)
		assert.equal(
			controlNodes(tree).filter((n) => n.props.accessibilityRole === 'checkbox')
				.length,
			12,
		)
		;(control(tree, '选择音源 添加歌曲 0').props.onPress as () => void)()
		f.session.setPickerQuery('最后的歌名')
		tree = draw()
		list = node(tree, 'playlist-picker-list')
		assert.equal((list.props.data as unknown[]).length, 1)
		;(control(tree, '选择音源 最后的歌名').props.onPress as () => void)()
		assert.deepEqual(f.session.getSnapshot().picker?.selectedSourceIds, [
			sources[0].id,
			sources[4999].id,
		])
		f.session.setPickerQuery('没有结果')
		draw()
		assert.equal(f.session.getSnapshot().picker?.selectedSourceIds.length, 2)
		f.session.setDuplicatePolicy('keep-all')
		assert.equal(f.session.appendSelected(), true)
		const items = f.store.get('large')!.items
		assert.equal(items.length, 5)
		assert.deepEqual(
			items.slice(-2).map((item) => item.sourceId),
			[sources[0].id, sources[4999].id],
		)
		assert.equal(new Set(items.map((item) => item.itemId)).size, 5)
		f.session.openAdd(sources)
		f.session.closeSheet()
		assert.equal(f.session.getSnapshot().picker, null)
	} finally {
		u.h.unmount()
		f.raw.close()
	}
})

void test('playback-like unmount retains query and occurrence; stale same-token callbacks cannot overwrite the remounted list', () => {
	const f = fixture(100)
	f.session.setDetailQuery('普通')
	const token = f.session.getSnapshot().detailViewToken
	f.session.recordDetailScroll(token, {
		itemId: 'item-80',
		index: 80,
		offset: 9600,
	})
	const first = ui(f),
		old = node(first.draw(), 'playlist-detail-list')
	first.h.unmount()
	const second = ui(f)
	try {
		const current = node(second.draw(), 'playlist-detail-list')
		assert.equal(f.session.getSnapshot().detailQuery, '普通')
		assert.equal((current.props.data as unknown[]).length, 98)
		;(old.props.onScrollBeginDrag as (event: unknown) => void)({
			nativeEvent: { contentOffset: { y: 1 } },
		})
		;(old.props.onContentSizeChange as (width: number, height: number) => void)(
			360,
			500,
		)
		first.h.flushAnimationFrames()
		assert.deepEqual(f.session.getDetailScroll(token), {
			itemId: 'item-80',
			index: 80,
			offset: 9600,
		})
		assert.equal(first.h.pendingAnimationFrames, 0)
	} finally {
		second.h.unmount()
		f.raw.close()
	}
})

void test('a no-op clamped restoration finishes even when native emits no zero-offset scroll event; dragging cancels a queued restore', () => {
	const f = fixture(1)
	const token = f.session.getSnapshot().detailViewToken
	f.session.recordDetailScroll(token, { itemId: null, index: 0, offset: 450 })
	const u = ui(f)
	try {
		let list = node(u.draw(), 'playlist-detail-list')
		const calls: unknown[] = []
		;(list.props.ref as { current: unknown }).current = {
			scrollToOffset: (arg: unknown) => calls.push(arg),
		}
		;(list.props.onLayout as (event: unknown) => void)({
			nativeEvent: { layout: { height: 900 } },
		})
		;(
			list.props.onContentSizeChange as (width: number, height: number) => void
		)(360, 700)
		u.h.flushAnimationFrames()
		assert.deepEqual(f.session.getDetailScroll(token), {
			itemId: null,
			index: 0,
			offset: 0,
		})
		f.session.setDetailQuery('最后')
		list = node(u.draw(), 'playlist-detail-list')
		assert.equal(u.h.pendingAnimationFrames, 1)
		;(list.props.onScrollBeginDrag as (event: unknown) => void)({
			nativeEvent: { contentOffset: { y: 25 } },
		})
		u.h.flushAnimationFrames()
		assert.equal(u.h.pendingAnimationFrames, 0)
		assert.equal(calls.length, 1)
		assert.equal(
			f.session.getDetailScroll(f.session.getSnapshot().detailViewToken).offset,
			25,
		)
	} finally {
		u.h.unmount()
		f.raw.close()
	}
})

void test('unmeasured-index fallback includes the measured variable-height header rather than getting stuck inside a long description', () => {
	const f = fixture(100)
	const token = f.session.getSnapshot().detailViewToken
	f.session.recordDetailScroll(token, {
		itemId: 'item-50',
		index: 50,
		offset: 35000,
	})
	const u = ui(f)
	try {
		const tree = u.draw(),
			list = node(tree, 'playlist-detail-list')
		const calls: { offset: number }[] = []
		;(list.props.ref as { current: unknown }).current = {
			scrollToOffset: (arg: { offset: number }) => calls.push(arg),
		}
		const header = list.props.ListHeaderComponent as ControlNode
		;(header.props.onLayout as (event: unknown) => void)({
			nativeEvent: { layout: { height: 30000 } },
		})
		;(list.props.onScrollToIndexFailed as (event: unknown) => void)({
			index: 50,
			averageItemLength: 100,
		})
		assert.equal(calls.at(-1)?.offset, 35000)
		assert.ok(calls.at(-1)!.offset > 30000)
	} finally {
		u.h.unmount()
		f.raw.close()
	}
})
