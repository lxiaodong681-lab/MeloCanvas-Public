import JSZip from 'jszip'

import { builtInThemes } from './core/theme'
import { checkCancelled, sha256 } from './core/theme-archive'
import { validateThemePackage } from './core/theme-package'
import type { PackageThemeComponents, PackageThemeTokens, ThemeImageDecoder } from './core/theme-package-types'
import { authorHost } from './theme-author'
import { mixBilibiliColor, readableBilibiliAccent } from './bilibili-theme-colors'
import { checkBackgroundAdjustments, defaultBackgroundAdjustments, type ThemeBackgroundAdjustments } from './theme-background'

export interface BilibiliThemeItem {
	id: string; name: string; kind: 'suit' | 'collection' | 'skin'; itemId: number; actId: number; lotteryId: number
}
export interface BilibiliThemePort {
	request: (endpoint: string, signal: AbortSignal) => Promise<unknown>
	/** Downloads with a byte limit and returns a bounded static PNG, never an animated resource. */
	image: (url: string, edge: number, signal: AbortSignal) => Promise<Uint8Array>
	decoder: ThemeImageDecoder
	background?: (bytes: Uint8Array, color: string, adjustments: ThemeBackgroundAdjustments) => Promise<Uint8Array>
}
type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('B 站主题响应格式异常')
	return value as RecordValue
}
function list(value: unknown, max: number): unknown[] {
	if (value == null) return []
	if (!Array.isArray(value) || value.length > max) throw new Error('B 站主题资源数量异常')
	return value
}
const id = (value: unknown): number => {
	const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : 0
	return Number.isSafeInteger(n) && n > 0 ? n : 0
}
const name = (value: unknown) => typeof value === 'string' ? Array.from(value).filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join('').trim().slice(0, 80) : ''
const color = (value: unknown): string | undefined => typeof value === 'string' && /^#?[0-9a-f]{6}$/i.test(value) ? `#${value.replace('#', '')}` : undefined

