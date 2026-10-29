import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { FlatList, ScrollView, View } from 'react-native'

import type { BilibiliThemeItem, BilibiliThemeResources } from './bilibili-theme'
import { defaultBackgroundAdjustments } from './theme-background'
import { ThemeAdjustmentSlider } from './theme-author-ui'
import { ThemeTextInput } from './theme-input'
import { SettingsGroup, SettingsRow } from './settings-layout'
import { ThemeSubpage } from './theme-subpage'
import { Button, IconButton, State, T, useTheme } from './ui'

export function BilibiliThemeEntry({ disabled, onPreview, onWorkingChange, onOpenChange, renderPreview, onCancelPreview }: {
	disabled: boolean; onPreview: (bytes: Uint8Array, signal?: AbortSignal) => Promise<boolean>; onWorkingChange: (busy: boolean) => void; onOpenChange?: (open: boolean) => void; renderPreview?: (onBack: () => void) => ReactNode; onCancelPreview?: () => void
}) {
	const theme = useTheme()
	const [route, setRoute] = useState<'home' | 'owned' | 'search' | 'detail' | 'help' | 'adjust' | null>(null)
	const [keyword, setKeyword] = useState('')
	const [searched, setSearched] = useState(false)
	const [failed, setFailed] = useState(false)
	const [results, setResults] = useState<BilibiliThemeItem[]>([])
	const [page, setPage] = useState(1), [query, setQuery] = useState('')
	const [source, setSource] = useState<'search' | 'owned'>('search')
	const [more, setMore] = useState(false), [notice, setNotice] = useState('')
	const [busy, setBusy] = useState(false)
	const [prepared, setPrepared] = useState<{ item: BilibiliThemeItem; resources: BilibiliThemeResources } | null>(null)
	const [backgroundId, setBackgroundId] = useState<number>()
	const [adjustments, setAdjustments] = useState({ ...defaultBackgroundAdjustments })
	const active = useRef<AbortController | null>(null)
	const alive = useRef(true)
	const listRoute = source === 'owned' ? 'owned' : 'search'
	function navigate(next: typeof route) { setRoute(next); onOpenChange?.(next !== null) }
	function back() {
		active.current?.abort()
		setNotice(''); setFailed(false)
		if (route === 'detail') { onCancelPreview?.(); navigate(listRoute) }
		else if (route === 'adjust') {
			if (busy) { onCancelPreview?.(); navigate(listRoute) }
			else navigate('detail')
		}
		else navigate(route === 'home' ? null : 'home')
	}
	useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort() } }, [])
	async function run(action: (signal: AbortSignal) => Promise<void>) {
		if (active.current || disabled) return
		const controller = new AbortController()
		active.current = controller; setBusy(true); onWorkingChange(true); setNotice(''); setFailed(false)
		try { await action(controller.signal) }
		catch (error) { if (alive.current && !controller.signal.aborted) { setFailed(true); setNotice(error instanceof Error ? error.message : '主题读取失败，请重试') } }
		finally { active.current = null; if (alive.current) { setBusy(false); onWorkingChange(false) } }
	}
	function search(next: number, submitted = false, owned = false) {
		const text = submitted ? keyword.trim() : query
		if (active.current || disabled || (!owned && !text)) return
		setSource(owned ? 'owned' : 'search'); setQuery(text); setPage(next); setSearched(true); setResults([])
		void run(async (signal) => {
			const mobile = await import('./bilibili-theme-mobile')
			const result = owned ? await mobile.listMobileOwnedBilibiliThemes(next, signal) : await mobile.searchMobileBilibiliThemes(text, next, signal)
			if (!alive.current || signal.aborted) return
			setResults(result.items); setPage(next); setQuery(text); setMore(result.hasMore); setSource(owned ? 'owned' : 'search')
			setNotice(result.items.length ? '' : owned ? '此账号暂无可导入主题。' : '未找到主题，请换个名称，或返回查看“我的 B站主题”。')
		})
	}
	function download(item: BilibiliThemeItem, update = false) {
		void run(async (signal) => {
			if (!update) { setPrepared(null); setBackgroundId(undefined); setAdjustments({ ...defaultBackgroundAdjustments }) }
			const mobile = await import('./bilibili-theme-mobile')
			const bytes = await mobile.importMobileBilibiliTheme(item, signal, (message) => { if (alive.current && !signal.aborted) setNotice(message) }, {
				...(update ? { backgroundId, adjustments } : {}),
				onResources: (resources) => { if (alive.current && !signal.aborted) setPrepared({ item, resources }) },
			})
			if (!alive.current || signal.aborted) return
			setNotice('正在校验并准备预览…')
			const success = await onPreview(bytes, signal)
			if (alive.current && !signal.aborted) {
				if (success) { setNotice(''); navigate('detail') }
				else { setFailed(true); setNotice('主题预览未完成，请重试。') }
			}
		})
	}

	const locked = busy || disabled
	const title = route === 'owned' ? '我的 B站主题' : route === 'search' ? '搜索 B站主题' : route === 'detail' ? '主题预览' : route === 'help' ? '导入说明' : route === 'adjust' ? '背景与取景' : 'B站个性主题'
	const openOwned = () => { navigate('owned'); search(1, false, true) }
	return <>
		<SettingsRow label='从 B站导入个性主题' disabled={disabled} onPress={() => navigate('home')} />
		{route && <ThemeSubpage title={title} onBack={back} scroll={route !== 'owned' && route !== 'search' && route !== 'detail'}>
			{route === 'home' && <SettingsGroup>
				<SettingsRow label='我的 B站主题' detail='浏览账号已有的装扮与收藏集' disabled={locked} onPress={openOwned} />
				<SettingsRow label='搜索主题' disabled={locked} onPress={() => { setSource('search'); setResults([]); setSearched(false); setNotice(''); navigate('search') }} />
				<SettingsRow label='导入说明' onPress={() => navigate('help')} />
			</SettingsGroup>}
			{route === 'help' && <View style={{ gap: 16 }}>
				<T>从“我的 B站主题”读取已登录账号的装扮，或按名称搜索。选中后先预览，确认应用后才会切换。</T>
				<T muted>支持配色、导航图标、进度条图片、背景和头像挂件。背景可单独选择与调整，原头像保留。不启用视频和循环动画。</T>
				<T muted>导入主题用于浅色模式。没有深色配置时使用宇宙外观，切回浅色恢复。</T>
			</View>}
			{(route === 'owned' || route === 'search') && <>
				{route === 'search' && <View style={{ paddingHorizontal: 20, paddingVertical: 12, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
					<ThemeTextInput accessibilityLabel='B站主题名称' value={keyword} maxLength={80} editable={!locked} onChangeText={setKeyword} placeholder='搜索装扮或收藏集' returnKeyType='search' onSubmitEditing={() => search(1, true)} style={{ flex: 1, minHeight: 48, padding: 12, color: theme.tokens.text.primary, backgroundColor: theme.tokens.surface.card, borderRadius: 12 }} />
					<IconButton name='search' label='搜索 B站主题' disabled={locked || !keyword.trim()} onPress={() => search(1, true)} />
				</View>}
				<FlatList key={route} data={results} keyExtractor={(item) => item.id} keyboardShouldPersistTaps='handled' initialNumToRender={12} windowSize={5} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}
					renderItem={({ item }) => <SettingsRow label={item.name} detail={item.kind === 'collection' ? '收藏集' : undefined} disabled={locked} onPress={() => download(item)} />}
					ListEmptyComponent={!busy && !notice ? <State title={searched ? '暂无主题' : '搜索 B站个性主题'} message={searched ? '试试其他名称，或返回查看账号已有的主题。' : '输入装扮或收藏集名称。'} /> : null}
					ListFooterComponent={<View style={{ gap: 12, paddingTop: 16 }}>
						{busy && <State title={notice || '正在读取主题'} busy />}
						{!busy && !!notice && <T>{notice}</T>}
						{!busy && failed && <Button secondary onPress={() => search(page, false, source === 'owned')}>重试读取</Button>}
						{!busy && results.length > 0 && (page > 1 || more) && <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
							<View style={{ flex: 1 }}><Button secondary disabled={locked || page === 1} onPress={() => search(page - 1, false, source === 'owned')}>上一页主题</Button></View><T size={13}>{page}</T>
							<View style={{ flex: 1 }}><Button secondary disabled={locked || !more} onPress={() => search(page + 1, false, source === 'owned')}>下一页主题</Button></View>
						</View>}
						{busy && <Button secondary onPress={() => active.current?.abort()}>取消读取 B站主题</Button>}
					</View>} />
			</>}
			{route === 'detail' && <>
				{!!prepared?.resources.backgrounds.length && <View style={{ paddingHorizontal: 20 }}><SettingsRow label='背景与取景' disabled={locked} onPress={() => navigate('adjust')} /></View>}
				{renderPreview?.(() => navigate(listRoute))}
			</>}
			{route === 'adjust' && prepared && <>
				<T size={13} muted>调整后更新预览，确认应用后生效。</T>
				<ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
					{prepared.resources.backgrounds.map((background, index) => <Button key={background.id} secondary={background.id !== (backgroundId ?? prepared.resources.backgrounds[0]?.id)} disabled={locked} onPress={() => setBackgroundId(background.id)}>{background.name || '背景 ' + (index + 1)}</Button>)}
				</ScrollView>
				{(['transparency', 'zoom', 'horizontal', 'vertical'] as const).map((key) => <ThemeAdjustmentSlider key={key} label={{ transparency: '壁纸透明度', zoom: '壁纸缩放', horizontal: '水平取景', vertical: '垂直取景' }[key]} value={key === 'zoom' ? adjustments.zoom * 100 : adjustments[key]} minimum={key === 'zoom' ? 100 : 0} maximum={key === 'zoom' ? 400 : 100} disabled={locked} onCommit={(value) => setAdjustments((current) => ({ ...current, [key]: key === 'zoom' ? value / 100 : value }))} />)}
				{!!notice && <T>{notice}</T>}
				<Button disabled={locked} onPress={() => download(prepared.item, true)}>{busy ? '正在更新预览…' : '更新主题预览'}</Button>
			</>}
		</ThemeSubpage>}
	</>
}
