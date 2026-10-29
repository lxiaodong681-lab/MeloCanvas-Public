import assert from 'node:assert/strict'
import { test } from 'node:test'

import { builtInThemes } from '../core/theme'
import type { AdaptedPackageTheme } from '../core/theme-package-adapter'
import { LyricsStore } from '../lyrics'

import {
	controlFixture,
	controlNodes,
	legacyControlPackage,
	type ControlNode,
} from './theme-control-fixture'

const sourceId = 'bilibili:BV1234567890:42'
const texts = Array.from(
	{ length: 12 },
	(_, index) => `合成歌词第${index + 1}行`,
)
const raw = `[offset:250]\n${texts
	.map((text, index) => `[00:${String(index * 3 + 1).padStart(2, '0')}]${text}`)
	.join('\n')}`

function nativeChildren(value: unknown): ControlNode[] {
	if (Array.isArray(value)) return value.flatMap(nativeChildren)
	return value && typeof value === 'object' && 'type' in value
		? [value as ControlNode]
		: []
}

function visibleNodes(value: unknown): ControlNode[] {
	return nativeChildren(value).flatMap((node) =>
		node.type === 'Modal' && node.props.visible === false
			? []
			: [node, ...visibleNodes(node.children)],
	)
}

function layout(node: ControlNode, y: number, width: number, height: number) {
	if (typeof node.props.onLayout === 'function')
		(node.props.onLayout as (event: unknown) => void)({
			nativeEvent: { layout: { x: 0, y, width, height } },
		})
}

function button(tree: unknown, label: string) {
	const found = visibleNodes(tree).find(
		(node) =>
			node.type === 'Pressable' && node.props.accessibilityLabel === label,
	)
	assert.ok(found, label)
	return found
}

function scroll(tree: unknown) {
	const found = visibleNodes(tree).find(
		(node) => node.type === 'ScrollView' && node.props.onScrollBeginDrag,
	)
	assert.ok(found)
	return found
}

function responsivePackage(
	legacy: AdaptedPackageTheme,
	minTouchDp = 96,
): AdaptedPackageTheme {
	return {
		...legacy,
		retained: {
			...legacy.retained,
			buttonMinTouchDp: minTouchDp,
			controlRowLayout: {
				minTouchDp,
				narrowFallback: 'reject',
			},
		},
	}
}

/** Native layout coordinates are relative to each node's own native parent. */
function reader(
	adapted: AdaptedPackageTheme | null,
	width: number,
	fontScale: number,
	input = { raw, count: texts.length, position: 17, duration: 45 },
) {
	const f = controlFixture()
	f.viewport.width = width
	f.viewport.fontScale = fontScale
	const ui = f.load('ui')
	const module = f.load('lyrics-ui')
	const data = new Map<string, string>()
	const library = {
		setting: (key: string) => data.get(key) ?? null,
		setSetting: (key: string, value: string) => data.set(key, value),
	}
	new LyricsStore(library).save({
		version: 1,
		sourceId,
		filename: '合成滚动回归.lrc',
		raw: input.raw,
		offsetMs: 500,
		importedAt: 0,
	})
	const before = [...data]
	let position = input.position
	const scrolls: number[] = []
	const sought: number[] = []
	const render = () => {
		const root = f.element(
			ui.ThemeRendererProvider as ControlNode['type'],
			{
				theme: adapted?.theme ?? builtInThemes.modern,
				adapted,
				allowedImageUris: [],
				reducedMotion: true,
			},
			f.element(module.LyricsReader as ControlNode['type'], {
				library,
				sourceId,
				title: '合成滚动回归',
				position,
				duration: input.duration,
				height: 274,
				onSeek: (seconds: number) => sought.push(seconds),
				onClose() {},
			}),
		)
		let tree = f.render(root)
		for (let pass = 0; pass < 3; pass++) {
			// Settle only the real responsive-row width ports, never a lyric's y.
			for (const node of visibleNodes(tree))
				if (typeof node.key === 'string' && node.key.includes('['))
					layout(node, 0, width - 32, 96)
			tree = f.render(root)
		}
		return tree
	}
	const initial = render()
	;(scroll(initial).props.ref as { current: unknown }).current = {
		scrollTo: ({ y, animated }: { y: number; animated: boolean }) => {
			assert.equal(animated, true)
			scrolls.push(y)
		},
	}
	return {
		f,
		render,
		scrolls,
		sought,
		setPosition(value: number) {
			position = value
		},
		drag(tree: unknown) {
			;(scroll(tree).props.onScrollBeginDrag as () => void)()
		},
		measureRows(tree: unknown, heights: readonly number[]) {
			const list = scroll(tree)
			const rows = nativeChildren(list.children)
			assert.equal(rows.length, input.count)
			assert.equal(
				f.flatten(list.props.contentContainerStyle).paddingVertical,
				60,
			)
			assert.equal(f.flatten(list.props.contentContainerStyle).gap, 12)
			let y = 60
			const offsets: number[] = []
			for (const [index, row] of rows.entries()) {
				const seek = controlNodes(row).find((node) => node.type === 'Pressable')
				assert.ok(seek, `row ${index}`)
				if (adapted?.retained.controlRowLayout)
					assert.notEqual(
						seek,
						row,
						'responsive target has native row wrappers',
					)
				offsets.push(y)
				layout(row, y, width - 32, heights[index])
				// No padding/vertical displacement in these row wrappers: each nested
				// child is y=0 relative to its parent, NOT y relative to ScrollView.
				for (const child of controlNodes(row).slice(1))
					layout(child, 0, width - 32, heights[index])
				y += heights[index] + 12
			}
			return offsets
		},
		assertUnchangedStorage() {
			assert.deepEqual([...data], before)
		},
	}
}

