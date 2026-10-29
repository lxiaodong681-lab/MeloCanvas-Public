import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, type Database } from '../core/database'
import { ImportStore } from '../core/imports'
import { LocalAudioStore } from '../core/local-audio'
import { sourceId, type Source } from '../core/model'
import { localLibrarySource } from '../core/music-library-source'
import { PlaylistStore } from '../core/playlists'
import { playlistEntryId } from '../core/queue'
import { builtInThemes } from '../core/theme'
import * as importDisplay from '../import-display'
import type { PlaylistCoverFiles } from '../playlist-cover-files'
import * as selection from '../playlist-selection'
import { PlaylistSession } from '../playlist-session'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const a: Source = {
	id: sourceId('BV1234567890', 10),
	bvid: 'BV1234567890',
	cid: 10,
	originalTitle: 'Alpha Live',
	uploader: '真实 UP甲',
	uploaderId: 123,
	performer: '已确认艺人',
	artwork: '',
	duration: 120,
	domain: 'music',
	audioAvailability: 'unknown',
}
const b: Source = {
	...a,
	id: sourceId('BV1234567891', 20),
	bvid: 'BV1234567891',
	cid: 20,
	originalTitle: 'Beta',
	uploader: 'UP乙',
	performer: null,
}
function fixture(coverFiles?: PlaylistCoverFiles) {
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
		store = new PlaylistStore(db),
		imports = new ImportStore(db)
	store.create('p', '真实混合歌单')
	store.append(
		'p',
		[a, b, a].map((source, index) => ({ itemId: `i${index + 1}`, source })),
		'keep-all',
	)
	imports.createDirectory({
		taskId: 'task',
		provider: 'qq',
		originalPlaylistId: 'remote',
		taskVersion: 1,
		originalMetadata: {},
		entries: [
			{
				entryId: 'e',
				originalEntryId: 'remote-song',
				originalPosition: 0,
				originalMetadata: {
					track: {
						name: 'Gamma 未匹配',
						singer: [{ name: '原艺人' }],
						album: { name: '原专辑' },
					},
				},
			},
		],
	})
	imports.review(
		'task',
		'e',
		{
			selected: true,
			review: { state: 'not-found', candidates: [], confirmation: null },
		},
		imports.get('task')!.revision,
	)
	imports.commitSelected('task', {
		commitId: 'c',
		expectedRevision: imports.get('task')!.revision,
		target: {
			kind: 'append',
			playlistId: 'p',
			expectedUpdatedAt: store.get('p')!.updatedAt,
		},
		duplicatePolicy: 'keep-all',
		itemIds: [{ entryId: 'e', itemId: 'pending4' }],
	})
	let sequence = 0
	const session = new PlaylistSession(
		store,
		library,
		() => `new-${++sequence}`,
		coverFiles,
	)
	session.open('p')
	const visible = () => {
		const state = session.getSnapshot()
		return selection.selectPlaylistDetailItems(
			state.detail,
			state.sources,
			state.detailQuery,
			state.detailFilter,
		)
	}
	return { raw, db, library, store, imports, session, visible }
}

void test('combined detail search preserves A/B/A item identity and searches real Source and pending descriptions without treating missing Source as pending', () => {
	const f = fixture()
	try {
		for (const query of ['  ALPHA  ', '已确认艺人', 'up甲', 'bv1234567890']) {
			f.session.setDetailQuery(query)
			assert.deepEqual(
				f.visible().map(({ item, index }) => [item.itemId, index]),
				[
					['i1', 0],
					['i3', 2],
				],
			)
		}
		for (const query of ['gamma', '原艺人', '原专辑', '尚未找到']) {
			f.session.setDetailQuery(query)
			assert.deepEqual(
				f.visible().map(({ item }) => item.itemId),
				['pending4'],
			)
		}
		f.session.setDetailFilter('pending')
		f.session.setDetailQuery('alpha')
		assert.deepEqual(f.visible(), [])
		f.session.setDetailQuery('   ')
		assert.deepEqual(
			f.visible().map(({ item }) => item.itemId),
			['pending4'],
		)
		const read = f.library.get.bind(f.library)
		f.library.get = (id) => (id === b.id ? null : read(id))
		f.session.refresh()
		assert.deepEqual(
			f.visible().map(({ item }) => item.itemId),
			['pending4'],
		)
		f.session.setDetailFilter('all')
		f.session.setDetailQuery('音源资料暂不可用')
		assert.deepEqual(
			f.visible().map(({ item }) => item.itemId),
			['i2'],
		)
		assert.throws(
			() => selection.preparePlaylistPlayback(f.store, f.library, 'p', 'i1'),
			/第 2 项.*原播放已保留/,
		)
	} finally {
		f.raw.close()
	}
})

