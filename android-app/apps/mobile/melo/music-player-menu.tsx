import React, { useState } from 'react'
import { Modal, Pressable, ScrollView, View } from 'react-native'

import { ControlTarget, T, useTheme } from './ui'

/** Playback stays in view; infrequent tools and provenance remain discoverable. */
export function MusicPlayerMenu({
	local,
	bvid,
	fm,
	notifications,
	bottomInset,
	onSource,
	onParts,
	onOffline,
	onTheme,
	onFm,
	onNotificationSettings,
}: {
	local: boolean
	bvid: string
	fm: boolean
	notifications: boolean
	bottomInset: number
	onSource: () => void
	onParts?: () => void
	onOffline?: () => void
	onTheme: () => void
	onFm: () => void
	onNotificationSettings: () => void
}) {
	const [open, setOpen] = useState(false)
	const theme = useTheme()
	const actions = [
		...(!local && !fm && onParts ? [{ label: '切换分 P', run: onParts }] : []),
		...(onOffline ? [{ label: '下载与离线', run: onOffline }] : []),
		...(!local ? [{ label: '查看音源信息', run: onSource }] : []),
		{ label: '切换主题', run: onTheme },
		{
			label: notifications ? '媒体通知设置' : '媒体通知不可用 · 前往设置',
			run: onNotificationSettings,
		},
		...(fm ? [{ label: '管理与退出私人 FM', run: onFm }] : []),
	]
	return (
		<>
			<ControlTarget
				fixed
				accessibilityRole='button'
				accessibilityLabel='更多播放选项'
				onPress={() => setOpen(true)}
				style={{
					minWidth: 48,
					minHeight: 48,
					alignItems: 'center',
					justifyContent: 'center',
				}}
			>
				<T size={25}>⋯</T>
			</ControlTarget>
			<Modal
				visible={open}
				transparent
				animationType='none'
				onRequestClose={() => setOpen(false)}
			>
				<View
					style={{
						flex: 1,
						justifyContent: 'flex-end',
						backgroundColor: '#00000066',
					}}
				>
					<Pressable
						accessibilityRole='button'
						accessibilityLabel='关闭播放选项'
						onPress={() => setOpen(false)}
						style={{
							position: 'absolute',
							top: 0,
							left: 0,
							right: 0,
							bottom: 0,
						}}
					/>
					<View
						accessibilityViewIsModal
						style={{
							backgroundColor: theme.tokens.surface.card,
							borderTopLeftRadius: 24,
							borderTopRightRadius: 24,
							padding: 22,
							paddingBottom: bottomInset + 16,
							maxHeight: '85%',
						}}
					>
						<T
							size={18}
							weight='600'
						>
							播放选项
						</T>
						<ScrollView
							keyboardShouldPersistTaps='handled'
							style={{ marginTop: 12 }}
						>
							{actions.map((action) => (
								<ControlTarget
									key={action.label}
									accessibilityRole='button'
									accessibilityLabel={action.label}
									onPress={() => {
										setOpen(false)
										action.run()
									}}
									style={{
										minHeight: 52,
										justifyContent: 'center',
										paddingVertical: 12,
									}}
								>
									<T>{action.label}</T>
								</ControlTarget>
							))}
							<View style={{ marginTop: 12, gap: 8, paddingVertical: 12 }}>
								<T
									muted
									size={12}
								>
									{local
										? '本地音频 · 私有副本，可离线播放。标题与艺术家来自文件信息。'
										: `Bilibili · ${bvid || '音源信息待核对'}。保留原始视频信息，UP 主不等于歌手，歌曲与录音版本尚未核对。`}
								</T>
								<T
									muted
									size={12}
								>
									喜欢仅保存在本机。
								</T>
								{!local && (
									<T
										muted
										size={12}
									>
										使用独立音轨收听；播放片段缓存不等于完整离线下载。
									</T>
								)}
							</View>
						</ScrollView>
						<ControlTarget
							accessibilityRole='button'
							accessibilityLabel='取消播放选项'
							onPress={() => setOpen(false)}
							style={{
								minHeight: 48,
								alignItems: 'center',
								justifyContent: 'center',
							}}
						>
							<T muted>取消</T>
						</ControlTarget>
					</View>
				</View>
			</Modal>
		</>
	)
}
