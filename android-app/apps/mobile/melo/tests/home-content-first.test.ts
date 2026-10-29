import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'

import {
	controlFixture,
	controlNodes,
	legacyControlPackage,
	measureControl,
	type ControlNode,
} from './theme-control-fixture'

void test('home search shortcut is compact and honest; existing recommendation and FM actions remain explicit', () => {
	for (const theme of Object.values(builtInThemes)) {
		const f = controlFixture(),
			ui = f.load('ui'),
			controls = f.load('app-controls'),
			calls: string[] = []
		const draw = (name: string, props: Record<string, unknown>) =>
			f.render(
				f.element(
					ui.ThemeProvider as ControlNode['type'],
					{ value: theme },
					f.element(controls[name] as ControlNode['type'], props),
				),
			)
		const hero = draw('HomeMusicHero', { onPress: () => calls.push('search') })
		const action = controlNodes(hero).find(
			(n) => n.props.accessibilityLabel === '搜索更多音乐',
		)!
		assert.ok(action)
		const style = action.props.style as (state: unknown) => unknown
		assert.equal(
			f.flatten(typeof style === 'function' ? style({ pressed: false }) : style)
				.minHeight,
			72,
		)
		;(action.props.onPress as () => void)()
		assert.doesNotMatch(JSON.stringify(hero), /立即播放|把日子|每日推荐/)
		const features = draw('HomeLocalFeatures', {
			onRecommendations: () => calls.push('recommendations'),
			onFm: () => calls.push('fm'),
		})
		for (const label of ['打开每日推荐', '打开私人 FM']) {
			const target = controlNodes(features).find(
				(n) => n.props.accessibilityLabel === label,
			)!
			;(target.props.onPress as () => void)()
		}
		assert.deepEqual(calls, ['search', 'recommendations', 'fm'])
		assert.match(JSON.stringify(features), /本机保存|本机收藏/)
	}
})
void test('home shows actual listening entry points and liked songs before search suggestions without changing playback bindings', () => {
	const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
	const home = source.slice(
		source.indexOf("{tab === 'home'"),
		source.indexOf("{tab === 'search'", source.indexOf("{tab === 'home'")),
	)
	assert.ok(
		home.indexOf('<HomeLocalFeatures') <
			home.indexOf('likes.slice(0, 2).map(row)'),
	)
	assert.ok(
		home.indexOf('likes.slice(0, 2).map(row)') < home.indexOf('<HomeMusicHero'),
	)
	assert.match(home, /onRecommendations=\{openRecommendations\}/)
	assert.match(home, /onFm=\{openFm\}/)
	assert.match(home, /<HomeMusicHero onPress=\{\(\) => navigateSearch\(\)\}/)
	assert.doesNotMatch(home, /游客即可|从搜索开始/)
})

void test('home adaptive controls preserve verified custom theme touch targets and channel actions', async () => {
	const legacy = await legacyControlPackage()
	for (const [name, props, labels] of [
		['HomeDiscoveryTabs', { channel: 'listening' }, ['发现音乐', '发现听视频']],
		['HomeLocalFeatures', {}, ['打开每日推荐', '打开私人 FM']],
		['HomeMusicHero', {}, ['搜索更多音乐']],
	] as const) {
		const f = controlFixture(),
			ui = f.load('ui'),
			calls: string[] = []
		const root = f.element(
			ui.PackageThemeProvider as ControlNode['type'],
			{
				...legacy,
				adapted: {
					...legacy.adapted,
					retained: {
						...legacy.adapted.retained,
						buttonMinTouchDp: 96,
						controlRowLayout: { minTouchDp: 96, narrowFallback: 'reject' },
					},
				},
			},
			f.element(f.load('app-controls')[name] as ControlNode['type'], {
				...props,
				onMusic: () => calls.push('music'),
				onListening: () => calls.push('listening'),
				onRecommendations: () => calls.push('recommendations'),
				onFm: () => calls.push('fm'),
				onPress: () => calls.push('search'),
			}),
		)
		assert.equal(
			controlNodes(f.render(root)).filter((n) => n.type === 'Pressable').length,
			0,
		)
		measureControl(f.render(root), 400)
		const controls = controlNodes(f.render(root)).filter(
			(n) => n.type === 'Pressable',
		)
		assert.equal(controls.length, labels.length)
		for (const [i, target] of controls.entries()) {
			assert.equal(target.props.accessibilityLabel, labels[i])
			const style = target.props.style as (state: unknown) => unknown
			assert.ok(
				Number(
					f.flatten(
						typeof style === 'function' ? style({ pressed: false }) : style,
					).minHeight,
				) >= 96,
			)
			;(target.props.onPress as () => void)()
		}
		assert.equal(calls.length, labels.length)
	}
})
