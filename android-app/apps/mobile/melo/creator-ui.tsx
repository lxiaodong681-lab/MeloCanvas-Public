import React, { useState } from 'react'
import { Modal, ScrollView, StyleSheet, View } from 'react-native'

import type { Creator, CreatorScope } from './core/creators'
import type { Source } from './core/model'
import type { CreatorSession, CreatorState } from './creator-session'
import { ConfirmationModal } from './theme-dialog'
import {
	Artwork,
	Backdrop,
	Button,
	Card,
	ControlRow,
	ControlTarget,
	Icon,
	IconButton,
	State,
	T,
	shape,
	time,
	useTheme,
} from './ui'

export const creatorScopeLabel: Record<CreatorScope, string> = {
	all: '全部投稿',
	music: '音乐投稿',
	listening: '听视频内容',
}

export function CreatorAvatar({
	creator,
	size = 68,
}: {
	creator: Creator
	size?: number
}) {
	const theme = useTheme()
	const frame = theme.components.playerFrame
	const style = {
		width: size,
		height: size,
		borderRadius:
			frame === 'stacked' ? size / 2 : frame === 'arch' ? size / 2 : 8,
		borderBottomLeftRadius:
			frame === 'arch' ? 8 : frame === 'stacked' ? size / 2 : 8,
		borderBottomRightRadius:
			frame === 'arch' ? 8 : frame === 'stacked' ? size / 2 : 8,
	}
	return (
		<View
			style={[
				style,
				{
					alignItems: 'center',
					justifyContent: 'center',
					backgroundColor: theme.tokens.surface.tinted,
					borderWidth: frame === 'tilted' ? 1.5 : 1,
					borderColor: theme.tokens.border.strong,
					transform: frame === 'tilted' ? [{ rotate: '-3deg' }] : [],
				},
			]}
		>
			{creator.avatar ? (
				<Artwork
					uri={creator.avatar}
					style={style}
					fit='cover'
				/>
			) : (
				<Icon
					name='user'
					size={size > 55 ? 30 : 22}
					color={theme.tokens.text.secondary}
				/>
			)}
		</View>
	)
}

export function CreatorLibraryEntry({ onPress }: { onPress: () => void }) {
	const theme = useTheme()
	return (
		<ControlTarget
			minimumWidthDp={148}
			minimumHeightDp={70}
			accessibilityRole='button'
			accessibilityLabel='管理本地关注的 UP 主'
			onPress={onPress}
			style={{ marginTop: 24, minHeight: 70 }}
		>
			<Card>
				<View style={[s.row, { gap: 12 }]}>
					<Icon
						name='user'
						color={theme.tokens.action.primary}
					/>
					<View style={{ flex: 1 }}>
						<T weight='600'>本地关注的 UP 主</T>
						<T
							muted
							size={11}
							style={{ marginTop: 4 }}
						>
							管理关注范围 · 保存在本机
						</T>
					</View>
					<Icon
						name='arrow'
						size={18}
						color={theme.tokens.text.secondary}
					/>
				</View>
			</Card>
		</ControlTarget>
	)
}