void test('filter changes retain hidden selections; explicit clear scopes subsequent select-all/remove/undo, while the add picker remains separate', () => {
	const f = fixture()
	try {
		f.session.setEditing(true)
		f.session.selectAll()
		assert.equal(f.session.getSnapshot().selectedItemIds.length, 4)
		f.session.setDetailQuery('alpha')
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, [
			'i1',
			'i2',
			'i3',
			'pending4',
		])
		f.session.toggleItem('i2')
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, [
			'i1',
			'i2',
			'i3',
			'pending4',
		])
		f.session.clearSelection()
		f.session.selectAll()
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, ['i1', 'i3'])
		assert.equal(
			f.session.move('i3', -1),
			false,
			'filtered sorting cannot change hidden neighbours',
		)
		assert.equal(f.session.removeSelected(), true)
		assert.deepEqual(
			f.store.get('p')!.items.map((item) => item.itemId),
			['i2', 'pending4'],
		)
		assert.deepEqual(f.visible(), [])
		assert.equal(f.session.undoRemove(), true)
		assert.deepEqual(
			f.store.get('p')!.items.map((item) => item.itemId),
			['i1', 'i2', 'i3', 'pending4'],
		)
		assert.deepEqual(
			f.visible().map(({ item, index }) => [item.itemId, index]),
			[
				['i1', 0],
				['i3', 2],
			],
		)
		f.session.openAdd([a, b])
		f.session.toggleSource(b.id)
		f.session.setPickerQuery('only alpha')
		f.session.setDetailQuery('beta')
		assert.equal(f.session.getSnapshot().picker!.query, 'only alpha')
		assert.deepEqual(f.session.getSnapshot().picker!.selectedSourceIds, [b.id])
		assert.equal(f.session.getSnapshot().detailQuery, 'beta')
		f.session.clearDetailFilters()
		assert.equal(f.session.move('i3', -1), true)
		assert.deepEqual(
			f.store.get('p')!.items.map((item) => item.itemId),
			['i1', 'i3', 'i2', 'pending4'],
		)
	} finally {
		f.raw.close()
	}
})

void test('review resolution and metadata refresh retain now-hidden selected identities; write failure preserves the whole selected scope', () => {
	const f = fixture()
	try {
		f.session.setDetailFilter('pending')
		f.session.setEditing(true)
		f.session.selectAll()
		f.imports.review(
			'task',
			'e',
			{
				review: {
					state: 'confirmed',
					candidates: [
						{
							candidateId: 'chosen',
							bvid: b.bvid,
							cid: b.cid,
							metadata: {},
							evidence: {},
						},
					],
					confirmation: { candidateId: 'chosen', sourceId: b.id },
				},
			},
			f.imports.get('task')!.revision,
		)
		f.imports.resolvePending('task', 'e', {
			playlistId: 'p',
			itemId: 'pending4',
			expectedRevision: f.imports.get('task')!.revision,
			expectedUpdatedAt: f.store.get('p')!.updatedAt,
		})
		f.session.refresh()
		assert.deepEqual(f.visible(), [])
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, ['pending4'])
		assert.equal(f.store.get('p')!.items[3].sourceId, b.id)
		f.session.setDetailFilter('all')
		f.session.setDetailQuery('alpha')
		f.session.selectAll()
		const before = f.store.get('p')
		f.raw.exec(
			"CREATE TRIGGER refuse_remove BEFORE DELETE ON playlist_items WHEN OLD.itemId='i3' BEGIN SELECT RAISE(ABORT,'disk write denied'); END",
		)
		assert.equal(f.session.removeSelected(), false)
		assert.deepEqual(f.store.get('p'), before)
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, [
			'pending4',
			'i1',
			'i3',
		])
		assert.match(f.session.getSnapshot().error, /disk write denied/)
		f.library.save({ ...a, originalTitle: '已经改名' })
		f.session.refresh()
		assert.deepEqual(f.visible(), [])
		assert.deepEqual(f.session.getSnapshot().selectedItemIds, [
			'pending4',
			'i1',
			'i3',
		])
	} finally {
		f.raw.close()
	}
})