export function bilibiliThemeImageUrl(value: unknown): string {
	if (typeof value !== 'string' || value.length > 2048) throw new Error('B 站主题图片地址无效')
	const url = new URL(value.startsWith('//') ? `https:${value}` : value)
	if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.hash ||
		!(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com')))
		throw new Error('主题图片必须来自 B 站图片域名')
	url.protocol = 'https:'
	return url.href
}

export async function searchBilibiliThemes(keyword: string, page: number, port: BilibiliThemePort, signal: AbortSignal) {
	const query = keyword.trim()
	if (!query || query.length > 80 || !Number.isSafeInteger(page) || page < 1 || page > 100) throw new Error('请输入 1–80 个字的主题名称')
	checkCancelled(signal)
	const data = record(await port.request(`/x/garb/v2/mall/home/search?key_word=${encodeURIComponent(query)}&pn=${page}&ps=10`, signal))
	checkCancelled(signal)
	const items: BilibiliThemeItem[] = []
	for (const value of list(data.list, 50)) {
		const entry = record(value), props = record(entry.properties ?? {})
		const kind = entry.part_id === 6 ? 'suit' : entry.part_id === 0 ? 'collection' : null
		const itemId = id(entry.item_id), actId = id(props.dlc_act_id), lotteryId = id(props.dlc_lottery_id)
		if (!kind || (kind === 'suit' ? !itemId : !actId || !lotteryId)) continue
		const key = kind === 'suit' ? `suit-${itemId}` : `collection-${actId}-${lotteryId}`
		if (!items.some((item) => item.id === key)) items.push({ id: key, kind, itemId, actId, lotteryId, name: name(entry.name) || '未命名主题' })
	}
	return { items, hasMore: page < 100 && typeof data.total === 'number' && page * 10 < data.total }
}

export async function listOwnedBilibiliThemes(page: number, port: BilibiliThemePort, signal: AbortSignal) {
	if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new Error('主题页码无效')
	checkCancelled(signal)
	// Same read-only endpoint as Bili's personal theme settings; includes delisted collection rewards.
	const data = record(await port.request(`/x/garb/user/asset/list?part=skin&state=active&pn=${page}&ps=20`, signal))
	checkCancelled(signal)
	const items: BilibiliThemeItem[] = []
	for (const value of list(data.list, 50)) {
		const asset = record(value), entry = record(asset.item ?? {})
		const itemId = id(entry.item_id)
		if (!itemId || asset.asset_state === 'expired' || items.some((item) => item.itemId === itemId)) continue
		items.push({ id: `skin-${itemId}`, kind: 'skin', itemId, actId: 0, lotteryId: 0, name: name(entry.name) || '未命名主题' })
	}
	const paging = record(data.page ?? {})
	return { items, hasMore: page < 100 && typeof paging.total === 'number' && page * 20 < paging.total }
}

export interface BilibiliThemeResources {
	skins: RecordValue[]; sliders: RecordValue[]; pendants: RecordValue[]
	backgrounds: { id: number; name: string; url: string }[]
}

function collectionActivity(value: unknown): number {
	if (typeof value !== 'string') return 0
	try {
		const url = new URL(value)
		return url.protocol === 'https:' && url.hostname === 'www.bilibili.com' && url.pathname === '/h5/mall/digital-card/home'
			? id(url.searchParams.get('act_id')) : 0
	} catch { return 0 }
}

/** Resolve the exact parent collection, never a similarly named shop result. */
export async function readBilibiliThemeResources(item: BilibiliThemeItem, port: BilibiliThemePort, signal: AbortSignal): Promise<BilibiliThemeResources> {
	checkCancelled(signal)
	let skins: RecordValue[] = [], sliders: RecordValue[] = [], pendants: RecordValue[] = []
	const backgrounds: BilibiliThemeResources['backgrounds'] = []
	const bags: RecordValue[] = []
	if (item.kind === 'suit' && id(item.itemId)) {
		const data = record(await port.request(`/x/garb/v2/mall/suit/detail?item_id=${item.itemId}`, signal))
		const parts = record(data.suit_items ?? {})
		skins = list(parts.skin, 24).map((v) => record(record(v).properties ?? {}))
		sliders = list(parts.play_icon, 24).map((v) => record(record(v).properties ?? {}))
		pendants = list(parts.pendant, 24).map((v) => record(record(v).properties ?? {}))
	} else if (item.kind === 'skin' && id(item.itemId)) {
		const benefit = record(await port.request(`/x/garb/v2/user/suit/benefit?item_id=${item.itemId}&part=skin`, signal))
		if (benefit.part_id !== 9) throw new Error('此资源不是个性主题，请重新读取我的主题')
		skins = [record(benefit.properties ?? {})]
		const actId = collectionActivity(benefit.buy_link)
		if (actId) {
			const activity = record(await port.request(`/x/vas/dlc_act/act/basic/v2?act_id=${actId}`, signal))
			for (const pool of list(activity.lottery_list, 12).map(record)) {
				checkCancelled(signal)
				const lotteryId = id(pool.lottery_id)
				if (!lotteryId) continue
				const bag = record(await port.request(`/x/vas/dlc_act/asset_bag?act_id=${actId}&lottery_id=${lotteryId}`, signal))
				if (list(bag.collect_list, 100).map(record).some((reward) =>
					typeof reward.redeem_item_id === 'string' && reward.redeem_item_id.split('&').some((key) => id(key.trim()) === item.itemId))) {
					bags.push(bag)
					break
				}
			}
			if (!bags.length) throw new Error('未找到与此主题对应的收藏集资源，请稍后重试')
		}
	} else if (item.kind === 'collection' && id(item.actId) && id(item.lotteryId)) {
		bags.push(record(await port.request(`/x/vas/dlc_act/asset_bag?act_id=${item.actId}&lottery_id=${item.lotteryId}`, signal)))
	} else throw new Error('主题标识无效，请重新搜索')
	for (const data of bags) {
		const ids = new Set<string>()
		for (const entry of list(data.collect_list, 100).map(record)) {
			if (![2, 3, 5].includes(Number(entry.redeem_item_type)) || typeof entry.redeem_item_id !== 'string') continue
			for (const key of entry.redeem_item_id.split('&')) if (id(key.trim())) ids.add(String(id(key.trim())))
		}
		if (ids.size > 24) throw new Error('收藏集组件过多，请选择单独的主题装扮')
		// Sequential and cancellable: a large collection never fans out dozens of requests.
		for (const key of ids) {
			checkCancelled(signal)
			if (item.kind === 'skin' && Number(key) === item.itemId) continue
			const benefit = record(await port.request(`/x/garb/v2/user/suit/benefit?item_id=${key}&part=emoji_package`, signal))
			if (benefit.part_id === 9) skins.push(record(benefit.properties ?? {}))
			if (benefit.part_id === 11) sliders.push(record(benefit.properties ?? {}))
			if (benefit.part_id === 1) pendants.push(record(benefit.properties ?? {}))
		}
		for (const entry of list(data.item_list, 100).map(record)) {
			const card = record(entry.card_item ?? {})
			if (!id(card.card_type_id) || typeof card.card_img !== 'string') continue
			backgrounds.push({ id: id(card.card_type_id), name: name(card.card_name) || '收藏集背景', url: bilibiliThemeImageUrl(card.card_img) })
		}
	}
	checkCancelled(signal)
	return { skins, sliders, pendants, backgrounds }
}

/** Static local resources only. Animated backgrounds/SVGA never run in the player. */
export async function importBilibiliTheme(item: BilibiliThemeItem, port: BilibiliThemePort, signal: AbortSignal,
	options: { resources?: BilibiliThemeResources; backgroundId?: number; adjustments?: ThemeBackgroundAdjustments; onResources?: (resources: BilibiliThemeResources) => void } = {}) {
	const { skins, sliders, pendants, backgrounds } = options.resources ?? await readBilibiliThemeResources(item, port, signal)
	options.onResources?.({ skins, sliders, pendants, backgrounds })
	const adjustments = options.adjustments ?? defaultBackgroundAdjustments
	checkBackgroundAdjustments(adjustments)
	checkCancelled(signal)
	const skin = skins.find((s) => s.head_bg || s.tail_icon_main || color(s.color) || color(s.tail_color_selected)) ?? {}, slider = sliders.find((s) => s.middle_png || s.static_icon_image) ?? {}
	const base = builtInThemes.modern.tokens
	// Bili's `color` is a header foreground (often white), not an accent color.
	const highlight = color(skin.tail_color_selected) ?? base.action.primary
	const surface = { base: mixBilibiliColor('#ffffff', highlight, 0.10), card: mixBilibiliColor('#ffffff', highlight, 0.025), tinted: mixBilibiliColor('#ffffff', highlight, 0.20) }
	const text = { primary: mixBilibiliColor('#17171c', highlight, 0.10), secondary: mixBilibiliColor('#4c4c55', highlight, 0.15), inverse: '#ffffff' }
	const border = { subtle: mixBilibiliColor('#ffffff', highlight, 0.30), strong: mixBilibiliColor('#707078', highlight, 0.30) }
	const accent = readableBilibiliAccent(highlight, [surface.base, surface.card, surface.tinted, text.inverse])
	const tokens: { light: PackageThemeTokens } = { light: { ...base, surface, text, border, action: { primary: accent },
		lyric: { active: accent, inactive: text.secondary }, progress: { track: border.subtle, fill: highlight, thumb: highlight } } }
	const components: PackageThemeComponents = { card: { variant: 'rounded' }, button: { variant: 'rounded', minTouchDp: 48 },
		input: { variant: 'rounded' }, navigation: { discoverIcon: 'home' }, player: { frame: 'square' }, progress: { variant: 'modern' } }
	const assets: { path: string; mime: 'image/png'; bytes: number; sha256: string }[] = []
	const zip = new JSZip()
	let total = 0
	const addBytes = (bytes: Uint8Array, path: string) => {
		checkCancelled(signal)
		total += bytes.length
		if (total > 12 * 1024 * 1024) throw new Error('主题图片总量过大，请选择更简单的主题')
		assets.push({ path, mime: 'image/png', bytes: bytes.length, sha256: sha256(bytes) })
		zip.file(path, bytes)
		return path
	}
	const add = async (value: unknown, path: string, edge: number) => {
		if (value == null || value === '') return undefined
		checkCancelled(signal)
		return addBytes(await port.image(bilibiliThemeImageUrl(value), edge, signal), path)
	}
	// head_bg is only a short header strip, never a song cover or character illustration.
	const bannerUrl = skin.head_myself_squared_bg || skin.image_cover || skin.image_preview || skin.head_myself_bg || skin.head_bg
	const hero = await add(bannerUrl, 'assets/banner.png', 1280)
	const pageHeader = await add(skin.head_bg || bannerUrl, 'assets/page-header.png', 1024)
	const navigation = await add(skin.tail_bg, 'assets/navigation.png', 1024)
	if (navigation) tokens.light.navigation = { normal: color(skin.tail_color) ?? base.text.secondary, selected: highlight }
	const background = backgrounds.find((candidate) => candidate.id === options.backgroundId) ?? backgrounds[0]
	const profileBackground = await add(background?.url, 'assets/profile-background.png', 1280)
	const avatarFrame = await add(pendants[0]?.image, 'assets/avatar-frame.png', 256)
	let backdrop: string | undefined
	if (profileBackground && port.background) {
		const original = await zip.file(profileBackground)!.async('uint8array')
		backdrop = addBytes(await port.background(original, surface.base, adjustments), 'assets/background.png')
	} else backdrop = await add(skin.head_myself_bg || skin.side_bg, 'assets/background.png', 1280)
	for (const [slot, key] of [['home', 'main'], ['search', 'dynamic'], ['library', 'channel'], ['user', 'myself']] as const) {
		const normal = await add(skin[`tail_icon_${key}`], `assets/${slot}.png`, 128)
		if (!normal) continue
		const selected = await add(skin[`tail_icon_selected_${key}`], `assets/${slot}-selected.png`, 128)
		components.icons ??= {}
		components.icons[slot] = { light: { normal, ...(selected ? { selected } : {}) } }
	}
	const thumb = await add(slider.middle_png || slider.static_icon_image, 'assets/thumb.png', 128)
	if (thumb) {
		const dragLeft = await add(slider.drag_left_png, 'assets/thumb-left.png', 128)
		const dragRight = await add(slider.drag_right_png, 'assets/thumb-right.png', 128)
		components.progress.thumb = { light: thumb, sizeDp: 32, ...(dragLeft ? { dragLeft } : {}), ...(dragRight ? { dragRight } : {}) }
	}
	if (!assets.length && !color(skin.color) && !color(skin.tail_color_selected)) throw new Error('此装扮没有可适配的静态主题资源，请换一个主题')
	// Prefer a real preview; packages containing only colors also need a preview image.
	const previewUrl = skin.image_preview || skin.image_cover || skin.head_bg || slider.middle_png || slider.static_icon_image
	const preview = await add(previewUrl, 'previews/theme.png', 720)
	if (!preview) throw new Error('此主题缺少可用的预览图，请选择其他装扮')
	const manifest = { format: 'melocanvas-theme', schemaVersion: 1, id: `bilibili.${item.id}`, version: '1.2.0', name: name(item.name),
		author: 'B站装扮作者（本机适配）', minAppVersion: '0.19.2', license: '原素材权利归原作者，仅作本机适配；参见 LICENSE.txt',
		entry: { tokens: 'tokens.json', components: 'components.json' }, fallback: 'melocanvas.builtin.modern',
		requiredCapabilities: authorHost.capabilities.filter((c) => (c !== 'package-icons-v1' || !!components.icons) && (c !== 'surface-art-v1' || !!hero || !!navigation)), optionalCapabilities: [], assets, previews: [preview] }
	zip.file('manifest.json', JSON.stringify(manifest))
	zip.file('tokens.json', JSON.stringify(tokens))
	zip.file('components.json', JSON.stringify({ components, decorations: { ...(hero ? { hero, banner: hero } : {}), ...(pageHeader ? { pageHeader } : {}), ...(profileBackground ? { profileBackground } : {}), ...(avatarFrame ? { avatarFrame } : {}), ...(navigation ? { navigation } : {}), ...(backdrop ? { backdrop } : {}) }, motion: { durationMs: 0, respectReducedMotion: true } }))
	zip.file('LICENSE.txt', `素材来自 B 站装扮「${name(item.name)}」。原素材权利归其权利人，导入不授予再次分发的许可。\n来源标识：${item.id}\n`)
	const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
	checkCancelled(signal)
	await validateThemePackage(bytes, authorHost, port.decoder, { signal })
	return bytes
}
