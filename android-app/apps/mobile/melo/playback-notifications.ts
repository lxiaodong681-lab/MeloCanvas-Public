import { Orpheus } from '@bbplayer/orpheus'
import { Alert, Linking, PermissionsAndroid, Platform } from 'react-native'

import type { Library } from './core/database'

const lockScreenHelp = '通知已允许不代表锁屏显示已开启。如果通知栏有音乐卡片、锁屏没有，请进入系统的音绘通知设置，开启“锁屏通知／锁屏显示”；若有“媒体播放”分类，也请检查该分类。iQOO、vivo 等手机可能需要单独开启。开启后歌曲信息可能在未解锁时显示，请按自己的隐私偏好选择。'

export async function openPlaybackNotificationSettings() {
	if (Platform.OS !== 'android') return Linking.openSettings()
	await Linking.sendIntent('android.settings.APP_NOTIFICATION_SETTINGS', [
		{ key: 'android.provider.extra.APP_PACKAGE', value: 'org.melocanvas.app' },
	]).catch(() => Linking.openSettings())
}

function viewNotificationSettings() {
	void openPlaybackNotificationSettings().catch(() => {
		Alert.alert('未能打开系统设置', '请在手机“设置 → 应用 → 音绘 → 通知”中查看锁屏通知。不同系统的名称可能略有不同。')
	})
}

export function showPlaybackNotificationHelp() {
	Alert.alert('锁屏没有音乐卡片？', lockScreenHelp, [
		{ text: '知道了', style: 'cancel' },
		{ text: '前往通知设置', onPress: viewNotificationSettings },
	])
}

export async function enablePlaybackNotifications(): Promise<boolean> {
	if (Platform.OS === 'android' && Platform.Version >= 33 &&
		!await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)) {
		const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
		if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) await openPlaybackNotificationSettings()
		if (result !== PermissionsAndroid.RESULTS.GRANTED) return false
	}
	if (!Orpheus.areNotificationsEnabled()) await openPlaybackNotificationSettings()
	return Orpheus.areNotificationsEnabled()
}

/** Called after the welcome screen; a refusal is respected across launches. */
export function explainPlaybackNotifications(
	library: Pick<Library, 'setting' | 'setSetting'>,
	onStatus: (enabled: boolean) => void,
) {
	if (Platform.OS !== 'android' || library.setting('playbackNotificationExplained') === 'true') return
	library.setSetting('playbackNotificationExplained', 'true')
	if (Orpheus.areNotificationsEnabled()) {
		Alert.alert('锁屏播放控制', lockScreenHelp, [
			{ text: '知道了', style: 'cancel' },
			{ text: '查看锁屏设置', onPress: viewNotificationSettings },
		], { cancelable: false })
		return
	}
	Alert.alert('开启播放通知',
		`开启后，可在通知栏上方的音乐卡片查看当前歌曲、暂停和切歌。${lockScreenHelp}`, [
			{ text: '暂不开启', style: 'cancel' },
			{ text: '开启通知', onPress: () => {
				void enablePlaybackNotifications().then(onStatus).catch(() => {
					Alert.alert('未能开启通知', '可在“设置 → 媒体通知与锁屏”中重新开启。')
				})
			} },
		], { cancelable: false })
}
