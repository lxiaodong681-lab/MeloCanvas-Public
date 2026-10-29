import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	parseAccountFollowings,
	type AccountFollowingState,
} from '../account-following-session'
import * as offlineState from '../offline-state'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'
import {
	biliState,
	importHost,
	importState,
	label,
	mixedTask,
	press,
	settle,
	task,
	text,
} from './theme-import-fixture'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
const click = (tree: unknown, name: string) => {
	const node = controlNodes(tree).find(
		(item) => typeof item.props.onPress === 'function' && (text(item) === name || item.props.accessibilityLabel === name),
	)
	assert.ok(node, name)
	assert.ok(!node.props.disabled, name)
	;(node.props.onPress as () => void)()
}

void test('legacy external playlist destination opens the direct import flow without a redundant destination form', () => {
 const h=importHost(); try {
 const tree=settle(h,h.page('ImportPage',importState({route:'destination',task:task()})),320);
 assert.match(text(tree),/准备导入/);
 assert.equal(controlNodes(tree).some(n=>n.props.accessibilityLabel==='导入副本名称'),false);
 assert.equal(h.calls.some(([name])=>name==='prepareCommit'||name==='commit'),false);
 } finally { h.unmount() }
})

void test('Bilibili destination draft survives task return without preparing or committing automatically', () => {
	const h = importHost()
	const detail = mixedTask()
	detail.contentReviews = [{ entryId: 'e0', kind: 'song', reviewedAt: 1 }]
	const render = (route: 'destination' | 'task', current = detail) =>
		settle(
			h,
			h.page('BilibiliImportPage', biliState({ route, task: current })),
			320,
		)
	try {
		let tree = render('destination')
		const field = controlNodes(tree).find(
			(node) => node.props.accessibilityLabel === '本地音乐歌单名称',
		)!
		;(field.props.onChangeText as (value: string) => void)('收藏夹副本草稿')
		press(tree, '歌曲重复：跳过目标歌单已存在的确认音源')
		render('destination')
		render('task')
		tree = render('destination')
		assert.equal(
			controlNodes(tree).find(
				(node) => node.props.accessibilityLabel === '本地音乐歌单名称',
			)!.props.value,
			'收藏夹副本草稿',
		)
		assert.equal(
			(
				label(tree, '歌曲重复：跳过目标歌单已存在的确认音源').props
					.accessibilityState as { checked: boolean }
			).checked,
			true,
		)
		tree = render('destination', { ...detail, taskId: 'another' })
		assert.equal(
			controlNodes(tree).find(
				(node) => node.props.accessibilityLabel === '本地音乐歌单名称',
			)!.props.value,
			'原收藏夹',
		)
		assert.equal(
			h.calls.some(([name]) => name === 'prepare' || name === 'commit'),
			false,
		)
	} finally {
		h.unmount()
	}
})

