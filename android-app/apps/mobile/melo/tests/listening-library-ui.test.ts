import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'

import { BilibiliReadGate } from '../bilibili-import-network'
import { migrate, type Database } from '../core/database'
import * as mixedTypes from '../core/import-mixed-types'
import { ImportStore } from '../core/imports'
import { builtInThemes } from '../core/theme'
import { VideoCatalog } from '../core/video-catalog'
import { VideoSaves } from '../core/video-saves'
import * as importDisplay from '../import-display'
import { ListeningLibrarySession } from '../listening-library-session'
import { parseListeningVideo } from '../listening-source'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const bvid = 'BV1vT411i7ET'
const otherBvid = 'BV1Z9pb6MEwT'
const text = (value: unknown): string =>
	Array.isArray(value)
		? value.map(text).join('')
		: typeof value === 'string' || typeof value === 'number'
			? String(value)
			: value && typeof value === 'object' && 'children' in value
				? text((value as ControlNode).children)
				: ''
const button = (tree: unknown, label: string) => {
	const found = controlNodes(tree).find(
		(entry) =>
			entry.type === 'Pressable' &&
			(entry.props.accessibilityLabel === label || text(entry) === label),
	)
	assert.ok(found, label)
	return found
}
const press = (tree: unknown, label: string) =>
	(button(tree, label).props.onPress as () => void)()

function video(cids = [11, 22]) {
	return parseListeningVideo(
		{
			bvid,
			title: '讲解视频',
			owner: { mid: 88, name: '原 UP' },
			pic: 'https://example.invalid/cover',
			videos: cids.length,
			pages: cids.map((cid, index) => ({
				cid,
				page: index + 1,
				part: `部分 ${cid}`,
				duration: 200,
			})),
		},
		bvid,
	)
}

function fixture(t: TestContext) {
	const raw = new DatabaseSync(':memory:')
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
	migrate(db)
	const imports = new ImportStore(db),
		saves = new VideoSaves(db),
		catalog = new VideoCatalog(db)
	const entries = [bvid, bvid, otherBvid, null].map((value, index) => ({
		entryId: `e${index}`,
		originalEntryId: `original-${index}`,
		originalPosition: index,
		originalMetadata: {
			media: {
				bvid: value,
				title: `原条目 ${index + 1}`,
				upper: { name: '原 UP' },
				duration: 200,
			},
			observed: { bvid: value },
		},
	}))
	imports.createDirectory({
		taskId: 'task',
		provider: 'bilibili',
		originalPlaylistId: 'remote',
		taskVersion: 1,
		originalMetadata: { title: '原收藏夹' },
		entries,
	})
	imports.setSelected(
		'task',
		entries.map((entry) => entry.entryId),
		true,
		0,
	)
	for (const entry of entries.slice(0, 3))
		imports.reviewContent(
			'task',
			entry.entryId,
			{ kind: 'knowledge' },
			imports.get('task')!.revision,
		)
	catalog.save(video(), 1)
	imports.commitMixed('task', {
		commitId: 'commit',
		expectedRevision: imports.get('task')!.revision,
		musicTarget: null,
		songDuplicatePolicy: 'keep-all',
		videoDuplicatePolicy: 'keep-all',
		itemIds: entries.map((entry, index) => ({
			entryId: entry.entryId,
			itemId: `saved-${index}`,
		})),
	})
	let requests = 0
	const session = new ListeningLibrarySession(
		saves,
		catalog,
		() => {
			requests++
			const result = Promise.resolve(video([33]))
			return { result, settled: result.then(() => {}) }
		},
		new BilibiliReadGate(),
	)
	type AlertAction = { text: string; style?: string; onPress?: () => void }
	const alerts: { title: string; message: string; actions: AlertAction[] }[] =
		[]
	const ports: Record<string, unknown> = {
		'./theme-dialog': { useThemeDialog: () => ({ dialog: null, show: (title: string, message: string, actions: AlertAction[]) => alerts.push({ title, message, actions }) }) },
		'./core/import-mixed-types': mixedTypes,
		'./import-display': importDisplay,
	}
	const ui = controlFixture({}, ports)
	const Provider = ui.load('ui').ThemeRendererProvider as ControlNode['type']
	ports['./theme-input'] = ui.load('theme-input')
	// The shared controls keep their original native ports. Only the page's native
	// surface and confirmation requests are captured here; BiliParts stays actual TSX.
	ports['react-native'] = {
		ScrollView: 'ScrollView',
		View: 'View',
	}
	ports['./bilibili-import-ui'] = ui.load('bilibili-import-ui')
	const Page = ui.load('listening-library-ui')
		.ListeningLibraryPage as ControlNode['type']
	const origins: string[][] = [],
		plays: string[] = []
	const render = (theme = builtInThemes.modern, playbackBusy = false) =>
		ui.render(
			ui.element(
				Provider,
				{ theme, adapted: null, allowedImageUris: [], reducedMotion: true },
				ui.element(Page, {
					state: session.getSnapshot(),
					session,
					playbackBusy,
					playbackError: null,
					onOrigin: (taskId: string, entryId: string) =>
						origins.push([taskId, entryId]),
					onPlay: () => {
						const selected = session.selectedSource()
						assert.ok(selected)
						plays.push(selected.id)
					},
				}),
			),
		)
	t.after(() => {
		session.close()
		ui.unmount()
		raw.close()
	})
	return {
		imports,
		saves,
		catalog,
		session,
		ui,
		render,
		alerts,
		origins,
		plays,
		requests: () => requests,
	}
}

