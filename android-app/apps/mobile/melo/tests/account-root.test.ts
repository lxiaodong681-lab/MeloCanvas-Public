import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import type { AccountSnapshot } from '../account-session'
import { builtInThemes, type ThemeKey } from '../core/theme'
import * as appInformation from '../app-information'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'
const tick = () => new Promise((resolve) => setImmediate(resolve))
const flatten = (style: unknown): Record<string, unknown> =>
	Array.isArray(style)
		? Object.assign({}, ...style.map(flatten))
		: style && typeof style === 'object'
			? (style as Record<string, unknown>)
			: {}
function fixture() {
	let rejectPoll: ((error: unknown) => void) | null = null
	let state: AccountSnapshot = {
		status: 'signed-out',
		generation: 0,
		account: null,
		error: null,
		reason: 'signed-out',
	}
	let scanned: ((value: unknown) => void) | null = null
	let loginCalls = 0
	let requests = 0
	let capabilities = 0
	let restores = 0
	let clears = 0
	let exits = 0
	let width = 320
	let fontScale = 1
	let themeKey: ThemeKey = 'modern'
	let themeReady = true
	let appearanceMode: 'light' | 'dark' = 'light'
	let appearanceReady = true
	let themeRestores = 0
	let signal: AbortSignal | null = null
	let appState = 'active'
	let now = 1000
	let polls = 0
	const listeners = new Set<(value: string) => void>()
	const changeAppState = (value: string) => {
		appState = value
		for (const listener of listeners) listener(value)
	}
	const timers = new Map<number, { callback: () => void; delay: number }>()
	let timerId = 0
	const source =
		"import { Date, setTimeout, clearTimeout } from './account-test-timers'\n" +
		readFileSync(new URL('../account-root.tsx', import.meta.url), 'utf8')
	const dependencies: Record<string, unknown> = {
		'./useAppearance': { useAppearance: () => ({ mode: appearanceMode, ready: appearanceReady }) },
		'./app-information': appInformation,
		'./author-support-ui': { AuthorSupportEntry: 'AuthorSupportEntry' },
		'react-native-safe-area-context': {
			SafeAreaProvider: 'SafeAreaProvider',
			SafeAreaView: 'SafeAreaView',
			initialWindowMetrics: null,
		},
		'./App': { __esModule: true, default: 'Application' },
		'react-native-qrcode-svg': { __esModule: true, default: 'QrCode' },
		'react-native': {
			View: 'View',
			Text: 'Text',
			Pressable: 'Pressable',
			ScrollView: 'ScrollView',
			SafeAreaView: 'SafeAreaView',
			ActivityIndicator: 'ActivityIndicator',
			StyleSheet: { create: (x: unknown) => x, flatten },
			Platform: { OS: 'android' },
			StatusBar: 'StatusBar',
			Modal: 'Modal',
			useWindowDimensions: () => ({ width, height: 700, fontScale }),
			BackHandler: {
				exitApp() {
					exits++
				},
			},
			AppState: {
				get currentState() { return appState },
				addEventListener: (_: string, listener: (value: string) => void) => {
					listeners.add(listener)
					return { remove() { listeners.delete(listener) } }
				},
			},
		},
		'./account-test-timers': {
			Date: { now: () => now },
			setTimeout: (callback: () => void, delay: number) => {
				const id = ++timerId
				timers.set(id, { callback, delay })
				return id
			},
			clearTimeout: (id: number) => timers.delete(id),
		},
		'./account-theme': {
			accountTheme: {
				subscribe: () => () => {},
				getSnapshot: () => themeKey,
				getReadySnapshot: () => themeReady,
				restore: async () => {
					themeRestores++
				},
			},
		},
		'./account-runtime': {
			watchNativeSessionExpiry: () => () => {},
			accountSession: {
				subscribe: () => () => {},
				getSnapshot: () => state,
				restore: async () => {
					restores++
				},
				signOut: async () => {
					clears++
					state = { ...state, status: 'signed-out' }
				},
				login: async (_: string, s: AbortSignal) => {
					loginCalls++
					signal = s
				},
			},
		},
		'./account-native-fetch': {
			accountRuntimeCapabilities: () => {
				capabilities++
				return 'bridge:true Headers:true Response:true TextEncoder:true'
			},
		},
		'./account-api': {
			accountDiagnosticCode: () => 'generate-transport',
			generateLoginQr: async (s: AbortSignal) => {
				requests++
				signal = s
				return {
					key: 'synthetic',
					url: 'https://passport.bilibili.com/synthetic',
				}
			},
			pollLoginQr: () => {
				polls++
				return new Promise((resolve, reject) => {
					rejectPoll = reject
					scanned = resolve
				})
			},
		},
	}
	const f = controlFixture({ 'account-root': source }, dependencies)
	dependencies['./account-welcome'] = f.load('account-welcome')
	const module = f.load('account-root')
	const render = () =>
		f.render(f.element(module.default as ControlNode['type'], {}))
	const checkbox = () =>
		controlNodes(render()).find(
			(node) => node.props.accessibilityRole === 'checkbox',
		)!
	const generate = () =>
		controlNodes(render()).find(
			(node) => node.props.testID === 'account-login-generate',
		)!
	return {
		f,
		render,
		checkbox,
		generate,
		openDiagnostics: () => {
			const node = controlNodes(render()).find(
				(item) => item.props.testID === 'account-diagnostic-disclosure',
			)!
			;(node.props.onPress as () => void)()
		},
		openNotice: () => {
			const node = controlNodes(render()).find(
				(item) => item.props.testID === 'account-usage-disclosure',
			)!
			;(node.props.onPress as () => void)()
		},
		capabilities: () => capabilities,
		restores: () => restores,
		clears: () => clears,
		exits: () => exits,
		themeRestores: () => themeRestores,
		setTheme: (key: ThemeKey) => {
			themeKey = key
		},
		setThemeReady: (ready: boolean) => { themeReady = ready },
		setAppearance: (mode: 'light' | 'dark', ready = true) => { appearanceMode = mode; appearanceReady = ready },
		setWidth: (next: number, scale = 1) => {
			width = next
			fontScale = scale
		},
		rejectPoll: () => rejectPoll?.(new Error('PRIVATE-URL-COOKIE')),
		requests: () => requests,
		logins: () => loginCalls,
		signal: () => signal,
		respond: () => scanned?.({ status: 'success', cookie: 'synthetic-only' }),
		respondPending: () => scanned?.({ status: 'waiting' }),
		respondExpired: () => scanned?.({ status: 'expired' }),
		background: () => changeAppState('background'),
		inactive: () => changeAppState('inactive'),
		foreground: () => changeAppState('active'),
		polls: () => polls,
		advanceClock: (milliseconds: number) => { now += milliseconds },
		runTimer: (delay: number) => {
			const entry = [...timers].find(([, value]) => value.delay === delay)
			assert.ok(entry, `missing ${delay}ms timer`)
			timers.delete(entry[0])
			entry[1].callback()
		},
		listenerCount: () => listeners.size,
		setState: (next: AccountSnapshot) => {
			state = next
		},
	}
}
void test('delayed theme preference never shows a default welcome before the saved appearance is known', () => {
	const f = fixture()
	try {
		f.setThemeReady(false)
		let nodes = controlNodes(f.render())
		assert.ok(nodes.some((n) => n.props.testID === 'app-startup'))
		assert.ok(!nodes.some((n) => n.props.testID === 'account-login-generate' || n.type === 'Application'))
		f.setTheme('anime')
		f.setThemeReady(true)
		nodes = controlNodes(f.render())
		assert.ok(!nodes.some((n) => n.props.testID === 'app-startup'))
		assert.ok(nodes.some((n) => n.props.testID === 'account-login-generate'))
	} finally { f.f.unmount() }
})
void test('appearance restores before showing login, dark login uses black surfaces and white status icons, QR stays scannable', async () => {
	const f = fixture()
	try {
		f.setAppearance('light', false)
		let nodes = controlNodes(f.render())
		assert.ok(!nodes.some((n) => n.props.testID === 'account-login-generate'))
		assert.equal(nodes.find((n) => n.type === 'StatusBar')?.props.backgroundColor, '#000000')
		f.setAppearance('dark')
		nodes = controlNodes(f.render())
		assert.ok(nodes.filter((n) => n.type === 'StatusBar').every((n) => n.props.barStyle === 'light-content'))
		assert.equal(nodes.find((n) => n.type === 'StatusBar')?.props.backgroundColor, '#000000')
		assert.equal(f.requests(), 0)
		;(f.checkbox().props.onPress as () => void)()
		;(f.generate().props.onPress as () => void)()
		await tick()
		assert.equal(controlNodes(f.render()).find((n) => n.type === 'QrCode')?.props.backgroundColor, '#FFFFFF')
	} finally { f.f.unmount() }
})