void test('reopening restores per-playlist filters; new copies and creates start unfiltered and read failure retains the original target', () => {
	const f = fixture()
	try {
		f.session.setDetailQuery('alpha')
		f.session.setDetailFilter('pending')
		const read = f.store.listSummaries.bind(f.store)
		f.store.listSummaries = () => {
			throw new Error('read denied')
		}
		f.session.refresh()
		assert.equal(f.session.getSnapshot().currentId, 'p')
		assert.equal(f.session.getSnapshot().detailQuery, 'alpha')
		assert.equal(f.session.getSnapshot().detailFilter, 'pending')
		assert.match(f.session.getSnapshot().error, /read denied/)
		f.store.listSummaries = read
		f.session.requestName('copy')
		assert.equal(f.session.saveName(), true)
		assert.equal(f.session.getSnapshot().detailQuery, '')
		assert.equal(f.session.getSnapshot().detailFilter, 'all')
		assert.notEqual(f.session.getSnapshot().currentId, 'p')
		f.session.setDetailQuery('beta')
		f.session.open('p')
		assert.equal(f.session.getSnapshot().detailQuery, 'alpha')
		assert.equal(f.session.getSnapshot().detailFilter, 'pending')
		f.session.setDetailFilter('pending')
		f.session.close()
		assert.equal(f.session.getSnapshot().detailFilter, 'all')
		f.session.requestName('create')
		f.session.setName('空歌单')
		assert.equal(f.session.saveName(), true)
		assert.equal(f.session.getSnapshot().detailFilter, 'all')
	} finally {
		f.raw.close()
	}
})

const component = (value: unknown) => value as ControlNode['type']
const text = (node: unknown): string =>
	Array.isArray(node)
		? node.map(text).join('')
		: node && typeof node === 'object' && 'children' in node
			? text((node as ControlNode).children)
			: typeof node === 'string' || typeof node === 'number'
				? String(node)
				: ''
const control = (tree: unknown, label: string) => {
	const node = controlNodes(tree).find(
		(entry) =>
			entry.type === 'Pressable' &&
			(entry.props.accessibilityLabel ?? text(entry.children)) === label,
	)
	assert.ok(node, `missing actual control: ${label}`)
	return node
}

