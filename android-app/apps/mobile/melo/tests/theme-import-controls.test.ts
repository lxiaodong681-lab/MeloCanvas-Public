import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'

import {
	controlNodes,
	legacyControlPackage,
} from './theme-control-fixture'
import {
	biliState,
	component,
	controls,
	flat,
	importHost,
	importState,
	label,
	measure,
	measurements,
	mixedTask,
	packageTheme,
	playlistState,
	press,
	receipt,
	responsive,
	settle,
	task,
	text,
	video,
} from './theme-import-fixture'

const picker = {
	sources: video.parts.map((part, index) => ({
		...part.source,
		originalTitle: index ? '原B' : '原A',
	})),
	selectedSourceIds: [video.parts[1].source.id],
	query: '',
	duplicatePolicy: 'keep-all' as const,
}
const candidate = {
	bvid: video.bvid,
	originalTitle: '候选版本',
	uploader: '原UP',
	uploaderId: 88,
	artwork: '',
	duration: 200,
	category: 'B站视频',
}


// Import now matches automatically; old per-entry approval pages are intentionally gone.
// Exercise the current routes and callbacks across the same four theme presentations.
void test('built-in and legacy themes expose automatic import and preserve playlist input contracts', async () => {
 const legacy = await legacyControlPackage()
 for (const theme of [...Object.values(builtInThemes), null]) {
  const h = importHost()
  const draw = (name: string, state: object) => settle(h, h.element(component(theme ? h.ui.ThemeProvider : h.ui.PackageThemeProvider), theme ? {value: theme} : {...legacy, reducedMotion: true}, h.page(name,state)),320)
  for (const kind of ['create','rename','copy'] as const) {
   const tree = draw('PlaylistDialogs', playlistState({nameForm:{kind,value:'草稿'}}))
   const input = label(tree,'歌单名称')
   assert.equal(input.props.value,'草稿')
   assert.equal(input.props.multiline,false)
  }
  h.calls.length=0
  let tree = draw('ImportPage',importState({route:'input',provider:'netease',url:'分享歌单 https://music.163.com/playlist?id=123'}))
  assert.deepEqual(h.calls,[])
  assert.equal(label(tree,'导入歌单').props.disabled,false)
  const scrolling=controlNodes(tree).find(n=>n.type==='ScrollView')!
  assert.ok(!controls(scrolling).some(n=>n.props.accessibilityLabel==='导入歌单'))
  press(tree,'导入歌单')
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(h.calls.filter(c=>c[0]==='importPlaylist').length,1)
  tree=draw('ImportPage',importState({route:'entry',task:task(),entryId:'e0',video,selectedCid:22}))
  press(tree,'试听');press(tree,'使用这个音源')
  assert.ok(h.calls.some(c=>c[0]==='preview' && (c[1] as {cid:number}).cid===22))
  assert.equal(h.calls.filter(c=>c[0]==='applySelectedSource').length,1)
  assert.ok(!h.calls.some(c=>c[0]==='prepareCommit' || c[0]==='confirmCandidate'))
  h.unmount()
 }
})

void test('running import disables resubmission and leaves pause available for every theme', async () => {
 const legacy = await legacyControlPackage()
 for (const theme of [...Object.values(builtInThemes), null]) {
  const h=importHost()
  const draw=(state:object)=>settle(h,h.element(component(theme?h.ui.ThemeProvider:h.ui.PackageThemeProvider),theme?{value:theme}:{...legacy,reducedMotion:true},h.page('ImportPage',state)),320)
  let tree=draw(importState({route:'input',provider:'qq',url:'原链接',reading:true,error:'平台受限'}))
  assert.equal(label(tree,'外部歌单完整链接').props.editable,false)
  assert.equal(label(tree,'正在读取歌单…').props.disabled,true)
  assert.match(text(tree),/平台受限/)
  press(tree,'暂停导入')
  assert.deepEqual(h.calls,[['cancelRead']])
  tree=draw(importState({route:'task',task:task(),batch:{phase:'running',eligible:3,skipped:0,budget:3,requested:2,completed:1,empty:0}}))
  assert.equal(label(tree,'正在匹配 1/3').props.disabled,true)
  press(tree,'暂停导入')
  assert.deepEqual(h.calls.at(-1),['pauseBatch'])
  tree=draw(importState({route:'task',task:task(),batch:{phase:'paused',eligible:3,skipped:0,budget:3,requested:2,completed:1,empty:0}}))
  press(tree,'继续导入')
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(h.calls.filter(c=>c[0]==='importPlaylist').length,1)
  h.unmount()
 }
})

