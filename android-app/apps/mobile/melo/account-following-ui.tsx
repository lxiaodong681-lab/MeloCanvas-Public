import React, { useEffect, useRef } from 'react'
import { FlatList, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type {
	AccountFollowingSession,
	AccountFollowingState,
} from './account-following-session'
import type { Creator, CreatorScope } from './core/creators'
import { CreatorAvatar, creatorScopeLabel } from './creator-ui'
import {
	Button,
	Card,
	ControlRow,
	ControlTarget,
	Icon,
	IconButton,
	State,
	T,
	useTheme,
} from './ui'

export function AccountFollowingPage({
	state,
	session,
	onImported,
}: {
	state: AccountFollowingState
	session: AccountFollowingSession
	onImported?: () => void
}) {
	const theme = useTheme()
	const insets = useSafeAreaInsets()
	const review = state.review
	const mode = review ? 'review' : 'selection'
	const list = useRef<FlatList<Creator> | null>(null)
	const offsets = useRef({ selection: 0, review: 0 })
	useEffect(() => {
		offsets.current = { selection: 0, review: 0 }
	}, [state.open, state.accountName])
	useEffect(() => {
		const frame = requestAnimationFrame(() =>
			list.current?.scrollToOffset({
				offset: offsets.current[mode],
				animated: false,
			}),
		)
		return () => cancelAnimationFrame(frame)
	}, [mode, state.open, state.accountName])
	return (
		<View
			testID='account-following-page'
			style={{ flex: 1 }}
		>
			<View style={{ paddingHorizontal: 22, paddingVertical: 12 }}>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
					<IconButton
						name='back'
						label={review ? '返回关注选择' : '关闭账号关注导入'}
						onPress={review ? session.cancelReview : session.close}
					/>
					<T
						size={23}
						weight='700'
						style={{ flex: 1 }}
					>
						{review ? '确认导入关注' : '从 B 站导入关注'}
					</T>
				</View>
			</View>
			{(state.error || state.notice) && (
				<View style={{ paddingHorizontal: 22, paddingBottom: 12, gap: 10 }}>
					{!!state.error && (
						<Card>
							<T style={{ color: theme.tokens.state.error }}>{state.error}</T>
							{state.failedPage !== null && (
								<Button
									secondary
									disabled={state.loading}
									onPress={() => {
										void session.retry()
									}}
								>
									重试读取
								</Button>
							)}
						</Card>
					)}
					{!!state.notice && (
						<View accessibilityLiveRegion='polite'>
							<T
								size={12}
								style={{ color: theme.tokens.action.primary }}
							>
								{state.notice}
							</T>
						</View>
					)}
				</View>
			)}
			<FlatList
				ref={list}
				style={{ flex: 1 }}
				key={mode}
				data={review?.items ?? state.items}
				keyExtractor={(creator) => creator.mid}
				onScroll={(event) => {
					offsets.current[mode] = Math.max(0, event.nativeEvent.contentOffset.y)
				}}
				scrollEventThrottle={100}
				contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 24 }}
				ListHeaderComponent={
					<View style={{ gap: 12, paddingBottom: 16 }}>
						<T
							muted
							size={12}
						>
							{state.accountName ? `${state.accountName} 的 B 站关注。` : ''}
							音绘关注与 B 站独立，只导入你勾选的 UP 主，不会自动同步。
						</T>

						{review ? (
							<Card>
								<T weight='600'>
									将 {review.items.length} 位 UP 主加入音绘关注
								</T>
								<T
									muted
									size={12}
									style={{ marginTop: 8 }}
								>
									关注范围：{creatorScopeLabel[review.scope]}。已在音绘关注的 UP
									主保留原有设置，B 站关注不会发生变化。
								</T>
							</Card>
						) : state.items.length > 0 ? (
							<>
								<T
									weight='600'
									size={14}
								>
									导入后的关注范围
								</T>
								<ControlRow
									controlMinWidthsDp={[90, 90, 108]}
									style={{ gap: 8 }}
								>
									{(['all', 'music', 'listening'] as CreatorScope[]).map(
										(scope) => (
											<ControlTarget
												key={scope}
												accessibilityRole='radio'
												accessibilityLabel={`导入范围：${creatorScopeLabel[scope]}`}
												accessibilityState={{ checked: state.scope === scope }}
												onPress={() => session.setScope(scope)}
												style={({ pressed }) => ({
													minHeight: 48,
													paddingHorizontal: 12,
													paddingVertical: 12,
													alignItems: 'center',
													justifyContent: 'center',
													backgroundColor:
														state.scope === scope
															? theme.tokens.surface.tinted
															: theme.tokens.surface.base,
													opacity: pressed ? 0.65 : 1,
													borderRadius: 8,
													borderWidth: 1,
													borderColor:
														state.scope === scope
															? theme.tokens.action.primary
															: theme.tokens.border.subtle,
												})}
											>
												<T size={12}>{creatorScopeLabel[scope]}</T>
											</ControlTarget>
										),
									)}
								</ControlRow>
							</>
						) : null}
					</View>
				}
				renderItem={({ item: creator }) => {
					if (review)
						return (
							<View style={{ paddingVertical: 10 }}>
								<T size={14}>
									{creator.name} · mid {creator.mid}
								</T>
							</View>
						)
					const existing = state.existingMids.includes(creator.mid)
					const selected = state.selectedMids.includes(creator.mid)
					return (
						<ControlTarget
							key={creator.mid}
							minimumWidthDp={160}
							minimumHeightDp={76}
							accessibilityRole='checkbox'
							accessibilityLabel={`${creator.name}，mid ${creator.mid}${existing ? '，已在音绘关注' : ''}`}
							accessibilityState={{
								checked: selected || existing,
								disabled: existing || state.loading,
							}}
							disabled={existing || state.loading}
							onPress={() => session.toggle(creator.mid)}
							style={({ pressed }) => ({
								flexDirection: 'row',
								alignItems: 'center',
								gap: 12,
								minHeight: 76,
								paddingVertical: 12,
								borderBottomWidth: 1,
								borderBottomColor: theme.tokens.border.subtle,
								opacity: pressed ? 0.65 : existing ? 0.65 : 1,
							})}
						>
							<CreatorAvatar
								creator={creator}
								size={44}
							/>
							<View style={{ flex: 1, gap: 4 }}>
								<T
									weight='600'
									size={14}
									lines={2}
								>
									{creator.name}
								</T>
								<T
									muted
									size={11}
									lines={1}
								>
									{existing
										? '已在音绘关注 · 保留原有设置'
										: creator.bio || `mid ${creator.mid}`}
								</T>
							</View>
							<View
								style={{
									width: 24,
									height: 24,
									borderWidth: 1,
									borderRadius: 5,
									borderColor:
										selected || existing
											? theme.tokens.action.primary
											: theme.tokens.border.subtle,
									alignItems: 'center',
									justifyContent: 'center',
								}}
							>
								{(selected || existing) && (
									<Icon
										name='check'
										size={19}
										color={theme.tokens.action.primary}
									/>
								)}
							</View>
						</ControlTarget>
					)
				}}
				ListFooterComponent={
					review ? null : (
						<View style={{ gap: 12, paddingTop: 16 }}>
							{state.loading && (
								<State
									busy
									title='正在读取 B 站关注'
									message='仅加载列表，不会自动导入。'
								/>
							)}
							{!state.loading && !state.error && state.items.length === 0 && (
								<State
									title='暂无可导入的 B 站关注'
									message='你可以继续在音绘中独立关注喜欢的 UP 主。'
								/>
							)}
							{state.more && state.failedPage === null && (
								<Button
									secondary
									disabled={state.loading}
									onPress={() => {
										void session.loadMore()
									}}
								>
									继续读取 B 站关注
								</Button>
							)}
						</View>
					)
				}
			/>
			{(review || state.items.length > 0) && (
				<View
					style={{
						paddingHorizontal: 22,
						paddingTop: 12,
						paddingBottom: Math.max(12, insets.bottom),
						gap: 10,
						borderTopWidth: 1,
						borderTopColor: theme.tokens.border.subtle,
						backgroundColor: theme.tokens.surface.base,
					}}
				>
					<View accessibilityLiveRegion='polite'>
						<T size={12}>
							{review
								? '待确认 ' +
									review.items.length +
									' 位 · ' +
									creatorScopeLabel[review.scope]
								: '已读取 ' +
									state.items.length +
									(state.total === null ? '' : ' / ' + state.total) +
									' 位 · 已选 ' +
									state.selectedMids.length +
									' 位'}
						</T>
					</View>
					{review ? (
						<ControlRow
							controlMinWidthsDp={[144, 96]}
							style={{ gap: 10 }}
						>
							<Button
								testID='confirm-account-following-import'
								onPress={() => {
									if (session.confirmImport() > 0) onImported?.()
								}}
							>
								确认导入到音绘
							</Button>
							<Button
								secondary
								onPress={session.cancelReview}
							>
								返回选择
							</Button>
						</ControlRow>
					) : (
						<Button
							testID='review-account-following-import'
							disabled={state.loading || state.selectedMids.length === 0}
							onPress={() => {
								session.requestImport()
							}}
						>
							导入所选 {state.selectedMids.length} 位…
						</Button>
					)}
				</View>
			)}
		</View>
	)
}