export function CreatorOverlay({
	state,
	session,
	playbackError,
	onPlay,
	onOpenSpace,
	topInset,
	bottomInset,
	reducedMotion,
	remoteProfile,
	remotePosts,
}: {
	state: CreatorState
	session: CreatorSession
	playbackError: string
	onPlay: (source: Source, mode: 'music' | 'listening') => void
	onOpenSpace: (url: string) => Promise<unknown>
	topInset: number
	bottomInset: number
	reducedMotion: boolean
	remoteProfile?: React.ReactNode
	remotePosts?: React.ReactNode
}) {
	const theme = useTheme()
	const c = theme.tokens
	const route = state.routes.at(-1)
	const formOpen = state.scopeForm !== null && !state.unfollowConfirm
	const creator = state.creator
	return (
		<Modal
			visible={!!route && !state.suspended}
			animationType={reducedMotion ? 'none' : 'slide'}
			onRequestClose={session.back}
		>
			<View
				style={{
					flex: 1,
					paddingTop: topInset,
					backgroundColor: c.surface.base,
				}}
			>
				<Backdrop />
				{state.unfollowConfirm && <ConfirmationModal title='取消本地关注？' onCancel={session.closeForm}>
					<T>只取消对「{creator?.name}」的本机关注，B站关注关系和音乐资料会保留。</T>
					{!!state.error && <T>{state.error}</T>}
					<Button secondary onPress={session.closeForm}>保留关注</Button>
					<Button onPress={session.unfollow}>确认取消本地关注</Button>
				</ConfirmationModal>}
				<ScrollView
					key={route?.kind === 'profile' ? route.mid : 'following'}
					contentContainerStyle={{
						paddingHorizontal: 22,
						paddingTop: 14,
						paddingBottom: bottomInset + 28,
					}}
					testID='creator-page'
				>
					<View
						style={[
							s.row,
							{ justifyContent: 'space-between', marginBottom: 20 },
						]}
					>
						<IconButton
							name='back'
							label={
								formOpen
									? '返回 UP 主页'
									: state.routes.length > 1
										? '返回本地关注列表'
										: '返回来源页面'
							}
							onPress={session.back}
						/>
						<T
							weight='600'
							size={16}
							style={{ flex: 1, textAlign: 'center' }}
						>
							{formOpen
								? '本地关注设置'
								: route?.kind === 'following'
									? '本地关注'
									: 'UP 主主页'}
						</T>
						<View style={{ width: 48 }} />
					</View>
					{!!playbackError && (
						<Card style={{ marginBottom: 14 }}>
							<T
								size={12}
								style={{ color: c.state.error }}
							>
								播放器：{playbackError}
							</T>
						</Card>
					)}
					{state.playbackBusy && (
						<Card style={{ marginBottom: 14 }}>
							<T size={12}>正在准备音源…</T>
							<View style={{ marginTop: 12 }}>
								<Button
									secondary
									onPress={session.cancelPlayback}
								>
									取消本次播放
								</Button>
							</View>
						</Card>
					)}
					{!!state.error && (
						<Card style={{ marginBottom: 14 }}>
							<T
								size={12}
								style={{ color: c.state.error }}
							>
								{state.error}
							</T>
							<View style={{ marginTop: 12 }}>
								<Button
									secondary
									onPress={session.refresh}
								>
									重新读取本地资料
								</Button>
							</View>
						</Card>
					)}
					{!!state.notice && (
						<Card style={{ marginBottom: 14 }}>
							<T size={12}>{state.notice}</T>
						</Card>
					)}
					{route?.kind === 'following' ? (
						<>
							<T
								size={23}
								weight='700'
							>
								关注的声音，从这里找到
							</T>
							<T
								muted
								size={12}
								style={{ marginTop: 12, marginBottom: 20 }}
							>
								音绘关注单独保存在本机，可以按音乐或听视频设置收听范围。
							</T>
							{state.following.length
								? state.following.map(({ creator: followed, subscription }) => (
										<ControlTarget
											minimumWidthDp={136}
											minimumHeightDp={90}
											key={followed.mid}
											accessibilityRole='button'
											accessibilityLabel={`打开已关注 UP 主 ${followed.name}，mid ${followed.mid}`}
											onPress={() => session.openProfile(followed.mid)}
											style={[
												s.row,
												{
													gap: 12,
													minHeight: 90,
													borderBottomWidth: 1,
													borderBottomColor: c.border.subtle,
												},
											]}
										>
											<CreatorAvatar
												creator={followed}
												size={48}
											/>
											<View style={{ flex: 1, gap: 5 }}>
												<T
													weight='600'
													lines={2}
												>
													{followed.name}
												</T>
												<T
													muted
													size={11}
												>
													{creatorScopeLabel[subscription.scope]}
												</T>
											</View>
											<Icon
												name='arrow'
												size={16}
												color={c.text.secondary}
											/>
										</ControlTarget>
									))
								: !state.error && (
										<State
											title='还没有本地关注'
											message='在音源信息、搜索结果更多或听视频 UP 名称处打开主页，即可关注。'
										/>
									)}
						</>
					) : !creator ? (
						<State
							title='UP 主资料暂时无法读取'
							message='请重新读取本地资料，或返回音源重新进入。'
							retry={session.refresh}
						/>
					) : formOpen ? (
						<>
							<T
								size={24}
								weight='700'
							>
								{state.subscription ? '修改关注范围' : '关注 UP 主'}
							</T>
							<T
								size={15}
								style={{ marginTop: 12 }}
							>
								{creator.name}
							</T>
							<T
								muted
								size={12}
								style={{ marginTop: 12, marginBottom: 18 }}
							>
								关注保存在本机，不同步到 B 站；通知默认关闭。
							</T>
								<>
									{(['all', 'music', 'listening'] as const).map((scope) => (
										<ControlTarget
											minimumWidthDp={83}
											minimumHeightDp={58}
											key={scope}
											accessibilityRole='radio'
											accessibilityLabel={`关注范围：${creatorScopeLabel[scope]}`}
											accessibilityState={{
												checked: state.scopeForm === scope,
											}}
											onPress={() => session.setScope(scope)}
											style={[
												s.row,
												{
													minHeight: 58,
													gap: 12,
													borderBottomWidth: 1,
													borderBottomColor: c.border.subtle,
												},
											]}
										>
											<View
												style={{
													width: 23,
													height: 23,
													borderRadius: 12,
													borderWidth: 1,
													borderColor:
														state.scopeForm === scope
															? c.action.primary
															: c.border.strong,
													alignItems: 'center',
													justifyContent: 'center',
												}}
											>
												{state.scopeForm === scope && (
													<View
														style={{
															width: 11,
															height: 11,
															borderRadius: 6,
															backgroundColor: c.action.primary,
														}}
													/>
												)}
											</View>
											<T>{creatorScopeLabel[scope]}</T>
										</ControlTarget>
									))}
									<View style={{ marginTop: 18 }}>
										<Button onPress={session.saveScope}>
											{state.subscription ? '保存关注范围' : '保存本地关注'}
										</Button>
									</View>
								</>
						</>
					) : (
						<>
							<Card>
								<View style={[s.row, { gap: 12, alignItems: 'flex-start' }]}>
									<CreatorAvatar creator={creator} />
									<View style={{ flex: 1 }}>
										<T
											size={24}
											weight='700'
											style={{ marginTop: 6 }}
										>
											{creator.name}
										</T>
										<T
											muted
											size={11}
											style={{ marginTop: 8 }}
										>
											Bilibili · mid {creator.mid}
										</T>
									</View>
								</View>
								<T
									muted
									size={12}
									style={{ marginTop: 16 }}
								>
									{creator.bio?.trim() || '暂无简介'}
								</T>
								<T
									muted
									size={10}
									style={{ marginTop: 8 }}
								>
									资料保存于本机
								</T>
								<View style={{ marginTop: 18 }}>
									<Button
										disabled={!state.profileLoaded}
										onPress={session.requestScope}
									>
										{state.subscription ? '已关注 · 修改范围' : '关注 UP 主'}
									</Button>
								</View>
								{state.subscription && (
									<>
										<T
											muted
											size={11}
											style={{ marginTop: 12 }}
										>
											当前范围：{creatorScopeLabel[state.subscription.scope]} ·
											通知关闭
										</T>
										<ControlTarget
											accessibilityRole='button'
											accessibilityLabel='取消本地关注'
											onPress={session.requestUnfollow}
											style={s.textAction}
										>
											<T
												size={12}
												style={{ color: c.text.secondary }}
											>
												取消本地关注
											</T>
										</ControlTarget>
									</>
								)}
							</Card>
							{remoteProfile}
							<ControlTarget
								accessibilityRole='link'
								accessibilityLabel='在 B 站打开 UP 主空间'
								onPress={() => {
									void session.openSpace(onOpenSpace)
								}}
								style={s.textAction}
							>
								<T
									size={12}
									style={{ color: c.action.primary }}
								>
									在 B 站打开空间 ↗
								</T>
							</ControlTarget>
							<T
								size={18}
								weight='700'
								style={{ marginTop: 14 }}
							>
								已保存的音源
							</T>
							<T
								muted
								size={11}
								style={{ marginTop: 9, marginBottom: 12 }}
							>
								仅显示本机已保存的音源。
							</T>
							{state.sources.length
								? state.sources.map((source) => (
										<CreatorSourceRow
											key={source.id}
											source={source}
											busy={state.playbackBusy}
											onPlay={onPlay}
										/>
									))
								: state.profileLoaded && (
										<T
											muted
											size={12}
											style={{ marginBottom: 16 }}
										>
											还没有保存这位 UP 主的音源。
										</T>
									)}
							{remotePosts}
						</>
					)}
				</ScrollView>
			</View>
		</Modal>
	)
}

