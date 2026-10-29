import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

import { bilibiliThemeImageUrl, importBilibiliTheme, listOwnedBilibiliThemes, readBilibiliThemeResources, searchBilibiliThemes, type BilibiliThemeItem, type BilibiliThemePort } from '../bilibili-theme'
import { validateThemePackage } from '../core/theme-package'
import { authorHost } from '../theme-author'
import { contrastRatio } from '../bilibili-theme-colors'
import { adaptPackageTheme } from '../core/theme-package-adapter'
import { builtInThemes } from '../core/theme'

const require = createRequire(import.meta.url)
const { createNodeImageDecoder } = require('../../../../../scripts/lib/theme-package-node.cjs')
const png = new Uint8Array(readFileSync(new URL('../../../../../theme-packages/progress-example/assets/thumb.png', import.meta.url)))
const suit: BilibiliThemeItem = { id: 'suit-123', name: '测试装扮', kind: 'suit', itemId: 123, actId: 0, lotteryId: 0 }
const skin = { head_bg: 'https://i0.hdslb.com/head.png', head_myself_bg: 'https://i0.hdslb.com/bg.png', image_preview: 'https://i0.hdslb.com/preview.png', tail_color_selected: '315a86', tail_icon_main: 'https://i0.hdslb.com/home.png', tail_icon_selected_main: 'https://i0.hdslb.com/home-selected.png', tail_icon_channel: 'https://i0.hdslb.com/library.png', tail_icon_myself: 'https://i0.hdslb.com/user.png', tail_icon_ani: 'https://i0.hdslb.com/animation.zip' }
const slider = { middle_png: 'https://i0.hdslb.com/thumb.png' }
const signal = () => new AbortController().signal

void test('owned collection resolves its matching pool, imports separate thumb/frame/background and never downloads video', async () => {
	const calls: string[] = []
	const f = port(async (url) => {
		calls.push(url)
		if (url.includes('item_id=456&')) return { part_id: 9, properties: skin, buy_link: 'https://www.bilibili.com/h5/mall/digital-card/home?act_id=88' }
		if (url.includes('act/basic')) return { lottery_list: [{ lottery_id: 1 }, { lottery_id: 2 }] }
		if (url.includes('lottery_id=1')) return { collect_list: [{ redeem_item_type: 5, redeem_item_id: '999' }] }
		if (url.includes('lottery_id=2')) return { collect_list: [{ redeem_item_type: 5, redeem_item_id: '456&77&78&77' }], item_list: [
			{ card_item: { card_type_id: 10, card_name: '背景一', card_img: 'https://i0.hdslb.com/one.png' } },
			{ card_item: { card_type_id: 11, card_name: '月光之下', card_img: 'https://i0.hdslb.com/moon.png' } },
		] }
		if (url.includes('item_id=77&')) return { part_id: 11, properties: { ...slider, drag_left_png: 'https://i0.hdslb.com/left.png', drag_right_png: 'https://i0.hdslb.com/right.png' } }
		if (url.includes('item_id=78&')) return { part_id: 1, properties: { image: 'https://i0.hdslb.com/frame.png', image_avatar: 'https://i0.hdslb.com/do-not-overwrite-avatar.png' } }
		throw new Error(url)
	})
	let processed = 0
	f.value.background = async (bytes, color, adjustments) => { processed++; assert.equal(adjustments.transparency, 65); assert.ok(color.startsWith('#')); return bytes }
	const owned = { ...suit, kind: 'skin' as const, itemId: 456 }
	const resources = await readBilibiliThemeResources(owned, f.value, signal())
	assert.equal(calls.filter((url) => url.includes('item_id=456&')).length, 1)
	assert.equal(calls.filter((url) => url.includes('item_id=77&')).length, 1)
	assert.ok(!calls.some((url) => url.includes('item_id=999')))
	const bytes = await importBilibiliTheme(owned, f.value, signal(), { resources, backgroundId: 11, adjustments: { transparency: 65, zoom: 1.2, horizontal: 40, vertical: 30 } })
	const verified = await validateThemePackage(bytes, authorHost, f.value.decoder)
	assert.equal(verified.snapshot.assets.avatarFrame?.path, 'assets/avatar-frame.png')
	assert.equal(verified.snapshot.assets.profileBackground?.path, 'assets/profile-background.png')
	assert.equal(verified.snapshot.assets.backdrop?.path, 'assets/background.png')
	assert.equal(verified.snapshot.components.progress.thumb?.dragLeft, 'assets/thumb-left.png')
	assert.equal(processed, 1)
	assert.ok(f.images.some(([url]) => url.endsWith('moon.png')))
	assert.ok(!f.images.some(([url]) => url.includes('overwrite-avatar') || url.endsWith('one.png')))
	await assert.rejects(validateThemePackage(bytes, { ...authorHost, capabilities: authorHost.capabilities.filter(c => c !== 'collection-art-v1') }, f.value.decoder), /必需能力/)
})

