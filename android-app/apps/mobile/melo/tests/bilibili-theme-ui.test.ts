import assert from 'node:assert/strict'
import test from 'node:test'
import { controlFixture, controlNodes, type ControlNode } from './theme-control-fixture'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const text = (v: unknown): string => Array.isArray(v) ? v.map(text).join('') : v && typeof v === 'object' && 'children' in v ? text(v.children) : typeof v === 'string' ? v : ''
function fixture() {
	const searched: [string, number][] = [], ownedPages: number[] = [], previews: Uint8Array[] = [], working: boolean[] = []
	let resolveImport!: (bytes: Uint8Array) => void, downloadSignal: AbortSignal | undefined
	let failOwned = false
	const f = controlFixture({}, {
		'./theme-background': { defaultBackgroundAdjustments: { transparency: 80, zoom: 1, horizontal: 50, vertical: 50 } },
		'./theme-author-ui': { ThemeAdjustmentSlider: 'ThemeAdjustmentSlider' },
		'./theme-input': { ThemeTextInput: 'TextInput' },
		'./bilibili-theme-mobile': {
			listMobileOwnedBilibiliThemes: async (page: number) => { ownedPages.push(page); if (failOwned) throw new Error('主题读取失败'); return { items: [{ id: 'skin-456', name: '星空列车', kind: 'skin' }], hasMore: true } },
			searchMobileBilibiliThemes: async (query: string, page: number) => { searched.push([query, page]); return { items: [{ id: 'suit-123', name: '示例', kind: 'suit' }], hasMore: true } },
			importMobileBilibiliTheme: async (_item: unknown, signal: AbortSignal) => { downloadSignal = signal; return new Promise<Uint8Array>((resolve) => { resolveImport = resolve }) },
		},
	})
	const module = f.load('bilibili-theme-ui')
	const render = () => f.render(f.element(module.BilibiliThemeEntry as ControlNode['type'], { disabled: false,
		renderPreview: (back: () => void) => f.element('Pressable', { accessibilityLabel: '取消主题预览', onPress: back }, '预览详情'), onWorkingChange: (b: boolean) => working.push(b), onPreview: async (b: Uint8Array) => { previews.push(b); return true } }))
	const press = (label: string) => { const b = controlNodes(render()).find((n) => n.type === 'Pressable' && (text(n) === label || n.props.accessibilityLabel === label))!; assert.ok(b, label); assert.ok(!b.props.disabled); (b.props.onPress as () => void)() }
	const input = (query: string) => { (controlNodes(render()).find((n) => n.type === 'TextInput')!.props.onChangeText as (s: string) => void)(query) }
	return { f, render, press, input, searched, ownedPages, previews, working, failOwned: (value: boolean) => { failOwned = value }, finish: () => resolveImport(new Uint8Array([1])), signal: () => downloadSignal }
}

void test('owned themes are opt-in and pagination stays in the owned list until another search', async () => {
	const h = fixture(); h.press('从 B站导入个性主题'); assert.equal(h.ownedPages.length, 0)
	assert.equal(controlNodes(h.render()).some(n => n.type === 'TextInput' || n.type === 'FlatList'), false)
	h.press('我的 B站主题'); await tick(); h.press('下一页主题'); await tick()
	assert.equal(controlNodes(h.render()).some(n => n.type === 'TextInput'), false)
	assert.equal(controlNodes(h.render()).filter(n => n.type === 'Modal').length, 1)
	assert.deepEqual(h.ownedPages, [1, 2]); assert.equal(h.searched.length, 0)
	h.press('星空列车'); await tick(); h.finish(); await tick()
	assert.equal(h.previews.length, 1)
	h.press('取消主题预览'); h.press('返回我的 B站主题的上一级'); h.press('搜索主题'); h.input('初音'); h.press('搜索 B站主题'); await tick(); h.press('下一页主题'); await tick()
	assert.deepEqual(h.searched, [['初音', 1], ['初音', 2]]); h.f.unmount()
})

void test('system back dismisses the child list before the import hub', async () => {
	const h = fixture()
	h.press('从 B站导入个性主题'); h.press('我的 B站主题'); await tick()
	const back = () => (controlNodes(h.render()).find(n => n.type === 'Modal')!.props.onRequestClose as () => void)()
	back()
	assert.equal(controlNodes(h.render()).some(n => n.type === 'FlatList'), false)
	assert.match(text(h.render()), /搜索主题/)
	back()
	assert.equal(controlNodes(h.render()).some(n => n.type === 'Modal'), false)
	h.f.unmount()
})

void test('owned-list failure exposes retry on that page without applying or auto-searching', async () => {
	const h = fixture()
	h.failOwned(true)
	h.press('从 B站导入个性主题'); h.press('我的 B站主题'); await tick()
	assert.match(text(h.render()), /主题读取失败/)
	assert.equal(h.working.at(-1), false)
	assert.equal(h.previews.length, 0)
	h.failOwned(false); h.press('重试读取'); await tick()
	assert.deepEqual(h.ownedPages, [1, 1])
	assert.equal(h.searched.length, 0)
	assert.match(text(h.render()), /星空列车/)
	h.f.unmount()
})

void test('back during download aborts and never reopens a preview after the result arrives', async () => {
	const h = fixture()
	h.press('从 B站导入个性主题'); h.press('我的 B站主题'); await tick()
	h.press('星空列车'); await tick()
	h.press('返回我的 B站主题的上一级')
	assert.equal(h.signal()?.aborted, true)
	h.finish(); await tick()
	assert.equal(h.previews.length, 0)
	assert.match(text(h.render()), /搜索主题/)
	assert.doesNotMatch(text(h.render()), /预览详情/)
	h.f.unmount()
})

void test('Bili import stays opt-in, paginates explicit searches, and prepares preview without applying', async () => {
	const h = fixture(); h.render(); assert.equal(h.searched.length, 0)
	h.press('从 B站导入个性主题'); h.press('搜索主题'); h.input('初音'); h.press('搜索 B站主题'); await tick()
	h.press('下一页主题'); await tick(); assert.deepEqual(h.searched, [['初音', 1], ['初音', 2]])
	h.press('示例'); await tick(); assert.equal(h.previews.length, 0)
	h.finish(); await tick(); assert.equal(h.previews.length, 1)
	assert.match(text(h.render()), /预览详情/)
	assert.equal(controlNodes(h.render()).some(n => n.type === 'FlatList'), false)
	assert.equal(h.working.at(-1), false); h.f.unmount()
})

void test('cancel and unmount suppress a late download, never opening a stale preview', async () => {
	for (const unmount of [false, true]) {
		const h = fixture(); h.press('从 B站导入个性主题'); h.press('搜索主题'); h.input('初音'); h.press('搜索 B站主题'); await tick()
		h.press('示例'); await tick()
		if (unmount) h.f.unmount(); else h.press('取消读取 B站主题')
		assert.equal(h.signal()?.aborted, true)
		h.finish(); await tick(); assert.equal(h.previews.length, 0); assert.equal(h.f.writesAfterUnmount, 0)
		if (!unmount) h.f.unmount()
	}
})
