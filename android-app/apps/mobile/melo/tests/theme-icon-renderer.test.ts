import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readBaselineSource } from './baseline-source'

import { builtInThemes } from '../core/theme'
import { packageThemeIconNames } from '../core/theme-package-types'
import { createPackageRendering } from '../theme-renderer'

import { controlNodes, legacyControlPackage } from './theme-control-fixture'
import {
	iconHost,
	iconPackage,
	normalized,
	only,
} from './theme-icon-renderer-fixture'

const prepared = iconPackage()

void test('search navigation can use theme artwork while literal search inputs retain the magnifier', async () => {
	const p = await prepared, f = iconHost(), adapted = structuredClone(p.light)
	adapted.retained.iconResources!.search = adapted.retained.iconResources!.home
	const themed = f.render(f.pack(f.icon({ name: 'search', selected: true, navigation: true }), adapted, p.allowed))
	assert.equal(controlNodes(themed).filter((node) => node.type === 'Image').length, 1)
	const input = f.render(f.pack(f.icon({ name: 'search', themed: false }), adapted, p.allowed))
	assert.equal(controlNodes(input).filter((node) => node.type === 'Image').length, 0)
	assert.equal(controlNodes(input).filter((node) => node.type === 'Svg').length, 1)
	adapted.retained.iconResources!.library = adapted.retained.iconResources!.home
	const local = f.render(f.pack(f.icon({ name: 'library' }), adapted, p.allowed))
	assert.equal(controlNodes(local).filter(node => node.type === 'Image').length, 0, 'local shortcut and cover placeholders keep their literal icon')
})

void test('navigation artwork uses its own foreground colors and preserves all four tab actions', async () => {
	const p = await prepared, f = iconHost(), adapted = structuredClone(p.light), calls: string[] = []
	adapted.retained.surfaceArt = { navigation: p.allowed[0], navigationColors: { normal: '#eeeeff', selected: '#99ffcc' } }
	const tree = f.render(f.pack(f.navigation({ tab: 'home', bottomInset: 6, onNavigate: (tab: string) => calls.push(tab) }), adapted, p.allowed))
	const tabs = controlNodes(tree).filter((node) => node.props.accessibilityRole === 'tab')
	assert.equal(tabs.length, 4)
	for (const [index, tab] of tabs.entries()) {
		const label = only(tab, 'Text')
		assert.equal(f.flatten(label.props.style).color, index === 0 ? '#99ffcc' : '#eeeeff')
		;(tab.props.onPress as () => void)()
	}
	assert.deepEqual(calls, ['home', 'search', 'library', 'profile'])
	const background = controlNodes(tree).find((node) => node.props.testID === 'theme-navigation-background')
	assert.equal(background?.props.pointerEvents, 'none')
})

