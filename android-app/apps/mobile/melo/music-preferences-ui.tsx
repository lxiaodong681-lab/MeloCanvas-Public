import { Image } from 'expo-image'
import React, { useEffect, useState, useSyncExternalStore } from 'react'
import {
	KeyboardAvoidingView,
	Modal,
	Platform,
	ScrollView,
	TextInput,
	View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { search } from './bilibili'
import type { SearchItem } from './core/model'
import {
	parseMusicPreferences,
	preferenceSeeds,
	type MusicPreferences,
	type MusicPreferencesStore,
} from './core/music-preferences'
import { PreferenceDiscoverySession } from './preference-discovery-session'
import { PageHeader } from './settings-layout'
import { Button, Card, ControlTarget, T, useTheme } from './ui'

const genres = [
	'流行',
	'摇滚',
	'民谣',
	'电子',
	'爵士',
	'古典',
	'国风',
	'动漫音乐',
]
const detailedGenres = [...genres, '嘻哈', 'R&B', '灵魂乐', '放克', '布鲁斯', '金属', '朋克', '独立音乐', '后摇', '乡村', '拉丁', '雷鬼', '世界音乐', '轻音乐', '纯音乐', '氛围音乐', '游戏音乐', '影视原声', '音乐剧', 'VOCALOID', '华语流行', '日语流行', '韩语流行', '粤语流行']
export function MusicPreferencesDialog({
	store,
	initial,
	firstRun,
	onClose,
	onSaved,
	onSearch,
	onImport,
}: {
	store: MusicPreferencesStore
	initial: MusicPreferences
	firstRun: boolean
	onClose: () => void
	onSaved: (value: MusicPreferences) => void
	onSearch: () => void
	onImport: () => void
}) {
	const theme = useTheme()
	const insets = useSafeAreaInsets()
	const c = theme.tokens
	const [step, setStep] = useState(firstRun ? 0 : 1)
	const [selected, setSelected] = useState(initial.genres)
	const [artistText, setArtistText] = useState(initial.artists.join('、'))
	const [error, setError] = useState('')
	function finish(destination?: () => void, skip = false) {
		try {
			// Do not replace an unreadable existing record, including one changed after opening.
			const previous = store.load()
			const next = parseMusicPreferences(
				JSON.stringify({
					version: 1,
					welcomeCompleted: true,
					genres: skip ? previous.genres : selected,
					artists: skip
						? previous.artists
						: [
								...new Set(
									artistText
										.split(/[、，,\n]/)
										.map((v) => v.trim())
										.filter(Boolean),
								),
							],
				}),
			)
			store.save(next, initial)
			onSaved(next)
			onClose()
			destination?.()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : '偏好保存失败，请重试')
		}
	}
	return (
		<Modal
			visible
			animationType='none'
			onRequestClose={() => (firstRun ? finish(undefined, true) : onClose())}
		>
			<KeyboardAvoidingView
				behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
				style={{
					flex: 1,
					backgroundColor: c.surface.base,
					paddingTop: Math.max(insets.top, 24),
					paddingBottom: Math.max(insets.bottom, 16),
				}}
			>
				<PageHeader title={step === 2 ? '导入已有歌单' : '音乐偏好'} onBack={() => firstRun ? finish(undefined, true) : onClose()} />
				<ScrollView
					style={{ flex: 1 }}
					contentContainerStyle={{ padding: 20, gap: 18 }}
					keyboardShouldPersistTaps='handled'
				>
					{step === 0 ? (
						<>
							<T muted>偏好可以稍后设置，先找一首喜欢的歌。</T>
							<Button onPress={() => setStep(1)}>选一点音乐偏好</Button>
							<Button
								secondary
								onPress={() => finish(onSearch, true)}
							>
								我想先搜一首歌
							</Button>
						</>
					) : step === 1 ? (
						<>
							<T muted>
								最多选择 8 种曲风，也可以填上喜欢的歌手。偏好只保存在本机，点击“查找推荐”后才会搜索。
							</T>
							<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
								{[...new Set([...(firstRun ? genres : detailedGenres), ...initial.genres])].map((genre) => (
									<ControlTarget
										key={genre} fixedWidth minimumWidthDp={Math.max(64, genre.length * 14 + 28)} accessibilityRole='checkbox' accessibilityLabel={genre} accessibilityState={{ checked: selected.includes(genre) }}
										style={{ minHeight: 48, borderRadius: 12, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: selected.includes(genre) ? c.action.primary : c.border.subtle, backgroundColor: selected.includes(genre) ? c.surface.tinted : c.surface.card }}
										onPress={() => {
											if (!selected.includes(genre) && selected.length >= 8) { setError('最多选择 8 种曲风，请先取消一项'); return }
											setError('')
											setSelected((current) =>
												current.includes(genre)
													? current.filter((v) => v !== genre)
													: [...current, genre],
											)
										}}
									>
										<T size={13} weight={selected.includes(genre) ? '700' : '400'} style={{ color: selected.includes(genre) ? c.action.primary : c.text.primary }}>{genre}</T>
									</ControlTarget>
								))}
							</View>
							<T weight='600'>喜欢的歌手（可选）</T>
							<TextInput
								accessibilityLabel='喜欢的歌手，用逗号分隔，最多八个'
								value={artistText}
								onChangeText={setArtistText}
								maxLength={488}
								placeholder='输入歌手名，用逗号分隔'
								placeholderTextColor={c.text.secondary}
								selectionColor={c.action.primary}
								cursorColor={c.action.primary}
								multiline
								style={{
									minHeight: 80,
									padding: 14,
									color: c.text.primary,
									backgroundColor: c.surface.card,
									borderRadius: 16,
								}}
							/>
							<T
								muted
								size={12}
							>
								最多填写 8 位，用逗号分隔。搜索结果也可能包含翻唱或相关作品。
							</T>

						</>
					) : (
						<>
							<T muted>
								导入已有歌单并自动匹配音源，也可以稍后从音乐库导入。
							</T>
							<Button onPress={() => finish(onImport)}>保存偏好并去导入</Button>
							<Button
								secondary
								onPress={() => finish()}
							>
								保存偏好，开始探索
							</Button>
						</>
					)}
					{!!error && (
						<>
							<T>{error}</T>
							<Button
								secondary
								onPress={onClose}
							>
								暂不保存，返回
							</Button>
						</>
					)}

				</ScrollView>
				<View style={{ paddingHorizontal: 20, paddingVertical: 12, gap: 8, backgroundColor: c.surface.card, borderTopWidth: 1, borderTopColor: c.border.subtle }}>
					{step === 1 && <Button onPress={() => firstRun ? setStep(2) : finish()}>{firstRun ? '继续' : '保存偏好'}</Button>}
					<ControlTarget accessibilityRole='button' accessibilityLabel={firstRun ? '暂时跳过，进入发现' : '取消'} onPress={() => firstRun ? finish(undefined, true) : onClose()} style={{ minHeight: 48, alignItems: 'center', justifyContent: 'center' }}><T size={13} style={{ color: c.action.primary }}>{firstRun ? '暂时跳过，进入发现' : '取消'}</T></ControlTarget>
				</View>
			</KeyboardAvoidingView>
		</Modal>
	)
}