void test('playlist picker remains virtualized and preserves duplicate source identities', () => {
 const h=importHost()
 const tree=settle(h,h.page('PlaylistDialogs',playlistState({picker})),320)
 const list=controlNodes(tree).find(n=>n.props.testID==='playlist-picker-list')!
 assert.ok(list)
 assert.equal(list.type,'FlatList')
 assert.equal(list.props.windowSize,5)
 assert.equal(list.props.initialNumToRender,12)
 assert.deepEqual((list.props.data as {id:string}[]).map(s=>s.id),picker.sources.map(s=>s.id))
 assert.deepEqual(list.props.extraData,picker.selectedSourceIds)
 h.unmount()
})

void test('actual playlist name/picker input bindings preserve draft, maxLength, original IME event and selective picker callbacks', () => {
	const h = importHost(),
		adapted = packageTheme()
	let state = playlistState({ nameForm: { kind: 'create', value: '草稿' } })
	let value = responsive(h, 'PlaylistDialogs', state, adapted),
		tree = settle(h, value)
	const input = label(tree, '歌单名称')
	assert.equal(input.type, 'TextInput')
	assert.equal(input.props.value, '草稿')
	assert.equal(input.props.maxLength, 40)
	assert.equal(input.props.returnKeyType, 'done')
	assert.equal(flat(h, input).minHeight, 96)
	;(input.props.onChangeText as (value: string) => void)('新草稿')
	const event = { nativeEvent: { text: '原生提交文本', eventCount: 3 } }
	;(input.props.onSubmitEditing as (event: unknown) => void)(event)
	assert.deepEqual(h.calls, [
		['setName', '新草稿'],
		['saveName', event],
	])
	state = playlistState({ nameForm: { kind: 'create', value: '新草稿' } })
	tree = settle(h, responsive(h, 'PlaylistDialogs', state, adapted))
	assert.equal(label(tree, '歌单名称').props.value, '新草稿')
	press(tree, '关闭歌单面板')
	assert.deepEqual(h.calls.at(-1), ['closeSheet'])
	tree = settle(
		h,
		responsive(h, 'PlaylistDialogs', playlistState({ picker }), adapted),
	)
	const query = label(tree, '搜索待添加的音源')
	;(query.props.onChangeText as (value: string) => void)('原B')
	tree = settle(
		h,
		responsive(
			h,
			'PlaylistDialogs',
			playlistState({ picker: { ...picker, query: '原B' } }),
			adapted,
		),
	)
	assert.equal(label(tree, '搜索待添加的音源').props.value, '原B')
	assert.equal(
		(
			label(tree, '选择音源 原B').props.accessibilityState as {
				checked: boolean
			}
		).checked,
		true,
	)
	assert.equal(
		controls(tree).some(
			(node) => node.props.accessibilityLabel === '选择音源 原A',
		),
		false,
	)
	press(tree, '选择音源 原B')
	assert.deepEqual(h.calls.at(-1), ['toggleSource', picker.sources[1].id])
	h.unmount()
})

void test('actual external input errors/cancel stay truthful and typing never reads a directory or submits twice', () => {
	const h = importHost(),
		adapted = packageTheme()
	let tree = settle(
		h,
		responsive(
			h,
			'ImportPage',
			importState({
				route: 'input',
				provider: 'qq',
				url: '原链接',
				reading: true,
				error: '平台受限',
			}),
			adapted,
		),
	)
	assert.equal(label(tree, '外部歌单完整链接').props.editable, false)
	assert.ok(text(tree).includes('平台受限'))
	press(tree, '暂停导入')
	assert.equal(
		h.calls.some((call) => call[0] === 'cancelRead'),
		true,
	)
	tree = settle(
		h,
		responsive(
			h,
			'ImportPage',
			importState({ route: 'input', provider: 'qq', url: '未请求链接' }),
			adapted,
		),
	)
	const input = label(tree, '外部歌单完整链接')
	;(input.props.onChangeText as (text: string) => void)('新链接')
	assert.equal(
		h.calls.some((call) => call[0] === 'readDirectory'),
		false,
	)
	press(tree, '导入歌单')
	assert.equal(h.calls.filter((call) => call[0] === 'importPlaylist').length, 1)
	h.unmount()
})

void test('large import shows a bounded summary without requiring selection or pagination', () => {
 const h=importHost(),directory=task('netease',21)
 const tree=settle(h,responsive(h,'ImportPage',importState({route:'task',task:directory}),packageTheme()),320)
 assert.match(text(tree),/共 21 首，全部按顺序导入/)
 assert.equal(controls(tree).filter(n=>n.props.accessibilityRole==='checkbox').length,0)
 assert.doesNotMatch(text(tree),/全选未保存项|核对版本与候选|下一页/)
 assert.deepEqual(h.calls,[])
 press(tree,'导入歌单')
 assert.equal(h.calls.filter(c=>c[0]==='importPlaylist').length,1)
 assert.equal(directory.entries.length,21)
 h.unmount()
})

