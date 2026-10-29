import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes, type ResolvedTheme } from '../core/theme'
import { cosmosTheme, themeAppearance } from '../core/theme-appearance'
import type { ThemePresentation } from '../core/theme-install-types'
import type { AdaptedPackageTheme } from '../core/theme-package-adapter'
import { LyricsStore } from '../lyrics'

import {
	controlFixture,
	controlNodes,
	legacyControlPackage,
	type ControlNode,
} from './theme-control-fixture'

const sourceId = 'bilibili:BV1234567890:42'
const first = '合成第一行'
const second = '合成第二行'
const timed = `[00:01]${first}\n[00:03]${second}`
const label = (value: unknown): string =>
	Array.isArray(value)
		? value.map(label).join('')
		: typeof value === 'string'
			? value
			: value && typeof value === 'object'
				? label((value as ControlNode).children)
				: ''

function textNode(tree: unknown, text: string) {
	const found = controlNodes(tree).find(
		(node) => node.type === 'Text' && label(node.children) === text,
	)
	assert.ok(found, text)
	return found
}

function reader(raw: string | null, initialTheme?: ResolvedTheme) {
	const f = controlFixture()
	f.viewport.width = 320
	f.viewport.fontScale = 2
	const ui = f.load('ui')
	const module = f.load('lyrics-ui')
	const data = new Map<string, string>()
	const library = {
		setting: (key: string) => data.get(key) ?? null,
		setSetting: (key: string, value: string) => data.set(key, value),
	}
	if (raw)
		new LyricsStore(library).save({
			version: 1,
			sourceId,
			filename: '合成歌词.lrc',
			raw,
			offsetMs: 0,
			importedAt: 0,
		})
	const saved = [...data]
	let position = 0
	let theme = initialTheme
	let adapted: AdaptedPackageTheme | null = null
	let sought = -1
	const render = () => {
		const content = f.element(module.LyricsReader as ControlNode['type'], {
			library,
			sourceId,
			title: '合成音源',
			position,
			duration: 30,
			height: 234,
			onSeek: (value: number) => {
				sought = value
			},
			onClose() {},
		})
		const root = theme
			? f.element(
					ui.ThemeRendererProvider as ControlNode['type'],
					{ theme, adapted, allowedImageUris: [], reducedMotion: true },
					content,
				)
			: content
		f.render(root)
		return f.render(root)
	}
	return {
		f,
		render,
		setPosition(value: number) {
			position = value
		},
		setTheme(value: ResolvedTheme, packageTheme: AdaptedPackageTheme | null) {
			theme = value
			adapted = packageTheme
		},
		assertUnchangedStorage() {
			assert.deepEqual([...data], saved)
		},
		sought: () => sought,
	}
}

async function customPackage() {
	const { adapted } = await legacyControlPackage()
	// Deliberately distinct valid colors: using action/text tokens must fail.
	adapted.theme.tokens.action.primary = '#112233'
	adapted.theme.tokens.text.primary = '#223344'
	adapted.theme.tokens.text.secondary = '#334455'
	adapted.retained.lyricTokens = {
		active: '#a32162',
		inactive: '#356b45',
	}
	return adapted
}

function previewColors(adapted: AdaptedPackageTheme) {
	const f = controlFixture()
	const preview = f.load('theme-preview')
	const root = f.element(preview.ThemeReferencePreview as ControlNode['type'], {
		adapted,
		allowedImageUris: [],
		reducedMotion: true,
	})
	const button = controlNodes(f.render(root)).find(
		(node) =>
			node.type === 'Pressable' && node.props.accessibilityLabel === '预览播放器',
	)
	assert.ok(button)
	;(button.props.onPress as () => void)()
	const tree = f.render(root)
	const colors = {
		active: f.flatten(textNode(tree, '向晚风，借一段安静').props.style).color,
		inactive: f.flatten(textNode(tree, '固定文字，仅预览歌词颜色').props.style)
			.color,
	}
	f.unmount()
	return colors
}