void test('untrusted collection links are not followed and unmatched pools do not apply another collection', async () => {
	const owned = { ...suit, kind: 'skin' as const, itemId: 456 }
	let calls = 0
	await readBilibiliThemeResources(owned, port(async () => { calls++; return { part_id: 9, properties: skin, buy_link: 'https://evil.test/h5/mall/digital-card/home?act_id=88' } }).value, signal())
	assert.equal(calls, 1)
	await assert.rejects(readBilibiliThemeResources(owned, port(async (url) => url.includes('benefit')
		? { part_id: 9, properties: skin, buy_link: 'https://www.bilibili.com/h5/mall/digital-card/home?act_id=88' }
		: { lottery_list: [] }).value, signal()), /未找到/)
})
function port(request: BilibiliThemePort['request']) {
	const images: [string, number][] = []
	const value: BilibiliThemePort = { request, decoder: createNodeImageDecoder(), image: async (url, edge) => { images.push([url, edge]); return png } }
	return { value, images }
}

void test('owned theme list reads active skin assets, handles pagination and excludes invalid or expired items', async () => {
	const f = port(async (url) => {
		assert.equal(url, '/x/garb/user/asset/list?part=skin&state=active&pn=2&ps=20')
		return { page: { total: 41 }, list: [
			{ asset_state: 'active', item: { item_id: 456, name: '星空列车与白的旅行' } },
			{ item: { item_id: 456, name: '重复' } }, { item: { item_id: -1 } },
			{ asset_state: 'expired', item: { item_id: 789 } },
		] }
	})
	const result = await listOwnedBilibiliThemes(2, f.value, signal())
	assert.deepEqual(result, { items: [{ id: 'skin-456', name: '星空列车与白的旅行', kind: 'skin', itemId: 456, actId: 0, lotteryId: 0 }], hasMore: true })
	await assert.rejects(listOwnedBilibiliThemes(0, f.value, signal()), /页码/)
	const controller = new AbortController(); controller.abort()
	await assert.rejects(listOwnedBilibiliThemes(1, f.value, controller.signal), /取消/)
})

void test('owned skin imports directly without requiring a searchable store listing', async () => {
	const f = port(async (url) => {
		assert.equal(url, '/x/garb/v2/user/suit/benefit?item_id=456&part=skin')
		return { part_id: 9, properties: { ...skin, tail_bg: 'https://i0.hdslb.com/nav.png' } }
	})
	const item = { ...suit, id: 'skin-456', kind: 'skin' as const, itemId: 456 }
	const verified = await validateThemePackage(await importBilibiliTheme(item, f.value, signal()), authorHost, f.value.decoder)
	assert.equal(verified.manifest.id, 'bilibili.skin-456')
	assert.equal(verified.snapshot.assets.navigation?.path, 'assets/navigation.png')
	await assert.rejects(importBilibiliTheme(item, port(async () => ({ part_id: 1, properties: skin })).value, signal()), /不是个性主题/)
})

