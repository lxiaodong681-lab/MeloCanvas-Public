import React, { useEffect, useRef, useState } from 'react'
import { Linking, View, type GestureResponderEvent } from 'react-native'

import { builtInThemes, type ThemeKey } from './core/theme'
import type { ColorMode } from './core/theme-appearance'
import { authorThemes, themeAuthorSteps } from './theme-author'
import type { prepareThemeBackground } from './theme-author-mobile'
import { ThemeTextInput } from './theme-input'
import { defaultBackgroundAdjustments } from './theme-background'
import { themeDeveloperGuide, themeDeveloperLinks } from './theme-developer-guide'
import { SettingsRow } from './settings-layout'
import { ThemeSubpage } from './theme-subpage'
import { Artwork, Button, Card, T, useTheme } from './ui'

type Preview = Awaited<ReturnType<typeof prepareThemeBackground>>

/** Keep drag updates local; only render a new wallpaper when the user releases. */
export function ThemeAdjustmentSlider({ label, hint, value, minimum = 0, maximum = 100, disabled, onCommit }: {
	label: string; hint?: string; value: number; minimum?: number; maximum?: number; disabled: boolean; onCommit: (value: number) => void
}) {
	const theme = useTheme()
	const [draft, setDraft] = useState<number | null>(null)
	const width = useRef(1)
	const drag = useRef<{ origin: number; width: number } | null>(null)
	useEffect(() => { drag.current = null; setDraft(null) }, [disabled, value])
	const clamp = (n: number) => Math.max(minimum, Math.min(maximum, Math.round(n)))
	const fromTouch = (event: GestureResponderEvent) => {
		const active = drag.current
		return clamp(minimum + ((event.nativeEvent.pageX - (active?.origin ?? 0)) / (active?.width ?? 1)) * (maximum - minimum))
	}
	const commit = (n: number) => {
		drag.current = null; setDraft(null)
		if (!disabled && clamp(n) !== value) onCommit(clamp(n))
	}
	const shown = draft ?? value
	const percent = (shown - minimum) / (maximum - minimum) * 100
	return <View style={{ gap: 4 }}>
		<T size={12}>{label}，{shown}%</T>
		<View accessibilityRole='adjustable' accessibilityLabel={label}
			accessibilityState={{ disabled }} accessibilityValue={{ min: minimum, max: maximum, now: shown, text: `${shown}%` }}
			accessibilityActions={[{ name: 'increment', label: '增加 1%' }, { name: 'decrement', label: '减少 1%' }]}
			onAccessibilityAction={({ nativeEvent }) => {
				if (nativeEvent.actionName === 'increment') commit(value + 1)
				if (nativeEvent.actionName === 'decrement') commit(value - 1)
			}}
			onLayout={({ nativeEvent }) => { width.current = Math.max(1, nativeEvent.layout.width) }}
			onStartShouldSetResponder={() => !disabled} onMoveShouldSetResponder={() => !disabled}
			onResponderTerminationRequest={() => false}
			onResponderGrant={(event) => {
				if (disabled) return
				drag.current = { origin: event.nativeEvent.pageX - event.nativeEvent.locationX, width: width.current }
				setDraft(fromTouch(event))
			}}
			onResponderMove={(event) => { if (!disabled && drag.current) setDraft(fromTouch(event)) }}
			onResponderRelease={(event) => { if (drag.current) commit(fromTouch(event)) }}
			onResponderTerminate={() => { drag.current = null; setDraft(null) }}
			style={{ height: 48, justifyContent: 'center', opacity: disabled ? 0.4 : 1 }}>
			<View pointerEvents='none' style={{ height: 4, borderRadius: 2, backgroundColor: theme.tokens.border.strong }}>
				<View style={{ height: 4, width: `${percent}%`, borderRadius: 2, backgroundColor: theme.tokens.action.primary }} />
			</View>
			<View pointerEvents='none' style={{ position: 'absolute', left: `${percent}%`, marginLeft: -10, width: 20, height: 20, borderRadius: 10, backgroundColor: theme.tokens.action.primary }} />
		</View>
		{hint && <T muted size={12}>{hint}</T>}
	</View>
}

