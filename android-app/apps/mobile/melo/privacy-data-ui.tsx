import React, { useState } from 'react'
import { Modal, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type {
	MusicPreferences,
	MusicPreferencesStore,
} from './core/music-preferences'
import { PageHeader, SettingsDetails, SettingsGroup, SettingsRow } from './settings-layout'
import { Button, Card, T, useTheme } from './ui'

/** Read-only overview. Destructive actions remain in their existing confirmation flows. */
export function PrivacyDataEntry({
	store,
	onPreferences,
	onSearchHistory,
	onRecentMusic,
	onRecommendations,
}: {
	store: Pick<MusicPreferencesStore, 'load'>
	onPreferences: () => void
	onSearchHistory: () => void
	onRecentMusic: () => void
	onRecommendations: () => void
}) {
	const c = useTheme().tokens
	const insets = useSafeAreaInsets()
	const [open, setOpen] = useState(false)
	const [preferences, setPreferences] = useState<MusicPreferences | null>(null)
	const [error, setError] = useState('')
	const read = () => {
		try {
			setPreferences(store.load())
			setError('')
		} catch {
			setPreferences(null)
			setError('音乐偏好暂时无法读取，原记录已保留。')
		}
	}
	const go = (destination: () => void) => {
		setOpen(false)
		destination()
	}
	return <>
		<SettingsRow label='隐私与本机数据' onPress={() => { read(); setOpen(true) }} />
		{open && <Modal visible animationType='none' onRequestClose={() => setOpen(false)}>
			<View style={{ flex: 1, backgroundColor: c.surface.base, paddingTop: insets.top, paddingBottom: insets.bottom }}>
				<PageHeader title='隐私与本机数据' backLabel='返回设置' onBack={() => setOpen(false)} />
				<ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
					<Card>
						<T weight='600'>音乐偏好</T>
						{preferences && <View style={{ gap: 8, marginVertical: 12 }}>
							<T size={13} muted>曲风：{preferences.genres.join('、') || '尚未选择'}</T>
							<T size={13} muted>歌手：{preferences.artists.join('、') || '尚未填写'}</T>
						</View>}
						{!!error && <><T style={{ color: c.state.error }}>{error}</T><Button secondary onPress={read}>重试读取偏好</Button></>}
						<SettingsRow label='编辑音乐偏好' onPress={() => go(onPreferences)} />
					</Card>
					<SettingsGroup title='记录管理'>
						<SettingsRow label='管理搜索历史' onPress={() => go(onSearchHistory)} />
						<SettingsRow label='管理音乐最近播放' onPress={() => go(onRecentMusic)} />
						<SettingsRow label='管理本地推荐' onPress={() => go(onRecommendations)} />
					</SettingsGroup>
					<SettingsDetails title='数据保存与联网说明'>
						<T size={13} muted>音乐偏好由你手动设置。主动找歌、继续查找、重新查找或点击关键词时，会将关键词用于 B站搜索；打开此页面不会发起搜索。</T>
						<T size={13} muted>喜欢、歌单、音乐偏好、搜索历史、导入记录、关注与听视频进度保存在本机。最近播放也保存在本机。历史清理不会删除音频文件，备份范围见设置中的“音乐库备份与恢复”。</T>
						<T size={13} muted>搜索、在线播放和读取关注内容会访问 B站；导入网易云、QQ、酷我、汽水或酷狗歌单会读取相应平台的公开目录。查找歌词会将歌名等查询信息发送给所选歌词来源。</T>
						<T size={13} muted>主动使用心动推荐时，在本机汇总歌单、喜欢和少量真实播放记录，向 B站发送最多三个歌曲或歌手关键词；不发送完整歌单、歌单名称、历史列表或本机路径。新候选需确认后才开始播放。</T>
						<T size={13} muted>本机音乐库与导入记录不上传音绘服务器。未启用上游遥测、远程更新或推荐通知。</T>
					</SettingsDetails>
				</ScrollView>
			</View>
		</Modal>}
	</>
}