void test('gate blocks child and QR generation until consent; revocation aborts late success', async () => {
	const f = fixture()
	assert.ok(
		!controlNodes(f.render()).some((node) => node.type === 'Application'),
	)
	assert.equal(f.generate().props.disabled, true)
	assert.equal(f.requests(), 0)
	;(f.checkbox().props.onPress as () => void)()
	assert.equal(f.generate().props.disabled, false)
	;(f.generate().props.onPress as () => void)()
	await tick()
	assert.equal(f.requests(), 1)
	assert.ok(controlNodes(f.render()).some((node) => node.type === 'QrCode'))
	;(f.checkbox().props.onPress as () => void)()
	assert.equal(f.signal()?.aborted, true)
	f.respond()
	await tick()
	assert.equal(f.logins(), 0)
	assert.ok(!controlNodes(f.render()).some((node) => node.type === 'QrCode'))
	f.f.unmount()
})
void test('same-phone scan keeps the QR and accepts confirmation only after foreground return', async () => {
	const f = fixture()
	try {
		f.render()
		;(f.checkbox().props.onPress as () => void)()
		;(f.generate().props.onPress as () => void)()
		await tick()
		const original = controlNodes(f.render()).find((node) => node.type === 'QrCode')!.props.value
		f.inactive()
		f.background()
		f.respond()
		await tick()
		assert.equal(f.signal()?.aborted, false)
		assert.equal(controlNodes(f.render()).find((node) => node.type === 'QrCode')?.props.value, original)
		assert.equal(f.logins(), 0, 'do not activate a session while backgrounded')
		f.foreground()
		await tick()
		assert.equal(f.logins(), 1)
		assert.equal(f.requests(), 1, 'return must use the original QR, not generate another')
	} finally {
		f.f.unmount()
		assert.equal(f.listenerCount(), 0)
	}
})