export function ThemeAuthorEntry({ disabled = false, onApply, onWorkingChange, colorMode = 'light' }: { disabled?: boolean; onApply: (bytes: Uint8Array) => Promise<boolean>; onWorkingChange?: (busy: boolean) => void; colorMode?: ColorMode }) {
	const [open, setOpen] = useState(false)
	return <>
		<SettingsRow label='外观调整，壁纸与配色' disabled={disabled} onPress={() => setOpen(true)} />
		{open && <ThemeSubpage title='外观调整' onBack={() => { if (!disabled) setOpen(false) }}>
			<ThemeAuthorPanel disabled={disabled} onWorkingChange={onWorkingChange} onApply={onApply} colorMode={colorMode} onClose={() => setOpen(false)} />
		</ThemeSubpage>}
	</>
}

export function ThemeAuthorPanel({ onClose, onApply, disabled = false, onWorkingChange, colorMode = 'light' }: { onClose: () => void; onApply: (bytes: Uint8Array) => Promise<boolean>; disabled?: boolean; onWorkingChange?: (busy: boolean) => void; colorMode?: ColorMode }) {
	const theme = useTheme()
	const [base, setBase] = useState<ThemeKey>('modern')
	const [name, setName] = useState('原色样例')
	const [source, setSource] = useState<string>()
	const [preview, setPreview] = useState<Preview | null>(null)
	const [working, setBusy] = useState(true)
	const busy = working || disabled
	useEffect(() => { onWorkingChange?.(working) }, [working, onWorkingChange])
	useEffect(() => () => { onWorkingChange?.(false) }, [onWorkingChange])
	const [notice, setNotice] = useState('')
	const [help, setHelp] = useState(false)
	const [developer, setDeveloper] = useState(false)
	const [progressColors, setProgressColors] = useState({ track: '', fill: '', thumb: '' })
	const [thumb, setThumb] = useState<{ bytes: Uint8Array; uri: string } | null>(null)
	const [attempt, setAttempt] = useState(0)
	const [adjustments, setAdjustments] = useState({ ...defaultBackgroundAdjustments })
	const [previewKey, setPreviewKey] = useState('')
	const renderKey = JSON.stringify([base, source, adjustments, attempt])
	const previewCurrent = !!preview && previewKey === renderKey
	const alive = useRef(true)
	const exporting = useRef(false)
	const abort = useRef(new AbortController())
	useEffect(() => {
		alive.current = true
		abort.current = new AbortController()
		return () => { alive.current = false; abort.current.abort() }
	}, [])
	useEffect(() => {
		let cancelled = false, owned: Preview | null = null
		setBusy(true); setPreview(null); setNotice('')
		void import('./theme-author-mobile').then((mobile) => mobile.prepareThemeBackground(base, source, adjustments)).then((result) => {
			if (cancelled) { result.dispose(); return }
			owned = result; setPreview(result); setPreviewKey(renderKey)
		}).catch((error: unknown) => {
			if (!cancelled) setNotice(error instanceof Error ? error.message : '背景处理失败，请重新选择图片')
		}).finally(() => { if (!cancelled) setBusy(false) })
		return () => { cancelled = true; owned?.dispose() }
	}, [base, source, adjustments, attempt, renderKey])
	async function pick() {
		if (exporting.current) return
		exporting.current = true; setBusy(true); setNotice('')
		try {
			const mobile = await import('./theme-author-mobile')
			const uri = await mobile.pickThemeBackground()
			if (alive.current && uri) setSource(uri)
		} catch (error) {
			if (alive.current) setNotice(error instanceof Error ? error.message : '图片选择失败')
		} finally { exporting.current = false; if (alive.current) setBusy(false) }
	}
	async function save() {
		if (!preview || !previewCurrent || exporting.current) return
		exporting.current = true; setBusy(true); setNotice('')
		try {
			const mobile = await import('./theme-author-mobile')
			await mobile.exportAuthoredTheme(base, name, preview.bytes, abort.current.signal, {
				colors: progress, ...(thumb ? { thumbImage: thumb.bytes } : {}),
			})
			if (alive.current) setNotice('分享面板已关闭。保存文件后，可回到主题工坊导入；当前主题未切换。')
		} catch (error) {
			if (alive.current) setNotice(error instanceof Error ? error.message : '主题导出失败，请重试')
		} finally { exporting.current = false; if (alive.current) setBusy(false) }
	}
	async function applyAppearance() {
		if (!preview || !previewCurrent || exporting.current) return
		exporting.current = true; setBusy(true); setNotice('')
		try {
			const mobile = await import('./theme-author-mobile')
			const result = await mobile.createAppearancePackage(base, preview.bytes)
			if (!alive.current) return
			const success = await onApply(result.bytes)
			if (alive.current) setNotice(success ? '外观已保存并应用，也可在已安装主题中重新选择。' : '外观未能保存，请重试。')
		} catch (error) {
			if (alive.current) setNotice(error instanceof Error ? error.message : '外观保存失败，请重试')
		} finally { exporting.current = false; if (alive.current) setBusy(false) }
	}
	async function openGuide(url: string) {
		try { await Linking.openURL(url) }
		catch { if (alive.current) setNotice('无法打开浏览器，请稍后重试；下方文档可离线阅读。') }
	}
	async function pickThumb() {
		if (exporting.current) return
		exporting.current = true; setBusy(true); setNotice('')
		try {
			const mobile = await import('./theme-author-mobile')
			const result = await mobile.pickThemeThumb()
			if (alive.current && result) setThumb(result)
		} catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : '滑块图片读取失败') }
		finally { exporting.current = false; if (alive.current) setBusy(false) }
	}
	const colors = builtInThemes[base].tokens
	const progress = { track: progressColors.track || colors.border.subtle, fill: progressColors.fill || colors.action.primary, thumb: progressColors.thumb || colors.action.primary }
	const validProgress = Object.values(progress).every((value) => /^#[0-9a-f]{6}$/i.test(value))
	return <Card style={{ gap: 16 }}>
		<View style={{ gap: 6 }}>
			<T size={18} weight='700'>外观调整</T>
			<T muted size={12}>选择基础配色，换上自己的壁纸，预览后保存。</T>
		</View>
		{colorMode === 'dark' && <T muted size={12}>这里制作和预览的是浅色外观。保存后深色仍使用宇宙，切回浅色即可看到壁纸；开发者可按教程添加独立的深色配色。</T>}
		<View style={{ gap: 12 }}>
			{authorThemes.map((key) => <Button key={key} secondary={base !== key} disabled={busy} onPress={() => {
				setBase(key)
				setName((current) => authorThemes.some((value) => current === `${builtInThemes[value].name}样例`) ? `${builtInThemes[key].name}样例` : current)
			}}>{builtInThemes[key].name}样例{base === key ? '，已选' : ''}</Button>)}
		</View>
		<Button secondary disabled={busy} onPress={() => void pick()}>选择背景图片</Button>
		{source && <Button secondary disabled={busy} onPress={() => setSource(undefined)}>恢复样例背景</Button>}
		{previewCurrent && preview && <View style={{ alignSelf: 'center', width: 180, height: 320, overflow: 'hidden', borderRadius: 12 }}>
			<Artwork uri={preview.uri} style={{ position: 'absolute', width: 180, height: 320 }} />
			<View style={{ padding: 18, gap: 18 }}>
				<T weight='700' style={{ color: colors.text.primary }}>背景预览</T>
				<T size={12} style={{ color: colors.text.secondary }}>文字与图片的实际配色</T>
				<View style={{ backgroundColor: colors.surface.card, padding: 12, borderRadius: 10 }}><T size={12} style={{ color: colors.action.primary }}>卡片与按钮保留清晰底色</T></View>
			</View>
		</View>}
		<ThemeAdjustmentSlider label='背景透明度' hint='0% 完整显示图片，100% 完全透明、只显示底色。' value={adjustments.transparency} disabled={busy} onCommit={(transparency) => setAdjustments({ ...adjustments, transparency })} />
		<ThemeAdjustmentSlider label='图片缩放' value={Math.round(adjustments.zoom * 100)} minimum={100} maximum={400} disabled={busy} onCommit={(zoom) => setAdjustments({ ...adjustments, zoom: zoom / 100 })} />
		<ThemeAdjustmentSlider label='水平取景位置' hint='0% 取最左侧，100% 取最右侧。' value={adjustments.horizontal} disabled={busy} onCommit={(horizontal) => setAdjustments({ ...adjustments, horizontal })} />
		<ThemeAdjustmentSlider label='垂直取景位置' hint='0% 取最顶部，100% 取最底部；没有裁切余量时，可先放大图片。' value={adjustments.vertical} disabled={busy} onCommit={(vertical) => setAdjustments({ ...adjustments, vertical })} />
		<Button secondary disabled={busy} onPress={() => setAdjustments({ ...defaultBackgroundAdjustments })}>重置背景调整</Button>
		<T muted size={12}>支持 JPG、PNG、WebP。松开滑块后更新预览；导出图片保留当前透明度和取景范围。</T>
		{busy && <T size={12}>正在处理，请稍候…</T>}
		{!busy && !preview && <Button secondary onPress={() => setAttempt(attempt + 1)}>重新生成预览</Button>}
		{!!notice && <View accessibilityLiveRegion='polite'><T size={12}>{notice}</T></View>}
		<Button disabled={busy || !previewCurrent} onPress={() => void applyAppearance()}>保存并应用外观</Button>
		<Button secondary onPress={() => setDeveloper(!developer)}>{developer ? '退出开发者模式' : '开发者模式，制作与发布主题'}</Button>
		{developer && <View style={{ gap: 12 }}>
			<T weight='700'>主题开发者模式</T>
			<T size={12}>进度条与滑块可独立配色。留空沿用基础配色；图片按原色显示，滑块颜色用于无图片或加载失败时的回退。</T>
			{([['track', '进度条底轨颜色'], ['fill', '已播放进度颜色'], ['thumb', '滑块颜色']] as const).map(([key, label]) => <View key={key} style={{ gap: 4 }}>
				<T size={12}>{label}</T>
				<ThemeTextInput accessibilityLabel={label} value={progressColors[key]} placeholder={progress[key]} maxLength={7} editable={!busy}
					onChangeText={(value) => setProgressColors({ ...progressColors, [key]: value.trim() })}
					style={{ padding: 12, color: theme.tokens.text.primary, backgroundColor: theme.tokens.surface.base, borderRadius: 10 }} />
			</View>)}
			{!validProgress && <T size={12}>颜色请使用 #RRGGBB，例如 #C3483B。</T>}
			<Button secondary disabled={busy} onPress={() => void pickThumb()}>选择滑块图片</Button>
			{thumb && <Button secondary disabled={busy} onPress={() => setThumb(null)}>移除滑块图片</Button>}
			<T muted size={12}>使用不超过 256×256 像素、256 KiB 的透明静态 PNG，显示大小为 28 dp。</T>
			{validProgress && <View style={{ height: 40, justifyContent: 'center' }}>
				<View style={{ height: 4, borderRadius: 2, backgroundColor: progress.track }}><View style={{ height: 4, width: '50%', backgroundColor: progress.fill }} /></View>
				<View style={{ position: 'absolute', left: '50%', marginLeft: -14, width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
					{thumb ? <Artwork uri={thumb.uri} size={28} fit='contain' /> : <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: progress.thumb }} />}
				</View>
			</View>}
			<ThemeTextInput accessibilityLabel='主题名称' value={name} maxLength={40} editable={!busy} onChangeText={setName} placeholder='给主题起个名字' style={{ color: theme.tokens.text.primary, backgroundColor: theme.tokens.surface.base, padding: 12, borderRadius: 10 }} />
			<Button disabled={busy || !previewCurrent || !name.trim() || !validProgress} onPress={() => void save()}>导出主题包</Button>
			<Button secondary onPress={() => setHelp(!help)}>{help ? '收起制作教程' : '查看制作教程'}</Button>
			{help && themeAuthorSteps.map((step) => <T key={step} size={12}>{step}</T>)}
			{themeDeveloperGuide.map((section) => <View key={section.title} style={{ gap: 6 }}><T weight='700'>{section.title}</T><T size={12}>{section.text}</T></View>)}
			<Button secondary onPress={() => void openGuide(themeDeveloperLinks.project)}>打开项目 GitHub</Button>
			<Button secondary onPress={() => void openGuide(themeDeveloperLinks.releases)}>GitHub Releases 发布说明</Button>
		</View>}
		<Button secondary disabled={busy} onPress={onClose}>返回主题列表</Button>
	</Card>
}