void test('account following keeps zero-selection and review controls outside its windowed list, restoring selection position', () => {
	const items = parseAccountFollowings(
		{
			list: Array.from({ length: 50 }, (_, index) => ({
				mid: index + 1,
				uname: `合成UP${index}`,
				face: '',
				sign: '',
			})),
			total: 50,
		},
		1,
		0,
	).items
	let state: AccountFollowingState = {
		open: true,
		accountName: '合成账号',
		items,
		selectedMids: [],
		existingMids: [],
		scope: 'all',
		page: 1,
		total: 50,
		more: false,
		loading: false,
		failedPage: null,
		error: '',
		notice: '',
		review: null,
	}
	const calls: string[] = []
	const dependencies: Record<string, unknown> = {}
	const f = controlFixture({}, dependencies, { start: 45, count: 2 })
	dependencies['./creator-ui'] = f.load('creator-ui')
	const ui = f.load('account-following-ui')
	const offsets: number[] = []
	const render = () =>
		f.render(
			f.element(ui.AccountFollowingPage as ControlNode['type'], {
				state,
				session: {
					close: () => calls.push('close'),
					cancelReview: () => {
						state = { ...state, review: null }
					},
					requestImport: () => calls.push('review'),
					confirmImport: () => {
						calls.push('confirm')
						return 1
					},
				},
			}),
		)
	const attach = (tree: unknown) => {
		const list = controlNodes(tree).find((node) => node.type === 'FlatList')!
		assert.ok(list, 'account following uses a windowed list')
		;(list.props.ref as { current: unknown }).current = {
			scrollToOffset: ({ offset }: { offset: number }) => offsets.push(offset),
		}
		return list
	}
	try {
		let tree = render()
		const list = attach(tree)
		f.flushAnimationFrames()
		const reviewButton = controlNodes(tree).find(
			(node) => node.props.testID === 'review-account-following-import',
		)!
		assert.equal(reviewButton.props.disabled, true)
		assert.equal(
			controlNodes(list).some(
				(node) => node.props.testID === 'review-account-following-import',
			),
			false,
		)
		assert.equal(
			controlNodes(tree).filter(
				(node) => node.props.accessibilityRole === 'checkbox',
			).length,
			2,
		)
		;(list.props.onScroll as (event: unknown) => void)({
			nativeEvent: { contentOffset: { y: 900 } },
		})
		state = {
			...state,
			selectedMids: [items[49].mid],
			review: { items: [items[49]], scope: 'all' },
		}
		tree = render()
		const reviewList = attach(tree)
		f.flushAnimationFrames()
		assert.equal(
			controlNodes(reviewList).some(
				(node) => node.props.testID === 'confirm-account-following-import',
			),
			false,
		)
		assert.ok(
			controlNodes(tree).some(
				(node) => node.props.testID === 'confirm-account-following-import',
			),
		)
		assert.deepEqual(calls, [])
		state = { ...state, review: null }
		tree = render()
		attach(tree)
		f.flushAnimationFrames()
		assert.equal(offsets.at(-1), 900)
		assert.deepEqual(calls, [])
	} finally {
		f.unmount()
	}
})

void test('offline list starts with collapsed capacity, fixed return and truthful operation feedback', async () => {
	const pending = deferred<void>()
	let failure = false
	const calls: string[] = []
	const f = controlFixture(
		{},
		{
			'./offline-state': offlineState,
			'@bbplayer/orpheus': {
				Orpheus: {
					getDownloads: async () => [
						{
							id: 'melo-offline:test',
							state: 2,
							verifiedComplete: false,
							contentLength: 100,
							bytesDownloaded: 20,
							track: {
								id: 'track',
								title: '合成下载',
								sourceId: 'bilibili:BV1234567890:42',
							},
						},
					],
					getOfflineStorage: async () => ({
						usedBytes: 20,
						limitBytes: 1024 ** 3,
						freeBytes: 1024 ** 4,
					}),
					pauseOfflineDownload: async () => {
						calls.push('pause')
						if (failure) throw new Error('Synthetic_Download_Detail')
						await pending.promise
					},
				},
			},
		},
	)
	const ui = f.load('offline-ui')
	const render = () =>
		f.render(
			f.element(ui.OfflineManager as ControlNode['type'], {
				visible: true,
				onClose: () => calls.push('close'),
				onPlay: async () => {},
				track: null,
				bottomInset: 24,
			}),
		)
	try {
		assert.doesNotMatch(text(render()), /上限.*尚未设置/)
		await tick()
		let tree = render()
		const scroll = controlNodes(tree).find(
			(node) => node.type === 'ScrollView',
		)!
		assert.equal(
			controlNodes(scroll).some(
				(node) =>
					text(node) === '返回' && typeof node.props.onPress === 'function',
			),
			false,
		)
		assert.equal(
			controlNodes(tree).some((node) => node.type === 'TextInput'),
			false,
		)
		click(tree, '容量设置')
		tree = render()
		assert.ok(
			controlNodes(tree).some(
				(node) => node.props.accessibilityLabel === '离线容量上限 GiB',
			),
		)
		click(tree, '返回')
		click(render(), '下载操作 合成下载')
		click(render(), '暂停下载， 保留部分')
		tree = render()
		assert.match(text(tree), /正在暂停下载/)
		assert.doesNotMatch(
			text(controlNodes(tree).find((node) => node.type === 'ScrollView')!),
			/正在暂停下载/,
		)
		pending.resolve()
		await tick()
		assert.match(text(render()), /已暂停，已下载部分保留/)
		failure = true
		click(render(), '下载操作 合成下载')
		click(render(), '暂停下载， 保留部分')
		await tick()
		tree = render()
		assert.match(text(tree), /操作未完成，请检查网络/)
		assert.doesNotMatch(text(tree), /Synthetic_Download_Detail/)
		click(tree, '查看错误详情')
		tree = render()
		assert.match(text(controlNodes(tree).find((node) => node.type === 'ScrollView')!), /Synthetic_Download_Detail/)
		assert.equal(controlNodes(tree).some((node) => node.props.accessibilityLiveRegion === 'polite' && text(node).includes('Synthetic_Download_Detail')), false)
		assert.deepEqual(calls, ['pause', 'pause'])
	} finally {
		pending.resolve()
		f.unmount()
	}
})

