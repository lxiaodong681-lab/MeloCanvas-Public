import { Asset } from 'expo-asset'
import * as DocumentPicker from 'expo-document-picker'
import { Directory, File, Paths } from 'expo-file-system'
import { Image } from 'react-native'

import { builtInThemes, type ThemeKey } from './core/theme'
import { buildAuthoredTheme, type AuthorProgress } from './theme-author'
import { inspectThemePng } from './core/theme-package'
import { themePackageLimits } from './core/theme-package-types'
import { createThemeImageDecoder } from './theme-image-decoder'
import { checkBackgroundAdjustments, defaultBackgroundAdjustments, type ThemeBackgroundAdjustments } from './theme-background'

const examples = {
	modern: require('./assets/coast.png') as number,
	pastoral: require('./assets/meadow.png') as number,
	anime: require('./assets/orbit.png') as number,
}

export async function pickThemeBackground(): Promise<string | null> {
	const picked = await DocumentPicker.getDocumentAsync({ type: ['image/jpeg', 'image/png', 'image/webp'], copyToCacheDirectory: true, multiple: false })
	if (picked.canceled || !picked.assets[0]) return null
	const asset = picked.assets[0]
	if ((asset.size ?? new File(asset.uri).size) > 16 * 1024 * 1024) throw new Error('请选择小于 16 MB 的背景图片')
	const size = await Image.getSize(asset.uri)
	if (size.width * size.height > 16_000_000 || Math.max(size.width, size.height) > 8192)
		throw new Error('图片分辨率过大，请先缩小至 1600 万像素以内')
	return asset.uri
}

export async function prepareThemeBackground(base: ThemeKey, uri?: string, adjustments: ThemeBackgroundAdjustments = defaultBackgroundAdjustments) {
	checkBackgroundAdjustments(adjustments)
	let source = uri
	if (!source) {
		const bundled = Asset.fromModule(examples[base])
		const asset = await new Asset({ name: bundled.name, type: bundled.type, hash: bundled.hash, uri: bundled.uri }).downloadAsync()
		source = asset.localUri ?? undefined
	}
	if (!source) throw new Error('样例图片读取失败，请重新选择')
	const file = new File(source)
	if (file.size > 16 * 1024 * 1024) throw new Error('请选择小于 16 MB 的背景图片')
	const size = await Image.getSize(source)
	if (!size.width || !size.height || size.width * size.height > 16_000_000 || Math.max(size.width, size.height) > 8192)
		throw new Error('图片尺寸不支持，请先缩小后重试')
	const native = await import('@bbplayer/native')
	const bytes = await native.prepareThemeBackgroundAsync(await file.bytes(), builtInThemes[base].tokens.surface.base, adjustments)
	const dir = new Directory(Paths.cache, 'melo-theme-author')
	dir.create({ intermediates: true, idempotent: true })
	const preview = new File(dir, `preview-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
	try {
		preview.write(bytes)
		return { bytes, uri: preview.uri, dispose: () => { if (preview.exists) preview.delete() } }
	} catch (error) {
		if (preview.exists) preview.delete()
		throw error
	}
}

export async function exportAuthoredTheme(base: ThemeKey, name: string, background: Uint8Array, signal?: AbortSignal, progress?: AuthorProgress) {
	const sharing = await import('expo-sharing')
	if (!(await sharing.isAvailableAsync())) throw new Error('此设备暂不支持系统分享，无法导出主题包')
	const result = await buildAuthoredTheme({ base, name, background, progress }, createThemeImageDecoder())
	if (signal?.aborted) return
	const dir = new Directory(Paths.cache, 'melo-theme-author')
	dir.create({ intermediates: true, idempotent: true })
	const file = new File(dir, result.filename)
	file.write(result.bytes)
	await sharing.shareAsync(file.uri, { mimeType: 'application/zip', UTI: 'public.zip-archive', dialogTitle: '导出主题包' })
}

export async function pickThemeThumb(): Promise<{ bytes: Uint8Array; uri: string } | null> {
	const picked = await DocumentPicker.getDocumentAsync({ type: 'image/png', copyToCacheDirectory: true, multiple: false })
	if (picked.canceled || !picked.assets[0]) return null
	const file = new File(picked.assets[0].uri)
	if (file.size > 256 * 1024) throw new Error('滑块图片请使用 256 KiB 以内的静态 PNG')
	const bytes = await file.bytes()
	if (bytes.length > 256 * 1024) throw new Error('滑块图片超过 256 KiB')
	const size = inspectThemePng(bytes, themePackageLimits)
	if (size.width > 256 || size.height > 256) throw new Error('滑块图片请缩小至 256×256 像素以内')
	await createThemeImageDecoder().decodeImage(bytes, themePackageLimits)
	return { bytes, uri: file.uri }
}

export async function createAppearancePackage(base: ThemeKey, background: Uint8Array) {
	return buildAuthoredTheme({ base, name: `我的外观 · ${builtInThemes[base].name}`, background }, createThemeImageDecoder())
}