void test('actual compact bucket tabs select the real saved list; the whole row opens its exact occurrence without reads or nested buttons', (t) => {
	const f = fixture(t)
	f.ui.viewport.width = 320
	f.ui.viewport.fontScale = 1.4
	for (const theme of Object.values(builtInThemes)) {
		f.session.open('listening')
		const tree = f.render(theme)
		const tabs = controlNodes(tree).filter(
			(entry) => entry.props.accessibilityRole === 'tab',
		)
		assert.equal(tabs.length, 2)
		assert.deepEqual(
			tabs.map(
				(entry) =>
					(entry.props.accessibilityState as { selected: boolean }).selected,
			),
			[true, false],
		)
		const tabGroup = controlNodes(tree).find(
			(entry) => entry.props.testID === 'saved-video-bucket-tabs',
		)!
		assert.equal(f.ui.flatten(tabGroup.props.style).flexDirection, 'row')
		for (const target of tabs) {
			const style =
				typeof target.props.style === 'function'
					? target.props.style({ pressed: false })
					: target.props.style
			assert.equal(f.ui.flatten(style).minHeight, 48)
			assert.equal(f.ui.flatten(style).height, undefined)
		}
		const row = button(tree, '查看收藏原项 2 原条目 2')
		assert.equal(
			controlNodes(row.children).filter((entry) => entry.type === 'Pressable')
				.length,
			0,
		)
		assert.doesNotMatch(
			text(tree),
			/保存时已读取视频目录|保存时未核验视频目录|音轨未核验/,
		)
		;(row.props.onPress as () => void)()
		assert.equal(f.session.getSnapshot().item!.itemId, 'saved-1')
		press(f.render(theme), '来源与管理')
		const detail = f.render(theme)
		assert.match(text(detail), /保存时已读取视频目录.*音轨未核验/)
		press(detail, '查看原任务证据与人工分类')
		assert.deepEqual(f.origins.at(-1), ['task', 'e1'])
		press(detail, '返回听视频收藏上一步')
		assert.equal(f.session.getSnapshot().route, 'item')
		press(f.render(theme), '返回听视频收藏上一步')
		assert.equal(f.session.getSnapshot().route, 'list')
		assert.equal(f.session.getSnapshot().bucket, 'listening')
		press(f.render(theme), '查看待分类列表')
		assert.equal(f.session.getSnapshot().bucket, 'unclassified')
		const unclassified = f.render(theme)
		const unclassifiedTabs = controlNodes(unclassified).filter(
			(entry) => entry.props.accessibilityRole === 'tab',
		)
		assert.deepEqual(
			unclassifiedTabs.map(
				(entry) =>
					(entry.props.accessibilityState as { selected: boolean }).selected,
			),
			[false, true],
		)
		assert.ok(button(unclassified, '查看收藏原项 1 原条目 4'))
		assert.equal(f.requests(), 0)
		assert.deepEqual(f.plays, [])
	}
})