void test('backup operation status stays outside scroll and chosen preview receives focus without restoring', async () => {
	const pending = deferred<boolean>()
	const calls: string[] = []
	const selected = {
		token: 'synthetic',
		catalogueJson: '{}',
		full: false,
		audioFiles: 0,
		themeFiles: 0,
		coverFiles: 0,
		bytes: 10,
	}
	const f = controlFixture(
		{},
		{
			'./library-backup-mobile': {
				canUndoLibraryBackup: () => false,
				saveLibraryBackup: async () => {
					calls.push('save')
					return pending.promise
				},
				chooseLibraryBackup: async () => {
					calls.push('choose')
					return selected
				},
				previewLibraryBackupMerge: () => ({
					inserted: 1,
					keptExisting: 0,
					skippedGroups: 0,
				}),
				previewLibraryBackup: () => ({
					playlists: 1,
					liked: 0,
					pendingItems: 0,
					localReferences: 0,
				}),
			},
		},
	)
	const ui = f.load('library-backup-ui')
	const render = () =>
		f.render(
			f.element(ui.LibraryBackupEntry as ControlNode['type'], {
				onRestored: () => calls.push('restore'),
			}),
		)
	const positions: number[] = []
	try {
		click(render(), '音乐库备份与恢复')
		click(render(), '创建备份')
		click(render(), '保存轻量备份到文件')
		let tree = render()
		assert.match(text(tree), /正在安全处理文件/)
		assert.doesNotMatch(
			text(controlNodes(tree).find((node) => node.type === 'ScrollView')!),
			/正在安全处理文件/,
		)
		pending.resolve(false)
		await tick()
		assert.match(text(render()), /已取消保存，未导出备份/)
		click(render(), '返回')
		await tick()
		click(render(), '从备份恢复')
		click(render(), '选择备份，先查看内容')
		await tick()
		tree = render()
		const scroll = controlNodes(tree).find(
			(node) => node.type === 'ScrollView',
		)!
		;(scroll.props.ref as { current: unknown }).current = {
			scrollTo: ({ y }: { y: number }) => positions.push(y),
		}
		const preview = controlNodes(tree).find(
			(node) =>
				node.type === 'View' &&
				typeof node.props.onLayout === 'function' &&
				text(node).includes('恢复预览'),
		)!
		assert.ok(preview)
		;(preview.props.onLayout as (event: unknown) => void)({
			nativeEvent: { layout: { y: 800 } },
		})
		assert.deepEqual(positions, [788])
		assert.deepEqual(calls, ['save', 'choose'])
	} finally {
		pending.resolve(false)
		f.unmount()
	}
})
