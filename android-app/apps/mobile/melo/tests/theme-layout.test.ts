import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	resolveThemeControlRow,
	resolveThemeNavigation,
	type ThemeControlRowPolicy,
} from '../core/theme-layout'

const regular: ThemeControlRowPolicy = {
	minTouchDp: 96,
	narrowFallback: 'reject',
}
const navigation = (availableWidthDp: number) => ({
	availableWidthDp,
	controlMinWidthsDp: [48, 48, 48, 48],
})

void test('四导航以实际净宽判定；360/412屏示例不允许两行或隐式缩小', () => {
	assert.deepEqual(resolveThemeNavigation(regular, navigation(360 - 20)), {
		kind: 'rejected',
		reason: 'insufficient-width',
		requiredWidthDp: 384,
		availableWidthDp: 340,
	})
	assert.deepEqual(resolveThemeNavigation(regular, navigation(412 - 20)), {
		kind: 'regular',
		touchDp: 96,
		minWidthsDp: [96, 96, 96, 96],
		requiredWidthDp: 384,
	})
})

void test('常规优先，其次显式compact，再显式host；授权只作用于受限行', () => {
	const policy: ThemeControlRowPolicy = {
		...regular,
		compactMinTouchDp: 72,
		narrowFallback: 'host-single-row',
	}
	for (const [width, kind, touchDp] of [
		[384, 'regular', 96],
		[340, 'compact', 72],
		[287, 'host-single-row', 48],
	] as const) {
		const result = resolveThemeNavigation(policy, navigation(width))
		assert.ok(result.kind !== 'rejected')
		assert.equal(result.kind, kind)
		assert.equal(result.touchDp, touchDp)
	}
	assert.equal(resolveThemeNavigation(policy, navigation(191)).kind, 'rejected')
	assert.equal(resolveThemeNavigation(policy, navigation(392)).kind, 'regular')
})

void test('无compact和fallback授权绝不降低48/49/72/96所需尺寸', () => {
	for (const minTouchDp of [48, 49, 72, 96]) {
		const policy: ThemeControlRowPolicy = {
			minTouchDp,
			narrowFallback: 'reject',
		}
		const required = minTouchDp * 4
		assert.equal(
			resolveThemeNavigation(policy, navigation(required)).kind,
			'regular',
		)
		assert.equal(
			resolveThemeNavigation(policy, navigation(required - 0.1)).kind,
			'rejected',
		)
	}
	assert.deepEqual(
		resolveThemeNavigation(
			{ minTouchDp: 48, narrowFallback: 'reject' },
			navigation(340),
		),
		{
			kind: 'regular',
			touchDp: 48,
			minWidthsDp: [48, 48, 48, 48],
			requiredWidthDp: 192,
		},
	)
})

void test('回退仍保留字体放大后的必要宽与gap，不能靠48覆盖文字或相邻目标', () => {
	const policy: ThemeControlRowPolicy = {
		...regular,
		narrowFallback: 'host-single-row',
	}
	const row = {
		availableWidthDp: 240,
		controlMinWidthsDp: [120, 60],
		gapDp: 12,
	}
	assert.deepEqual(resolveThemeControlRow(policy, row), {
		kind: 'regular',
		touchDp: 96,
		minWidthsDp: [120, 96],
		requiredWidthDp: 228,
	})
	assert.deepEqual(
		resolveThemeControlRow(policy, { ...row, availableWidthDp: 192 }),
		{
			kind: 'host-single-row',
			touchDp: 48,
			minWidthsDp: [120, 60],
			requiredWidthDp: 192,
		},
	)
	assert.equal(
		resolveThemeControlRow(policy, { ...row, availableWidthDp: 191.9 }).kind,
		'rejected',
	)
})

void test('五项播放器行须足够宽；没有换行或重排分支，原有large最小宽也须传入', () => {
	const row = {
		availableWidthDp: 306,
		controlMinWidthsDp: [48, 48, 68, 48, 48],
		gapDp: 0,
	}
	assert.equal(resolveThemeControlRow(regular, row).kind, 'rejected')
	assert.deepEqual(
		resolveThemeControlRow({ ...regular, compactMinTouchDp: 48 }, row),
		{
			kind: 'compact',
			touchDp: 48,
			minWidthsDp: [48, 48, 68, 48, 48],
			requiredWidthDp: 260,
		},
	)
})

void test('输入/结果彼此隔离，resolver不写主题、不保留测量数组', () => {
	const policy = Object.freeze({ ...regular, compactMinTouchDp: 72 })
	const measured = Object.freeze({
		...navigation(340),
		controlMinWidthsDp: Object.freeze([48, 60, 50, 48]),
	})
	const before = structuredClone({ policy, measured })
	const result = resolveThemeNavigation(policy, measured)
	assert.ok(result.kind !== 'rejected')
	result.minWidthsDp[0] = 999
	assert.deepEqual({ policy, measured }, before)
	assert.deepEqual(resolveThemeNavigation(policy, measured), {
		kind: 'compact',
		touchDp: 72,
		minWidthsDp: [72, 72, 72, 72],
		requiredWidthDp: 288,
	})
})

void test('拒绝非finite/越界/分数尺寸、负测量/错误策略和求和溢出', () => {
	for (const minTouchDp of [NaN, Infinity, -Infinity, 47, 97, 48.5])
		assert.throws(() =>
			resolveThemeNavigation({ ...regular, minTouchDp }, navigation(340)),
		)
	for (const compactMinTouchDp of [NaN, Infinity, 47, 97, 72.5])
		assert.throws(() =>
			resolveThemeNavigation(
				{ ...regular, compactMinTouchDp },
				navigation(340),
			),
		)
	assert.throws(() =>
		resolveThemeNavigation(
			{ minTouchDp: 48, compactMinTouchDp: 49, narrowFallback: 'reject' },
			navigation(340),
		),
	)
	assert.throws(() =>
		resolveThemeNavigation(
			{ ...regular, narrowFallback: 'wrap' as 'reject' },
			navigation(340),
		),
	)
	for (const availableWidthDp of [NaN, Infinity, -Infinity, 0, -1])
		assert.throws(() =>
			resolveThemeNavigation(regular, navigation(availableWidthDp)),
		)
	for (const gapDp of [NaN, Infinity, -1])
		assert.throws(() =>
			resolveThemeControlRow(regular, { ...navigation(340), gapDp }),
		)
	for (const width of [NaN, Infinity, -1])
		assert.throws(() =>
			resolveThemeControlRow(regular, {
				availableWidthDp: 340,
				controlMinWidthsDp: [width],
				gapDp: 0,
			}),
		)
	assert.throws(() =>
		resolveThemeControlRow(regular, {
			availableWidthDp: 340,
			controlMinWidthsDp: [],
			gapDp: 0,
		}),
	)
	assert.throws(() =>
		resolveThemeControlRow(regular, {
			availableWidthDp: 340,
			controlMinWidthsDp: new Array<number>(4),
			gapDp: 0,
		}),
	)
	assert.throws(() =>
		resolveThemeControlRow(regular, {
			availableWidthDp: 340,
			controlMinWidthsDp: [Number.MAX_VALUE, Number.MAX_VALUE],
			gapDp: 0,
		}),
	)
})

void test('导航包装固定四个目的地，调用者不能借第三方布局隐藏/增加目的地', () => {
	for (const count of [0, 1, 3, 5])
		assert.throws(() =>
			resolveThemeNavigation(regular, {
				availableWidthDp: 340,
				controlMinWidthsDp: Array<number>(count).fill(48),
			}),
		)
})
