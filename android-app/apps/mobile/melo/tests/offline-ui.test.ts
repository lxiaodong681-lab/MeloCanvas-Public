import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { builtInThemes } from '../core/theme'
import * as state from '../offline-state'

import {
	compile,
	nodes,
	react,
	text,
	type ViewNode,
} from './search-page-fixture'

function fixture(verified: boolean, limit = 1024 ** 3) {
	const calls: string[] = []
	const task = {
		id: 'melo-offline:test',
		state: 3,
		verifiedComplete: verified,
		contentLength: 100,
		bytesDownloaded: 100,
		track: {
			id: 'source',
			sourceId: 'bilibili:BV1vT411i7ET:123',
			url: 'orpheus://bilibili?bvid=BV1vT411i7ET&cid=123&quality=30232',
			title: 'Synthetic',
		},
	}
	let confirmation: { onPress?: () => void }[] = []
	const slots: unknown[] = [
		'all',
		[task],
		{ usedBytes: 100, limitBytes: limit, freeBytes: 999999 },
		'',
		'',
		false,
		false,
	]
	let index = 0
	const output = {} as { OfflineManager: (props: unknown) => ViewNode }
	runInNewContext(
		compile(
			readFileSync(new URL('../offline-ui.tsx', import.meta.url), 'utf8'),
		),
		{
			exports: output,
			Error,
			require: (name: string) => {
				if (name === 'react')
					return {
						__esModule: true,
						default: react,
						...react,
						useState: (initial: unknown) => { const slot=index++; if (!(slot in slots)) slots[slot]=initial; return [slots[slot],(value: unknown)=>{slots[slot]=value}] },
						useEffect: () => {},
					}
				if (name === 'react-native')
					return {
						View: 'View',
						Modal: 'Modal',
						KeyboardAvoidingView: 'KeyboardAvoidingView',
						Platform: { OS: 'android' },
						ScrollView: 'ScrollView',
						TextInput: 'TextInput',
					}
				if (name === './library-collection-ui') return { CollectionMenu: 'CollectionMenu' }
				if (name === './theme-dialog') return { useThemeDialog: () => ({ dialog: null, show: (_a: string, _b: string, buttons: typeof confirmation) => { confirmation = buttons } }) }
				if (name === './ui')
					return {
						T: 'T', Artwork: 'Artwork', ControlTarget: 'ControlTarget',
						Card: 'Card',
						Button: 'Button',
						useTheme: () => builtInThemes.modern,
					}
				if (name === 'react-native-safe-area-context')
					return { useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) }
				if (name === './settings-layout') return { PageHeader: 'PageHeader', SettingsRow: 'SettingsRow' }
				if (name === './offline-state') return state
				if (name === '@bbplayer/orpheus')
					return {
						Orpheus: {
							removeDownload: async (id: string) => calls.push(id),
							getDownloads: async () => [task],
							setOfflineStorageLimit: async (value: number) => { calls.push('limit:'+value) },
							getOfflineStorage: async () => slots[2],
						},
					}
				throw new Error(`Unexpected ${name}`)
			},
		},
	)
	const render = () => { index=0; return output.OfflineManager({
		visible: true,
		onClose: () => { calls.push('close') },
		track: task.track,
		onPlay: async () => {},
		bottomInset: 20,
	}) }
	const button = (label: string): ViewNode | undefined =>
		nodes(render()).find((n) => n.type === 'Button' && text(n) === label) ?? nodes(render()).filter(n => n.type === 'CollectionMenu').flatMap(n => n.props.actions as { label: string; onPress: () => void }[]).filter(a => a.label === label).map(a => ({ type: 'MenuAction', props: a, children: [] }))[0]
	return { calls, render, button, confirmation: () => confirmation }
}
void test('actual offline UI does not offer playback for an incomplete completed record', () => {
	assert.equal(fixture(false).button('离线播放'), undefined)
	assert.ok(fixture(true).button('离线播放'))
	assert.equal(
		fixture(true, 0).button('下载当前歌曲')?.props.disabled,
		true,
	)
})
void test('removing actual offline data is guarded by explicit cancel/confirm UI', async () => {
	const f = fixture(true)
	;(f.button('移除离线副本')!.props.onPress as () => void)()
	assert.deepEqual(f.calls, [])
	assert.equal(f.confirmation()[0]?.onPress, undefined)
	f.confirmation()[1].onPress!()
	await Promise.resolve()
	assert.deepEqual(f.calls, ['melo-offline:test'])
})

void test('capacity is a separate page, validates input, and hardware back returns to downloads', async () => {
 const f=fixture(true); const find=(type:string)=>nodes(f.render()).find(n=>n.type===type)!;
 assert.equal(nodes(f.render()).some(n=>n.type==='TextInput'),false);
 (find('SettingsRow').props.onPress as ()=>void)();
 assert.equal(find('PageHeader').props.title,'容量设置');
 assert.equal(nodes(f.render()).some(n=>n.type==='CollectionMenu'),false);
 assert.equal(find('TextInput').props.value,'1');
 (find('TextInput').props.onChangeText as (v:string)=>void)('invalid');
 (f.button('保存容量上限')!.props.onPress as ()=>void)(); await new Promise(r=>setImmediate(r));
 assert.match(text(f.render()),/请输入有效的 GiB 容量/); assert.equal(f.calls.length,0);
 (find('TextInput').props.onChangeText as (v:string)=>void)('2');
 (f.button('保存容量上限')!.props.onPress as ()=>void)(); await new Promise(r=>setImmediate(r));
 assert.deepEqual(f.calls,['limit:'+2*1024**3]);
 (find('Modal').props.onRequestClose as ()=>void)();
 assert.equal(find('PageHeader').props.title,'下载与离线'); assert.ok(f.button('离线播放'));
 (find('Modal').props.onRequestClose as ()=>void)(); assert.equal(f.calls.at(-1),'close');
});