void test('search handles suit/collection IDs, deduplicates, excludes unsupported products and preserves pagination', async () => {
	const f = port(async (url) => { assert.match(url, /key_word=%E5%88%9D%E9%9F%B3&pn=2&ps=10/); return { total: 30, list: [
		{ item_id: 123, part_id: 6, name: '装扮', properties: {} },
		{ item_id: 123, part_id: 6, name: '重复', properties: {} },
		{ part_id: 0, name: '收藏集', properties: { dlc_act_id: '12', dlc_lottery_id: '34' } },
		{ part_id: 1, item_id: 5 }, { part_id: 6, item_id: -1 },
	] } })
	const result = await searchBilibiliThemes('初音', 2, f.value, signal())
	assert.deepEqual(result.items.map((x) => x.id), ['suit-123', 'collection-12-34'])
	assert.equal(result.hasMore, true)
	await assert.rejects(searchBilibiliThemes(' ', 1, f.value, signal()))
})

void test('suit converts only supported static assets to a real installable package and leaves missing search icon to host', async () => {
	const f = port(async (url) => { assert.match(url, /suit\/detail\?item_id=123$/); return { suit_items: { skin: [{ properties: skin }], play_icon: [{ properties: slider }], loading: [{ properties: { loading_url: 'unsupported' } }] } } })
	const bytes = await importBilibiliTheme(suit, f.value, signal())
	const verified = await validateThemePackage(bytes, authorHost, f.value.decoder)
	assert.equal(verified.snapshot.tokens.light.action.primary, '#315a86')
	assert.equal(verified.snapshot.tokens.light.progress?.fill, '#315a86')
	assert.equal(verified.snapshot.components.progress.thumb?.sizeDp, 32)
	assert.equal(verified.snapshot.components.icons?.home?.light.selected, 'assets/home-selected.png')
	assert.equal(verified.snapshot.components.icons?.search, undefined)
	assert.ok(verified.snapshot.assets.backdrop)
	assert.ok(f.images.filter(([, edge]) => edge === 128).length >= 5)
	assert.ok(!f.images.some(([url]) => url.includes('animation')))
	assert.equal(verified.snapshot.motion.durationMs, 0)
})

void test('collections read component benefits sequentially, deduplicate IDs and enforce the request budget', async () => {
	const urls: string[] = []
	const f = port(async (url) => {
		urls.push(url)
		if (url.includes('asset_bag')) return { collect_list: [{ redeem_item_type: 2, redeem_item_id: '1&2&1' }] }
		return url.includes('item_id=1&') ? { part_id: 9, properties: skin } : { part_id: 11, properties: slider }
	})
	await importBilibiliTheme({ ...suit, id: 'collection-12-34', kind: 'collection', actId: 12, lotteryId: 34 }, f.value, signal())
	assert.equal(urls.length, 3)
	const tooMany = port(async () => ({ collect_list: [{ redeem_item_type: 2, redeem_item_id: Array.from({ length: 25 }, (_, i) => i + 1).join('&') }] }))
	await assert.rejects(importBilibiliTheme({ ...suit, kind: 'collection', actId: 1, lotteryId: 2 }, tooMany.value, signal()), /组件过多/)
	assert.equal(tooMany.images.length, 0)
})

void test('fourth Bili tab and secondary page art are imported with coherent surfaces, not just home artwork', async () => {
	const f = port(async () => ({ suit_items: { skin: [{ properties: { ...skin,
		tail_icon_dynamic: 'https://i0.hdslb.com/dynamic.png', tail_icon_selected_dynamic: 'https://i0.hdslb.com/dynamic-selected.png',
	} }] } }))
	const bytes = await importBilibiliTheme(suit, f.value, signal())
	const verified = await validateThemePackage(bytes, authorHost, f.value.decoder)
	assert.deepEqual(verified.snapshot.components.icons?.search?.light, { normal: 'assets/search.png', selected: 'assets/search-selected.png' })
	assert.ok(f.images.some(([url]) => url.endsWith('/dynamic.png')))
	assert.ok(f.images.some(([url]) => url.endsWith('/dynamic-selected.png')))
	assert.equal(verified.snapshot.assets.pageHeader?.path, 'assets/page-header.png')
	const t = verified.snapshot.tokens.light
	assert.notDeepEqual(t.surface, builtInThemes.modern.tokens.surface)
	for (const background of Object.values(t.surface)) {
		assert.ok(contrastRatio(t.action.primary, background) >= 4.5)
		assert.ok(contrastRatio(t.text.primary, background) >= 4.5)
		assert.ok(contrastRatio(t.text.secondary, background) >= 4.5)
	}
	await assert.rejects(validateThemePackage(bytes, { ...authorHost, appVersion: '0.19.1' }, f.value.decoder), /版本/)
})