void test('resolver snapshots only exact canonical allowlisted image states and never crosses modes', async () => {
	const p = await prepared,
		value = structuredClone(p.light),
		allowed = [...p.allowed]
	const mapping = value.retained.iconResources
	assert.ok(mapping?.play?.light.selected)
	const normal = mapping.play.light.normal.uri,
		selected = mapping.play.light.selected.uri
	const rendering = createPackageRendering(value, allowed, false)
	assert.equal(rendering.resolveIcon('play'), normal)
	assert.equal(rendering.resolveIcon('play', true), selected)
	assert.equal(rendering.resolveIcon('queue', true), undefined)
	assert.equal(
		rendering.resolveIcon('heart', true),
		mapping.heart?.light.normal.uri,
	)
	assert.equal(
		createPackageRendering(p.dark, p.allowed, false).resolveIcon('heart', true),
		undefined,
	)
	assert.ok(
		p.dark.theme.warnings.some(
			(warning) => warning.includes('heart') && warning.includes('深色'),
		),
	)
	mapping.play.light.normal.uri = 'file:///private/changed.png'
	mapping.play.light.selected.uri = 'file:///private/changed-selected.png'
	value.mode = 'dark'
	allowed.length = 0
	assert.equal(rendering.resolveIcon('play'), normal)
	assert.equal(rendering.resolveIcon('play', true), selected)
	for (const uri of [
		'https://example.invalid/icon.png',
		'content://app/icon.png',
		'file://host/icon.png',
		'file:///private/%69con.png',
		'file:///private/../icon.png',
		'file:///private//icon.png',
		`${normal}?x=1`,
		`${normal}#x`,
		normal.replace('.png', '-not-bound.png'),
	]) {
		const bad = structuredClone(p.light),
			states = bad.retained.iconResources?.play?.light
		assert.ok(states?.selected)
		states.selected.uri = uri
		const hostUris = [
			...p.allowed,
			...(uri.endsWith('-not-bound.png') ? [] : [uri]),
		]
		assert.equal(
			createPackageRendering(bad, hostUris, false).resolveIcon('play', true),
			undefined,
		)
		assert.equal(
			createPackageRendering(bad, hostUris, false).resolveIcon('play'),
			undefined,
			'invalid declared selected is not an omitted state with normal fallback',
		)
		states.selected.uri = selected
		states.normal.uri = uri
		assert.equal(
			createPackageRendering(bad, hostUris, false).resolveIcon('play'),
			undefined,
		)
	}
})

void test('actual Icon uses normal/selected PNG explicitly; filled play is not selection and missing mapping remains SVG', async () => {
	const p = await prepared,
		f = iconHost()
	const render = (props: Record<string, unknown>) =>
		f.render(f.pack(f.icon(props), p.light, p.allowed))
	let tree = render({ name: 'play', filled: true, size: 29 })
	const normal = only(tree, 'Image')
	assert.ok(String(normal.props.source).endsWith('/assets/icon-normal.png'))
	assert.equal(normal.props.contentFit, 'contain')
	assert.deepEqual(normalized(f, f.flatten(normal.props.style)), {
		width: 29,
		height: 29,
	})
	assert.equal(normal.props.accessible, false)
	assert.equal(normal.props.accessibilityElementsHidden, true)
	assert.equal(normal.props.importantForAccessibility, 'no-hide-descendants')
	assert.equal(normal.props.pointerEvents, 'none')
	tree = render({ name: 'play', selected: true })
	assert.ok(
		String(only(tree, 'Image').props.source).endsWith(
			'/assets/icon-selected.png',
		),
	)
	tree = render({ name: 'heart', selected: true, filled: true })
	assert.ok(
		String(only(tree, 'Image').props.source).endsWith(
			'/assets/icon-normal.png',
		),
	)
	tree = render({ name: 'queue', selected: true })
	assert.equal(
		controlNodes(tree).filter((node) => node.type === 'Image').length,
		0,
	)
	assert.equal(only(tree, 'Svg').props.width, 22)
})

void test('actual dark rendering chooses only dark PNG and leaves a missing dark role to the original vector', async () => {
	const p = await prepared,
		f = iconHost()
	for (const selected of [false, true]) {
		const tree = f.render(
			f.pack(f.icon({ name: 'play', selected }), p.dark, p.allowed),
		)
		assert.ok(
			String(only(tree, 'Image').props.source).endsWith(
				selected
					? '/assets/icon-dark-selected.png'
					: '/assets/icon-dark-normal.png',
			),
		)
	}
	const tree = f.render(
		f.pack(
			f.icon({ name: 'heart', selected: true, filled: true, color: '#112233' }),
			p.dark,
			p.allowed,
		),
	)
	assert.equal(only(tree, 'Path').props.fill, '#112233')
	assert.equal(
		controlNodes(tree).filter((node) => node.type === 'Image').length,
		0,
	)
})

