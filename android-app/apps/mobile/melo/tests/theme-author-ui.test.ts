import assert from 'node:assert/strict'
import test from 'node:test'
import * as author from '../theme-author'
import * as backgroundOptions from '../theme-background'
import * as developerGuide from '../theme-developer-guide'
import { controlFixture, controlNodes, type ControlNode } from './theme-control-fixture'

const tick = () => new Promise(resolve => setImmediate(resolve))
const text = (v: unknown): string => Array.isArray(v) ? v.map(text).join('') : v && typeof v === 'object' && 'children' in v ? text(v.children) : typeof v === 'string' ? v : ''

function fixture(prepare?: () => Promise<unknown>, colorMode: 'light' | 'dark' = 'light') {
	const calls: unknown[][] = [], disposed: string[] = [], prepared: unknown[][] = [], applied: Uint8Array[] = []
	let picked: string | null = null
	const f = controlFixture({}, {
		'./theme-author': author,
		'./theme-background': backgroundOptions,
		'./theme-developer-guide': developerGuide,
		'./theme-input': { ThemeTextInput: 'TextInput' },
		'./theme-author-mobile': {
			prepareThemeBackground: prepare ?? (async (base: string, uri: string | undefined, options: unknown) => {prepared.push([base,uri,options]);return {bytes:new Uint8Array([1]),uri:uri ?? `file:///${base}.png`,dispose:()=>disposed.push(base)}}),
			createAppearancePackage: async () => ({bytes:new Uint8Array([9])}),
			pickThemeBackground: async () => picked,
			pickThemeThumb: async () => ({ bytes: new Uint8Array([7]), uri: 'file:///thumb.png' }),
			exportAuthoredTheme: async (...args: unknown[]) => { calls.push(args) },
		},
	})
	const module = f.load('theme-author-ui')
	const render = () => f.render(f.element(module.ThemeAuthorEntry as ControlNode['type'],{colorMode,onApply:async(bytes:Uint8Array)=>{applied.push(bytes);return true}}))
	const button = (label: string) => controlNodes(render()).find(n=>n.type==='Pressable' && text(n)===label)!
	const press = (label: string) => { const b=button(label); assert.ok(b,label); assert.ok(!b.props.disabled,label); (b.props.onPress as ()=>void)() }
	return {f,module,render,button,press,calls,disposed,prepared,applied,setPicked:(uri: string|null)=>{picked=uri}}
}

void test('dark appearance explains the light wallpaper preview without generating it repeatedly', async () => {
	const h = fixture(undefined, 'dark')
	h.press('外观调整，壁纸与配色'); h.render(); await tick()
	assert.match(text(h.render()), /保存后深色仍使用宇宙/)
	for (let i = 0; i < 100; i++) h.render()
	assert.equal(h.prepared.length, 1)
	h.f.unmount()
})

void test('authoring is opt-in; three examples, tutorial, photo cancel and explicit export preserve current theme', async()=>{
	const h=fixture()
	assert.equal(h.calls.length,0)
	assert.ok(!text(h.render()).includes('背景预览'))
	h.press('外观调整，壁纸与配色'); h.render(); await tick()
	assert.match(text(h.render()),/背景预览/)
	assert.ok(!text(h.render()).includes('导出主题包'))
	h.press('开发者模式，制作与发布主题')
	h.press('查看制作教程')
	assert.match(text(h.render()),/已安装主题/)
	assert.match(text(h.render()),/不会改变手机桌面/)
	h.press('森间样例'); h.render(); await tick()
	assert.ok(h.disposed.includes('modern'))
	h.press('选择背景图片'); await tick(); h.render()
	assert.ok(!text(h.render()).includes('恢复样例背景'))
	h.setPicked('file:///photo.jpg'); h.press('选择背景图片'); await tick(); h.render(); await tick()
	assert.ok(h.button('恢复样例背景'))
	h.press('导出主题包'); await tick()
	assert.equal(h.calls.length,1)
	assert.equal(h.calls[0][0],'pastoral')
	assert.equal(h.calls[0][1],'森间样例')
	assert.match(text(h.render()),/当前主题未切换/)
	h.f.unmount()
})

