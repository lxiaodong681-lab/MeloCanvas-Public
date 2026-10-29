import assert from 'node:assert/strict'
import test from 'node:test'
import { controlFixture, controlNodes, type ControlNode } from './theme-control-fixture'
import { builtInThemes } from '../core/theme'

void test('theme frame overlays without clipping or replacing a saved custom avatar', () => {
	const writes: unknown[] = []
	const f = controlFixture({}, {
		'./ui': { ControlTarget: 'Pressable', Icon: 'Icon', useTheme: () => builtInThemes.modern,
			useThemeRendering: () => ({ surfaceArt: { avatarFrame: 'file:///private/frame.png' } }) },
		'./theme-dialog': { useThemeDialog: () => ({ dialog: null, show() {} }) },
		'expo-file-system': {}, './playlist-cover-mobile': { playlistCoverFiles: {} },
	})
	const Component = f.load('profile-avatar').ProfileAvatar as ControlNode['type']
	const nodes = controlNodes(f.render(f.element(Component, {
		library: { setting: (key: string) => key === 'profile.avatar.offline' ? 'file:///private/my-avatar.png' : '', setSetting: (...args: unknown[]) => writes.push(args) }, onNotice() {},
	})))
	assert.equal((nodes.find(n => n.type === 'Image')!.props.source as { uri: string }).uri, 'file:///private/my-avatar.png')
	const avatarStyle = nodes.find(n => n.props.accessibilityLabel === '修改头像')!.props.style as { width: number; height: number; borderRadius: number; overflow: string }
	assert.equal(avatarStyle.width, 50)
	assert.equal(avatarStyle.height, 50)
	assert.equal(avatarStyle.borderRadius, 25)
	assert.equal(avatarStyle.overflow, 'hidden')
	const frame = nodes.find(n => n.props.testID === 'theme-avatar-frame')!
	assert.equal(frame.props.pointerEvents, 'none')
	assert.equal((frame.props.style as { overflow?: string }).overflow, undefined)
	assert.equal(nodes.filter(n => n.type === 'Image')[1].props.source, 'file:///private/frame.png')
	assert.equal(nodes.filter(n => n.type === 'Image')[1].props.transition, 0)
	assert.equal(writes.length, 0)
	f.unmount()
})

void test('manual avatar persists across account verification and cancellation, reset restores latest Bilibili avatar', async () => {
	const saved = new Map<string, string>()
	const library = { setting: (key: string) => saved.get(key) ?? null, setSetting: (key: string, value: string) => saved.set(key, value) }
	let buttons: { text: string; onPress?: () => void }[] = [], picked: string | null = 'file:///picked.png'
	let copied = 0
	class Directory { create() {} }
	class File { uri: string; exists = true; constructor(parent: unknown, name?: string) { this.uri = name ? `file:///private/${name}` : String(parent) } async copy() { copied++ } delete() { this.exists = false } }
	function fixture(avatar: string) {
		const f = controlFixture({}, {
			'./theme-dialog': { useThemeDialog: () => ({ dialog: null, show: (_title: string, _message: string, actions: typeof buttons) => { buttons = actions } }) },
			'react-native': { View: 'View', Pressable: 'Pressable', Text: 'Text', StyleSheet: { flatten: (v: unknown) => v, create: (v: unknown) => v },
				useWindowDimensions: () => ({ fontScale: 1 }) },
			'expo-file-system': { Directory, File, Paths: { document: 'file:///private' } },
			'./playlist-cover-mobile': { playlistCoverFiles: { pick: async () => picked } },
		})
		const Component = f.load('profile-avatar').ProfileAvatar as ControlNode['type']
		const render = () => f.render(f.element(Component, { library, accountId: '123', accountAvatar: avatar, onNotice() {} }))
		const uri = () => (controlNodes(render()).find(n => n.type === 'Image')!.props.source as { uri: string }).uri
		const menu = () => { (controlNodes(render()).find(n => n.props.accessibilityLabel === '修改头像')!.props.onPress as () => void)() }
		return { f, render, uri, menu }
	}
	let f = fixture('https://i0.hdslb.com/first.jpg')
	assert.equal(f.uri(), 'https://i0.hdslb.com/first.jpg')
	f.menu(); buttons.find(b => b.text === '选择图片')!.onPress!()
	await new Promise(resolve => setImmediate(resolve))
	const custom = f.uri(); assert.match(custom, /^file:\/\/\/private\/avatar-/); assert.equal(copied, 1)
	f.f.unmount()
	f = fixture('https://i0.hdslb.com/new.jpg')
	assert.equal(f.uri(), custom)
	picked = null; f.menu(); buttons.find(b => b.text === '选择图片')!.onPress!()
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(f.uri(), custom); assert.equal(copied, 1)
	f.menu(); buttons.find(b => b.text === '使用 B 站头像')!.onPress!()
	assert.equal(f.uri(), 'https://i0.hdslb.com/new.jpg')
	f.f.unmount()
})