void test('explicit cancellation clears scan feedback and a stopped poll never reports expiry', async () => {
	const f = fixture()
	try {
		f.render()
		;(f.checkbox().props.onPress as () => void)()
		;(f.generate().props.onPress as () => void)()
		await tick()
		f.respondPending()
		await tick()
		const cancel = controlNodes(f.render()).find(
			(node) => node.props.testID === 'account-login-cancel',
		)!
		;(cancel.props.onPress as () => void)()
		await tick()
		const tree = JSON.stringify(f.render())
		assert.ok(
			!tree.includes('二维码已过期'),
			'stopped waiting is cancellation, not an expired QR',
		)
		assert.ok(
			!tree.includes('请使用 B 站 App 扫码'),
			'cancelled feedback must not ask for an obsolete scan',
		)
		assert.equal(f.signal()?.aborted, true)
		assert.equal(f.logins(), 0)
	} finally {
		f.f.unmount()
	}
})
void test('background pauses waiting queries and foreground resumes the same QR', async () => {
	const f = fixture()
	try {
		f.render()
		;(f.checkbox().props.onPress as () => void)()
		;(f.generate().props.onPress as () => void)()
		await tick()
		f.respondPending()
		await tick()
		f.background()
		f.runTimer(2000)
		await tick()
		const tree = JSON.stringify(f.render())
		assert.ok(!tree.includes('二维码已过期'))
		assert.ok(controlNodes(f.render()).some((node) => node.type === 'QrCode'))
		assert.equal(f.signal()?.aborted, false)
		assert.equal(f.polls(), 1, 'do not start a fresh query while backgrounded')
		assert.equal(f.logins(), 0)
		f.foreground()
		await tick()
		assert.equal(f.polls(), 2)
		assert.equal(f.requests(), 1)
		f.respond()
		await tick()
		assert.equal(f.logins(), 1)
	} finally {
		f.f.unmount()
	}
})

