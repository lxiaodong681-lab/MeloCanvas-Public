import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { builtInThemes } from '../core/theme'
import * as backgroundOptions from '../theme-background'
import * as themePackage from '../core/theme-package'
import * as themePackageTypes from '../core/theme-package-types'
import { compile } from './search-page-fixture'

function fixture() {
	let canceled = false, size = 100, width = 720, height = 1280, available = true, invalid = false
	let prepareCalls = 0, builds = 0, reads = 0, shares = 0, writes = 0, deletes = 0
	const adjustments: backgroundOptions.ThemeBackgroundAdjustments[] = []
	const files = new Map<string, Uint8Array>()
	class Directory { create() {} }
	class File {
		uri: string
		constructor(parent: unknown, name?: string) { this.uri = name ? `file:///cache/${name}` : String(parent) }
		get size() { return size }
		get exists() { return files.has(this.uri) }
		async bytes() { reads++; return new Uint8Array([1, 2, 3]) }
		write(bytes: Uint8Array) { writes++; files.set(this.uri, bytes) }
		delete() { deletes++; files.delete(this.uri) }
	}
	const module = {} as Pick<typeof import('../theme-author-mobile'), 'pickThemeBackground' | 'prepareThemeBackground' | 'exportAuthoredTheme' | 'createAppearancePackage'>
	runInNewContext(compile(readFileSync(new URL('../theme-author-mobile.ts', import.meta.url),'utf8')), {
		exports: module,
		require: (name: string) => {
			if (name === 'expo-asset') return {Asset:class {
				static fromModule() { return {name:'example',type:'png',uri:'drawable-example'} }
				async downloadAsync() { return {localUri:'file:///sample.png'} }
			}}
			if (name === 'expo-document-picker') return {getDocumentAsync:async()=>canceled?{canceled:true}:{canceled:false,assets:[{uri:'file:///photo.jpg',size}]}}
			if (name === 'expo-file-system') return {File,Directory,Paths:{cache:'file:///cache'}}
			if (name === 'react-native') return {Image:{getSize:async()=>({width,height})}}
			if (name === './core/theme') return {builtInThemes}
			if (name === './core/theme-package') return themePackage
			if (name === './core/theme-package-types') return themePackageTypes
			if (name === './theme-background') return backgroundOptions
			if (name === './theme-author') return {buildAuthoredTheme:async()=>{builds++;if(invalid)throw new Error('invalid PNG');return {bytes:new Uint8Array([4]),filename:'sample.melotheme'}}}
			if (name === './theme-image-decoder') return {createThemeImageDecoder:()=>({})}
			if (name === '@bbplayer/native') return {prepareThemeBackgroundAsync:async(bytes: Uint8Array,color: string,options: backgroundOptions.ThemeBackgroundAdjustments)=>{prepareCalls++;adjustments.push(options);assert.equal(bytes.length,3);assert.equal(color,builtInThemes.modern.tokens.surface.base);return new Uint8Array([4,5])}}
			if (name === 'expo-sharing') return {isAvailableAsync:async()=>available,shareAsync:async(uri:string,options:{mimeType:string})=>{shares++;assert.match(uri,/\.melotheme$/);assert.equal(options.mimeType,'application/zip')}}
			if (name.startsWith('./assets/')) return 1
			throw Error(name)
		},
	})
	return {module,adjustments,stats:()=>({prepareCalls,builds,reads,shares,writes,deletes}),set:(values:{canceled?:boolean;size?:number;width?:number;height?:number;available?:boolean;invalid?:boolean})=>{
		canceled=values.canceled??canceled;size=values.size??size;width=values.width??width;height=values.height??height;available=values.available??available;invalid=values.invalid??invalid
	}}
}

void test('photo selection cancellation and dimensions are checked before native decode',async()=>{
	const f=fixture();f.set({canceled:true})
	assert.equal(await f.module.pickThemeBackground(),null)
	f.set({canceled:false,size:17*1024*1024})
	await assert.rejects(f.module.pickThemeBackground(),/16 MB/)
	f.set({size:100,width:5000,height:5000})
	await assert.rejects(f.module.prepareThemeBackground('modern','file:///photo.jpg'),/尺寸/)
	assert.equal(f.stats().prepareCalls,0);assert.equal(f.stats().reads,0)
})

void test('custom transparency and crop reach native unchanged; invalid settings never decode', async () => {
	const f = fixture()
	for (const transparency of [0, 100]) {
		const options = { transparency, zoom: 4, horizontal: 0, vertical: 100 }
		await f.module.prepareThemeBackground('modern', 'file:///photo.jpg', options)
		assert.deepEqual(f.adjustments.at(-1), options)
	}
	for (const options of [{transparency:NaN}, {zoom:0}, {zoom:4.1}, {horizontal:-1}, {vertical:101}])
		await assert.rejects(f.module.prepareThemeBackground('modern', undefined, {...backgroundOptions.defaultBackgroundAdjustments,...options}), /调整数值无效/)
	assert.equal(f.stats().prepareCalls,2)
})

void test('normal appearance save validates locally without requiring a sharing provider', async () => {
	const f = fixture(); f.set({available:false})
	const result = await f.module.createAppearancePackage('modern',new Uint8Array([1]))
	assert.equal(result.bytes.length,1)
	assert.equal(f.stats().builds,1)
	assert.equal(f.stats().shares,0)
})

void test('sample and selected photo both produce disposable private PNG previews',async()=>{
	const f=fixture()
	for(const uri of [undefined,'file:///photo.jpg']) {
		const preview=await f.module.prepareThemeBackground('modern',uri)
		assert.match(preview.uri,/\.png$/);assert.equal(preview.bytes.length,2)
		preview.dispose();preview.dispose()
	}
	assert.equal(f.stats().prepareCalls,2);assert.equal(f.stats().deletes,2)
})

void test('unavailable sharing, invalid package and dismissed editor never publish an output',async()=>{
	const f=fixture();f.set({available:false})
	await assert.rejects(f.module.exportAuthoredTheme('modern','name',new Uint8Array([1])),/不支持系统分享/)
	assert.equal(f.stats().builds,0)
	f.set({available:true,invalid:true})
	await assert.rejects(f.module.exportAuthoredTheme('modern','name',new Uint8Array([1])),/invalid PNG/)
	f.set({invalid:false})
	const signal=new AbortController();signal.abort()
	await f.module.exportAuthoredTheme('modern','name',new Uint8Array([1]),signal.signal)
	assert.equal(f.stats().writes,0);assert.equal(f.stats().shares,0)
	await f.module.exportAuthoredTheme('modern','name',new Uint8Array([1]))
	assert.equal(f.stats().writes,1);assert.equal(f.stats().shares,1)
})
