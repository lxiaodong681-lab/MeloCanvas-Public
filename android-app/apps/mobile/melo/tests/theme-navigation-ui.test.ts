import assert from 'node:assert/strict'
import test from 'node:test'
import { builtInThemes } from '../core/theme'
import { cosmosTheme } from '../core/theme-appearance'
import { controlFixture, controlNodes, type ControlNode } from './theme-control-fixture'

const tick = () => new Promise(resolve => setImmediate(resolve))
const text = (v: unknown): string => Array.isArray(v) ? v.map(text).join('') : v && typeof v === 'object' && 'children' in v ? text(v.children) : typeof v === 'string' ? v : ''
for (const theme of [...Object.values(builtInThemes), cosmosTheme]) {
	void test(`${theme.id}: installed themes are a child list and preview apply stays outside scrolling content`, async () => {
		const f = controlFixture({}, {
			'./theme-preview': { ThemeReferencePreview: 'ThemeReferencePreview' },
			'./theme-author-ui': { ThemeAuthorEntry: 'ThemeAuthorEntry' },
			'./bilibili-theme-ui': { BilibiliThemeEntry: 'BilibiliThemeEntry' },
			'./theme-workshop-session': { themeWorkshopBusy: () => false },
		})
		const current = { selection: { kind: 'builtin', key: 'modern' }, theme, adapted: null, packageMetadata: null, allowedImageUris: [] }
		let preview: unknown = null
		const calls: string[] = []
		const module = f.load('theme-package-panel')
		const render = () => f.render(f.element(f.load('ui').ThemeProvider as ControlNode['type'], { value: theme }, f.element(module.ThemePackagePanel as ControlNode['type'], {
			colorMode: theme === cosmosTheme ? 'dark' : 'light', reducedMotion: true,
			state: { current, installer: { preview, installed: [{ id: 'sample', archiveSha256: 'abc', name: '示例装扮', version: '1.0', storedBytes: 5 * 1024 * 1024 }], cleanupErrors: [] }, file: {}, widgetTheme: {} },
			session: { close: () => { preview = null; calls.push('cancel') }, apply: async () => { calls.push('apply'); preview = null; return true }, activateInstalled: async (id: string) => { calls.push(id); return true }, removeInstalled: async (id: string, hash: string) => { calls.push(`remove:${id}/${hash}`); return true } },
		})))
		const press = (label: string) => {
			const n = controlNodes(render()).find(node => node.type === 'Pressable' && (node.props.accessibilityLabel === label || text(node) === label))!
			assert.ok(n, label); (n.props.onPress as () => void)()
		}
		assert.equal(controlNodes(render()).some(n => n.type === 'FlatList'), false)
		press('已安装主题')
		assert.equal(controlNodes(render()).filter(n => n.type === 'FlatList').length, 1)
		assert.match(text(render()), /本地 5.0 MB/)
		press('删除主题 示例装扮')
		assert.match(text(render()), /删除本地主题？/)
		assert.deepEqual(calls, [], 'opening confirmation must not delete')
		press('取消')
		assert.deepEqual(calls, [], 'cancel preserves local files')
		press('删除主题 示例装扮')
		press('删除主题'); await tick()
		assert.deepEqual(calls, ['remove:sample/abc'])
		calls.length = 0
		press('示例装扮'); await tick()
		assert.deepEqual(calls, ['sample'])
		press('返回已安装主题的上一级')
		assert.equal(controlNodes(render()).some(n => n.type === 'Modal'), false)
		preview = current
		const tree = render()
		const scroll = controlNodes(tree).find(n => n.type === 'ScrollView')!
		assert.ok(scroll)
		assert.equal(controlNodes(scroll).some(n => n.type === 'Pressable' && text(n) === '应用此主题'), false)
		press('应用此主题'); await tick()
		assert.deepEqual(calls, ['sample', 'apply'])
		assert.equal(controlNodes(render()).some(n => n.type === 'Modal'), false)
		preview = current
		press('返回主题预览的上一级')
		assert.deepEqual(calls, ['sample', 'apply', 'cancel'])
		f.unmount()
	})
}