void test('creator dark lyrics agree between import preview and reader, then return to light without changing lyrics', async () => {
	const light = await customPackage()
	const dark = structuredClone(light)
	dark.mode = 'dark'
	dark.theme.tokens = structuredClone(cosmosTheme.tokens)
	dark.retained.lyricTokens = { active: '#FFE2A0', inactive: '#B4C6D8' }
	const chosen: ThemePresentation = {
		selection: { kind: 'package', id: light.theme.id, archiveSha256: 'a'.repeat(64) },
		theme: light.theme, adapted: light, darkAdapted: dark, allowedImageUris: [], packageMetadata: null,
	}
	const r = reader(timed, light.theme)
	r.setPosition(2)
	for (const mode of ['dark', 'light', 'dark'] as const) {
		const presentation = themeAppearance(chosen, mode)
		r.setTheme(presentation.theme, presentation.adapted)
		const expected = previewColors(presentation.adapted!)
		assert.equal(r.f.flatten(textNode(r.render(), first).props.style).color, expected.active)
		assert.equal(r.f.flatten(textNode(r.render(), second).props.style).color, expected.inactive)
	}
	r.assertUnchangedStorage()
	r.f.unmount()
})

void test('real reader uses the same custom lyric colors as the real package preview as current lines change', async () => {
	const adapted = await customPackage()
	const colors = previewColors(adapted)
	assert.deepEqual(colors, adapted.retained.lyricTokens)
	const r = reader(timed, adapted.theme)
	r.setTheme(adapted.theme, adapted)
	for (const [position, active] of [
		[0, -1],
		[2, 0],
		[4, 1],
		[2, 0],
		[0, -1],
	]) {
		r.setPosition(position)
		const tree = r.render()
		for (const [index, text] of [first, second].entries()) {
			const node = textNode(tree, text)
			const style = r.f.flatten(node.props.style)
			assert.equal(
				style.color,
				index === active ? colors.active : colors.inactive,
			)
			assert.equal(style.fontSize, index === active ? 20 : 17)
			assert.equal(style.lineHeight, (index === active ? 20 : 17) * 1.45)
			assert.equal(style.fontWeight, index === active ? '700' : '400')
			assert.equal(style.textAlign, 'center')
			assert.equal(style.fontFamily, undefined)
			assert.notEqual(node.props.allowFontScaling, false)
			assert.equal(node.props.maxFontSizeMultiplier, undefined)
			assert.equal(node.props.numberOfLines, undefined)
		}
	}
	const seek = controlNodes(r.render()).find(
		(node) => node.props.accessibilityLabel === `点击返回封面，长按跳到 1.0 秒：${first}`,
	)
	assert.ok(seek)
	assert.equal(seek.props.accessibilityRole, 'button')
	assert.ok(Number(r.f.flatten(seek.props.style).minHeight) >= 48)
	;(seek.props.onLongPress as () => void)()
	assert.equal(r.sought(), 1)
	r.assertUnchangedStorage()
	r.f.unmount()
})

void test('validated existing package lyric colors reach the real reader unchanged', async () => {
	const { adapted } = await legacyControlPackage()
	const r = reader(timed, adapted.theme)
	r.setTheme(adapted.theme, adapted)
	r.setPosition(2)
	const tree = r.render()
	assert.equal(
		r.f.flatten(textNode(tree, first).props.style).color,
		adapted.retained.lyricTokens.active,
	)
	assert.equal(
		r.f.flatten(textNode(tree, second).props.style).color,
		adapted.retained.lyricTokens.inactive,
	)
	r.f.unmount()
})

for (const [name, theme] of [
	['default context', undefined],
	['cosmos dark', cosmosTheme],
	...Object.entries(builtInThemes),
] as const) {
	void test(`reader keeps existing active action/inactive text fallbacks: ${name}`, () => {
		const r = reader(timed, theme)
		r.setPosition(2)
		const tree = r.render()
		const expected = theme ?? builtInThemes.modern
		assert.equal(
			r.f.flatten(textNode(tree, first).props.style).color,
			expected.tokens.action.primary,
		)
		assert.equal(
			r.f.flatten(textNode(tree, second).props.style).color,
			expected.tokens.text.secondary,
		)
		r.assertUnchangedStorage()
		r.f.unmount()
	})
}

