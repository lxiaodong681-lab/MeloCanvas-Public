import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type * as Notifications from '../playback-notifications'

function fixture(enabled = false) {
	const data = new Map<string, string>(), prompts: { text: string; buttons: { onPress?: () => void }[] }[] = []
	let requests = 0, settings = 0, permission = false, result = 'granted', failIntent = false
	const intents: { action: string; extras: unknown }[] = []
	const output = {} as typeof Notifications
	runInNewContext(ts.transpileModule(readFileSync(new URL('../playback-notifications.ts', import.meta.url), 'utf8'), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText, { exports: output, require(name: string) {
		if (name === '@bbplayer/orpheus') return { Orpheus: { areNotificationsEnabled: () => enabled } }
		if (name === 'react-native') return {
			Platform: { OS: 'android', Version: 35 },
			Alert: { alert: (title: string, text: string, buttons: { onPress?: () => void }[]) => prompts.push({ text: title + text, buttons }) },
			Linking: { sendIntent: async (action: string, extras: unknown) => {
				intents.push({ action, extras }); settings++
				if (failIntent) throw new Error('settings intent unavailable')
			}, openSettings: async () => { settings++ } },
			PermissionsAndroid: {
				PERMISSIONS: { POST_NOTIFICATIONS: 'notifications' }, RESULTS: { GRANTED: 'granted', NEVER_ASK_AGAIN: 'never' },
				check: async () => permission,
				request: async () => { requests++; if (result === 'granted') enabled = true; return result },
			},
		}
		throw Error(name)
	} })
	return { output, prompts, intents, failIntent: () => { failIntent = true }, counts: () => ({ requests, settings }), library: {
		setting: (key: string) => data.get(key) ?? null,
		setSetting: (key: string, value: string) => { data.set(key, value) },
	}, deny: () => { result = 'denied' }, blockedChannel: () => { permission = true } }
}

void test('first launch explains media controls once and requests permission only after choosing enable', async () => {
	const f = fixture(); let status = false
	f.output.explainPlaybackNotifications(f.library, value => { status = value })
	assert.equal(f.prompts.length, 1)
	assert.match(f.prompts[0].text, /通知栏上方.*暂停和切歌/)
	assert.deepEqual(f.counts(), { requests: 0, settings: 0 })
	f.prompts[0].buttons[1].onPress!()
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(status, true)
	assert.deepEqual(f.counts(), { requests: 1, settings: 0 })
	f.output.explainPlaybackNotifications(f.library, () => {})
	assert.equal(f.prompts.length, 1)
})

void test('denial is not followed by a forced settings jump or a repeat prompt', async () => {
	const f = fixture(); f.deny()
	f.output.explainPlaybackNotifications(f.library, () => {})
	assert.equal(await f.output.enablePlaybackNotifications(), false)
	assert.deepEqual(f.counts(), { requests: 1, settings: 0 })
	f.output.explainPlaybackNotifications(f.library, () => {})
	assert.equal(f.prompts.length, 1)
	const channel = fixture(); channel.blockedChannel()
	await channel.output.enablePlaybackNotifications()
	assert.deepEqual(channel.counts(), { requests: 0, settings: 1 })
})

void test('enabled notifications still get a one-time lock-screen explanation without requesting permission again', async () => {
	const f = fixture(true)
	f.output.explainPlaybackNotifications(f.library, () => {})
	assert.equal(f.prompts.length, 1)
	assert.match(f.prompts[0].text, /通知已允许不代表锁屏显示已开启/)
	assert.match(f.prompts[0].text, /iQOO.*vivo/)
	assert.deepEqual(f.counts(), { requests: 0, settings: 0 })
	f.prompts[0].buttons[1].onPress!()
	await new Promise(resolve => setImmediate(resolve))
	assert.deepEqual(f.counts(), { requests: 0, settings: 1 })
	assert.equal(f.intents[0].action, 'android.settings.APP_NOTIFICATION_SETTINGS')
	assert.equal(JSON.stringify(f.intents[0].extras), JSON.stringify([
		{ key: 'android.provider.extra.APP_PACKAGE', value: 'org.melocanvas.app' },
	]))
	f.output.explainPlaybackNotifications(f.library, () => {})
	assert.equal(f.prompts.length, 1)
})

void test('lock-screen help remains available after onboarding and falls back to app settings', async () => {
	const f = fixture(true)
	f.library.setSetting('playbackNotificationExplained', 'true')
	f.output.showPlaybackNotificationHelp()
	assert.equal(f.prompts.length, 1)
	assert.match(f.prompts[0].text, /锁屏通知.*锁屏显示/)
	assert.match(f.prompts[0].text, /歌曲信息/)
	assert.deepEqual(f.counts(), { requests: 0, settings: 0 })
	f.failIntent()
	f.prompts[0].buttons[1].onPress!()
	await new Promise(resolve => setImmediate(resolve))
	assert.deepEqual(f.counts(), { requests: 0, settings: 2 })
})