void test('actual external candidate and P controls retain explicit original BV/CID read, selection, preview and explicit source replacement', () => {
	const h = importHost(),
		adapted = packageTheme(),
		directory = task()
	let state = importState({
		route: 'entry',
		task: directory,
		entryId: 'e0',
		query: '保留查询',
		candidates: [candidate],
		searchPage: 1,
	})
	let tree = settle(h, responsive(h, 'ImportPage', state, adapted))
	press(tree, `选择音源 候选版本`)
	assert.deepEqual(
		h.calls.filter((call) => call[0] === 'readVideo'),
		[['readVideo', video.bvid]],
	)
	assert.equal(
		h.calls.some(
			(call) => call[0] === 'applySelectedSource' || call[0] === 'preview',
		),
		false,
	)
	state = { ...state, video }
	tree = settle(h, responsive(h, 'ImportPage', state, adapted))
	assert.equal(label(tree, '使用这个音源').props.disabled, true)
	press(tree, '选择分P 2 版本2')
	assert.deepEqual(h.calls.at(-1), ['selectCid', 22])
	state = { ...state, selectedCid: 22 }
	tree = settle(h, responsive(h, 'ImportPage', state, adapted))
	press(tree, '试听')
	assert.equal(h.calls.filter((call) => call[0] === 'preview').length, 1)
	assert.equal(
		h.calls.some((call) => call[0] === 'applySelectedSource'),
		false,
	)
	press(tree, '使用这个音源')
	assert.equal(
		h.calls.filter((call) => call[0] === 'applySelectedSource').length,
		1,
	)
	assert.equal(label(tree, '导入候选关键词或BV号').props.value, '保留查询')
	h.unmount()
})

void test('actual Bili input/type/part and unknown item controls never invent a BV or automatic confirmation', () => {
	const h = importHost(),
		adapted = packageTheme(),
		directory = mixedTask()
	directory.entries[0].originalMetadata = {
		media: { id: 1, type: 2, title: '失效原项' },
		observed: { bvid: null },
	}
	let tree = settle(
		h,
		responsive(
			h,
			'BilibiliImportPage',
			biliState({ route: 'entry', task: directory, entryId: 'e0' }),
			adapted,
		),
	)
	assert.equal(label(tree, '读取原BV真实分 P').props.disabled, true)
	assert.ok(text(tree).includes('原条目无可核验 BV'))
	assert.equal(
		h.calls.some((call) => call[0] === 'readVideo'),
		false,
	)
	press(tree, '修改人工内容类型')
	tree = settle(
		h,
		responsive(
			h,
			'BilibiliImportPage',
			biliState({ route: 'entry', task: directory, entryId: 'e0' }),
			adapted,
		),
	)
	const beforeKind = h.calls.length
	press(tree, '知识讲解')
	assert.deepEqual(h.calls.slice(beforeKind), [
		['setKind', 'knowledge'],
		['rememberScroll', 'entry:task:e0:public', 0],
	])
	tree = settle(
		h,
		responsive(
			h,
			'BilibiliImportPage',
			biliState({ route: 'entry', task: mixedTask(), entryId: 'e0', video }),
			adapted,
		),
	)
	assert.equal(label(tree, '明确确认所选原BV/CID').props.disabled, true)
	press(tree, '选择原视频 P2 版本2，CID 22，03:20')
	assert.equal(
		h.calls.some((call) => call[0] === 'selectCid' && call[1] === 22),
		true,
	)
	assert.equal(
		h.calls.some((call) => call[0] === 'confirmCid'),
		false,
	)
	tree = settle(
		h,
		responsive(
			h,
			'BilibiliImportPage',
			biliState({
				route: 'entry',
				task: mixedTask(),
				entryId: 'e0',
				video,
				selectedCid: 22,
			}),
			adapted,
		),
	)
	press(tree, '明确确认所选原BV/CID')
	assert.equal(h.calls.filter((call) => call[0] === 'confirmCid').length, 1)
	tree = settle(h, responsive(h, 'BilibiliImportPage', biliState(), adapted))
	;(
		label(tree, 'B站收藏夹所属UP的mid').props.onChangeText as (
			value: string,
		) => void
	)('1234')
	assert.equal(
		h.calls.some((call) => call[0] === 'readFolders'),
		false,
	)
	press(tree, '读取可见收藏夹')
	assert.equal(h.calls.filter((call) => call[0] === 'readFolders').length, 1)
	tree = settle(
		h,
		responsive(
			h,
			'BilibiliImportPage',
			biliState({ busy: true, error: '响应异常，原资料保留' }),
			adapted,
		),
	)
	assert.equal(label(tree, 'B站收藏夹所属UP的mid').props.editable, false)
	assert.equal(label(tree, '读取可见收藏夹').props.disabled, true)
	assert.ok(text(tree).includes('响应异常，原资料保留'))
	press(tree, '取消本次读取')
	assert.deepEqual(h.calls.at(-1), ['cancelRead'])
	h.unmount()
})

