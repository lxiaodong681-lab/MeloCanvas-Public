import assert from 'node:assert/strict'
import test from 'node:test'
import { controlFixture, controlNodes, type ControlNode } from './theme-control-fixture'
import { iconHost, iconPackage } from './theme-icon-renderer-fixture'
import { builtInThemes } from '../core/theme'

const ref = (uri: string) => ({ kind: 'package' as const, path: 'assets/thumb.png', sha256: '0'.repeat(64), mime: 'image/png' as const, uri })

void test('collection thumb uses directional PNG only during a drag and restores the middle PNG on release', async () => {
	const p = await iconPackage(), f = iconHost(), adapted = structuredClone(p.light)
	adapted.retained.progress = { thumb: ref(p.allowed[0]), dragLeft: ref(p.allowed[1]), dragRight: ref(p.allowed[2]), sizeDp: 32 }
	adapted.retained.controlRowLayout = undefined
	adapted.retained.buttonMinTouchDp = 48
	const component = f.load('progress').Progress as ControlNode['type']
	const seeks: number[] = []
	const render = () => controlNodes(f.render(f.pack(f.element(component, { position: 10, duration: 100, onSeek: (n: number) => { seeks.push(n) } }), adapted, p.allowed)))
	const track = () => render().find(n => n.props.accessibilityRole === 'adjustable')!
	const image = () => render().find(n => n.type === 'Image')!.props.source
	const event = (name: string, x: number) => (track().props[name] as (e: unknown) => void)({ nativeEvent: { pageX: x + 40, locationX: x } })
	;(track().props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 200 } } })
	assert.equal(image(), p.allowed[0])
	event('onResponderGrant', 20); event('onResponderMove', 100)
	assert.equal(image(), p.allowed[2]); assert.equal(seeks.length, 0)
	event('onResponderMove', 60); assert.equal(image(), p.allowed[1])
	event('onResponderRelease', 60); assert.equal(image(), p.allowed[0]); assert.deepEqual(seeks, [30])
	f.unmount()
})

function fixture() {
	const f = controlFixture(), module = f.load('progress')
	let position = 10, disabled = false, duration = 100
	const seeks: number[] = [], completed: (() => void)[] = [], dragging: boolean[] = []
	const render = () => controlNodes(f.render(f.element(module.Progress as ControlNode['type'], {
		position, duration, disabled,
		onDragChange: (value: boolean) => dragging.push(value),
		onSeek: (value: number) => { seeks.push(value); return new Promise<void>((resolve) => completed.push(resolve)) },
	}))).find((n) => n.props.accessibilityRole === 'adjustable')!
	const event = (name: string, x: number) => {
		const callback = render().props[name] as ((event: unknown) => void) | undefined
		assert.equal(typeof callback, 'function', name)
		callback!({ nativeEvent: { pageX: 40 + x, locationX: x } })
	}
	;(render().props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { width: 200 } } })
	return { f, render, event, seeks, completed, dragging,
		position: (value: number) => { position = value }, disabled: () => { disabled = true },
		duration: (value: number) => { duration = value },
		now: () => (render().props.accessibilityValue as { now: number }).now,
	}
}

void test('diagonal and off-track drags keep the horizontal target and lock scrolling until release', async () => {
	const f = fixture()
	f.event('onResponderGrant', 20)
	assert.equal(f.dragging.at(-1), true)
	for (const pageY of [0, 100, 500, -200]) {
		;(f.render().props.onResponderMove as (event: unknown) => void)({
			nativeEvent: { pageX: 190, pageY, locationX: -999, locationY: pageY },
		})
		f.position(12)
		assert.equal(f.now(), 75)
		assert.equal(f.dragging.at(-1), true)
	}
	f.event('onResponderRelease', 150)
	assert.deepEqual(f.seeks, [75])
	assert.equal(f.dragging.at(-1), false)
	f.event('onResponderRelease', 100)
	assert.deepEqual(f.seeks, [75], 'late release must not submit a second seek')
	f.position(75); f.completed[0](); await Promise.resolve()
	assert.equal(f.now(), 75)
	f.event('onResponderGrant', 20)
	f.event('onResponderTerminate', 120)
	assert.equal(f.dragging.at(-1), false)
	f.event('onResponderRelease', 120)
	assert.deepEqual(f.seeks, [75], 'a cancelled gesture must not later seek')
	f.f.unmount()
})