void test('actual three-theme TSX search/filter/manage callbacks preserve original item positions and the full A/B/A playback queue', async () => {
	for (const theme of Object.values(builtInThemes)) {
		const f = fixture()
		const deps: Record<string, unknown> = {
			'./core/queue': { playlistEntryId },
			'./playlist-selection': selection,
			'./import-display': importDisplay,
		}
		const h = controlFixture({}, deps)
		deps['./theme-input'] = h.load('theme-input')
		const played: ReturnType<typeof selection.preparePlaylistPlayback>[] = []
		const draw = () =>
			h.render(
				h.element(
					component(h.load('ui').ThemeProvider),
					{ value: theme },
					h.element(component(h.load('playlist-ui').PlaylistDetailPage), {
						state: f.session.getSnapshot(),
						session: f.session,
						onBack() {},
						onSearch() {},
						onPlay: async (playlistId: string, start: string) => {
							played.push(
								selection.preparePlaylistPlayback(
									f.store,
									f.library,
									playlistId,
									start,
								),
							)
							return true
						},
						playbackBusy: false,
						currentEntryId: playlistEntryId('i3'),
						bottomInset: 0,
						reducedMotion: true,
					}),
				),
			)
		try {
			let tree = draw()
			assert.match(text(tree), /4 首，1 首未匹配/)
			const input = controlNodes(tree).find(
				(node) => node.props.testID === 'playlist-detail-search-input',
			)!
			assert.equal(input.type, 'TextInput')
			;(input.props.onChangeText as (query: string) => void)(' alpha ')
			tree = draw()
			assert.deepEqual(
				controlNodes(tree)
					.filter(
						(node) =>
							typeof node.props.testID === 'string' &&
							node.props.testID.startsWith('playlist-item-'),
					)
					.map((node) => node.props.testID),
				['playlist-item-i1', 'playlist-item-i3'],
			)
			const third = control(tree, '播放歌单第3项 Alpha Live')
			assert.equal(
				(third.props.accessibilityState as { selected: boolean }).selected,
				true,
			)
			await (third.props.onPress as () => Promise<void>)()
			assert.deepEqual(
				played[0].entries.map((entry) => entry.itemId),
				['i1', 'i2', 'i3'],
			)
			assert.equal(played[0].startItemId, 'i3')
			await (
				control(tree, '播放全部').props
					.onPress as () => Promise<void>
			)()
			assert.equal(played[1].startItemId, 'i1')
			;(control(tree, '管理歌单条目').props.onPress as () => void)()
			tree = draw()
			assert.match(text(tree), /筛选中暂不能排序/)
			assert.equal(
				controlNodes(tree).some((node) =>
					String(node.props.accessibilityLabel).startsWith('上移歌单'),
				),
				false,
			)
			;(control(tree, '全选全部筛选结果').props.onPress as () => void)()
			assert.deepEqual(f.session.getSnapshot().selectedItemIds, ['i1', 'i3'])
			;(control(tree, '歌单条目筛选：待匹配').props.onPress as () => void)()
			tree = draw()
			assert.match(text(tree), /没有符合条件的条目/)
			assert.deepEqual(f.session.getSnapshot().selectedItemIds, ['i1', 'i3'])
			;(control(tree, '清除歌单筛选').props.onPress as () => void)()
			tree = draw()
			assert.equal(f.session.getSnapshot().detailQuery, '')
			assert.ok(control(tree, '上移歌单第3项'))
			f.session.setEditing(false)
			f.session.setDetailFilter('pending')
			tree = draw()
			const pending = controlNodes(tree).find((node) =>
				String(node.props.accessibilityLabel).startsWith('歌单第4项'),
			)!
			assert.equal(pending.props.disabled, true)
			assert.match(text(tree), /Gamma 未匹配/)
			assert.equal(text(tree).includes('把第一段喜欢'), false)
			f.store.create('empty', '空歌单')
			f.session.open('empty')
			assert.match(text(draw()), /把第一段喜欢的声音放进来/)
		} finally {
			h.unmount()
			f.raw.close()
		}
	}
})

void test('actual playlist description editor saves multiline full text and permits clearing', () => {
	const f = fixture()
	const deps: Record<string, unknown> = {
		'./core/queue': { playlistEntryId },
		'./playlist-selection': selection,
		'./import-display': importDisplay,
	}
	const h = controlFixture({}, deps)
	deps['./theme-input'] = h.load('theme-input')
	const draw = () =>
		h.render(
			h.element(
				component(h.load('ui').ThemeProvider),
				{ value: builtInThemes.modern },
				h.element(component(h.load('playlist-ui').PlaylistDialogs), {
					state: f.session.getSnapshot(),
					session: f.session,
					bottomInset: 0,
					reducedMotion: true,
					onSearch() {},
				}),
			),
		)
	try {
		f.session.requestName('description')
		let tree = draw()
		const input = controlNodes(tree).find(
			(n) => n.props.testID === 'playlist-description-input',
		)!
		assert.equal(input.type, 'TextInput')
		assert.equal(input.props.multiline, true)
		assert.equal(input.props.maxLength, undefined)
		const description = '第一行\n' + '长文完整保存'.repeat(80)
		;(input.props.onChangeText as (s: string) => void)(description)
		tree = draw()
		;(control(tree, '保存歌单简介').props.onPress as () => void)()
		assert.equal(f.store.get('p')?.description, description)
		f.session.requestName('description')
		tree = draw()
		const edit = controlNodes(tree).find(
			(n) => n.props.testID === 'playlist-description-input',
		)!
		assert.equal(edit.props.value, description)
		;(edit.props.onChangeText as (s: string) => void)('')
		tree = draw()
		assert.notEqual(control(tree, '保存歌单简介').props.disabled, true)
		;(control(tree, '保存歌单简介').props.onPress as () => void)()
		assert.equal(f.store.get('p')?.description, '')
	} finally {
		h.unmount()
		f.raw.close()
	}
})