void test('actual Bili per-occurrence checkboxes and duplicate choices preserve explicit item IDs and original unknown destination', () => {
	const h = importHost(),
		adapted = packageTheme(),
		directory = mixedTask()
	let tree = settle(
		h,
		responsive(
			h,
			'BilibiliImportPage',
			biliState({ route: 'task', task: directory }),
			adapted,
		),
	)
	assert.equal(
		controls(tree).some((node) => node.props.accessibilityRole === 'checkbox'),
		false,
	)
	press(tree, '调整导入条目')
	tree = settle(
		h,
		responsive(
			h,
			'BilibiliImportPage',
			biliState({ route: 'task', task: directory }),
			adapted,
		),
	)
	press(tree, '选择原目录第1项 原A')
	press(tree, '选择原目录第3项 原A')
	assert.deepEqual(
		h.calls.filter((call) => call[0] === 'setSelected'),
		[
			['setSelected', 'e0', false],
			['setSelected', 'e2', true],
		],
	)
	directory.history = [{ kind: 'playlist', receipt: receipt() }]
	tree = settle(
		h,
		responsive(
			h,
			'BilibiliImportPage',
			biliState({ route: 'task', task: directory }),
			adapted,
		),
	)
	assert.equal(
		controls(tree).some(
			(node) => node.props.accessibilityLabel === '选择原目录第1项 原A',
		),
		false,
	)
	assert.ok(label(tree, '选择原目录第3项 原A'))
	const state = biliState({ route: 'destination', task: mixedTask() })
	tree = settle(h, responsive(h, 'BilibiliImportPage', state, adapted))
	assert.ok(text(tree).includes('本次没有歌曲，不创建空音乐歌单'))
	assert.equal(
		(
			label(tree, '视频重复：保留全部出现项（默认）').props
				.accessibilityState as { checked: boolean }
		).checked,
		true,
	)
	press(tree, '视频重复：跳过同收藏类别已存在的 BV')
	tree = settle(h, responsive(h, 'BilibiliImportPage', state, adapted))
	press(tree, '核对保存内容')
	assert.deepEqual(h.calls.at(-1), [
		'prepare',
		null,
		'keep-all',
		'skip-existing-video',
	])
	h.unmount()
})

void test('restored legacy import routes resume automatic import instead of reopening approval forms', () => {
 const h=importHost(),done=task();done.commits=[receipt()]
 for(const route of ['destination','result'] as const) {
  const tree=settle(h,responsive(h,'ImportPage',importState({route,task:done,error:'保存失败'}),packageTheme()),320)
  assert.match(text(tree),/保存失败/)
  assert.doesNotMatch(text(tree),/核对本次保存|导入副本名称|保留重复出现项/)
  press(tree,'补匹配并打开歌单')
 }
 assert.equal(h.calls.filter(c=>c[0]==='importPlaylist').length,2)
 assert.ok(!h.calls.some(c=>c[0]==='prepareCommit'))
 h.unmount()
})

void test('actual Bili radio width budget includes its existing padding and selected border, preserving long wrapping label', () => {
	const h = importHost(),
		choice = h.load('bilibili-import-ui').BiliChoice
	const value = h.element(
		component(h.ui.PackageThemeProvider),
		{ adapted: packageTheme(), allowedImageUris: [], reducedMotion: true },
		h.element(component(choice), {
			label: '长内容类别标签保留原有换行',
			selected: true,
			press: () => h.calls.push(['choice']),
		}),
	)
	let tree = h.render(value)
	const row = measurements(tree)[0]
	assert.ok(row)
	measure(row, 75)
	tree = h.render(value)
	assert.equal(controls(tree).length, 0)
	measure(row, 76)
	tree = h.render(value)
	const button = label(tree, '长内容类别标签保留原有换行')
	assert.equal(flat(h, button).minWidth, 76)
	assert.equal(flat(h, button).padding, 12)
	assert.equal(flat(h, button).borderWidth, 2)
	press(tree, '长内容类别标签保留原有换行')
	assert.deepEqual(h.calls, [['choice']])
	h.unmount()
})
