import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import * as information from '../app-information'
import * as notices from '../open-source-notices'
import { builtInThemes } from '../core/theme'

import { compile } from './search-page-fixture'
import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const content = (value: unknown): string =>
	Array.isArray(value)
		? value.map(content).join('')
		: value && typeof value === 'object' && 'children' in value
			? content(value.children)
			: typeof value === 'string'
				? value
				: ''

void test('sharing loads only on request, uses the selected original local asset and MIME, and fails before sharing when unavailable', async () => {
	let mode = 'missing'
	const images: number[] = []
	const shares: { uri: string; options: { mimeType: string } }[] = []
	let loads = 0
	const module: {
		shareSupportCode?: (channel: 'wechat' | 'alipay') => Promise<void>
	} = {}
	runInNewContext(
		compile(
			readFileSync(
				new URL('../author-support-mobile.ts', import.meta.url),
				'utf8',
			),
		),
		{
			exports: module,
			require: (name: string) => {
				if (name === './assets/support/wechat.png') return 1
				if (name === './assets/support/alipay.jpg') return 2
				if (name === 'expo-asset')
					return {
						Asset: class {
							constructor(
								readonly descriptor: {
									uri: string
									hash: string
									type: string
								},
							) {}
							static fromModule(image: number) {
								return {
									name: `support-${image}`,
									type: image === 1 ? 'png' : 'jpg',
									hash: String(image),
									uri: `drawable-${image}`,
									downloadAsync: async () => ({
										localUri: `drawable-${image}`,
									}),
								}
							}
							async downloadAsync() {
								const image = Number(this.descriptor.hash)
								assert.equal(this.descriptor.uri, `drawable-${image}`)
								images.push(image)
								return {
									localUri:
										mode === 'no-file' ? null : `file:///support-${image}`,
								}
							}
						},
					}
				if (name === 'expo-sharing') {
					loads++
					if (mode === 'missing') throw new Error('native sharing unavailable')
					return {
						isAvailableAsync: async () => mode !== 'unavailable',
						shareAsync: async (uri: string, options: { mimeType: string }) => {
							assert.ok(
								uri.startsWith('file://'),
								'Android sharing rejects packaged drawable names',
							)
							shares.push({ uri, options })
						},
					}
				}
				throw new Error(name)
			},
		},
	)
	assert.equal(loads, 0)
	assert.ok(module.shareSupportCode)
	await assert.rejects(module.shareSupportCode('wechat'), /不支持系统分享/)
	mode = 'unavailable'
	await assert.rejects(module.shareSupportCode('wechat'), /不支持系统分享/)
	assert.equal(images.length, 0)
	assert.equal(shares.length, 0)
	mode = 'available'
	await module.shareSupportCode('wechat')
	await module.shareSupportCode('alipay')
	assert.deepEqual(images, [1, 2])
	assert.equal(shares[0].uri, 'file:///support-1')
	assert.equal(shares[0].options.mimeType, 'image/png')
	assert.equal(shares[1].uri, 'file:///support-2')
	assert.equal(shares[1].options.mimeType, 'image/jpeg')
	mode = 'no-file'
	await assert.rejects(module.shareSupportCode('alipay'), /无法分享/)
	assert.equal(shares.length, 2)
})