void test('detail retains unverified and missing-BV evidence, and removal still requires confirmation of the exact saved occurrence', (t) => {
	const f = fixture(t)
	f.session.open('listening')
	press(f.render(), '查看收藏原项 3 原条目 3')
	press(f.render(), '来源与管理')
	assert.match(text(f.render()), /保存时未核验视频目录.*音轨未核验/)
	f.session.back()
	f.session.open('unclassified')
	press(f.render(), '查看收藏原项 1 原条目 4')
	f.render()
	press(f.render(), '来源与管理')
	const detail = f.render()
	assert.match(text(detail), /原目录缺少视频身份/)
	assert.match(text(detail), /原条目未提供 BV，暂时不能读取分 P 或收听/)
	assert.equal(
		controlNodes(detail).some(
			(entry) =>
				entry.type === 'Pressable' && text(entry) === '以听视频收听所选 P',
		),
		false,
	)
	assert.equal(
		controlNodes(detail).some(
			(entry) =>
				entry.type === 'Pressable' &&
				text(entry) === '刷新分 P',
		),
		false,
	)
	press(detail, '移除本地收藏原项')
	assert.equal(f.alerts.length, 1)
	assert.match(
		f.alerts[0].message,
		/不删除音源、断点、喜欢、音乐歌单或导入历史/,
	)
	assert.ok(f.saves.get('saved-3'))
	const cancel = f.alerts[0].actions.find(
		(action) => action.style === 'cancel',
	)!
	cancel.onPress?.()
	assert.ok(f.saves.get('saved-3'))
	const confirm = f.alerts[0].actions.find(
		(action) => action.style === 'destructive',
	)!
	assert.equal(confirm.text, '移除本地收藏原项')
	confirm.onPress!()
	assert.equal(f.saves.get('saved-3'), null)
	assert.equal(f.saves.list('listening', { offset: 0, limit: 20 }).length, 3)
	assert.equal(f.imports.getMixed('task')!.history[0].receipt.results.length, 4)
	assert.equal(f.session.getSnapshot().route, 'list')
	assert.equal(f.requests(), 0)
})

void test('a vanished visited P stays unselected until an actual part choice; busy playback remains disabled and only explicit refresh reads', async (t) => {
	const f = fixture(t)
	f.catalog.recordVisitedPart(bvid, `bilibili:${bvid}:22`)
	f.catalog.save(video([33]), 2)
	f.session.open('listening')
	press(f.render(), '查看收藏原项 1 原条目 1')
	press(f.render(), '选择分 P 并播放')
	let detail = f.render()
	assert.match(text(detail), /最后访问分 P 已不在当前目录/)
	assert.equal(f.session.selectedSource(), null)
	assert.equal(button(detail, '以听视频收听所选 P').props.disabled, true)
	f.session.selectCid(999)
	assert.equal(f.session.selectedSource(), null)
	assert.equal(f.requests(), 0)
	const choice = controlNodes(detail).find(
		(entry) =>
			entry.type === 'Pressable' &&
			String(entry.props.accessibilityLabel).startsWith(
				'选择原视频 P1 部分 33，CID 33',
			),
	)!
	assert.ok(choice)
	;(choice.props.onPress as () => void)()
	detail = f.render()
	assert.equal(button(detail, '以听视频收听所选 P').props.disabled, false)
	assert.equal(
		button(f.render(builtInThemes.modern, true), '以听视频收听所选 P').props
			.disabled,
		true,
	)
	press(detail, '以听视频收听所选 P')
	assert.deepEqual(f.plays, [`bilibili:${bvid}:33`])
	assert.equal(f.requests(), 0)
	press(detail, '刷新分 P')
	assert.equal(f.requests(), 1)
	await new Promise<void>((resolve) => setImmediate(resolve))
	assert.equal(f.session.getSnapshot().busy, false)
	assert.equal(f.session.getSnapshot().video!.parts[0].source.cid, 33)
})
