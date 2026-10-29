import React from 'react'
import { ScrollView, View } from 'react-native'
import { useThemeDialog } from './theme-dialog'

import type { RecommendationReason } from './core/recommendations'
import type { RecommendationSession } from './recommendation-session'
import {
	Artwork,
	Button,
	Card,
	ControlRow,
	ControlTarget,
	IconButton,
	State,
	T,
	time,
	useTheme,
	useThemeRendering,
} from './ui'

const labels: Record<string, string> = {
	liked: '你喜欢的音源',
	playlist: '来自你的本地歌单',
	'saved-music': '你保存的音乐音源',
	'imported-song': '已核对导入歌曲',
}
export const recommendationReasonText = (reason: RecommendationReason) =>
	labels[reason] ?? '来源说明暂不可用'

function FeedbackPageAction({
	children,
	...props
}: React.ComponentProps<typeof Button>) {
	const rendering = useThemeRendering()
	const button = <Button {...props}>{children}</Button>
	return rendering?.controlRowLayout ? (
		<View style={{ flex: 1 }}>{button}</View>
	) : (
		button
	)
}

function RecommendationFeedback({
	state,
	session,
}: {
	state: ReturnType<RecommendationSession['getSnapshot']>
	session: RecommendationSession
}) {
	const c = useTheme().tokens,
		page = state.feedbackPage
	const confirmation = useThemeDialog()
	const blocked = state.busy || state.resetConfirming
	const items =
		page?.items.filter(
			(item) => !state.restoredSourceIds.includes(item.sourceId),
		) ?? []
	const confirmReset = () => {
		const decide = session.prepareReset()
		if (!decide) return
		confirmation.show(
			'重置本地推荐？',
			'仅清除本地推荐的选择与不感兴趣反馈，并重新生成当前推荐。不会删除喜欢、歌单、关注，也不会更改播放。',
			[
				{ text: '保留当前推荐', style: 'cancel', onPress: () => decide(false) },
				{
					text: '确认重置本地推荐',
					style: 'destructive',
					onPress: () => decide(true),
				},
			],
			{ cancelable: true, onDismiss: () => decide(false) },
		)
	}
	return (
		<ScrollView
			testID='recommendation-feedback-page'
			contentContainerStyle={{ padding: 20, paddingBottom: 24, gap: 14 }}
		>
			{confirmation.dialog}
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
				<IconButton
					name='back'
					label='返回每日推荐'
					onPress={session.back}
				/>
				<T
					size={23}
					weight='700'
					style={{ flex: 1 }}
				>
					管理不感兴趣
				</T>
			</View>
			<Card>
				<T size={12}>
					这里只管理此设备上的音源反馈。恢复后可再次参与后续推荐，不保证立即出现。
				</T>
			</Card>
			{!!state.notice && <T size={12}>{state.notice}</T>}
			{!!state.error && (
				<Card>
					<T style={{ color: c.state.error }}>推荐操作未完成</T>
					<T size={12}>{state.error}</T>
				</Card>
			)}
			{!!state.feedbackError && (
				<Card>
					<T style={{ color: c.state.error }}>反馈列表暂时无法读取</T>
					<T size={12}>{state.feedbackError}</T>
					<Button
						onPress={() => session.loadDismissed()}
						disabled={blocked}
					>
						重试读取反馈列表
					</Button>
				</Card>
			)}
			{state.feedbackStale && (
				<T
					size={12}
					muted
				>
					下方保留尚未恢复的旧列表，分页统计已过期；请重新读取后再恢复或翻页。
				</T>
			)}
			{!!page && !state.feedbackStale && (
				<T
					size={12}
					muted
				>
					{page.total === 0
						? '共 0 条反馈'
						: `共 ${page.total} 条反馈 · 第 ${page.page} 页 / ${page.totalPages} 页`}
				</T>
			)}
			{!!page && !state.feedbackStale && page.total === 0 && (
				<State
					title='还没有不感兴趣的音源'
					message='你标记过的音源会在这里保留，可随时恢复。'
				/>
			)}
			{!!page &&
				!state.feedbackStale &&
				page.total > 0 &&
				page.items.length === 0 && (
					<State
						title='这一页已没有反馈'
						message='列表可能已变化，请返回上一页查看。'
					/>
				)}
			{items.map((item) => (
				<Card key={item.sourceId}>
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
						{!!item.source && (
							<Artwork
								uri={item.source.artwork}
								size={48}
							/>
						)}
						<View style={{ flex: 1 }}>
							<T
								weight='600'
								lines={2}
							>
								{item.source?.originalTitle ?? '音源已不在本机'}
							</T>
							{item.source ? (
								<T
									muted
									size={11}
								>
									UP · {item.source.uploader}
								</T>
							) : (
								<T
									muted
									size={11}
								>
									音源标识 · {item.sourceId}
								</T>
							)}
							<T
								muted
								size={11}
							>
								标记时间 ·{' '}
								{Number.isFinite(new Date(item.dismissedAt).getTime())
									? new Date(item.dismissedAt).toLocaleString()
									: '时间无法显示'}
							</T>
						</View>
						<IconButton
							name='repeat'
							label={`恢复此音源 ${item.source?.originalTitle ?? item.sourceId}`}
							disabled={blocked || state.feedbackStale}
							onPress={() =>
								session.restoreSource(item.sourceId, state.feedbackRevision)
							}
						/>
					</View>
				</Card>
			))}
			{!!page && !state.feedbackStale && page.total > 0 && (
				<ControlRow
					controlMinWidthsDp={[88, 88]}
					gapDp={10}
					style={{ flexDirection: 'row', gap: 10 }}
				>
					<FeedbackPageAction
						secondary
						disabled={blocked || page.page <= 1}
						onPress={() =>
							session.loadDismissed(
								Math.max(1, Math.min(page.page - 1, page.totalPages)),
							)
						}
					>
						上一页反馈
					</FeedbackPageAction>
					<FeedbackPageAction
						secondary
						disabled={blocked || page.page >= page.totalPages}
						onPress={() => session.loadDismissed(page.page + 1)}
					>
						下一页反馈
					</FeedbackPageAction>
				</ControlRow>
			)}
			<Card>
				<T
					size={16}
					weight='700'
				>
					重置本地推荐
				</T>
				<T
					size={12}
					muted
					style={{ marginTop: 8 }}
				>
					只清除本地推荐选择与不感兴趣反馈，不会删除喜欢、歌单或关注，也不会改变播放。
				</T>
				<View style={{ marginTop: 12 }}>
					<Button
						secondary
						disabled={blocked}
						onPress={confirmReset}
					>
						重置本地推荐
					</Button>
				</View>
			</Card>
		</ScrollView>
	)
}