void test('a query interrupted in the background is retried on return without replacing the QR', async () => {
	const f = fixture()
	try {
		f.render()
		;(f.checkbox().props.onPress as () => void)()
		;(f.generate().props.onPress as () => void)()
		await tick()
		f.background()
		f.rejectPoll()
		await tick()
		assert.equal(f.polls(), 1)
		assert.ok(controlNodes(f.render()).some((node) => node.type === 'QrCode'))
		f.foreground()
		await tick()
		assert.equal(f.polls(), 2)
		assert.equal(f.requests(), 1)
		f.respond()
		await tick()
		assert.equal(f.logins(), 1)
	} finally { f.f.unmount() }
})

void test('a stale waiting response after foreground return is refreshed without another polling delay', async () => {
	const f = fixture()
	try {
		f.render()
		;(f.checkbox().props.onPress as () => void)()
		;(f.generate().props.onPress as () => void)()
		await tick()
		f.background()
		f.respondPending()
		await tick()
		f.foreground()
		await tick()
		assert.equal(f.polls(), 2)
		assert.equal(f.requests(), 1)
		f.respondExpired()
		await tick()
		assert.ok(JSON.stringify(f.render()).includes('二维码已过期'))
		assert.ok(!controlNodes(f.render()).some((node) => node.type === 'QrCode'))
		assert.equal(f.logins(), 0)
	} finally { f.f.unmount() }
})

void test('explicit cancellation on return still rejects a confirmation received in the background', async () => {
	const f = fixture()
	try {
		f.render()
		;(f.checkbox().props.onPress as () => void)()
		;(f.generate().props.onPress as () => void)()
		await tick()
		f.background()
		f.respond()
		await tick()
		f.foreground()
		const cancel = controlNodes(f.render()).find((node) => node.props.testID === 'account-login-cancel')!
		;(cancel.props.onPress as () => void)()
		await tick()
		assert.equal(f.logins(), 0)
		assert.equal(f.signal()?.aborted, true)
		assert.ok(!controlNodes(f.render()).some((node) => node.type === 'QrCode'))
	} finally { f.f.unmount() }
})

void test('expiry clears a background QR even when the current query ignores abort', async () => {
	const f = fixture()
	try {
		f.render()
		;(f.checkbox().props.onPress as () => void)()
		;(f.generate().props.onPress as () => void)()
		await tick()
		f.background()
		f.runTimer(180000)
		assert.equal(f.signal()?.aborted, true)
		assert.ok(!controlNodes(f.render()).some((node) => node.type === 'QrCode'))
		assert.ok(JSON.stringify(f.render()).includes('二维码已过期'))
		assert.equal(f.generate().props.disabled, false)
		f.respond()
		f.foreground()
		await tick()
		assert.equal(f.logins(), 0)
	} finally { f.f.unmount() }
})

void test('wall-clock expiry on return rejects confirmation when Android has suspended timers', async () => {
	const f = fixture()
	try {
		f.render()
		;(f.checkbox().props.onPress as () => void)()
		;(f.generate().props.onPress as () => void)()
		await tick()
		f.background()
		f.respond()
		await tick()
		f.advanceClock(180001)
		f.foreground()
		await tick()
		assert.equal(f.logins(), 0)
		assert.equal(f.signal()?.aborted, true)
		assert.ok(JSON.stringify(f.render()).includes('二维码已过期'))
		assert.ok(!controlNodes(f.render()).some((node) => node.type === 'QrCode'))
	} finally { f.f.unmount() }
})