function CreatorSourceRow({
	source,
	busy,
	onPlay,
}: {
	source: Source
	busy: boolean
	onPlay: (source: Source, mode: 'music' | 'listening') => void
}) {
	const theme = useTheme()
	const [more, setMore] = useState(false)
	const music = source.domain === 'music'
	return (
		<View
			style={{
				borderBottomWidth: 1,
				borderBottomColor: theme.tokens.border.subtle,
				paddingVertical: 12,
			}}
		>
			<ControlRow
				controlMinWidthsDp={[music ? 116 : 164, 48]}
				gapDp={10}
				style={[s.row, { gap: 10 }]}
			>
				<ControlTarget
					minimumHeightDp={68}
					accessibilityRole='button'
					accessibilityLabel={`${music ? '播放本地音乐音源' : '收听本地视频音源'} ${source.originalTitle}`}
					disabled={busy}
					onPress={() => onPlay(source, music ? 'music' : 'listening')}
					style={[s.row, { flex: 1, gap: 12, minHeight: 68 }]}
				>
					<Artwork
						uri={source.artwork}
						fit={music ? 'cover' : 'contain'}
						style={[
							shape(theme.components.card),
							music ? { width: 56, height: 56 } : { width: 104, height: 59 },
						]}
					/>
					<View style={{ flex: 1, gap: 4 }}>
						<T
							weight='600'
							size={13}
							lines={2}
						>
							{source.originalTitle}
						</T>
						<T
							muted
							size={10}
							lines={1}
						>
							UP · {source.uploader} · {time(source.duration)}
						</T>
						<T
							muted
							size={10}
						>
							{music ? '已保存的音乐分类' : '内容分类待确认'} · 本地已知音源
						</T>
					</View>
				</ControlTarget>
				<ControlTarget
					fixed
					accessibilityRole='button'
					accessibilityLabel={`本地音源更多 ${source.originalTitle}`}
					accessibilityState={{ expanded: more }}
					onPress={() => setMore(!more)}
					style={s.textAction}
				>
					<T
						muted
						size={11}
					>
						更多
					</T>
				</ControlTarget>
			</ControlRow>
			{more && (
				<ControlTarget
					accessibilityRole='button'
					accessibilityLabel={`${music ? '以听视频收听' : '以音乐播放'} ${source.originalTitle}`}
					disabled={busy}
					onPress={() => {
						setMore(false)
						onPlay(source, music ? 'listening' : 'music')
					}}
					style={[s.textAction, { alignItems: 'flex-end' }]}
				>
					<T
						size={12}
						style={{ color: theme.tokens.action.primary }}
					>
						{music ? '以听视频收听' : '以音乐播放'}
					</T>
				</ControlTarget>
			)}
		</View>
	)
}

const s = StyleSheet.create({
	row: { flexDirection: 'row', alignItems: 'center' },
	textAction: { minHeight: 48, minWidth: 48, justifyContent: 'center' },
})