void test('actual image error returns the unchanged vector and preserves size/color/filled semantics', async () => {
	const p = await prepared,
		f = iconHost(),
		baseline = iconHost({
			ui: readBaselineSource('89c193f1:android-app/apps/mobile/melo/ui.tsx'),
		})
	const props = {
		name: 'play',
		selected: true,
		filled: true,
		size: 31,
		color: '#112233',
	}
	const element = f.pack(f.icon(props), p.light, p.allowed)
	let tree = f.render(element)
	;(only(tree, 'Image').props.onError as () => void)()
	tree = f.render(element)
	const original = baseline.render(
		baseline.pack(baseline.icon(props), p.light, p.allowed),
	)
	assert.deepEqual(normalized(f, tree), normalized(baseline, original))
	assert.equal(only(tree, 'Svg').props.width, 31)
	assert.equal(only(tree, 'Path').props.fill, '#112233')
})

void test('late image errors cannot affect a new resource, same-URI new theme, theme ABA, or an unmounted icon', async () => {
	const p = await prepared,
		f = iconHost()
	const nextTheme = structuredClone(p.light)
	nextTheme.theme.tokens.action.primary = '#abcdef'
	const render = (theme = p.light, selected = false) =>
		f.render(f.pack(f.icon({ name: 'play', selected }), theme, p.allowed))
	let tree = render()
	const first = only(tree, 'Image').props.onError as () => void
	tree = render(p.light, true)
	first()
	tree = render(p.light, true)
	assert.ok(
		String(only(tree, 'Image').props.source).endsWith(
			'/assets/icon-selected.png',
		),
	)
	const selectedError = only(tree, 'Image').props.onError as () => void
	tree = render(nextTheme, true) // identical URI, a different trusted rendering object
	selectedError()
	assert.ok(only(render(nextTheme, true), 'Image'))
	tree = render(p.light)
	first()
	assert.ok(only(render(), 'Image'))
	const currentError = only(tree, 'Image').props.onError as () => void
	f.unmount()
	first()
	currentError()
	assert.equal(f.writesAfterUnmount, 0)
})

void test('IconButton active and navigation selected feed only artwork while parent a11y, disabled and callbacks remain authoritative', async () => {
	const p = await prepared,
		f = iconHost(),
		calls: string[] = []
	for (const active of [false, true]) {
		const tree = f.render(
			f.pack(
				f.button({
					name: 'play',
					label: '播放控制',
					active,
					disabled: true,
					onPress: () => calls.push('play'),
				}),
				p.light,
				p.allowed,
			),
		)
		const button = only(tree, 'Pressable')
		assert.equal(button.props.accessibilityRole, 'button')
		assert.equal(button.props.accessibilityLabel, '播放控制')
		assert.deepEqual(normalized(f, button.props.accessibilityState), {
			disabled: true,
			selected: active,
		})
		assert.equal(button.props.disabled, true)
		assert.ok(
			String(only(tree, 'Image').props.source).endsWith(
				active ? '/assets/icon-selected.png' : '/assets/icon-normal.png',
			),
		)
		assert.equal(only(tree, 'Image').props.accessibilityLabel, undefined)
	}
	const enabled = f.render(
		f.pack(
			f.button({
				name: 'play',
				label: '播放控制',
				active: true,
				onPress: () => calls.push('play'),
			}),
			p.light,
			p.allowed,
		),
	)
	;(only(enabled, 'Pressable').props.onPress as () => void)()
	for (const tab of ['home', 'search']) {
		const tree = f.render(
			f.pack(
				f.navigation({
					tab,
					bottomInset: 6,
					onNavigate: (next: string) => calls.push(next),
				}),
				p.light,
				p.allowed,
			),
		)
		assert.ok(
			String(only(tree, 'Image').props.source).endsWith(
				tab === 'home'
					? '/assets/icon-selected.png'
					: '/assets/icon-normal.png',
			),
		)
		const tabs = controlNodes(tree).filter(
			(node) => node.props.accessibilityRole === 'tab',
		)
		assert.equal(tabs.length, 4)
		assert.deepEqual(
			tabs.map(
				(node) =>
					(node.props.accessibilityState as { selected: boolean }).selected,
			),
			[tab === 'home', tab === 'search', false, false],
		)
		for (const target of tabs) (target.props.onPress as () => void)()
	}
	assert.deepEqual(calls, [
		'play',
		'home',
		'search',
		'library',
		'profile',
		'home',
		'search',
		'library',
		'profile',
	])
})