void test('导入来源摘要基于当前条目且复制保留，移除后刷新不冒称远程关联', () => {
	const f = fixture()
	try {
		assert.equal(
			f.session.getSnapshot().playlists.find((p) => p.playlist.id === 'p')
				?.importSummary,
			'导入条目来源：QQ 歌单，本地副本',
		)
		const items = f.store.get('p')!.items
		assert.equal(
			selection.playlistImportSummary(items.filter((i) => !i.importOrigin)),
			'',
		)
		const pending = items.find((i) => i.importOrigin)!
		const origins = ['bilibili', 'qq', 'netease'] as const
		const mixed = origins.map((provider) => ({
			...pending,
			importOrigin: { ...pending.importOrigin!, provider },
		}))
		assert.equal(
			selection.playlistImportSummary([...mixed, ...mixed]),
			'导入条目来源：网易云歌单 / QQ 歌单 / B站收藏夹，本地副本',
		)
		const copy = f.store.copy(
			'p',
			'copy',
			'副本',
			items.map((_, i) => `copy-${i}`),
		)
		assert.equal(
			selection.playlistImportSummary(copy.items),
			selection.playlistImportSummary(items),
		)
		f.store.remove('p', [pending.itemId])
		f.session.refresh()
		assert.equal(
			f.session.getSnapshot().playlists.find((p) => p.playlist.id === 'p')
				?.importSummary,
			'',
		)
	} finally {
		f.raw.close()
	}
})

void test('actual cover editor previews selected file, saves only on explicit action and restores automatic cover', async () => {
	const f = fixture({
		pick: async () => 'file:///cache/photo',
		persist: async () => ({ uri: 'file:///private/photo', discard() {} }),
	})
	const deps: Record<string, unknown> = {
		'./core/queue': { playlistEntryId },
		'./playlist-selection': selection,
		'./import-display': importDisplay,
	}
	const h = controlFixture({}, deps)
	deps['./theme-input'] = h.load('theme-input')
	const draw = () =>
		h.render(
			h.element(
				component(h.load('ui').ThemeProvider),
				{ value: builtInThemes.modern },
				h.element(component(h.load('playlist-ui').PlaylistDialogs), {
					state: f.session.getSnapshot(),
					session: f.session,
					bottomInset: 0,
					reducedMotion: true,
					onSearch() {},
				}),
			),
		)
	try {
		f.session.requestCover()
		let tree = draw()
		await (
			control(tree, '选择本地图片').props.onPress as () => Promise<boolean>
		)()
		tree = draw()
		assert.equal(f.session.getSnapshot().coverForm?.uri, 'file:///cache/photo')
		assert.equal(f.store.get('p')?.coverUri, null)
		await (
			control(tree, '保存歌单封面').props.onPress as () => Promise<boolean>
		)()
		assert.equal(f.store.get('p')?.coverUri, 'file:///private/photo')
		f.session.requestCover()
		tree = draw()
		;(control(tree, '恢复自动封面').props.onPress as () => void)()
		tree = draw()
		await (
			control(tree, '保存歌单封面').props.onPress as () => Promise<boolean>
		)()
		assert.equal(f.store.get('p')?.coverUri, null)
	} finally {
		h.unmount()
		f.raw.close()
	}
})