export function RecommendationPage({
	state,
	session,
	onPlay,
}: {
	state: ReturnType<RecommendationSession['getSnapshot']>
	session: RecommendationSession
	onPlay: (sourceId: string) => void
}) {
	const c = useTheme().tokens,
		snapshot = state.snapshot
	if (state.view === 'dismissed')
		return (
			<RecommendationFeedback
				state={state}
				session={session}
			/>
		)
	return (
		<ScrollView
			testID='recommendation-page'
			contentContainerStyle={{ padding: 20, paddingBottom: 24, gap: 14 }}
		>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
				<IconButton
					name='back'
					label='返回发现页'
					onPress={session.back}
				/>
				<T
					size={23}
					weight='700'
					style={{ flex: 1 }}
				>
					每日推荐
				</T>
			</View>
			<Card>
				<T
					size={20}
					weight='700'
				>
					继续听熟悉的音乐
				</T>
				<T
					muted
					size={12}
					style={{ marginTop: 8 }}
				>
					仅从已核对并保存的本机歌曲中挑选。播放音频仍可能需要网络。
				</T>
				{!!snapshot && (
					<T
						muted
						size={12}
						style={{ marginTop: 8 }}
					>
						日期 · {snapshot.localDate}
					</T>
				)}
			</Card>
			<Button
				secondary
				onPress={session.openDismissed}
				disabled={state.busy}
				testID='manage-dismissed-recommendations'
			>
				管理不感兴趣
			</Button>
			{!!state.error && (
				<Card>
					<T style={{ color: c.state.error }}>本地推荐暂时无法读取</T>
					<T
						size={12}
						style={{ marginTop: 8 }}
					>
						{state.error}
					</T>
					{!!snapshot && (
						<T
							muted
							size={12}
							style={{ marginTop: 8 }}
						>
							下方保留上次成功读取的内容。
						</T>
					)}
					<View style={{ marginTop: 12 }}>
						<Button
							onPress={session.load}
							disabled={state.busy}
						>
							重试读取每日推荐
						</Button>
					</View>
				</Card>
			)}
			{!!snapshot && (
				<>
					<Button
						onPress={session.refresh}
						disabled={state.busy}
					>
						换一批
					</Button>
					<T
						size={11}
						muted
					>
						换一批只调整本机候选，不改变播放队列；候选较少时可能重复。
					</T>
					{snapshot.canUndo && (
						<Button
							secondary
							onPress={session.undo}
							disabled={state.busy}
						>
							撤销上次不感兴趣
						</Button>
					)}
				</>
			)}
			{!!state.notice && <T size={12}>{state.notice}</T>}
			{!!state.playError && (
				<T
					size={12}
					style={{ color: c.state.error }}
				>
					{state.playError}
				</T>
			)}
			{!!snapshot && snapshot.items.length === 0 && (
				<State
					title='暂时没有可推荐的本机音源'
					message='先在导入中核对并保存歌曲，再来看看；不感兴趣的音源也可能已被排除。'
				/>
			)}
			{snapshot?.items.map(({ source, reasons }) => (
				<Card key={source.id}>
					<ControlRow
						controlMinWidthsDp={[108, 48]}
						gapDp={8}
						style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
					>
						<ControlTarget
							minimumHeightDp={64}
							accessibilityRole='button'
							accessibilityLabel={`播放每日推荐音源 ${source.originalTitle}`}
							accessibilityState={{ busy: state.playingId === source.id }}
							onPress={() => onPlay(source.id)}
							style={{
								flex: 1,
								flexDirection: 'row',
								alignItems: 'center',
								gap: 12,
								minHeight: 64,
							}}
						>
							<Artwork
								uri={source.artwork}
								size={48}
							/>
							<View style={{ flex: 1 }}>
								<T
									weight='600'
									lines={2}
								>
									{source.originalTitle}
								</T>
								<T
									muted
									size={11}
									style={{ marginTop: 4 }}
								>
									UP · {source.uploader} · {time(source.duration)}
								</T>
								<T
									muted
									size={11}
									style={{ marginTop: 4 }}
								>
									{reasons.map(recommendationReasonText).join(' · ')}
								</T>
								{state.playingId === source.id && (
									<T size={11}>正在准备此音源…</T>
								)}
							</View>
						</ControlTarget>
						<IconButton
							name='close'
							label={`对此音源不感兴趣 ${source.originalTitle}`}
							disabled={state.busy}
							onPress={() => session.dismiss(source.id)}
						/>
					</ControlRow>
				</Card>
			))}
		</ScrollView>
	)
}