void test('unmount during a background confirmation removes listeners and discards the result', async () => {
	const f = fixture()
	f.render()
	;(f.checkbox().props.onPress as () => void)()
	;(f.generate().props.onPress as () => void)()
	await tick()
	f.background()
	f.respond()
	await tick()
	f.f.unmount()
	await tick()
	assert.equal(f.listenerCount(), 0)
	f.foreground()
	await tick()
	assert.equal(f.logins(), 0)
})
void test('verified and approved offline states mount app, checking and error do not', () => {
	const f = fixture()
	for (const status of [
		'checking',
		'error',
		'signed-out',
		'authenticated',
		'offline',
	] as const) {
		f.setState({
			status,
			generation: 1,
			account: status === 'authenticated' ? { mid: '1', name: '合成' } : null,
			error: null,
			reason: null,
		})
		assert.equal(
			controlNodes(f.render()).some((node) => node.type === 'Application'),
			status === 'authenticated' || status === 'offline',
		)
	}
	f.f.unmount()
})

void test('first poll failure clears QR but identifies poll rather than generate, without raw error', async () => {
	const f = fixture()
	f.render()
	;(f.checkbox().props.onPress as () => void)()
	;(f.generate().props.onPress as () => void)()
	await tick()
	f.rejectPoll()
	await tick()
	const visibleText = () => JSON.stringify(controlNodes(f.render()).filter((node) => node.type === 'Text').map((node) => node.children))
	assert.ok(!visibleText().includes('poll-failed'))
	f.openDiagnostics()
	const tree = visibleText()
	assert.ok(tree.includes('poll-failed'))
	assert.ok(!tree.includes('PRIVATE'))
	assert.ok(!controlNodes(f.render()).some((node) => node.type === 'QrCode'))
	f.f.unmount()
})
void test('QR renderer failure cancels polling and shows only fixed diagnostic', async () => {
	const f = fixture()
	f.render()
	;(f.checkbox().props.onPress as () => void)()
	;(f.generate().props.onPress as () => void)()
	await tick()
	const qr = controlNodes(f.render()).find((node) => node.type === 'QrCode')!
	;(qr.props.onError as (e: unknown) => void)(new Error('PRIVATE-URL-COOKIE'))
	assert.equal(
		f.signal()?.aborted,
		false,
		'QR failure state update stays deferred',
	)
	await tick()
	f.respond()
	await tick()
	f.openDiagnostics()
	const tree = JSON.stringify(f.render())
	assert.ok(tree.includes('qr-render-failed'))
	assert.ok(!tree.includes('PRIVATE'))
	assert.equal(f.signal()?.aborted, true)
	assert.equal(f.logins(), 0)
	f.f.unmount()
})

void test('welcome disclosures include free use and contact terms and never consent or generate by themselves', () => {
	const f = fixture()
	try {
		let tree = f.render()
		assert.equal(f.generate().props.disabled, true)
		assert.equal(
			(f.checkbox().props.accessibilityState as { checked: boolean }).checked,
			false,
		)
		assert.equal(f.capabilities(), 0)
		assert.ok(
			!controlNodes(tree).some(
				(node) =>
					node.props.testID === 'account-usage-notice' ||
					node.props.testID === 'account-connection-diagnostic',
			),
		)
		;(f.generate().props.onPress as () => void)()
		assert.equal(
			f.requests(),
			0,
			'disabled generation callback must not submit',
		)
		f.openNotice()
		tree = f.render()
		const notice = controlNodes(tree).find(
			(node) => node.props.testID === 'account-usage-notice',
		)!
		assert.ok(notice)
		for (const paragraph of [
			'音绘是非官方 B 站音乐客户端，与哔哩哔哩官方无隶属关系。使用前需要登录 B 站账号。',
			'账号会话用于连接 B 站服务，保存在本应用的系统安全存储中，不放入音乐备份。不读取你浏览器的登录资料，也不要求输入 B 站密码。',
			'内容和字幕可能受账号权限、平台限制或接口变化影响。登录不代表取得下载、转载或公开分发许可；本说明不免除开发者应承担的责任。',
			'当前为 0.19.4 Build 35 公开 Beta，功能及兼容性仍需测试',
			'免费提供，不收取下载、登录或功能使用费用',
			'lxiaodong681@gmail.com',
		])
			assert.ok(JSON.stringify(notice).includes(paragraph), paragraph)
		f.openDiagnostics()
		tree = f.render()
		assert.ok(
			controlNodes(tree).some(
				(node) => node.props.testID === 'account-connection-diagnostic',
			),
		)
		assert.ok(f.capabilities() > 0)
		assert.equal(f.requests(), 0)
		assert.equal(f.logins(), 0)
		assert.equal(
			(f.checkbox().props.accessibilityState as { checked: boolean }).checked,
			false,
		)
		assert.equal(f.generate().props.disabled, true)
	} finally {
		f.f.unmount()
	}
})

