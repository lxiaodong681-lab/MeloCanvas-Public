import { Orpheus, type PlaybackNetworkPolicy } from '@bbplayer/orpheus'
import { useEffect, useState } from 'react'
import { AppState, Switch, View } from 'react-native'

import { Button, T, useTheme } from './ui'

/** Native policy owns background playback too; JS only displays and changes the saved preference. */
export function PlaybackNetworkSetting() {
	const colors = useTheme().tokens
	const [state, setState] = useState<PlaybackNetworkPolicy | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	async function refresh() {
		try {
			setState(await Orpheus.getPlaybackNetworkPolicy())
			setError('')
		} catch {
			setError('暂时无法读取播放网络设置，请重试。')
		}
	}
	useEffect(() => {
		void refresh()
		const network = Orpheus.addListener(
			'onPlaybackNetworkPolicyChanged',
			setState,
		)
		const app = AppState.addEventListener('change', (value) => {
			if (value === 'active') void refresh()
		})
		return () => {
			network.remove()
			app.remove()
		}
	}, [])
	async function change(enabled: boolean) {
		setBusy(true)
		try {
			setState(await Orpheus.setWifiOnlyPlayback(enabled))
			setError('')
		} catch {
			setError('设置未能保存，请重试。')
		} finally {
			setBusy(false)
		}
	}
	return (
		<View style={{ paddingVertical: 12, gap: 12 }}>
			<View
				style={{
					flexDirection: 'row',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: 12,
				}}
			>
				<T style={{ flex: 1 }}>仅 Wi-Fi 播放</T>
				<Switch
					trackColor={{
						true: colors.action.primary,
						false: colors.border.strong,
					}}
					accessibilityLabel='仅 Wi-Fi 播放'
					disabled={busy || !state}
					value={state?.enabled ?? false}
					onValueChange={(value) => {
						void change(value)
					}}
				/>
			</View>
			<T
				muted
				size={12}
			>
				{!state
					? '正在读取播放网络设置…'
					: state.blocked
						? state.networkReason === 'unverified'
							? '无法确认当前网络或 VPN 的底层连接为 Wi-Fi，在线音频暂受限。确认 Wi-Fi 后请手动重试。'
							: '当前不是已确认的纯 Wi-Fi 连接，在线音频已受限。连接 Wi-Fi 后请手动点播放，不会自动恢复。'
						: state?.enabled
							? '已开启。离开 Wi-Fi 时停止在线加载；恢复后由你手动播放。'
							: '未开启，在线播放可能使用移动数据。'}
			</T>
			<T
				muted
				size={11}
			>
				本地导入与已验证完整缓存不受限；部分缓存不算离线音频。此开关不限制搜索、封面或手动下载。
			</T>
			{!!error && <T>{error}</T>}
			{(!!error || state?.blocked) && (
				<Button
					secondary
					onPress={() => {
						void refresh()
					}}
				>
					重新检查网络
				</Button>
			)}
		</View>
	)
}
