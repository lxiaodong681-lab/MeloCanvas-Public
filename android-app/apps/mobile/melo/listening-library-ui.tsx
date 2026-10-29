import React, { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { SettingsGroup, SettingsRow } from './settings-layout'
import { ScrollView, View } from 'react-native'
import { useThemeDialog } from './theme-dialog'

import { BiliParts, contentKindNames } from './bilibili-import-ui'
import { importEntryDescription } from './import-display'
import type {
	ListeningLibrarySession,
	ListeningLibraryState,
} from './listening-library-session'
import {
	Button,
	Card,
	ControlRow,
	ControlTarget,
	IconButton,
	T,
	shape,
	time,
	useTheme,
} from './ui'

export function ListeningLibraryPage({
	backRef,
	state,
	session,
	onPlay,
	onOrigin,
	playbackBusy,
	playbackError,
}: {
	backRef?: MutableRefObject<(() => boolean) | null>
	state: ListeningLibraryState
	session: ListeningLibrarySession
	onPlay: () => void
	onOrigin: (taskId: string, entryId: string) => void
	playbackBusy: boolean
	playbackError: string | null
}) {
	const confirmation = useThemeDialog()
	const [page, setPage] = useState<'main' | 'parts' | 'info'>('main')
	useEffect(() => { setPage('main') }, [state.item?.itemId, state.route])
	useLayoutEffect(() => {
		if (!backRef) return
		backRef.current = () => {
			if (state.route !== 'item' || page === 'main') return false
			setPage('main'); return true
		}
		return () => { backRef.current = null }
	}, [backRef, state.route, page])
	const scroll = useRef<ScrollView | null>(null),
		actionY = useRef(0),
		theme = useTheme(),
		c = theme.tokens
	const focus = () =>
		scroll.current?.scrollTo({ y: actionY.current, animated: false })
	const item = state.item,
		original = item
			? importEntryDescription(item.importOrigin, 'bilibili')
			: null
	return (
		<ScrollView
			key={`${page}:${state.route}:${item?.itemId ?? state.offset}:${state.bucket}`}
			ref={scroll}
			contentContainerStyle={{ padding: 20, paddingBottom: 90, gap: 12 }}
		>
			{confirmation.dialog}
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
				<IconButton
					name='back'
					label='返回听视频收藏上一步'
					onPress={() => page === 'main' ? session.back() : setPage('main')}
				/>
				<T
					size={23}
					weight='700'
					style={{ flex: 1 }}
				>
					{page === 'parts' ? '选择分 P' : page === 'info' ? '来源与管理' : state.bucket === 'listening' ? '听视频收藏' : '待分类原条目'}
				</T>
				<IconButton
					name='close'
					label='关闭听视频收藏列表'
					onPress={session.close}
				/>
			</View>
			{!!state.error && <T style={{ color: c.state.error }}>{state.error}</T>}
			{!!state.notice && <T size={12}>{state.notice}</T>}
			{state.route === 'list' && (
				<>
					<ControlRow
						testID='saved-video-bucket-tabs'
						controlMinWidthsDp={[104, 80]}
						gapDp={8}
						style={{ flexDirection: 'row', gap: 8 }}
					>
						{(['listening', 'unclassified'] as const).map((bucket) => {
							const selected = state.bucket === bucket
							return (
								<ControlTarget
									key={bucket}
									accessibilityRole='tab'
									accessibilityLabel={
										bucket === 'listening' ? '查看听视频收藏' : '查看待分类列表'
									}
									accessibilityState={{ selected }}
									onPress={() => session.open(bucket)}
									style={[
										shape(theme.components.button),
										{
											flex: 1,
											minHeight: 48,
											padding: 10,
											alignItems: 'center',
											justifyContent: 'center',
											backgroundColor: selected
												? c.surface.tinted
												: c.surface.card,
										},
									]}
								>
									<T
										weight={selected ? '700' : '400'}
										style={{
											color: selected ? c.action.primary : c.text.secondary,
											textAlign: 'center',
										}}
									>
										{bucket === 'listening' ? '听视频收藏' : '待分类'}
									</T>
								</ControlTarget>
							)
						})}
					</ControlRow>
					{!state.items.length && !state.error && (
						<Card>
							<T>本页暂无本地条目。</T>
						</Card>
					)}
					{state.items.map((saved, index) => {
						const info = importEntryDescription(saved.importOrigin, 'bilibili')
						return (
							<ControlTarget
								key={saved.itemId}
								minimumHeightDp={64}
								accessibilityRole='button'
								accessibilityLabel={`查看收藏原项 ${state.offset + index + 1} ${info.title}`}
								onPress={() => session.openItem(saved.itemId)}
							>
								<Card>
									<View style={{ gap: 8 }}>
										<T weight='700'>
											{state.offset + index + 1}. {info.title}
										</T>
										<T
											muted
											size={12}
										>
											{info.artists}，{contentKindNames[saved.contentKind]}
										</T>
									</View>
								</Card>
							</ControlTarget>
						)
					})}
					<T
						muted
						size={11}
					>
						本地列表第 {Math.floor(state.offset / 20) + 1} 页
					</T>
					<Button
						secondary
						disabled={!state.offset}
						onPress={session.previous}
					>
						上一页本地收藏
					</Button>
					<Button
						secondary
						disabled={!state.more}
						onPress={session.next}
					>
						下一页本地收藏
					</Button>
				</>
			)}
			{state.route === 'item' && item && original && (
				<>
					<T
						size={21}
						weight='700'
					>
						{original.title}
					</T>
					<T size={12}>
						{original.artists}，{contentKindNames[item.contentKind]}
					</T>
					{!item.bvid && <T muted>原条目未提供 BV，暂时不能读取分 P 或收听，仍可保留、分类或移除。</T>}
					{page === 'main' && <SettingsGroup>
						<SettingsRow label='选择分 P 并播放' disabled={!item.bvid} onPress={() => {
							setPage('parts')
							if (!state.video && !state.busy && !state.transportBusy) void session.readVideo()
						}} />
						<SettingsRow label='来源与管理' onPress={() => setPage('info')} />
					</SettingsGroup>}
					{page === 'info' && <>
					<T
						muted
						size={11}
					>
						重复条目分别保留，音乐合集保持音乐类别。音轨可用性未核验。
					</T>
					<T
						muted
						size={11}
					>
						{item.bvid ? '保留原视频来源' : '原目录缺少视频身份'}，{' '}
						{item.verification.catalogVerified
							? '保存时已读取视频目录'
							: '保存时未核验视频目录'}{' '}
						音轨未核验
					</T>
					<T
						size={11}
						muted
					>
						原媒体 {item.importOrigin.originalEntryId ?? '未提供'}，BV{' '}
						{item.bvid ?? '未提供'}，{' '}
						{original.duration === null
							? '原时长缺失'
							: time(original.duration)}
					</T>
					<Button
						secondary
						onPress={() =>
							onOrigin(item.importOrigin.taskId, item.importOrigin.entryId)
						}
					>
						查看原任务证据与人工分类
					</Button>
					<Button
						secondary
						onPress={() =>
							confirmation.show(
								'移除这一本地收藏原项？',
								'仅移除此出现项，不删除音源、断点、喜欢、音乐歌单或导入历史。',
								[
									{ text: '保留', style: 'cancel' },
									{
										text: '移除本地收藏原项',
										style: 'destructive',
										onPress: session.remove,
									},
								],
							)
						}
					>
						移除本地收藏原项
					</Button>
					</>}
					{page === 'parts' && <>
					{!item.bvid ? (
						<Card>
							<T>
								原条目未提供 BV，暂时不能读取分 P 或收听，仍可保留、分类或移除。
							</T>
						</Card>
					) : (
						<>
							<Button
								secondary
								disabled={state.busy || state.transportBusy}
								onPress={() => {
									void session.readVideo()
								}}
							>
								{state.busy ? '正在读取分 P…' : '刷新分 P'}
							</Button>
							{state.video && (
								<>
									<View
										onLayout={(event) => {
											actionY.current = event.nativeEvent.layout.y
										}}
									>
										<Card>
											<View style={{ gap: 10 }}>
												<T>
													{state.video.parts.find(part => part.source.cid === state.selectedCid)?.title ?? '请选择要收听的分 P'}
												</T>
												<Button
													disabled={
														!state.selectedCid ||
														state.playback.busy ||
														playbackBusy
													}
													onPress={onPlay}
												>
													以听视频收听所选 P
												</Button>
												{!!state.playback.error && (
													<T style={{ color: c.state.error }}>
														{state.playback.error}
													</T>
												)}
												{!!playbackError && (
													<T style={{ color: c.state.error }}>
														{playbackError}
													</T>
												)}
												<T
													muted
													size={11}
												>
													保留各分 P 的收听进度。原分 P 已移除时，请重新选择。
												</T>
											</View>
										</Card>
									</View>
									<BiliParts
										video={state.video}
										cid={state.selectedCid}
										select={(cid) => {
											session.selectCid(cid)
											focus()
										}}
									/>
								</>
							)}
						</>
					)}
					</>}
				</>
			)}
		</ScrollView>
	)
}