void test('contact and support controls preserve external destinations, original code selection and back state across themes', async () => {
	for (const theme of Object.values(builtInThemes)) {
		const urls: string[] = []
		const shares: string[] = []
		let rejectShare: ((error: Error) => void) | undefined
		const ui = controlFixture(
			{},
			{
				'./app-information': information,
				'./open-source-notices': notices,
				'./author-support-mobile': {
					supportCodes: {
						wechat: {
							label: '微信支付',
							image: 'wechat-original',
							aspectRatio: 1118 / 1524,
						},
						alipay: {
							label: '支付宝',
							image: 'alipay-original',
							aspectRatio: 1080 / 1620,
						},
					},
					shareSupportCode: (channel: string) => {
						shares.push(channel)
						return new Promise((_, reject) => {
							rejectShare = reject
						})
					},
				},
				'react-native': {
					View: 'View',
					Text: 'Text',
					Pressable: 'Pressable',
					ScrollView: 'ScrollView',
					Modal: 'Modal',
					ActivityIndicator: 'ActivityIndicator',
					StyleSheet: {
						create: (value: unknown) => value,
						flatten: (value: unknown) =>
							Array.isArray(value) ? Object.assign({}, ...value) : value,
					},
					useWindowDimensions: () => ({
						width: 320,
						height: 700,
						fontScale: 1.4,
					}),
					Linking: {
						openURL: async (url: string) => {
							urls.push(url)
							if (url.startsWith('mailto:')) throw new Error('no mail app')
						},
					},
				},
			},
		)
		const root = ui.element(
			ui.load('ui').ThemeProvider as ControlNode['type'],
			{ value: theme },
			ui.element(
				ui.load('author-support-ui').AuthorSupportEntry as ControlNode['type'],
				{},
			),
		)
		const render = () => ui.render(root)
		const press = (label: string) => {
			const node = controlNodes(render()).find(
				(item) =>
					typeof item.props.onPress === 'function' &&
					content(item.children) === label,
			)
			assert.ok(node, label)
			;(node.props.onPress as () => void)()
		}
		assert.equal(
			controlNodes(render()).some((node) => node.type === 'Modal'),
			false,
		)
		assert.deepEqual(urls, [])
		press('联系作者与支持')
		press('前往 GitHub Issues')
		await tick()
		press('发送邮件')
		await tick()
		assert.deepEqual(urls, [
			information.authorContact.issues,
			'mailto:lxiaodong681@gmail.com',
		])
		assert.match(content(render()), /长按邮箱地址复制/)
		press('请作者喝杯咖啡')
		assert.equal(
			controlNodes(render()).find(
				(node) => node.props.accessibilityLabel === '微信支付收款码',
			)?.props.source,
			'wechat-original',
		)
		press('支付宝')
		assert.equal(
			controlNodes(render()).find(
				(node) => node.props.accessibilityLabel === '支付宝收款码',
			)?.props.source,
			'alipay-original',
		)
		press('分享收款码图片')
		const pending = controlNodes(render()).find(
			(node) =>
				typeof node.props.onPress === 'function' &&
				content(node.children) === '正在打开分享…',
		)!
		;(pending.props.onPress as () => void)()
		assert.deepEqual(
			shares,
			['alipay'],
			'a second tap must not invoke native sharing again',
		)
		const modal = controlNodes(render()).find((node) => node.type === 'Modal')!
		;(modal.props.onRequestClose as () => void)()
		rejectShare!(new Error('share dismissed after returning'))
		await tick()
		assert.doesNotMatch(content(render()), /暂时无法分享/)
		assert.match(content(render()), /问题反馈/)
		press('许可证与素材权利')
		const expand = (title: string) => {
			const node = controlNodes(render()).find((item) => item.props.accessibilityLabel === title)
			assert.ok(node, title)
			;(node.props.onPress as () => void)()
		}
		assert.doesNotMatch(content(render()), /Permission is hereby granted/)
		expand('MeloCanvas OC — limited asset license, not MIT')
		assert.match(content(render()), /LicenseRef-MeloCanvas-OC/)
		assert.match(content(render()), /其他用途须事先取得维护者明确许可/)
		expand('BBPlayer — MIT')
		assert.doesNotMatch(content(render()), /LicenseRef-MeloCanvas-OC/)
		assert.match(content(render()), /Copyright \(c\) 2025 Roitium\./)
		assert.match(content(render()), /Permission is hereby granted/)
		assert.match(content(render()), /THE SOFTWARE IS PROVIDED/)
		expand('NeteaseCloudMusicApi — MIT')
		assert.match(content(render()), /Copyright \(c\) 2013-2022 Binaryify/)
		const boolbase = notices.openSourceNotices.find((notice) => notice.title.includes('boolbase@1.0.0'))!
		assert.ok(boolbase)
		expand(boolbase.title)
		assert.match(content(render()), /Felix Boehm/)
		expand(boolbase.title)
		assert.doesNotMatch(content(render()), /Felix Boehm/)
		expand(boolbase.title)
		const licenseModal = controlNodes(render()).find((node) => node.type === 'Modal')!
		;(licenseModal.props.onRequestClose as () => void)()
		assert.match(content(render()), /问题反馈/)
		press('许可证与素材权利')
		assert.doesNotMatch(content(render()), /Felix Boehm/)
		;(controlNodes(render()).find((node) => node.type === 'Modal')!.props.onRequestClose as () => void)()
		press('使用与免责声明')
		assert.match(content(render()), /不收取下载、登录或功能使用费用/)
		assert.match(content(render()), /不排除或限制依法不得排除/)
		assert.deepEqual(urls, [
			information.authorContact.issues,
			'mailto:lxiaodong681@gmail.com',
		])
		ui.unmount()
	}
})