void test('collection illustration and navigation background survive conversion; pale accents remain readable', async () => {
	const f = port(async () => ({ suit_items: { skin: [{ properties: { ...skin,
		tail_color_selected: '#99ffcc', tail_color: '#f5f5ff', tail_bg: 'https://i0.hdslb.com/tail.png',
		head_myself_squared_bg: 'https://i0.hdslb.com/character.png',
	} }] } }))
	const verified = await validateThemePackage(await importBilibiliTheme(suit, f.value, signal()), authorHost, f.value.decoder)
	const assets = verified.snapshot.assets as typeof verified.snapshot.assets & { banner?: { path: string }; navigation?: { path: string } }
	assert.equal(assets.banner?.path, 'assets/banner.png')
	assert.equal(assets.navigation?.path, 'assets/navigation.png')
	assert.notEqual(verified.snapshot.tokens.light.action.primary.toLowerCase(), '#99ffcc')
	const tokens = verified.snapshot.tokens.light
	for (const background of [tokens.surface.base, tokens.surface.card, tokens.surface.tinted, tokens.text.inverse])
		assert.ok(contrastRatio(tokens.action.primary, background) >= 4.5)
	assert.equal(verified.snapshot.tokens.light.progress?.fill, '#99ffcc')
	assert.ok(f.images.some(([url]) => url.endsWith('/character.png')))
	assert.notEqual(assets.hero.kind === 'package' && assets.hero.path, 'assets/header.png')
	const root = `file:///data/themes/${verified.manifest.id}/${verified.snapshot.package.archiveSha256}/`
	const adapted = adaptPackageTheme(verified, {
		package: verified.snapshot.package, rootUri: root,
		resources: verified.snapshot.resources.map((r) => ({ path: r.path, sha256: r.sha256, uri: root + r.path })),
	}, { mode: 'light', host: authorHost, privateThemesRootUri: 'file:///data/themes/' })
	assert.equal(adapted.retained.surfaceArt?.banner, root + 'assets/banner.png')
	assert.equal(adapted.retained.surfaceArt?.navigation, root + 'assets/navigation.png')
	assert.deepEqual(adapted.retained.surfaceArt?.navigationColors, { normal: '#f5f5ff', selected: '#99ffcc' })
	await assert.rejects(validateThemePackage(await importBilibiliTheme(suit, f.value, signal()), {
		...authorHost, capabilities: authorHost.capabilities.filter((c) => c !== 'surface-art-v1'),
	}, f.value.decoder), /必需能力/)
})

void test('untrusted destinations, API failure, unusable themes, corrupt images and cancellation never return a package', async () => {
	for (const url of ['https://hdslb.com.evil.test/a.png', 'file:///x.png', 'https://user@i0.hdslb.com/a.png', 'https://i0.hdslb.com:444/a.png']) assert.throws(() => bilibiliThemeImageUrl(url))
	assert.equal(bilibiliThemeImageUrl('//i0.hdslb.com/a.png'), 'https://i0.hdslb.com/a.png')
	const f = port(async () => ({ suit_items: { skin: [{ properties: skin }] } }))
	const abort = new AbortController(); abort.abort()
	await assert.rejects(importBilibiliTheme(suit, f.value, abort.signal)); assert.equal(f.images.length, 0)
	await assert.rejects(importBilibiliTheme(suit, port(async () => ({ suit_items: {} })).value, signal()), /没有可适配/)
	await assert.rejects(importBilibiliTheme(suit, port(async () => { throw new Error('接口不可用') }).value, signal()), /接口不可用/)
	await assert.rejects(importBilibiliTheme(suit, { ...f.value, image: async () => new Uint8Array([1, 2]) }, signal()), /PNG/)
	const controller = new AbortController()
	await assert.rejects(importBilibiliTheme(suit, { ...f.value, image: async () => { controller.abort(); return png } }, controller.signal))
})
