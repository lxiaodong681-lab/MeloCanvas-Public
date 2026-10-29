import { Orpheus, type DownloadTask, type Track } from '@bbplayer/orpheus'
import React, { useEffect, useState } from 'react'
import {
	KeyboardAvoidingView,
	Modal,
	Platform,
	ScrollView,
	TextInput,
	View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { PageHeader, SettingsRow } from './settings-layout'
import { CollectionMenu } from './library-collection-ui'
import { useThemeDialog } from './theme-dialog'
import {
	offlineBytes,
	offlinePhase,
	offlineLimitBytes,
	offlinePlaybackTrack,
	offlineState,
} from './offline-state'
import { Artwork, Button, Card, ControlTarget, T, useTheme } from './ui'

export function OfflineManager({
	visible,
	onClose,
	track,
	onPlay,
	bottomInset,
}: {
	visible: boolean
	onClose: () => void
	track: Track | null
	onPlay: (track: Track) => Promise<void>
	bottomInset: number
}) {
	const theme = useTheme()
	const confirmation = useThemeDialog()
	const [downloadTab, setDownloadTab] = useState<'all' | 'complete' | 'active'>(
		'all',
	)
	const insets = useSafeAreaInsets()
	const [tasks, setTasks] = useState<DownloadTask[]>([])
	const [storage, setStorage] = useState({
		usedBytes: 0,
		limitBytes: 0,
		freeBytes: 0,
	})
	const [limit, setLimit] = useState('')
	const [error, setError] = useState('')
	const [busy, setBusy] = useState(false)
	const [loading, setLoading] = useState(true)
	const [showDetails, setShowDetails] = useState(false)
	const [readError, setReadError] = useState('')
	const [showStorage, setShowStorage] = useState(false)
	const [operation, setOperation] = useState('')
	const [notice, setNotice] = useState('')
	async function refresh() {
		const [items, status] = await Promise.all([
			Orpheus.getDownloads(),
			Orpheus.getOfflineStorage(),
		])
		setTasks(items.filter((item) => item.id.startsWith('melo-offline:')))
		setStorage(status)
		setReadError('')
		setLoading(false)
	}
	useEffect(() => {
		if (!visible) return
		let active = true
		let pending = false
		const update = async () => {
			if (pending) return
			pending = true
			try {
				const [items, status] = await Promise.all([
					Orpheus.getDownloads(),
					Orpheus.getOfflineStorage(),
				])
				if (!active) return
				setTasks(items.filter((item) => item.id.startsWith('melo-offline:')))
				setStorage(status)
				setReadError('')
				setLoading(false)
			} catch (cause) {
				if (active) {
					setReadError(cause instanceof Error ? cause.message : String(cause))
					setLoading(false)
				}
			} finally {
				pending = false
			}
		}
		setShowDetails(false)
		setShowStorage(false)
		setError('')
		setNotice('')
		setLoading(true)
		void update()
		const interval = setInterval(() => {
			void update()
		}, 1500)
		return () => {
			active = false
			clearInterval(interval)
		}
	}, [visible])
	async function retryRead() {
		if (busy) return
		setBusy(true)
		setOperation('正在读取离线内容…')
		setShowDetails(false)
		try {
			await refresh()
		} catch (cause) {
			setReadError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			setBusy(false)
			setOperation('')
		}
	}
	async function run(
		action: () => Promise<unknown>,
		label = '正在处理离线任务…',
		completed = '',
	) {
		if (busy) return
		setBusy(true)
		setError('')
		setNotice('')
		setOperation(label)
		setShowDetails(false)
		try {
			await action()
			await refresh()
			setNotice(completed)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			setBusy(false)
			setOperation('')
		}
	}
	const back = () => {
		if (showStorage) setShowStorage(false)
		else onClose()
	}
	return (
		<Modal
			visible={visible}
			animationType='slide'
			onRequestClose={back}
		>
			<KeyboardAvoidingView
				style={{ flex: 1, backgroundColor: theme.tokens.surface.base }}
				behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
			>
				{confirmation.dialog}
				<View style={{ paddingTop: insets.top }}><PageHeader title={showStorage ? '容量设置' : '下载与离线'} onBack={back} disabled={busy} /></View>
				{(busy || !!notice) && (
					<View
						accessibilityLiveRegion='polite'
						style={{ paddingHorizontal: 20, paddingBottom: 10 }}
					>
						<T size={12}>{busy ? operation : notice}</T>
					</View>
				)}
				{(readError || !!error) && (
					<View
						accessibilityLiveRegion='polite'
						style={{ paddingHorizontal: 20, paddingBottom: 10 }}
					>
						<Card>
							<T>
								{readError
									? '离线内容暂时无法读取，请重试。'
									: /^(请输入有效的 GiB 容量|容量范围为)/.test(error)
										? error
										: '操作未完成，请检查网络、可用空间和音源权限后重试。'}
							</T>
							{readError && (
								<Button
									secondary
									disabled={busy}
									onPress={() => void retryRead()}
								>
									重新读取
								</Button>
							)}
							{(!!error || !!readError) && (
								<>
									<Button
										secondary
										onPress={() => setShowDetails(!showDetails)}
									>
										{showDetails ? '收起错误详情' : '查看错误详情'}
									</Button>
								</>
							)}
						</Card>
					</View>
				)}
				<ScrollView
					key={showStorage ? 'storage' : 'downloads'}
					keyboardShouldPersistTaps='handled'
					contentContainerStyle={{
						padding: 20,
						paddingTop: 12,
						paddingBottom: bottomInset + 28,
						gap: 12,
						backgroundColor: theme.tokens.surface.base,
						flexGrow: 1,
					}}
				>
					{!showStorage && <T muted>
						完整下载后可离线播放。仅通过 Wi-Fi
						手动保存；播放片段缓存不算离线保存。
					</T>}
					{showDetails && (readError || error) && (
						<Card>
							<T
								muted
								size={12}
							>
								{readError || error}
							</T>
						</Card>
					)}
					{!showStorage && !loading && !readError && (
						<T size={12}>
							已用 {offlineBytes(storage.usedBytes)}， 上限{' '}
							{offlineBytes(storage.limitBytes)}， 设备可用{' '}
							{offlineBytes(storage.freeBytes)}
						</T>
					)}
					{!showStorage && <SettingsRow label='容量设置' disabled={loading || !!readError} onPress={() => {
						setLimit(String(storage.limitBytes / 1024 ** 3))
						setError('')
						setNotice('')
						setShowStorage(true)
					}} />}
					{showStorage && (
						<Card>
							<T>
								已用 {offlineBytes(storage.usedBytes)}， 上限{' '}
								{storage.limitBytes
									? offlineBytes(storage.limitBytes)
									: '尚未设置'}
							</T>
							<T muted>
								设备可用 {offlineBytes(storage.freeBytes)}。默认上限 1
								GiB，可调整；达到上限会提示，不会自动删除已有内容。
							</T>
							<T size={13} style={{ marginTop: 4 }}>容量上限（GiB）</T>
							<TextInput
								accessibilityLabel='离线容量上限 GiB'
								placeholder='容量上限（GiB）'
								placeholderTextColor={theme.tokens.text.secondary}
								selectionColor={theme.tokens.action.primary}
								cursorColor={theme.tokens.action.primary}
								keyboardType='decimal-pad'
								value={limit}
								onChangeText={setLimit}
								style={{ minHeight: 48, color: theme.tokens.text.primary, backgroundColor: theme.tokens.surface.base, borderWidth: 1, borderColor: theme.tokens.border.strong, borderRadius: 12, paddingHorizontal: 12 }}
							/>
							<Button
								disabled={busy}
								onPress={() =>
									void run(
										() =>
											Orpheus.setOfflineStorageLimit(offlineLimitBytes(limit)),
										'正在保存容量上限…',
										'离线容量上限已保存。',
									)
								}
							>
								保存容量上限
							</Button>
						</Card>
					)}
					{!showStorage && <>
					{track && (track.sourceId ?? track.id).startsWith('bilibili:') && (
						<Button
							disabled={busy || loading || !!readError || !storage.limitBytes}
							onPress={() =>
								void run(
									() =>
										Orpheus.saveOfflineTrack({
											...track,
											sourceId: track.sourceId ?? track.id,
											url: track.url.replace(/&meloOffline=1$/, ''),
										}),
									'正在提交下载…',
									'已提交下载，请在下方查看进度。',
								)
							}
						>
							下载当前歌曲
						</Button>
					)}
					<View
						accessibilityRole='tablist'
						style={{ flexDirection: 'row', gap: 20 }}
					>
						{(['all', 'complete', 'active'] as const).map((value) => (
							<ControlTarget
								key={value}
								accessibilityRole='tab'
								accessibilityState={{ selected: downloadTab === value }}
								onPress={() => setDownloadTab(value)}
								style={{
									minHeight: 48,
									justifyContent: 'center',
									borderBottomWidth: value === downloadTab ? 2 : 0,
									borderBottomColor: theme.tokens.action.primary,
								}}
							>
								<T>
									{value === 'all'
										? '全部'
										: value === 'complete'
											? '已下载'
											: '下载中'}
								</T>
							</ControlTarget>
						))}
					</View>
					{loading ? (
						<T>正在读取离线内容…</T>
					) : !tasks.length && !readError ? (
						<T muted>还没有离线保存。播放音乐后，从更多选项中保存当前音轨。</T>
					) : (
						tasks
							.filter(
								(task) =>
									downloadTab === 'all' ||
									(downloadTab === 'complete'
										? task.verifiedComplete && offlinePhase(task) === 3
										: !task.verifiedComplete || offlinePhase(task) !== 3),
							)
							.map((task) => (
								<View
									key={task.id}
									style={{
										flexDirection: 'row',
										alignItems: 'center',
										gap: 10,
										borderBottomWidth: 1,
										borderBottomColor: theme.tokens.border.subtle,
										paddingVertical: 12,
									}}
								>
									<ControlTarget
										accessibilityRole='button'
										accessibilityLabel={
											'离线播放 ' + (task.track?.title || '未命名音轨')
										}
										accessibilityState={{
											disabled:
												busy ||
												!task.verifiedComplete ||
												offlinePhase(task) !== 3,
										}}
										disabled={
											busy || !task.verifiedComplete || offlinePhase(task) !== 3
										}
										onPress={() =>
											void run(async () => {
												await onPlay(offlinePlaybackTrack(task))
												onClose()
											})
										}
										style={{
											flex: 1,
											flexDirection: 'row',
											alignItems: 'center',
											gap: 11,
											minHeight: 56,
										}}
									>
										<Artwork
											uri={task.track?.artwork}
											size={46}
										/>
										<View style={{ flex: 1, minWidth: 0 }}>
											<T
												weight='600'
												lines={2}
											>
												{task.track?.title || '未命名音轨'}
											</T>
											<T
												muted
												size={13}
											>
												{offlineBytes(task.bytesDownloaded)}
												{task.contentLength > 0
													? ' / ' + offlineBytes(task.contentLength)
													: ''}
											</T>
											<T
												muted
												size={13}
											>
												{offlineState(task)}
											</T>
											{task.contentLength > 0 && !task.verifiedComplete && (
												<View
													style={{
														height: 3,
														backgroundColor: theme.tokens.border.subtle,
														marginTop: 5,
													}}
												>
													<View
														style={{
															height: 3,
															width: `${Math.min(100, (task.bytesDownloaded / task.contentLength) * 100)}%`,
															backgroundColor: theme.tokens.action.primary,
														}}
													/>
												</View>
											)}
										</View>
									</ControlTarget>
									<CollectionMenu
										label={'下载操作 ' + (task.track?.title || '未命名音轨')}
										actions={[
											...(task.verifiedComplete && offlinePhase(task) === 3
												? [
														{
															label: '离线播放',
															disabled: busy,
															onPress: () =>
																void run(async () => {
																	await onPlay(offlinePlaybackTrack(task))
																	onClose()
																}),
														},
													]
												: []),
											...([0, 2, 7].includes(task.state)
												? [
														{
															label: '暂停下载， 保留部分',
															disabled: busy,
															onPress: () =>
																void run(
																	() => Orpheus.pauseOfflineDownload(task.id),
																	'正在暂停下载…',
																	'已暂停，已下载部分保留。',
																),
														},
													]
												: []),
											...([1, 4].includes(task.state)
												? [
														{
															label: '继续 / 重试',
															disabled: busy,
															onPress: () =>
																void run(
																	() => Orpheus.retryOfflineDownload(task.id),
																	'正在继续下载…',
																	'已提交继续下载。',
																),
														},
													]
												: []),
											...(offlinePhase(task) === 3 && !task.verifiedComplete
												? [
														{
															label: '重新保存',
															disabled: busy,
															onPress: () =>
																confirmation.show(
																	'重新保存？',
																	'移除这条不完整的离线副本并重新下载，喜欢与歌单不变。',
																	[
																		{ text: '取消', style: 'cancel' },
																		{
																			text: '重新保存',
																			onPress: () =>
																				void run(
																					() =>
																						Orpheus.retryOfflineDownload(
																							task.id,
																						),
																					'正在重新保存…',
																					'已提交重新保存。',
																				),
																		},
																	],
																),
														},
													]
												: []),
											{
												label: '移除离线副本',
												disabled: busy || offlinePhase(task) === 5,
												onPress: () =>
													confirmation.show(
														'移除离线副本？',
														'只移除离线数据和任务，不删除喜欢、歌单或原始来源。正在播放的离线音轨可能中断。',
														[
															{ text: '保留', style: 'cancel' },
															{
																text: '移除',
																style: 'destructive',
																onPress: () =>
																	void run(
																		() => Orpheus.removeDownload(task.id),
																		'正在移除离线副本…',
																		'已移除离线副本。',
																	),
															},
														],
													),
											},
										]}
									/>
								</View>
							))
					)}
					</>}
				</ScrollView>
			</KeyboardAvoidingView>
		</Modal>
	)
}
