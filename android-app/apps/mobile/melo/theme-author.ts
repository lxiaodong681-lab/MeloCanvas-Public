import JSZip from 'jszip'

import { builtInThemes, type ThemeKey } from './core/theme'
import { sha256 } from './core/theme-archive'
import { validateThemePackage } from './core/theme-package'
import type { ThemeImageDecoder, PackageThemeTokens } from './core/theme-package-types'

export const authorThemes = ['modern', 'pastoral', 'anime'] as const
export const authorHost = {
	appVersion: '0.19.2',
	capabilities: ['semantic-colors', 'icons', 'backgrounds', 'component-variants', 'player-frame', 'motion-presets', 'custom-progress-v1', 'package-icons-v1', 'surface-art-v1', 'collection-art-v1'],
}

export interface AuthorProgress {
	colors: NonNullable<PackageThemeTokens['progress']>
	thumbImage?: Uint8Array
}

/** Export through the same validator as imported packages; no install or activation. */
export async function buildAuthoredTheme(
	input: { base: ThemeKey; name: string; background: Uint8Array; progress?: AuthorProgress },
	decoder: ThemeImageDecoder,
) {
	const name = input.name.trim()
	if (!name || name.length > 40) throw new Error('主题名称请填写 1–40 个字')
	if (!authorThemes.includes(input.base)) throw new Error('请选择基础配色')
	if (!input.background.length || input.background.length > 4 * 1024 * 1024)
		throw new Error('处理后的背景图片需小于 4 MB')
	const theme = builtInThemes[input.base]
	const hash = sha256(input.background)
	const id = `local.author.${input.base}.${hash.slice(0, 12)}`
	const image = (path: string) => ({ path, mime: 'image/png', bytes: input.background.length, sha256: hash })
	const manifest = {
		format: 'melocanvas-theme', schemaVersion: 1, id, version: '1.0.0', name,
		author: '音绘用户', minAppVersion: '0.18.0', license: 'See LICENSE.txt',
		entry: { tokens: 'tokens.json', components: 'components.json' },
		fallback: 'melocanvas.builtin.modern', requiredCapabilities: authorHost.capabilities.filter((c) => c !== 'collection-art-v1' && c !== 'surface-art-v1' && c !== 'package-icons-v1' && (c !== 'custom-progress-v1' || !!input.progress)),
		optionalCapabilities: [],
		assets: [image('assets/background.png'), image('previews/background.png')],
		previews: ['previews/background.png'],
	}
	if (input.progress?.thumbImage) manifest.assets.push({ path: 'assets/thumb.png', mime: 'image/png', bytes: input.progress.thumbImage.length, sha256: sha256(input.progress.thumbImage) })
	const tokens = { light: { ...theme.tokens, lyric: { active: theme.tokens.action.primary, inactive: theme.tokens.text.secondary }, ...(input.progress ? { progress: input.progress.colors } : {}) } }
	const components = {
		components: {
			card: { variant: 'rounded' }, button: { variant: 'rounded', minTouchDp: 48 },
			input: { variant: 'rounded' }, navigation: { discoverIcon: theme.components.discoverIcon },
			player: { frame: 'square' }, progress: { variant: input.base, ...(input.progress?.thumbImage ? { thumb: { light: 'assets/thumb.png', sizeDp: 28 } } : {}) },
		},
		decorations: { backdrop: 'assets/background.png' },
		motion: { durationMs: 0, respectReducedMotion: true },
	}
	const zip = new JSZip()
	for (const [path, value] of Object.entries({ 'manifest.json': manifest, 'tokens.json': tokens, 'components.json': components }))
		zip.file(path, JSON.stringify(value, null, 2))
	zip.file('LICENSE.txt', '配色与配置样例来自 MeloCanvas。用户选择的背景图片版权归其原作者；导出不改变图片的授权范围。\n')
	zip.file('assets/background.png', input.background)
	zip.file('previews/background.png', input.background)
	if (input.progress?.thumbImage) zip.file('assets/thumb.png', input.progress.thumbImage)
	// STORE avoids high expansion ratios for simple wallpapers and expensive JS compression.
	const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
	await validateThemePackage(bytes, authorHost, decoder)
	return { bytes, filename: `melo-${input.base}-${hash.slice(0, 8)}.melotheme` }
}

export const themeAuthorSteps = [
	'明暗模式在“我的 → 设置 → 显示”调整。这里的简约工具制作浅色配色和壁纸；深色下使用宇宙回退，切回浅色恢复壁纸。需要独立深色配置时进入开发者模式，参考双模式宇宙样例。',
	'1. 选择原色、森间或星轨作为基础配色，填写自己的主题名称。三套样例沿用内置配色，采用简单布局。',
	'2. 点击“选择背景图片”，从手机文件中选择 JPG、PNG 或 WebP 静态图片；也可以直接使用样例图片。',
	'3. 自由调整背景透明度（0% 完整显示，100% 只显示底色）、缩放（100–400%）、水平和垂直取景位置。松手后更新预览，也可重置。最终合成为 720 × 1280 的静态 PNG。',
	'4. 自己使用时点击“保存并应用外观”即可。需要分享时进入开发者模式，填写主题名称并点击“导出主题包”，在系统分享面板保存文件。导出不会切换当前主题。',
	'开发者模式还可独立设置进度条底轨、已播放部分和滑块颜色，选择不超过 256×256 像素、256 KiB 的透明静态 PNG 滑块。图片按原色显示，滑块颜色用于无图片时回退；这些高级设置随导出主题包保存，通过工坊预览后应用。',
	'5. 回到主题工坊，点击“从文件导入主题”，选择 .melotheme 文件，确认预览后点击“应用此主题”。安装后会出现在“已安装主题”中。',
	'进阶修改：主题包是 ZIP 文件。manifest.json 是名称和资源清单；tokens.json 是颜色；components.json 是组件样式；assets/background.png 是背景。只改颜色后可将根目录内文件压缩为 ZIP，再改扩展名为 .melotheme。修改图片必须同步更新清单中的 bytes 和 SHA-256，初学者建议回到本工具重新选择图片并导出。',
	'背景用于应用支持背景的页面；卡片、弹层和系统通知仍使用各自的底色，不会改变手机桌面或系统主题。',
] as const