void test('thumb centers coincide with rail endpoints and fill for built-in and image themes', async () => {
	const p = await iconPackage()
	for (const theme of [...Object.values(builtInThemes), null]) {
		const f = iconHost(), component = f.load('progress').Progress as ControlNode['type']
		const adapted = structuredClone(p.light)
		adapted.retained.progress = { thumb: ref(p.allowed[0]), sizeDp: 32 }
		adapted.retained.controlRowLayout = undefined
		const render = (position: number) => {
			const child = f.element(component, { position, duration: 100, onSeek: () => {} })
			return controlNodes(f.render(theme
				? f.element(f.load('ui').ThemeProvider as ControlNode['type'], { value: theme }, child)
				: f.pack(child, adapted, p.allowed)))
		}
		const track = render(0).find(n => n.props.accessibilityRole === 'adjustable')!
		;(track.props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { width: 200 } } })
		for (const position of [0, 25, 100]) {
			const nodes = render(position)
			const thumb = nodes.find(n => f.flatten(n.props.style).position === 'absolute' && typeof f.flatten(n.props.style).left === 'number')!
			const style = f.flatten(thumb.props.style)
			assert.equal(Number(style.left) + Number(style.width) / 2, position * 2)
			assert.ok(nodes.some(n => f.flatten(n.props.style).width === `${position}%`))
		}
		f.unmount()
	}
})

void test('drag previews continuously, resists playback ticks and seeks once on release', async () => {
	const f = fixture()
	f.event('onResponderGrant', 20)
	f.event('onResponderMove', 120)
	assert.equal(f.now(), 60)
	f.position(11)
	assert.equal(f.now(), 60)
	assert.deepEqual(f.seeks, [])
	assert.equal((f.render().props.onResponderTerminationRequest as () => boolean)(), false)
	f.event('onResponderRelease', 150)
	assert.deepEqual(f.seeks, [75])
	assert.equal(f.now(), 75)
	f.position(75)
	f.completed[0]()
	await Promise.resolve()
	assert.equal(f.now(), 75)
	f.f.unmount()
})

void test('drag is bounded and cancellation/disabled controls never commit a seek', () => {
	const f = fixture()
	f.event('onResponderGrant', 20)
	f.event('onResponderMove', -50)
	assert.equal(f.now(), 0)
	f.event('onResponderMove', 300)
	assert.equal(f.now(), 100)
	f.event('onResponderTerminate', 300)
	assert.equal(f.now(), 10)
	assert.deepEqual(f.seeks, [])
	f.disabled()
	f.event('onResponderGrant', 100)
	f.event('onResponderMove', 120)
	f.event('onResponderRelease', 120)
	assert.deepEqual(f.seeks, [])
	f.f.unmount()
})

void test('completion of an earlier seek cannot erase a newer drag preview', async () => {
	const f = fixture()
	f.event('onResponderGrant', 20)
	f.event('onResponderRelease', 40)
	f.event('onResponderGrant', 40)
	f.event('onResponderMove', 140)
	f.completed[0]()
	await Promise.resolve()
	assert.equal(f.now(), 70)
	f.f.unmount()
})

void test('late seek completion after unmount cannot write preview state', async () => {
	const f = fixture()
	f.event('onResponderGrant', 20)
	f.event('onResponderRelease', 80)
	f.f.unmount()
	f.completed[0]()
	await Promise.resolve()
	assert.equal(f.f.writesAfterUnmount, 0)
})