export function PreferenceDiscovery({
	preferences,
	onEdit,
	onPlay,
	onSearch,
}: {
	preferences: MusicPreferences
	onEdit: () => void
	onPlay: (item: SearchItem) => void
	onSearch: (seed: string) => void
}) {
	const [session] = useState(() => new PreferenceDiscoverySession(search))
	const [expanded, setExpanded] = useState(false)
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
	useEffect(() => {
		setExpanded(false)
		session.reset()
		return () => session.cancel()
	}, [session, preferences])
	const seeds = preferenceSeeds(preferences)
	return (
		<Card>
			<View style={{ gap: 12 }}>
				<T
					size={18}
					weight='700'
				>
					按偏好推荐
				</T>
				<T
					muted
					size={12}
				>
					{seeds.length
						? `本次先找：${seeds.slice(0, 3).join('、')}。按关键词轮流呈现 B 站音乐分区候选，未核验歌手身份或曲风。仅主动查找，不上传歌单或播放历史。`
						: '选一点曲风或填下喜欢的歌手，再找些新的声音。'}
				</T>
				{seeds.length > 0 && (
					<Button
						disabled={state.loading}
						onPress={() => {
							void session.load(preferences)
						}}
					>
						{state.loading
							? '正在查找推荐…'
							: state.searched
								? '刷新全部推荐'
								: '查找推荐'}
					</Button>
				)}
				{!state.loading && state.pendingSeeds.length > 0 && (
					<Button
						secondary
						onPress={() => {
							void session.retry()
						}}
					>
						{`继续查找剩余 ${state.pendingSeeds.length} 项`}
					</Button>
				)}
				{state.pendingSeeds.length > 0 && state.items.length > 0 && (
					<T
						muted
						size={12}
					>
						保留已有结果；继续只查询失败或未完成的关键词。
					</T>
				)}

				<Button
					secondary
					onPress={onEdit}
				>
					调整音乐偏好
				</Button>
				{state.loading && (
					<Button
						secondary
						onPress={session.cancel}
					>
						停止查找
					</Button>
				)}
				{!!state.error && <T>{state.error}</T>}
				{state.searched &&
					!state.loading &&
					!state.items.length &&
					!state.pendingSeeds.length &&
					!state.error && (
						<T muted>暂时没有匹配的音乐分区结果，可以换个关键词。</T>
					)}
				{state.items
					.slice(0, expanded ? 24 : 6)
					.map(({ item, hits, retrievedAt }) => (
						<ControlTarget
							key={item.bvid}
							accessibilityRole='button'
							accessibilityLabel={`播放 ${item.originalTitle}`}
							onPress={() => onPlay(item)}
							style={{
								flexDirection: 'row',
								alignItems: 'center',
								gap: 12,
								minHeight: 64,
							}}
						>
							<Image
								source={item.artwork ? { uri: item.artwork } : undefined}
								style={{ width: 48, height: 48, borderRadius: 12 }}
								contentFit='cover'
								accessibilityIgnoresInvertColors
							/>
							<View style={{ flex: 1, gap: 3 }}>
								<T
									lines={2}
									weight='600'
								>
									{item.originalTitle}
								</T>
								<T
									muted
									size={11}
									lines={2}
								>
									因关键词{hits.map(({ seed }) => `“${seed}”`).join('、')}找到 ·
									UP：{item.uploader}
								</T>
								<T
									muted
									size={11}
								>
									取得于 {new Date(retrievedAt).toLocaleString()}
								</T>
							</View>
						</ControlTarget>
					))}
				{state.items.length > 6 && (
					<Button
						secondary
						onPress={() => setExpanded(!expanded)}
					>
						{expanded ? '收起' : `查看其余 ${state.items.length - 6} 条`}
					</Button>
				)}

				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={{ gap: 8 }}
				>
					{seeds.map((seed) => (
						<Button
							key={seed}
							secondary
							onPress={() => onSearch(seed)}
						>
							继续搜「{seed}」
						</Button>
					))}
				</ScrollView>
			</View>
		</Card>
	)
}
