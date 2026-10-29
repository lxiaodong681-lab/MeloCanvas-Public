import React, { useRef, useState } from 'react'
import { Modal, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type { InspectedLibraryBackup } from '../../../packages/native/src/LibraryBackupModule'

import {
	chooseLibraryBackup,
	canUndoLibraryBackup,
	undoLastLibraryBackup,
	previewLibraryBackupMerge,
	discardLibraryBackup,
	previewLibraryBackup,
	restoreLibraryBackup,
	shareLibraryBackup,
	saveLibraryBackup,
} from './library-backup-mobile'
import { PageHeader, SettingsGroup, SettingsRow } from './settings-layout'
import { ConfirmationModal } from './theme-dialog'
import { Button, Card, T, useTheme } from './ui'

const boundaries =
	'均不含登录信息、账号凭据、活动播放队列、在线下载缓存、仅 Wi-Fi 开关、推荐反馈和原生最近播放记录；包含已保存的听读进度。不是自动云同步。'
function backupError(error: unknown): string {
	const message = error instanceof Error ? error.message : ''
	if (/[\u3400-\u9fff]/.test(message)) return message
	if (/collision|Existing file|File changed/.test(message))
		return '存在相同文件身份但内容不同的音频、主题或封面，已拒绝覆盖。请保留两份资料；如需重试，请重新选择备份。'
	if (/Unknown or expired/.test(message))
		return '备份预览已失效，请重新选择文件。'
	if (/limit|large|space|ENOSPC|SQLITE_FULL/i.test(message))
		return '备份超过大小限制或可用空间不足，当前资料已保留。请检查空间或改用轻量备份。'
	return '备份文件无法处理，当前资料未被覆盖。请确认文件完整、空间足够，并重新选择备份。'
}
export function LibraryBackupEntry({ onRestored }: { onRestored: () => void }) {
	const theme = useTheme()
	const insets = useSafeAreaInsets()
	const [open, setOpen] = useState(false)
	const [page, setPage] = useState<'home' | 'export' | 'restore' | 'undo' | 'help'>('home')
	const [backupScope, setBackupScope] = useState<'light' | 'full'>('light')
	const [busy, setBusy] = useState(false)
	const active = useRef(false)
	const scroll = useRef<ScrollView | null>(null)
	const focusedPreview = useRef<string | null>(null)
	const [selected, setSelected] = useState<InspectedLibraryBackup | null>(null)
	const [message, setMessage] = useState('')
	const [confirmReplace, setConfirmReplace] = useState(false)
	const [confirmUndo, setConfirmUndo] = useState(false)
	const [canUndo, setCanUndo] = useState(false)
	const [mergePreview, setMergePreview] = useState<ReturnType<
		typeof previewLibraryBackupMerge
	> | null>(null)
	const refresh = () => {
		try {
			onRestored()
		} catch {
			setMessage('资料已恢复，但界面刷新失败。请重新打开应用查看。')
		}
	}
	const restore = async (mode: 'merge' | 'replace') => {
		if (!selected) return
		const result = await restoreLibraryBackup(selected, mode)
		setSelected(null)
		focusedPreview.current = null
		setConfirmReplace(false)
		setMergePreview(null)
		setCanUndo(mode === 'replace' || canUndo)
		setMessage(
			(mode === 'replace'
				? '替换完成，已保存可撤销检查点。'
				: `合并完成：新增 ${result.inserted} 条资料，保留/跳过 ${result.keptExisting} 条，${result.skippedGroups} 个已有歌单或导入组保持原样。`) +
				'主题和部分设置在下次打开应用时生效。重新选择听视频后记录新进度，当前音频不中断。' +
				(result.cleanupWarning
					? '临时文件清理失败，可稍后重试清理；恢复本身已完成。'
					: ''),
		)
		refresh()
	}
	const perform = async (action: () => Promise<void>) => {
		if (active.current) return
		active.current = true
		setBusy(true)
		setMessage('')
		try {
			await action()
		} catch (error) {
			setMessage(backupError(error))
		} finally {
			active.current = false
			setBusy(false)
		}
	}
	const close = () => {
		if (!active.current)
			void perform(async () => {
				if (selected) await discardLibraryBackup(selected)
				setSelected(null)
				focusedPreview.current = null
				setConfirmReplace(false)
				setConfirmUndo(false)
				setMergePreview(null)
				setOpen(false)
			})
	}
	const summary = selected ? previewLibraryBackup(selected) : null
	const back = () => {
		if (active.current) return
		if (page === 'home') { close(); return }
		if (confirmReplace) { setConfirmReplace(false); return }
		void perform(async () => {
			if (selected) await discardLibraryBackup(selected)
			setSelected(null)
			focusedPreview.current = null
			setMergePreview(null)
			setConfirmUndo(false)
			setPage('home')
		})
	}
	return (
		<>
			<SettingsRow
				label='音乐库备份与恢复'
				onPress={() => {
					setPage('home')
					setOpen(true)
					try {
						setCanUndo(canUndoLibraryBackup())
					} catch {
						setMessage('恢复检查点暂时无法读取。')
					}
				}}
			/>
			<Modal
				visible={open}
				animationType='slide'
				onRequestClose={back}
				presentationStyle='pageSheet'
			>
				<View
					style={{
						flex: 1,
						backgroundColor: theme.tokens.surface.base,
						paddingTop: insets.top,
						paddingBottom: insets.bottom,
					}}
				>
					<PageHeader title={page === 'export' ? '创建备份' : page === 'restore' ? '从备份恢复' : page === 'undo' ? '撤销恢复' : page === 'help' ? '备份说明' : '备份与恢复'} onBack={back} disabled={busy} />
					{(busy || !!message) && (
						<View
							accessibilityLiveRegion='polite'
							style={{ paddingHorizontal: 24, paddingBottom: 12, gap: 6 }}
						>
							{busy && <T size={12}>正在安全处理文件，请稍候…</T>}
							{!!message && <T size={12}>{message}</T>}
						</View>
					)}
					<ScrollView
						key={page}
						ref={scroll}
						contentContainerStyle={{
							padding: 20,
							gap: 12,
							backgroundColor: theme.tokens.surface.base,
							flexGrow: 1,
						}}
					>
						{page === 'home' && <SettingsGroup>
							<SettingsRow label='创建备份' onPress={() => setPage('export')} />
							<SettingsRow label='从备份恢复' onPress={() => setPage('restore')} />
							{canUndo && <SettingsRow label='撤销上次替换恢复…' onPress={() => { setConfirmUndo(true); setPage('undo') }} />}
							<SettingsRow label='备份说明' onPress={() => setPage('help')} />
						</SettingsGroup>}
						{(page === 'export' || page === 'help') && <T size={13} muted>备份文件未加密，请保存在应用以外的位置并妥善保管。</T>}
						{page === 'help' && <><T size={13} muted>{boundaries}</T><T size={13} muted>“保存到文件”将备份写入你选择的位置；系统分享不代表文件已保存。</T></>}
						{page === 'restore' && !selected && <>
						<T muted>选择备份文件，查看内容后再确认恢复。</T>
						<Button
							secondary
							disabled={busy || !!selected}
							onPress={() =>
								void perform(async () => {
									const backup = await chooseLibraryBackup()
									if (backup) {
										focusedPreview.current = null
										setSelected(backup)
										setConfirmReplace(false)
										try {
											setMergePreview(previewLibraryBackupMerge(backup))
										} catch (error) {
											setMergePreview(null)
											setMessage(
												error instanceof Error
													? error.message
													: '合并预检失败，当前资料未改动。',
											)
										}
									}
								})
							}
						>
							选择备份，先查看内容
						</Button>
						</>}
						{page === 'export' && <>
						<View style={{ flexDirection: 'row', gap: 10 }}>
							<View style={{ flex: 1 }}>
								<Button
									secondary={backupScope !== 'light'}
									onPress={() => setBackupScope('light')}
								>
									仅资料
								</Button>
							</View>
							<View style={{ flex: 1 }}>
								<Button
									secondary={backupScope !== 'full'}
									onPress={() => setBackupScope('full')}
								>
									含本地文件
								</Button>
							</View>
						</View>
						{backupScope === 'light' && (
							<Card>
								<T weight='600'>轻量音乐库备份</T>
								<T muted>
									歌单、喜欢、UP
									关注、待匹配目录、听读进度、搜索历史、音乐偏好、歌词及支持的设置。不含音频、主题包和自定义封面文件；本地歌曲保留身份，但新设备需要原文件才能播放。
								</T>
								<View style={{ marginTop: 12, gap: 12 }}>
									<Button
										disabled={busy || !!selected}
										onPress={() =>
											void perform(async () => {
												const saved = await saveLibraryBackup(false)
												setMessage(
													saved
														? '备份已保存到你选择的位置。请妥善保管。'
														: '已取消保存，未导出备份。',
												)
											})
										}
									>
										保存轻量备份到文件
									</Button>
									<Button
										secondary
										disabled={busy || !!selected}
										onPress={() =>
											void perform(async () => {
												await shareLibraryBackup(false)
												setMessage(
													'已打开系统分享。请确认文件实际保存到应用以外的位置。',
												)
											})
										}
									>
										分享轻量备份
									</Button>
								</View>
							</Card>
						)}
						{backupScope === 'full' && (
							<Card>
								<T weight='600'>完整音乐库备份</T>
								<T muted>
									轻量资料，加上已导入的本地音频和已安装主题。还包括自定义歌单封面。文件总量上限
									2 GiB，单文件 512 MiB，最多 20,000 个文件；请预留足够空间。
								</T>
								<View style={{ marginTop: 12, gap: 12 }}>
									<Button
										disabled={busy || !!selected}
										onPress={() =>
											void perform(async () => {
												const saved = await saveLibraryBackup(true)
												setMessage(
													saved
														? '备份已保存到你选择的位置。请妥善保管。'
														: '已取消保存，未导出备份。',
												)
											})
										}
									>
										保存完整备份到文件
									</Button>
									<Button
										secondary
										disabled={busy || !!selected}
										onPress={() =>
											void perform(async () => {
												await shareLibraryBackup(true)
												setMessage(
													'已打开系统分享。请确认文件实际保存到应用以外的位置。',
												)
											})
										}
									>
										分享完整备份
									</Button>
								</View>
							</Card>
						)}
						</>}
						{page === 'restore' && selected && summary && (
							<View
								onLayout={(event) => {
									if (focusedPreview.current === selected.token) return
									focusedPreview.current = selected.token
									scroll.current?.scrollTo({
										y: Math.max(0, event.nativeEvent.layout.y - 12),
										animated: false,
									})
								}}
							>
								<Card>
									<T weight='600'>
										{selected.full ? '完整音乐库备份' : '轻量音乐库备份'}，
										恢复预览
									</T>
									<T>
										{summary.playlists} 个歌单， {summary.liked} 个喜欢，{' '}
										{summary.pendingItems} 个待匹配条目
									</T>
									<T muted>
										{selected.audioFiles} 个音频文件， {selected.themeFiles}{' '}
										个主题文件， {selected.coverFiles} 个封面
									</T>
									<T muted>
										将保留当前内容和设置，只添加缺失资料。已存在的歌单及相关导入记录整组跳过，不混合顺序；相同文件身份但内容不同会拒绝恢复。音乐不会自动播放。
									</T>
									{!selected.full && summary.localReferences > 0 && (
										<T>
											注意：包含 {summary.localReferences}{' '}
											个本地歌曲引用，但不含音频文件。换设备后它们可能暂时无法播放。
										</T>
									)}
									{mergePreview && (
										<T muted>
											合并预检：预计新增 {mergePreview.inserted} 条，保留/跳过{' '}
											{mergePreview.keptExisting} 条，
											{mergePreview.skippedGroups}{' '}
											个已有组保持原样。确认时会再次核对当前资料。
										</T>
									)}
									<View style={{ gap: 12, marginTop: 12 }}>
										<Button
											disabled={busy || !mergePreview || confirmReplace}
											onPress={() => void perform(() => restore('merge'))}
										>
											确认合并，不覆盖当前内容
										</Button>
										<Button
											secondary
											disabled={busy}
											onPress={() => setConfirmReplace(true)}
										>
											选择替换恢复…
										</Button>
										{confirmReplace && (
											<ConfirmationModal title='替换歌单、喜欢和资料？' cancelable={!busy} onCancel={() => { if (!active.current) setConfirmReplace(false) }}>
												{!!message && <View accessibilityLiveRegion='polite'><T>{message}</T></View>}
												<T>
													将替换当前歌单、喜欢、导入记录、UP
													关注、已保存听读进度及支持的设置。不会删除已有音频文件、本地音频条目、主题文件或正在播放队列。操作会在同一事务保存撤销检查点；仅在资料未继续修改时可自动撤销。
												</T>
												<Button
													disabled={busy}
													onPress={() => void perform(() => restore('replace'))}
												>
													确认替换，并保存撤销点
												</Button>
												<Button
													secondary
													disabled={busy}
													onPress={() => setConfirmReplace(false)}
												>
													不替换，返回合并
												</Button>
											</ConfirmationModal>
										)}
										<Button
											secondary
											disabled={busy}
											onPress={() =>
												void perform(async () => {
													await discardLibraryBackup(selected)
													setSelected(null)
													focusedPreview.current = null
												})
											}
										>
											取消恢复
										</Button>
									</View>
								</Card>
							</View>
						)}
						{page === 'undo' && canUndo && !selected && (
							<Card>
								{confirmUndo && (
									<ConfirmationModal title='撤销上次替换恢复？' cancelable={!busy} onCancel={back}>
										{!!message && <View accessibilityLiveRegion='polite'><T>{message}</T></View>}
										<T>
											恢复到上次替换前的歌单与资料。若之后已有新修改，将拒绝自动撤销并保留当前资料。
										</T>
										<Button
											disabled={busy}
											onPress={() =>
												void perform(async () => {
													undoLastLibraryBackup()
													setCanUndo(false)
													setConfirmUndo(false)
													setPage('home')
													setMessage(
														'已撤销上次替换恢复；音频与主题文件未删除。重新选择听视频后记录新进度。',
													)
													refresh()
												})
											}
										>
											确认撤销替换
										</Button>
										<Button
											secondary
											disabled={busy}
											onPress={back}
										>
											取消撤销
										</Button>
									</ConfirmationModal>
								)}
							</Card>
						)}
					</ScrollView>
				</View>
			</Modal>
		</>
	)
}