void test('advanced progress editing remains developer-only and exports colors and image together', async () => {
	const h = fixture()
	h.press('外观调整，壁纸与配色'); h.render(); await tick()
	assert.ok(!text(h.render()).includes('选择滑块图片'))
	h.press('开发者模式，制作与发布主题')
	const input = (label: string, value: string) => {
		const field = controlNodes(h.render()).find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === label)!
		;(field.props.onChangeText as (value: string) => void)(value)
	}
	input('已播放进度颜色', 'bad')
	assert.equal(h.button('导出主题包').props.disabled, true)
	input('已播放进度颜色', '#112233'); input('滑块颜色', '#445566'); input('进度条底轨颜色', '#778899')
	h.press('选择滑块图片'); await tick()
	h.press('导出主题包'); await tick()
	const progress = h.calls[0][4] as { colors: { fill: string; track: string; thumb: string }; thumbImage: Uint8Array }
	assert.deepEqual({ ...progress.colors }, { track: '#778899', fill: '#112233', thumb: '#445566' })
	assert.equal(progress.thumbImage[0], 7)
	h.press('移除滑块图片'); h.press('导出主题包'); await tick()
	assert.equal((h.calls[1][4] as { thumbImage?: Uint8Array }).thumbImage, undefined)
	h.f.unmount()
})

void test('closing during image generation disposes late previews without writing to an unmounted panel', async()=>{
	let finish!: (value: unknown)=>void
	let disposed=0
	const h=fixture(()=>new Promise(resolve=>{finish=resolve}))
	h.press('外观调整，壁纸与配色'); h.render(); await tick()
	h.f.unmount()
	finish({bytes:new Uint8Array([1]),uri:'file:///late.png',dispose:()=>{disposed++}})
	await tick()
	assert.equal(disposed,1)
	assert.equal(h.f.writesAfterUnmount,0)
	assert.equal(h.calls.length,0)
})

void test('failed preview keeps export disabled and offers a real retry',async()=>{
	let attempts=0
	const h=fixture(async()=>{attempts++;throw new Error('无法读取图片')})
	h.press('外观调整，壁纸与配色'); h.render(); await tick()
	assert.match(text(h.render()),/无法读取图片/)
	assert.equal(h.button('保存并应用外观').props.disabled,true)
	h.press('重新生成预览'); h.render(); await tick()
	assert.equal(attempts,2)
	h.f.unmount()
})

void test('ordinary users can adjust and apply locally without export; developer publishing documentation is opt-in',async()=>{
	const h=fixture()
	h.press('外观调整，壁纸与配色');h.render();await tick()
	const sliders=()=>controlNodes(h.render()).filter(n=>n.props.accessibilityRole==='adjustable')
	assert.equal(sliders().length,4)
	const transparency=sliders().find(n=>n.props.accessibilityLabel==='背景透明度')!
	;(transparency.props.onAccessibilityAction as (event:unknown)=>void)({nativeEvent:{actionName:'decrement'}})
	h.render();await tick()
	assert.equal((h.prepared.at(-1)![2] as {transparency:number}).transparency,79)
	h.press('保存并应用外观');await tick()
	assert.equal(h.applied.length,1)
	assert.equal(h.calls.length,0)
	assert.match(text(h.render()),/外观已保存并应用/)
	h.press('重置背景调整');h.render();await tick()
	assert.deepEqual({ ...(h.prepared.at(-1)![2] as backgroundOptions.ThemeBackgroundAdjustments) },backgroundOptions.defaultBackgroundAdjustments)
	h.press('开发者模式，制作与发布主题')
	assert.match(text(h.render()),/作者自行托管主题文件/)
	assert.match(text(h.render()),/manifest.json/)
	assert.ok(h.button('打开项目 GitHub'))
	h.f.unmount()
})

void test('slider drag uses stable page coordinates and commits once on release, never on cancelled drags',()=>{
	const h=fixture(), commits:number[]=[]
	const render=()=>h.f.render(h.f.element(h.module.ThemeAdjustmentSlider as ControlNode['type'],{label:'test',value:80,disabled:false,onCommit:(n:number)=>commits.push(n)}))
	const slider=()=>controlNodes(render()).find(n=>n.props.accessibilityRole==='adjustable')!
	const call=(name:string,event:unknown)=>(slider().props[name] as (event:unknown)=>void)(event)
	call('onLayout',{nativeEvent:{layout:{width:200}}})
	call('onResponderGrant',{nativeEvent:{pageX:150,locationX:50}})
	call('onResponderMove',{nativeEvent:{pageX:260,locationX:1}})
	assert.equal(commits.length,0)
	call('onResponderRelease',{nativeEvent:{pageX:300,locationX:1}})
	assert.deepEqual(commits,[100])
	call('onResponderGrant',{nativeEvent:{pageX:150,locationX:50}})
	call('onResponderTerminate',{})
	call('onResponderRelease',{nativeEvent:{pageX:120,locationX:20}})
	assert.deepEqual(commits,[100])
	h.f.unmount()
})