void test('dark lyrics search and version sheet retain readable colors while switching appearance', () => {
	const r = reader(timed, cosmosTheme)
	const press = (targetLabel: string) => {
		const node = controlNodes(r.render()).find(n => n.props.accessibilityLabel === targetLabel)!
		;(node.props.onPress as () => void)()
	}
	press('歌词版本与设置')
	press('搜索歌词')
	for (const theme of [cosmosTheme, builtInThemes.modern, cosmosTheme]) {
		r.setTheme(theme, null)
		const tree = r.render()
		const input = controlNodes(tree).find(node => node.props.testID === 'lyrics-song-search')!
		assert.equal(input.props.placeholderTextColor, theme.tokens.text.secondary)
		assert.equal(input.props.selectionColor, theme.tokens.action.primary)
		assert.equal(input.props.cursorColor, theme.tokens.action.primary)
		const modal = controlNodes(tree).find(node => node.type === 'Modal')!
		const sheet = controlNodes(modal).find(node => node.props.accessibilityViewIsModal)!
		assert.equal(r.f.flatten(sheet.props.style).backgroundColor, theme.tokens.surface.card)
		assert.equal(r.f.flatten(textNode(modal, '搜索歌词').props.style).color, theme.tokens.text.primary)
	}
	r.assertUnchangedStorage()
	r.f.unmount()
})

void test('untimed lyrics have no active color or invented seek; empty reader retains semantic controls', async () => {
	const adapted = await customPackage()
	const r = reader(`${first}\n${second}`, adapted.theme)
	r.setTheme(adapted.theme, adapted)
	r.setPosition(20)
	const tree = r.render()
	for (const text of [first, second])
		assert.equal(
			r.f.flatten(textNode(tree, text).props.style).color,
			adapted.retained.lyricTokens.inactive,
		)
	assert.equal(
		controlNodes(tree).some((node) =>
			String(node.props.accessibilityLabel).startsWith('跳到'),
		),
		false,
	)
	r.assertUnchangedStorage()
	r.f.unmount()

	const empty = reader(null, adapted.theme)
	empty.setTheme(adapted.theme, adapted)
	const emptyTree = empty.render()
	assert.equal(
		empty.f.flatten(textNode(emptyTree, '正在获取歌词…').props.style).color,
		adapted.theme.tokens.text.secondary,
	)
	assert.equal(
		empty.f.flatten(textNode(emptyTree, '重新自动匹配').props.style)
			.color,
		adapted.theme.tokens.action.primary,
	)
	assert.equal(
		controlNodes(emptyTree).some((node) => label(node.children) === '♪'),
		false,
	)
	empty.assertUnchangedStorage()
	empty.f.unmount()
})

void test('timed instrumental placeholder and provider changes resolve current lyric colors without changing saved content', async () => {
	const adapted = await customPackage()
	const r = reader(`[00:01]${first}\n[00:03]\n[00:05]${second}`, adapted.theme)
	r.setTheme(adapted.theme, adapted)
	r.setPosition(4)
	assert.equal(
		r.f.flatten(textNode(r.render(), '♪').props.style).color,
		adapted.retained.lyricTokens.active,
	)
	const replacement = structuredClone(adapted)
	replacement.retained.lyricTokens = { active: '#552288', inactive: '#246688' }
	r.setTheme(replacement.theme, replacement)
	assert.equal(
		r.f.flatten(textNode(r.render(), '♪').props.style).color,
		replacement.retained.lyricTokens.active,
	)
	assert.equal(
		r.f.flatten(textNode(r.render(), first).props.style).color,
		replacement.retained.lyricTokens.inactive,
	)
	r.setTheme(builtInThemes.pastoral, null)
	assert.equal(
		r.f.flatten(textNode(r.render(), '♪').props.style).color,
		builtInThemes.pastoral.tokens.action.primary,
	)
	r.assertUnchangedStorage()
	r.f.unmount()
})