void test('three defaults and real legacy48 retain every original SVG tree, parent state and callbacks', async () => {
	const baseline = Object.fromEntries(
		['ui', 'host-controls'].map((name) => [
			name,
			readBaselineSource(`89c193f1:android-app/apps/mobile/melo/${name}.tsx`),
		]),
	)
	const legacy = await legacyControlPackage(),
		f = iconHost(),
		old = iconHost(baseline)
	let comparisons = 0
	for (const theme of [...Object.values(builtInThemes), legacy.adapted.theme]) {
		const wrap = (h: ReturnType<typeof iconHost>, child: unknown) =>
			theme === legacy.adapted.theme
				? h.pack(child, legacy.adapted, legacy.allowedImageUris)
				: h.builtin(child, theme)
		for (const name of packageThemeIconNames)
			for (const filled of [false, true]) {
				const props = {
					name,
					filled,
					selected: true,
					color: '#123456',
					size: 27,
				}
				assert.deepEqual(
					normalized(f, f.render(wrap(f, f.icon(props)))),
					normalized(old, old.render(wrap(old, old.icon(props)))),
				)
				comparisons++
			}
		for (const active of [false, true]) {
			const props = { name: 'heart', label: '喜欢', active, onPress: () => {} }
			const actual = normalized(f, f.render(wrap(f, f.button(props)))),
				expected = normalized(old, old.render(wrap(old, old.button(props))))
			if (theme !== legacy.adapted.theme) {
				const before = only(expected, 'Pressable'),
					style = before.props.style as Record<string, unknown>
				for (const field of [
					'borderRadius',
					'backgroundColor',
					'minWidth',
					'minHeight',
				])
					assert.equal(style[field], undefined, `historical ${field}`)
				before.props.style = {
					...style,
					borderRadius: 24,
					minWidth: 48,
					minHeight: 48,
					...(active ? { backgroundColor: theme.tokens.surface.tinted } : {}),
				}
				assert.deepEqual(
					only(actual, 'Pressable').props.style,
					before.props.style,
				)
			}
			assert.deepEqual(actual, expected)
		}
		const navProps = { tab: 'home', bottomInset: 12, onNavigate: () => {} }
		const actualNav = normalized(f, f.render(wrap(f, f.navigation(navProps)))),
			expectedNav = normalized(
				old,
				old.render(wrap(old, old.navigation(navProps))),
			)
		if (theme !== legacy.adapted.theme) {
			for (const name of ['发现', '搜索', '音乐库', '我的']) {
				const before = controlNodes(expectedNav).filter(
						(n) =>
							n.type === 'Pressable' &&
							n.props.accessibilityLabel === `导航${name}`,
					),
					after = controlNodes(actualNav).filter(
						(n) =>
							n.type === 'Pressable' &&
							n.props.accessibilityLabel === `导航${name}`,
					)
				assert.equal(before.length, 1)
				assert.equal(after.length, 1)
				const style = before[0].props.style as Record<string, unknown>
				for (const field of ['minWidth', 'borderRadius', 'backgroundColor'])
					assert.equal(style[field], undefined)
				assert.equal(style.minHeight, 54)
				before[0].props.style = {
					...style,
					minWidth: 48,
					borderRadius: theme.components.button === 'comic' ? 8 : 18,
					backgroundColor:
						'transparent',
				}
				assert.deepEqual(after[0].props.style, before[0].props.style)
			}
		}
		for (const text of controlNodes(expectedNav).filter(n => n.type === 'Text')) {
			const style = text.props.style as Record<string, unknown>
			if (style.fontSize === 10) { style.fontSize = 11; style.lineHeight = 11 * 1.45 }
		}
		assert.deepEqual(actualNav, expectedNav)
	}
	assert.equal(comparisons, 160)
})