for (const name of ['modern', 'legacy', 'responsive'] as const)
	for (const [width, fontScale] of [
		[360, 1],
		[320, 2],
	] as const)
		void test(`lyrics follow content offsets, not nested control offsets: ${name} ${width}dp font${fontScale}`, async () => {
			const legacy =
				name === 'modern' ? null : (await legacyControlPackage()).adapted
			const adapted =
				name === 'responsive' ? responsivePackage(legacy!) : legacy
			const r = reader(adapted, width, fontScale)
			const floor = name === 'responsive' ? 96 : 48
			const heights = texts.map((_, index) =>
				fontScale === 2 ? floor + 48 + (index % 3) * 24 : floor,
			)
			try {
				let tree = r.render()
				const offsets = r.measureRows(tree, heights)
				// 17s selects line 6 after the file's −250ms and saved +500ms corrections.
				assert.equal(r.scrolls.at(-1), offsets[5] - 80)
				r.drag(tree)
				tree = r.render()
				const pausedCalls = r.scrolls.length
				r.setPosition(23)
				tree = r.render()
				r.measureRows(tree, heights)
				assert.equal(r.scrolls.length, pausedCalls)
				;(button(tree, '回到当前').props.onPress as () => void)()
				tree = r.render()
				assert.equal(r.scrolls.at(-1), offsets[7] - 80)
				assert.ok(
					r.scrolls.at(-1)! > 0,
					'return must not jump to the beginning',
				)
				assert.equal(
					visibleNodes(tree).some(
						(node) => node.props.accessibilityLabel === '回到当前',
					),
					false,
				)
				assert.deepEqual(r.sought, [], 'scrolling never seeks playback')

				// A changed multiline height must update the content-space position.
				const expanded = heights.map((height) => height + 24)
				const expandedOffsets = r.measureRows(tree, expanded)
				assert.equal(r.scrolls.at(-1), expandedOffsets[7] - 80)
				r.drag(tree)
				tree = r.render()
				;(
					button(tree, '点击返回封面，长按跳到 10.3 秒：合成歌词第4行').props
						.onLongPress as () => void
				)()
				assert.deepEqual(r.sought, [10.25])
				r.setPosition(11)
				tree = r.render()
				;(button(tree, '回到当前').props.onPress as () => void)()
				r.render()
				assert.equal(r.scrolls.at(-1), expandedOffsets[3] - 80)
				r.setPosition(1.2)
				r.render()
				const beforeFirst = r.scrolls.length
				r.setPosition(1.25)
				r.render()
				assert.equal(r.scrolls.length, beforeFirst + 1)
				assert.equal(r.scrolls.at(-1), 0, 'only the first row clamps to top')
				r.assertUnchangedStorage()
			} finally {
				r.f.unmount()
			}
		})

for (const name of ['modern', 'responsive49'] as const)
	void test(`paused device timeline returns to active 40.5s lyric at 54.395s: ${name}`, async () => {
		const adapted =
			name === 'modern'
				? null
				: responsivePackage((await legacyControlPackage()).adapted, 49)
		if (adapted)
			adapted.retained.lyricTokens = { active: '#D11A57', inactive: '#205CBB' }
		const r = reader(adapted, 360, 1, {
			raw: [0, 5, 10, 20, 40, 60, 80]
				.map(
					(seconds, index) =>
						`[${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}]Synthetic line${index}`,
				)
				.join('\n'),
			count: 7,
			position: 54.395,
			duration: 90,
		})
		try {
			let tree = r.render()
			const offsets = r.measureRows(
				tree,
				Array.from({ length: 7 }, () => 49),
			)
			const active = button(tree, '点击返回封面，长按跳到 40.5 秒：Synthetic line4')
			const activeText = controlNodes(active).find(
				(node) => node.type === 'Text',
			)
			assert.ok(activeText)
			assert.equal(r.f.flatten(activeText.props.style).fontWeight, '700')
			assert.equal(
				r.f.flatten(activeText.props.style).color,
				adapted ? '#D11A57' : builtInThemes.modern.tokens.action.primary,
			)
			r.drag(tree)
			tree = r.render()
			const before = r.scrolls.length
			// Native manual movement does not change the paused playback position.
			r.measureRows(
				tree,
				Array.from({ length: 7 }, () => 49),
			)
			assert.equal(r.scrolls.length, before)
			;(button(tree, '回到当前').props.onPress as () => void)()
			tree = r.render()
			assert.equal(r.scrolls.at(-1), offsets[4] - 80)
			assert.equal(r.scrolls.at(-1), 224)
			assert.equal(
				visibleNodes(tree).some(
					(node) => node.props.accessibilityLabel === '回到当前',
				),
				false,
			)
			assert.deepEqual(r.sought, [])
			r.assertUnchangedStorage()
		} finally {
			r.f.unmount()
		}
	})
