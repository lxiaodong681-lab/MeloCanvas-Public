import { Asset } from 'expo-asset'

export const supportCodes = {
	wechat: {
		label: '微信支付',
		image: require('./assets/support/wechat.png') as number,
		aspectRatio: 1118 / 1524,
		mimeType: 'image/png',
	},
	alipay: {
		label: '支付宝',
		image: require('./assets/support/alipay.jpg') as number,
		aspectRatio: 1080 / 1620,
		mimeType: 'image/jpeg',
	},
} as const
export type SupportChannel = keyof typeof supportCodes

export async function shareSupportCode(channel: SupportChannel): Promise<void> {
	let sharing: typeof import('expo-sharing')
	try {
		sharing = await import('expo-sharing')
	} catch {
		throw new Error('当前安装版本暂不支持系统分享，可直接查看收款码。')
	}
	if (!(await sharing.isAvailableAsync()))
		throw new Error('此设备暂不支持系统分享，可直接查看收款码。')
	const code = supportCodes[channel]
	const bundled = Asset.fromModule(code.image)
	// Bare Android images can be marked downloaded with only a drawable name.
	// Export an independent Asset to a real cache file for the sharing API.
	const asset = await new Asset({
		name: bundled.name,
		type: bundled.type,
		hash: bundled.hash,
		uri: bundled.uri,
	}).downloadAsync()
	if (!asset.localUri?.startsWith('file://'))
		throw new Error('收款码暂时无法分享，请稍后重试。')
	await sharing.shareAsync(asset.localUri, {
		mimeType: code.mimeType,
		dialogTitle: `${code.label}收款码`,
	})
}