void test('welcome QR keeps a white scan surface, fits narrow widths and preserves explicit cancel at large text', async () => {
	const f = fixture()
	try {
		f.render()
		;(f.checkbox().props.onPress as () => void)()
		;(f.generate().props.onPress as () => void)()
		await tick()
		for (const width of [240, 320, 560]) {
			f.setWidth(width, 2)
			const tree = f.render()
			assert.ok(
				controlNodes(tree).some(
					(node) => node.props.testID === 'account-welcome-scroll',
				),
			)
			const qr = controlNodes(tree).find((node) => node.type === 'QrCode')!
			assert.ok(qr)
			assert.equal(qr.props.backgroundColor, '#FFFFFF')
			const size = qr.props.size as number
			const padding = Math.min(24, Math.max(12, width * 0.06))
			assert.ok(size > 0 && size <= 220)
			assert.ok(size + 60 + padding * 2 <= width)
			const surface = controlNodes(tree).find(
				(node) => node.props.testID === 'account-login-qr',
			)!
			assert.equal(f.f.flatten(surface.props.style).backgroundColor, '#FFFFFF')
			for (const node of controlNodes(tree).filter(
				(item) => item.type === 'Pressable',
			)) {
				const styles = f.f.flatten(
					typeof node.props.style === 'function'
						? (node.props.style as (state: unknown) => unknown)({
								pressed: false,
							})
						: node.props.style,
				)
				assert.ok(Number(styles.minHeight) >= 48)
				assert.equal(
					styles.height,
					undefined,
					'large text may grow the touch target',
				)
			}
			assert.ok(
				controlNodes(tree)
					.filter((node) => node.type === 'Text')
					.every((node) => node.props.numberOfLines == null),
			)
			assert.equal(f.generate().props.disabled, true)
		}
		const before = f.requests()
		const content = controlNodes(f.render()).find(
			(node) => node.props.testID === 'account-welcome-content',
		)!
		;(content.props.onLayout as (event: unknown) => void)({
			nativeEvent: { layout: { width: 180 } },
		})
		const measuredQr = controlNodes(f.render()).find(
			(node) => node.type === 'QrCode',
		)!
		assert.ok(
			Number(measuredQr.props.size) + 60 <= 180,
			'QR uses actual safe-area content width',
		)
		;(f.generate().props.onPress as () => void)()
		assert.equal(f.requests(), before)
		const cancel = controlNodes(f.render()).find(
			(node) => node.props.testID === 'account-login-cancel',
		)!
		;(cancel.props.onPress as () => void)()
		assert.equal(f.signal()?.aborted, true)
		f.respond()
		await tick()
		assert.equal(f.logins(), 0)
		assert.ok(!controlNodes(f.render()).some((node) => node.type === 'QrCode'))
	} finally {
		f.f.unmount()
	}
})

