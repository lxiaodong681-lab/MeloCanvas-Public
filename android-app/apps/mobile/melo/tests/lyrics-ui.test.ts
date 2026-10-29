import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LyricsStore, reviewLyricsVersion } from '../lyrics'

import {
	controlFixture,
	controlNodes,
	legacyControlPackage,
	type ControlNode,
} from './theme-control-fixture'
const sourceId = 'bilibili:BV1234567890:42'
const original = '[00:01.250]清晨写一行\n[00:03]回声沿路响'
const tick = () => new Promise((resolve) => setImmediate(resolve))
const label = (value: unknown): string =>
	Array.isArray(value)
		? value.map(label).join('')
		: typeof value === 'string'
			? value
			: value && typeof value === 'object'
				? label((value as ControlNode).children)
				: ''
function fixture(
	pick: () => Promise<{ filename: string; raw: string } | null>,
) {
	const data = new Map<string, string>()
	let id = sourceId
	let saves = 0
	let failSave = false
	const library = {
		setting: (key: string) => data.get(key) ?? null,
		setSetting: (key: string, value: string) => {
			if (failSave) throw new Error('合成保存失败')
			saves++
			data.set(key, value)
		},
	}
	const f = controlFixture({}, { './lyrics-mobile': { pickLyrics: pick } })
	const module = f.load('lyrics-ui')
	let position = 2
	let sought = -1
	const render = () =>
		f.render(
			f.element(module.LyricsReader as ControlNode['type'], {
				library,
				sourceId: id,
				title: '测试版（翻唱 Live）',
				performer: '合成演唱者乙',
				uploader: '合成投稿者',
				position,
				duration: 20,
				height: 274,
				onClose: () => {},
				onSeek: (seconds: number) => {
					sought = seconds
				},
			}),
		)

	const button = (text: string) => {
		const target = controlNodes(render()).find(
			(node) =>
				node.type === 'Pressable' &&
				(node.props.accessibilityLabel === text ||
					label(node.children) === text),
		)
		assert.ok(target, text)
		return target
	}
	const press = (text: string) => {
		;(button(text).props.onPress as () => void)()
	}
	return {
		f,
		setSource: (value: string) => {
			id = value
		},
		saves: () => saves,
		failSave: (value: boolean) => {
			failSave = value
		},
		library,
		render,
		press,
		button,
		setPosition: (value: number) => {
			position = value
		},
		sought: () => sought,
	}
}
void test('real import requires version confirmation; precise seek, manual suspension, offset and reread work', async () => {
	const f = fixture(async () => ({ filename: '原创测试.lrc', raw: original }))
	f.press('歌词版本与设置')
	f.press('导入本地歌词（可选）')
	await tick()
	assert.equal(new LyricsStore(f.library).get(sourceId), null)
	f.press('确认用于当前音源')
	assert.equal(new LyricsStore(f.library).get(sourceId)?.raw, original)
	;(f.button('点击返回封面，长按跳到 1.3 秒：清晨写一行').props.onLongPress as () => void)()
	assert.equal(f.sought(), 1.25)
	const scroll = controlNodes(f.render()).find(
		(node) => node.type === 'ScrollView',
	)!
	;(scroll.props.onScrollBeginDrag as () => void)()
	f.setPosition(4)
	f.render()
	f.button('回到当前')
	f.press('回到当前')
	assert.equal(
		controlNodes(f.render()).some(
			(node) => node.props.accessibilityLabel === '回到当前',
		),
		false,
	)
	f.press('歌词版本与设置')
	f.press('调整歌词时间')
	f.press('延后 0.5 秒')
	f.press('返回歌词上一级')
	assert.equal(new LyricsStore(f.library).get(sourceId)?.offsetMs, 500)
	;(f.button('点击返回封面，长按跳到 1.8 秒：清晨写一行').props.onLongPress as () => void)()
	assert.equal(f.sought(), 1.75)
	f.f.unmount()
})
void test('cancel replacement preserves prior content and plain text cannot seek', async () => {
	const f = fixture(async () => ({
		filename: '原创文本.txt',
		raw: '没有时间戳\n不会假装同步',
	}))
	f.press('歌词版本与设置')
	f.press('导入本地歌词（可选）')
	await tick()
	f.press('取消，不更改')
	assert.equal(new LyricsStore(f.library).get(sourceId), null)
	f.press('导入本地歌词（可选）')
	await tick()
	f.press('确认用于当前音源')
	assert.equal(
		controlNodes(f.render()).some((node) =>
			String(node.props.accessibilityLabel).startsWith('跳到'),
		),
		false,
	)
	f.f.unmount()
})
void test('picker resolution after source component unmount never writes lyrics to a newer song', async () => {
	let finish!: (value: { filename: string; raw: string }) => void
	const f = fixture(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	f.press('歌词版本与设置')
	f.press('导入本地歌词（可选）')
	f.f.unmount()
	finish({ filename: '原创.lrc', raw: original })
	await tick()
	assert.equal(new LyricsStore(f.library).get(sourceId), null)
	assert.equal(f.f.writesAfterUnmount, 0)
})

void test('automatic following pauses after manual drag until explicit return', async () => {
	const f = fixture(async () => ({ filename: '原创.lrc', raw: original }))
	f.press('歌词版本与设置')
	f.press('导入本地歌词（可选）')
	await tick()
	f.press('确认用于当前音源')
	let calls = 0
	const scroll = controlNodes(f.render()).find(
		(node) => node.type === 'ScrollView',
	)!
	;(scroll.props.ref as { current: unknown }).current = {
		scrollTo: () => {
			calls++
		},
	}
	const first = controlNodes(f.render()).find(
		(node) =>
			node.type === 'View' &&
			node.key === 0 &&
			typeof node.props.onLayout === 'function',
	)!
	;(first.props.onLayout as (event: unknown) => void)({
		nativeEvent: { layout: { y: 100 } },
	})
	assert.equal(calls, 1)
	;(scroll.props.onScrollBeginDrag as () => void)()
	f.setPosition(4)
	f.render()
	const second = controlNodes(f.render()).find(
		(node) =>
			node.type === 'View' &&
			node.key === 1 &&
			typeof node.props.onLayout === 'function',
	)!
	;(second.props.onLayout as (event: unknown) => void)({
		nativeEvent: { layout: { y: 180 } },
	})
	assert.equal(calls, 1)
	f.press('回到当前')
	assert.ok(calls > 1)
	f.f.unmount()
})
void test('repeated picker taps are guarded and picker failure can be retried', async () => {
	let calls = 0
	let fail!: (error: Error) => void
	const f = fixture(() => {
		calls++
		return new Promise((_, reject) => {
			fail = reject
		})
	})
	f.press('歌词版本与设置')
	const press = f.button('导入本地歌词（可选）').props.onPress as () => void
	press()
	press()
	assert.equal(calls, 1)
	fail(new Error('无法读取文件'))
	await tick()
	f.press('导入本地歌词（可选）')
	assert.equal(calls, 2)
	fail(new Error('取消'))
	await tick()
	f.f.unmount()
})

void test('player switches cover to lyric reading without replacing transport; host back exits reading first', () => {
	const f = controlFixture()
	f.viewport.width = 320
	f.viewport.fontScale = 2
	const player = f.load('music-ui')
	const readingBackRef: { current: (() => boolean) | null } = { current: null }
	let closed = 0
	const track = {
		id: 'queue-entry',
		sourceId,
		title: '原创测试音源',
		duration: 30,
		artwork: 'file://cover',
	}
	const root = f.element(player.MusicPlayer as ControlNode['type'], {
		library: { setting: () => null, setSetting: () => {} },
		readingBackRef,
		player: {
			track,
			queue: [track],
			position: 0,
			duration: 30,
			playing: false,
			fmContext: null,
			seek() {},
			toggle() {},
			previous() {},
			next() {},
		},
		current: {
			id: sourceId,
			originalTitle: '合成完整标题（翻唱 Live 未截断）',
			performer: '合成演唱乙',
			uploader: '合成UP甲',
		},
		isLiked: () => false,
		busyBv: '',
		onLike() {},
		onClose: () => {
			closed++
		},
		onTheme() {},
		onSource() {},
		onQueue() {},
		onNotice() {},
		onNotificationSettings() {},
		notifications: true,
		bottomInset: 20,
		onFm() {},
		fmMessage: '',
	})
	const render = () => f.render(root)
	const button = (name: string) => {
		const found = controlNodes(render()).find(
			(node) =>
				node.props.accessibilityLabel === name && node.type === 'Pressable',
		)
		assert.ok(found, name)
		return found
	}
	;(button('点击封面查看歌词').props.onPress as () => void)()
	button('点击歌词区域返回封面')
	;(button('点击歌词区域返回封面').props.onPress as () => void)()
	button('点击封面查看歌词')
	assert.equal(closed, 0)
	;(button('点击封面查看歌词').props.onPress as () => void)()
	button('歌词版本与设置')
	;(button('歌词版本与设置').props.onPress as () => void)()
	const versionText = label(render())
	for (const text of [
		'合成完整标题（翻唱 Live 未截断）',
	])
		assert.ok(versionText.includes(text), text)
	button('继续播放')
	assert.equal(
		f.flatten(
			controlNodes(render()).find(
				(node) => node.props.testID === 'player-lyrics-region',
			)!.props.style,
		).height,
		672,
	)
	assert.equal(
		controlNodes(render()).some(
			(node) => node.props.testID === 'player-cover-shadow',
		),
		false,
	)
	assert.ok(readingBackRef.current)
	assert.equal(readingBackRef.current(), true)
	assert.equal(closed, 0)
	button('展开歌词')
	assert.ok(
		controlNodes(render()).some(
			(node) => node.props.testID === 'player-cover-shadow',
		),
	)
	assert.equal(readingBackRef.current, null)
	f.unmount()
})

void test('lyric reading and secondary tools retain custom theme 48dp targets at narrow width', async () => {
	const legacy = await legacyControlPackage()
	const f = controlFixture()
	f.viewport.width = 320
	f.viewport.fontScale = 2
	const ui = f.load('ui'),
		reader = f.load('lyrics-ui')
	const content = f.element(reader.LyricsReader as ControlNode['type'], {
		library: { setting: () => null, setSetting() {} },
		sourceId,
		title: '原创',
		position: 0,
		duration: 30,
		height: 234,
		onSeek() {},
		onClose() {},
	})
	const root = f.element(
		ui.PackageThemeProvider as ControlNode['type'],
		{ ...legacy, reducedMotion: true },
		content,
	)
	const targets = controlNodes(f.render(root)).filter(
		(node) => node.type === 'Pressable',
	)
	assert.ok(targets.length >= 4)
	for (const target of targets) {
		const style = f.flatten(
			typeof target.props.style === 'function'
				? target.props.style({ pressed: false })
				: target.props.style,
		)
		assert.ok(Number(style.minHeight ?? style.height) >= 48)
	}
	f.unmount()
})

void test('review preserves cover and Live evidence, never treats uploader as performer or guesses a score', () => {
	const review = reviewLyricsVersion(
		{ title: '合成曲（翻唱 Live）', performer: '演唱乙' },
		{
			filename: '合成曲_Studio.lrc',
			raw: '[ti:合成曲（原唱）]\n[ar:演唱甲]\n[00:01]原创合成句',
		},
	)
	assert.deepEqual(review.currentHints, ['翻唱 / Cover', '现场 / Live'])
	assert.deepEqual(review.candidateHints, ['录音室 / Studio', '原唱标注'])
	assert.equal(review.parsed.artist, '演唱甲')
	assert.ok(review.warnings.some((text) => text.includes('演唱者标注不同')))
	const unknown = reviewLyricsVersion(
		{ title: '同名歌' },
		{ filename: '同名歌.txt', raw: '原创合成句' },
	)
	assert.ok(unknown.warnings.some((text) => text.includes('UP 主')))
	assert.ok(unknown.warnings.some((text) => text.includes('文件未标注演唱者')))
})
void test('narrow reader shows full separate source and candidate evidence and confirmation saves only once', async () => {
	const f = fixture(async () => ({
		filename: '录音室版.lrc',
		raw: '[ti:测试版原唱]\n[ar:合成演唱者甲]\n[00:01]原创合成句',
	}))
	f.f.viewport.width = 320
	f.f.viewport.fontScale = 2
	f.press('歌词版本与设置')
	f.press('导入本地歌词（可选）')
	await tick()
	const text = label(f.render())
	for (const value of [
		'测试版（翻唱 Live）',
		'演唱者：合成演唱者乙',
		'UP 主：合成投稿者',
		'测试版原唱',
		'合成演唱者甲',
		'演唱者标注不同',
		'版本标注不同',
	])
		assert.ok(text.includes(value), value)
	const confirm = f.button('确认用于当前音源').props.onPress as () => void
	const reviewScroll = controlNodes(f.render()).filter(node => node.type === 'ScrollView')
	assert.equal(reviewScroll.some(node => controlNodes(node).some(child => child.props.testID === 'lyrics-review-actions')), false)
	assert.ok(controlNodes(f.render()).some(node => node.props.testID === 'lyrics-review-actions'))
	confirm()
	confirm()
	assert.equal(f.saves(), 1)
	f.f.unmount()
})
void test('cancel and failed replacement preserve prior lyrics and offset; stale confirmation cannot save a newer candidate', async () => {
	let raw = original
	const f = fixture(async () => ({ filename: '合成.lrc', raw }))
	f.press('导入本地歌词（可选）')
	await tick()
	f.press('确认用于当前音源')
	f.press('歌词版本与设置')
	f.press('调整歌词时间')
	f.press('延后 0.5 秒')
	f.press('返回歌词上一级')
	const before = new LyricsStore(f.library).get(sourceId)
	raw = '[00:02]另一首原创合成句'
	f.press('导入本地歌词（可选）')
	await tick()
	const stale = f.button('确认用于当前音源').props.onPress as () => void
	f.press('取消，不更改')
	stale()
	assert.deepEqual(new LyricsStore(f.library).get(sourceId), before)
	f.press('导入本地歌词（可选）')
	await tick()
	f.failSave(true)
	f.press('确认用于当前音源')
	assert.deepEqual(new LyricsStore(f.library).get(sourceId), before)
	assert.ok(label(f.render()).includes('合成保存失败'))
	f.failSave(false)
	f.press('确认用于当前音源')
	assert.equal(new LyricsStore(f.library).get(sourceId)?.raw, raw)
	assert.equal(new LyricsStore(f.library).get(sourceId)?.offsetMs, 0)
	f.f.unmount()
})
void test('close and reopen isolates old picker results and errors from newer candidates', async () => {
	const requests: {
		resolve: (value: { filename: string; raw: string }) => void
		reject: (cause: Error) => void
	}[] = []
	const f = fixture(
		() =>
			new Promise((resolve, reject) => {
				requests.push({ resolve, reject })
			}),
	)
	f.press('歌词版本与设置')
	f.press('导入本地歌词（可选）')
	f.press('返回歌词上一级')
	f.press('歌词版本与设置')
	f.press('导入本地歌词（可选）')
	requests[1].resolve({ filename: '新版.lrc', raw: original })
	await tick()
	requests[0].reject(new Error('旧回包错误'))
	await tick()
	assert.ok(label(f.render()).includes('新版.lrc'))
	assert.ok(!label(f.render()).includes('旧回包错误'))
	f.press('确认用于当前音源')
	assert.equal(new LyricsStore(f.library).get(sourceId)?.filename, '新版.lrc')
	f.f.unmount()
})
void test('same title with different cid or local UUID rejects old picker and old confirmation', async () => {
	const ids = [
		'bilibili:BV1234567890:43',
		'local:123e4567-e89b-42d3-a456-426614174000',
	]
	for (const id of ids) {
		let finish!: (value: { filename: string; raw: string }) => void
		const f = fixture(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		f.press('导入本地歌词（可选）')
		f.setSource(id)
		f.render()
		finish({ filename: '旧音源.lrc', raw: original })
		await tick()
		assert.ok(!label(f.render()).includes('旧音源.lrc'))
		assert.equal(f.saves(), 0)
		f.press('导入本地歌词（可选）')
		finish({ filename: '当前.lrc', raw: original })
		await tick()
		const stale = f.button('确认用于当前音源').props.onPress as () => void
		f.setSource(sourceId)
		f.render()
		stale()
		assert.equal(f.saves(), 0)
		f.f.unmount()
	}
})

void test('choosing another candidate invalidates the previous confirmation and dismissed picker success stays dismissed', async () => {
	const requests: ((value: { filename: string; raw: string }) => void)[] = []
	const f = fixture(
		() =>
			new Promise((resolve) => {
				requests.push(resolve)
			}),
	)
	f.press('导入本地歌词（可选）')
	requests[0]({ filename: '第一版.lrc', raw: original })
	await tick()
	const oldConfirm = f.button('确认用于当前音源').props.onPress as () => void
	f.press('选择其他歌词文件')
	oldConfirm()
	assert.equal(f.saves(), 0)
	requests[1]({ filename: '第二版.lrc', raw: '[00:01]原创另一版' })
	await tick()
	oldConfirm()
	assert.equal(f.saves(), 0)
	f.press('确认用于当前音源')
	assert.equal(new LyricsStore(f.library).get(sourceId)?.filename, '第二版.lrc')
	f.press('导入本地歌词（可选）')
	const modal = controlNodes(f.render()).find((node) => node.type === 'Modal')!
	;(modal.props.onRequestClose as () => void)()
	requests[2]({ filename: '已关闭.lrc', raw: original })
	await tick()
	assert.ok(!label(f.render()).includes('已关闭.lrc'))
	assert.equal(new LyricsStore(f.library).get(sourceId)?.filename, '第二版.lrc')
	f.f.unmount()
})
