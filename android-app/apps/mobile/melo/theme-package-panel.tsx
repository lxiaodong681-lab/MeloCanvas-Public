import React, { useState } from 'react'
import { FlatList, ScrollView, View } from 'react-native'

import { ThemeReferencePreview } from './theme-preview'
import { ThemeAuthorEntry } from './theme-author-ui'
import { BilibiliThemeEntry } from './bilibili-theme-ui'
import {
	themeWorkshopBusy,
	type ThemeWorkshopSession,
	type ThemeWorkshopSnapshot,
} from './theme-workshop-session'
import { SettingsDetails, SettingsRow } from './settings-layout'
import { ThemeSubpage } from './theme-subpage'
import { Button, Card, IconButton, State, T, useTheme } from './ui'
import { ConfirmationModal } from './theme-dialog'
import type { InstalledThemeRecord } from './core/theme-install-types'
import type { CurrentThemeDisplay } from './useThemeCurrentLayout'
import { cosmosTheme, themeAppearance, type ColorMode } from './core/theme-appearance'

export function ThemePackagePanel({
	state,
	session,
	reducedMotion,
	display,
	colorMode = 'light',
}: {
	state: ThemeWorkshopSnapshot
	session: ThemeWorkshopSession
	reducedMotion: boolean
	display?: CurrentThemeDisplay
	colorMode?: ColorMode
}) {
	const theme = useTheme()
	const install = state.installer
	const [bilibiliOpen, setBilibiliOpen] = useState(false)
	const [installedOpen, setInstalledOpen] = useState(false)
	const [removing, setRemoving] = useState<InstalledThemeRecord | null>(null)
	const [bilibiliBusy, setBilibiliBusy] = useState(false)
	const [authorBusy, setAuthorBusy] = useState(false)
	const workshopBusy = themeWorkshopBusy(state)
	const busy = workshopBusy || bilibiliBusy || authorBusy
	const writable = !!install && !install.readOnly && !state.loading
	const error = state.error ?? state.file.error ?? install?.error
	const preview = install?.preview
	const previewDisplay = preview ? themeAppearance(preview, colorMode) : null
	const metadata = preview?.packageMetadata ?? state.current.packageMetadata
	const busyMessage = state.loading
		? '正在读取主题记录'
		: state.file.busy
			? '正在读取所选主题文件'
			: install?.phase === 'validating'
				? '正在完整校验主题包'
				: install?.phase === 'preparing-preview'
					? '正在准备安全预览'
					: '正在应用主题'
	const renderPreview = (onBack: () => void) => <View style={{ flex: 1 }}>
		<ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 16 }}>
			{metadata && <>
				<T size={18} weight='700'>{metadata.name}</T>
				<T muted size={13}>作者：{metadata.author}</T>
				<SettingsDetails title='主题信息'><T size={13}>授权：{metadata.license}</T><T size={13}>版本 {metadata.version}，{metadata.archiveBytes} 字节</T></SettingsDetails>
			</>}
			{preview && previewDisplay && <>
				<ThemeReferencePreview adapted={previewDisplay.adapted} fallbackTheme={previewDisplay.theme} allowedImageUris={previewDisplay.allowedImageUris} reducedMotion={reducedMotion} />
				{colorMode === 'dark' && previewDisplay.theme === cosmosTheme && <T muted size={13}>此主题没有深色配置，深色使用宇宙外观；配色与壁纸在浅色模式显示。</T>}
				{!!preview.theme.warnings.length && <T muted size={13}>部分主题效果暂不支持，已使用兼容样式。</T>}
			</>}
			{!!error && <T>{error.message}</T>}
		</ScrollView>
		<View style={{ padding: 20, borderTopWidth: 1, borderTopColor: theme.tokens.border.subtle, backgroundColor: theme.tokens.surface.card }}>
			<Button disabled={busy || !writable || !preview} onPress={() => { void session.apply().then((success) => { if (success) onBack() }) }}>{busy ? '正在处理…' : '应用此主题'}</Button>
		</View>
	</View>
	return (
		<View style={{ gap: 14 }}>
			<T
				size={18}
				weight='700'
			>
				第三方主题
			</T>
			<T
				muted
				size={12}
			>
				从作者的发布页或网盘下载 .melotheme 文件，预览后再应用。
			</T>
			<T size={12}>
				{display?.temporaryModern || colorMode === 'dark' ? '已选主题' : '当前主题'}：
				{state.current.theme.name}
			</T>
			{state.current.packageMetadata && <SettingsDetails title='当前主题信息'>
				<T size={13}>作者：{state.current.packageMetadata.author}</T>
				<T size={13}>授权：{state.current.packageMetadata.license}</T>
				<T size={13}>版本 {state.current.packageMetadata.version}</T>
			</SettingsDetails>}
			{colorMode === 'dark' && <T muted size={12}>
				{themeAppearance(state.current, colorMode).theme === cosmosTheme
					? '当前深色外观：宇宙。所选主题没有深色配置，切回浅色后恢复原主题。'
					: '当前使用所选主题的深色配置。'}
			</T>}
			{display?.temporaryModern && (
				<Card>
					<View
						testID='theme-current-layout-notice'
						accessibilityLiveRegion='polite'
					>
						<T size={12}>当前临时显示：{colorMode === 'dark' ? '宇宙外观' : '内置现代主题'}</T>
						<T
							muted
							size={11}
						>
							{display.reason}
						</T>
					</View>
				</Card>
			)}
			{state.widgetTheme.status === 'error' && (
				<Card>
					<T size={12}>小组件主题同步失败，应用主题已保留。</T>
					<T
						muted
						size={11}
					>
						{state.widgetTheme.error?.message}
					</T>
					{state.widgetTheme.canRetry && (
						<Button
							secondary
							disabled={busy || !writable}
							onPress={session.retryWidgetTheme}
						>
							重试同步小组件主题
						</Button>
					)}
				</Card>
			)}
			{state.current.selection.kind === 'package' && (
				<T
					muted
					size={11}
				>
					小组件使用主题配色与宿主样式，专属图案暂用兼容外观。
				</T>
			)}
			{state.file.file && (
				<Card>
					<T weight='600'>{state.file.file.name}</T>
					<T
						muted
						size={12}
					>
						{state.file.file.bytes === null
							? '大小待限额读取确认'
							: `${state.file.file.bytes} 字节`}
					</T>
				</Card>
			)}
			{workshopBusy && (
				<State
					title={busyMessage}
					busy
				/>
			)}
			{!busy && error && (
				<Card>
					<T
						weight='700'
						style={{ color: theme.tokens.state.error }}
					>
						主题操作未完成
					</T>
					<T>{error.message}</T>
					<T
						muted
						size={12}
					>
						当前显示仍为：
						{display?.presentation.theme.name ?? state.current.theme.name}。
					</T>
				</Card>
			)}
			{install?.readOnly && (
				<T
					muted
					size={12}
				>
					主题记录只读，原记录已保留。当前使用
					{(display?.presentation ?? state.current).selection.kind === 'builtin'
						? '内置回退'
						: '原有主题'}
					：{display?.presentation.theme.name ?? state.current.theme.name}。
				</T>
			)}
			{!state.loading &&
				(!install ||
					install.readOnly ||
					!!state.error ||
					state.widgetTheme.needsReload) && (
					<Button
						secondary
						disabled={busy}
						onPress={() => {
							void session.load()
						}}
					>
						重新读取主题记录
					</Button>
				)}
			<SettingsRow label='从文件导入主题' disabled={busy || !writable} onPress={() => { void session.choose() }} />
			<ThemeAuthorEntry colorMode={colorMode} disabled={workshopBusy || bilibiliBusy || !writable} onWorkingChange={setAuthorBusy} onApply={session.applyAuthored} />
			<BilibiliThemeEntry disabled={busy || !writable} onPreview={session.previewBytes} onWorkingChange={setBilibiliBusy} onOpenChange={setBilibiliOpen} renderPreview={renderPreview} onCancelPreview={session.close} />
			{workshopBusy && !state.loading && (
				<Button
					secondary
					onPress={session.close}
				>
					取消当前主题操作
				</Button>
			)}
			{preview && !bilibiliOpen && !authorBusy && <ThemeSubpage title='主题预览' onBack={session.close} scroll={false}>{renderPreview(() => {})}</ThemeSubpage>}

			{!!install?.installed.length && <SettingsRow label='已安装主题' value={String(install.installed.length)} disabled={busy} onPress={() => setInstalledOpen(true)} />}
			{installedOpen && <ThemeSubpage title='已安装主题' onBack={() => setInstalledOpen(false)} scroll={false}>
				<View style={{ paddingHorizontal: 20, paddingBottom: 12, gap: 12 }}>
					<T muted size={13}>保存在本机，切换无需重新下载。</T>
					{!!error && <><T size={13}>{error.message}</T><Button secondary disabled={busy} onPress={() => { void session.load() }}>重新加载主题</Button></>}
				</View>
				<FlatList data={install?.installed ?? []} keyExtractor={(item) => item.id + '/' + item.archiveSha256} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }} initialNumToRender={12} windowSize={5}
					renderItem={({ item }) => {
						const selected = state.current.selection
						const current = selected.kind === 'package' && selected.id === item.id && selected.archiveSha256 === item.archiveSha256
						return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
							<View style={{ flex: 1 }}><SettingsRow label={item.name} detail={item.storedBytes ? `本地 ${(item.storedBytes / 1024 / 1024).toFixed(1)} MB` : '已保存在本机'} value={current ? '使用中' : undefined} disabled={busy || !writable || current} onPress={() => { void session.activateInstalled(item.id, item.archiveSha256) }} /></View>
							<IconButton name='close' label={`删除主题 ${item.name}`} disabled={busy || !writable} onPress={() => setRemoving(item)} />
						</View>
					}} />
				{removing && <ConfirmationModal title='删除本地主题？' onCancel={() => setRemoving(null)} cancelable={!busy}>
					<T>将删除“{removing.name}”及其本地图片。正在使用时会切回原色，之后可重新导入。</T>
					<Button secondary disabled={busy} onPress={() => setRemoving(null)}>取消</Button>
					<Button disabled={busy} onPress={() => { void session.removeInstalled(removing.id, removing.archiveSha256).then(() => setRemoving(null)) }}>{busy ? '正在删除…' : '删除主题'}</Button>
				</ConfirmationModal>}
			</ThemeSubpage>}
			{install?.canUndo && (
				<Button
					secondary
					disabled={busy || !writable}
					onPress={() => {
						void session.undo()
					}}
				>
					撤销上次主题切换
				</Button>
			)}
			{!!install?.cleanupErrors.length && (
				<Card>
					<T weight='600'>暂存清理提示</T>
					<T
						muted
						size={12}
					>
						当前主题：{state.current.theme.name}
					</T>
					{[...new Set(install.cleanupErrors.map((item) => item.message))].map(
						(message) => (
							<T
								key={message}
								muted
								size={12}
							>
								{message}
							</T>
						),
					)}
				</Card>
			)}
		</View>
	)
}