void test('welcome checking, recovery, clearing and exit retain the account gate callbacks', async () => {
	const f = fixture()
	try {
		f.setState({
			status: 'checking',
			generation: 1,
			account: null,
			error: null,
			reason: null,
		})
		let tree = f.render()
		assert.ok(
			controlNodes(tree).some(
				(node) => node.props.accessibilityLabel === '正在验证账号',
			),
		)
		assert.ok(
			!controlNodes(tree).some(
				(node) =>
					node.props.testID === 'account-login-generate' ||
					node.type === 'Application',
			),
		)
		f.setState({
			status: 'error',
			generation: 2,
			account: null,
			error: '合成验证失败',
			reason: null,
		})
		tree = f.render()
		assert.ok(JSON.stringify(tree).includes('合成验证失败'))
		const before = f.restores()
		const retry = controlNodes(tree).find(
			(node) => node.props.testID === 'account-login-retry',
		)!
		;(retry.props.onPress as () => void)()
		await tick()
		assert.equal(f.restores(), before + 1)
		const clear = controlNodes(f.render()).find(
			(node) => node.props.testID === 'account-login-clear',
		)!
		;(clear.props.onPress as () => void)()
		await tick()
		assert.equal(f.clears(), 0)
		let confirmation = controlNodes(f.render()).find((node) => node.type === 'Modal' && node.props.visible === true)!
		assert.ok(confirmation)
		;(confirmation.props.onRequestClose as () => void)()
		assert.equal(f.clears(), 0)
		;(clear.props.onPress as () => void)()
		confirmation = controlNodes(f.render()).find((node) => node.type === 'Modal' && node.props.visible === true)!
		const confirm = controlNodes(confirmation).find((node) => node.type === 'Pressable' && JSON.stringify(node.children).includes('确认清除登录状态'))!
		assert.ok(confirm)
		;(confirm.props.onPress as () => void)()
		await tick()
		assert.equal(f.clears(), 1)
		const exit = controlNodes(f.render()).find(
			(node) => node.props.testID === 'account-login-exit',
		)!
		;(exit.props.onPress as () => void)()
		assert.equal(f.exits(), 1)
		assert.equal(f.requests(), 0)
		assert.equal(f.logins(), 0)
	} finally {
		f.f.unmount()
	}
})

void test('login appearance follows only the builtin key without mounting the app or implying consent', () => {
	const f = fixture()
	try {
		for (const key of ['modern', 'pastoral', 'anime'] as const) {
			f.setTheme(key)
			f.setWidth(320, 1.4)
			const tree = f.render()
			const nodes = controlNodes(tree)
			const screen = nodes.find((node) => node.type === 'SafeAreaView')!
			assert.equal(
				f.f.flatten(screen.props.style).backgroundColor,
				builtInThemes[key].tokens.surface.base,
			)
			const art = nodes.find(
				(node) => node.props.testID === `account-welcome-art-${key}`,
			)!
			assert.ok(art, 'the real native art tree must match this theme')
			assert.equal(art.props.pointerEvents, 'none')
			assert.equal(art.props.importantForAccessibility, 'no-hide-descendants')
			assert.ok(!nodes.some((node) => node.type === 'Application'))
			assert.equal(f.generate().props.disabled, true)
			assert.equal(
				(f.checkbox().props.accessibilityState as { checked: boolean }).checked,
				false,
			)
		}
		assert.equal(f.themeRestores(), 1)
		assert.equal(f.requests(), 0)
		assert.equal(f.logins(), 0)
	} finally {
		f.f.unmount()
	}
})

void test('all login themes keep the real QR white and remove welcome artwork while cancellation still aborts', async () => {
	for (const key of ['modern', 'pastoral', 'anime'] as const) {
		const f = fixture()
		try {
			f.setTheme(key)
			f.render()
			;(f.checkbox().props.onPress as () => void)()
			;(f.generate().props.onPress as () => void)()
			await tick()
			const nodes = controlNodes(f.render())
			assert.ok(
				!nodes.some((node) =>
					String(node.props.testID).startsWith('account-welcome-art-'),
				),
			)
			const qr = nodes.find((node) => node.type === 'QrCode')!
			assert.ok(qr)
			assert.equal(qr.props.color, '#111111')
			assert.equal(qr.props.backgroundColor, '#FFFFFF')
			assert.equal(f.requests(), 1)
			const cancel = nodes.find(
				(node) => node.props.testID === 'account-login-cancel',
			)!
			;(cancel.props.onPress as () => void)()
			f.respond()
			await tick()
			assert.equal(f.signal()?.aborted, true)
			assert.equal(f.logins(), 0)
			assert.ok(
				!controlNodes(f.render()).some((node) => node.type === 'QrCode'),
			)
		} finally {
			f.f.unmount()
		}
	}
})