void test('picker searches confirmed performers and filename basenames without merging source/cid or exposing directories', () => {
	const local = localLibrarySource({
		id: 'local:12345678-1234-1234-1234-123456789abc',
		originalName: '/private/user-secret/Original Recording.FLAC',
		title: 'Local title',
		artist: 'Local artist',
		durationSeconds: 100,
		bytes: 1000,
		importedAt: 1,
	})
	const otherPart = { ...a, id: sourceId(a.bvid, 11), cid: 11 }
	const sources = [a, b, otherPart, local]
	for (const query of [' 已确认艺人 ', ' ALPHA ', 'bv1234567890'])
		assert.deepEqual(selection.selectPlaylistPickerSources(sources, query), [
			a,
			otherPart,
		])
	for (const query of [' original RECORDING.flac ', 'Local artist'])
		assert.deepEqual(selection.selectPlaylistPickerSources(sources, query), [
			local,
		])
	assert.deepEqual(
		selection.selectPlaylistPickerSources(sources, 'user-secret'),
		[],
	)
	assert.deepEqual(
		selection.selectPlaylistPickerSources(sources, 'undefined'),
		[],
	)
	assert.deepEqual(
		selection.selectPlaylistPickerSources(sources, '  '),
		sources,
	)
	const windows = {
		...local,
		originalName: 'C:\\private-secret\\Original Recording.FLAC',
	}
	assert.deepEqual(
		selection.selectPlaylistPickerSources([windows], 'private-secret'),
		[],
	)
	assert.deepEqual(
		selection.selectPlaylistPickerSources([windows], 'recording.flac'),
		[windows],
	)
})

void test('actual picker search in all themes retains hidden checks and appends explicit sources with stable local UUID and occurrences', () => {
	for (const theme of Object.values(builtInThemes)) {
		const f = fixture()
		const audio = {
			id: 'local:12345678-1234-1234-1234-123456789abc',
			originalName: 'Original Recording.FLAC',
			title: '本地曲目',
			artist: '本地艺人',
			durationSeconds: 100,
			bytes: 1000,
			importedAt: 1,
		}
		new LocalAudioStore(f.db).add(audio)
		const local = localLibrarySource(audio)
		const deps: Record<string, unknown> = {
			'./core/queue': { playlistEntryId },
			'./playlist-selection': selection,
			'./import-display': importDisplay,
		}
		const h = controlFixture({}, deps)
		deps['./theme-input'] = h.load('theme-input')
		const draw = () =>
			h.render(
				h.element(
					component(h.load('ui').ThemeProvider),
					{ value: theme },
					h.element(component(h.load('playlist-ui').PlaylistDialogs), {
						state: f.session.getSnapshot(),
						session: f.session,
						bottomInset: 0,
						reducedMotion: true,
						onSearch() {},
					}),
				),
			)
		const search = (query: string) => {
			const input = controlNodes(draw()).find(
				(n) =>
					n.props.accessibilityLabel === '搜索待添加的音源' &&
					typeof n.props.onChangeText === 'function',
			)
			assert.ok(input)
			;(input.props.onChangeText as (value: string) => void)(query)
			return draw()
		}
		try {
			f.session.openAdd([a, b, local])
			let tree = search(' 已确认艺人 ')
			;(control(tree, '选择音源 Alpha Live').props.onPress as () => void)()
			tree = search(' ORIGINAL recording.flac ')
			assert.doesNotMatch(text(tree), /Alpha Live/)
			;(control(tree, '选择音源 本地曲目').props.onPress as () => void)()
			assert.deepEqual(f.session.getSnapshot().picker?.selectedSourceIds, [
				a.id,
				local.id,
			])
			tree = search('no-match')
			assert.match(text(tree), /没有匹配的待添加音源/)
			assert.deepEqual(f.session.getSnapshot().picker?.selectedSourceIds, [
				a.id,
				local.id,
			])
			tree = search('')
			assert.equal(
				control(tree, '选择音源 Alpha Live').props.accessibilityState &&
					(
						control(tree, '选择音源 Alpha Live').props.accessibilityState as {
							checked: boolean
						}
					).checked,
				true,
			)
			f.session.setDuplicatePolicy('keep-all')
			assert.equal(f.session.appendSelected(), true)
			const items = f.store.get('p')!.items
			assert.deepEqual(
				items.map((item) => item.sourceId),
				[a.id, b.id, a.id, null, a.id, local.id],
			)
			assert.equal(new Set(items.map((item) => item.itemId)).size, items.length)
			f.session.setDetailQuery(' recording.FLAC ')
			assert.deepEqual(
				f.visible().map(({ item, index }) => [item.sourceId, index]),
				[[local.id, 5]],
			)
		} finally {
			h.unmount()
			f.raw.close()
		}
	}
})
