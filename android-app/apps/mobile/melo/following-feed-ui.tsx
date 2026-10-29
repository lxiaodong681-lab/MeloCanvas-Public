import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import {
	FlatList,
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	View,
} from 'react-native'

import type { Creator, CreatorScope } from './core/creators'
import type {
	FollowingFeedItem,
	FollowingFeedSnapshot,
} from './core/following-feed-types'
import { creatorScopeLabel } from './creator-ui'
import type { FollowingFeedSession } from './following-feed-session'
import { CollectionMenu, type CollectionAction } from './library-collection-ui'
import {
	Artwork,
	Button,
	Card,
	ControlRow,
	ControlTarget,
	IconButton,
	State,
	T,
	shape,
	time,
	useTheme,
	useThemeRendering,
} from './ui'

interface FeedScrollRestore {
	identity: object
	session: FollowingFeedSession
	filter: CreatorScope
	target: number
	viewport: number
	content: number
	active: boolean
	restoring: boolean
	frame: number | null
	commanded: number | null
	acknowledged: boolean
}

const emptyFeedActions: CollectionAction[] = []

/** Shared host controls only; opening the page never refreshes remote posts. */
export function FollowingFeedHeader({
	onBack,
	onManage,
	onSearch,
	actions = emptyFeedActions,
}: {
	onBack: () => void
	onManage: () => void
	onSearch: () => void
	actions?: CollectionAction[]
}) {
	return (
		<>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
				<IconButton
					name='back'
					label='返回音乐库'
					onPress={onBack}
				/>
				<T
					size={23}
					weight='700'
					style={{ flex: 1 }}
				>
					关注更新
				</T>
				<CollectionMenu
					label='关注更新更多操作'
					actions={[
						{ label: '管理本地关注的 UP 主', onPress: onManage },
						{ label: '寻找 UP 主', onPress: onSearch },
						...actions,
					]}
				/>
			</View>
			<T
				muted
				size={12}
			>
				显示已保存的投稿；刷新会读取每位 UP 主的最新一页。
			</T>
		</>
	)
}

const emptyText: Record<
	FollowingFeedSnapshot['status'],
	{ title: string; message: string }
> = {
	'no-subscriptions': {
		title: '还没有关注的 UP 主',
		message: '关注 UP 主后，点击刷新即可读取最新一页投稿。',
	},
	uncached: {
		title: '还没有读取关注投稿',
		message: '点击刷新读取最新一页投稿；也可前往 UP 主页读取。',
	},
	empty: {
		title: '上次读取没有投稿',
		message: '可以刷新查看最新一页；这里保留的是上次读取结果。',
	},
	'partial-empty': {
		title: '部分关注还没有读取',
		message: '已读取部分暂无投稿，刷新可查看其他关注的最新一页。',
	},
	'filtered-empty': {
		title: '这个范围暂无投稿',
		message:
			'还没有符合当前筛选和关注范围的投稿。可从更多菜单管理每位 UP 的关注范围。',
	},
	ready: {
		title: '暂时没有可展示的投稿',
		message: '可点击刷新读取最新一页，或重新读取本地记录。',
	},
}
function readTime(timestamp: number) {
	return new Date(timestamp).toLocaleString()
}

function FeedRow({
	item,
	busy,
	onPlay,
	onCreator,
}: {
	item: FollowingFeedItem
	busy: boolean
	onPlay: (bvid: string, mode: 'music' | 'listening') => void
	onCreator: (creator: Creator) => void
}) {
	const theme = useTheme(),
		post = item.post
	return (
		<Card style={{ marginBottom: 14 }}>
			<ControlTarget
				minimumWidthDp={164}
				minimumHeightDp={68}
				accessibilityRole='button'
				accessibilityLabel={`核对并收听关注投稿 ${post.title}`}
				disabled={busy}
				onPress={() => onPlay(post.bvid, 'listening')}
				style={{
					flexDirection: 'row',
					alignItems: 'center',
					gap: 12,
					minHeight: 68,
				}}
			>
				<Artwork
					uri={post.artwork}
					fit='contain'
					style={[shape(theme.components.card), { width: 104, height: 59 }]}
				/>
				<View style={{ flex: 1, gap: 5 }}>
					<T
						size={14}
						weight='600'
						lines={2}
					>
						{post.title}
					</T>
					<T
						muted
						size={11}
					>
						{time(post.duration)} ·{' '}
						{new Date(post.publishedAt).toLocaleDateString()}
					</T>
					<T
						muted
						size={11}
					>
						{item.contentScope === 'music'
							? '已确认音乐类别'
							: item.contentScope === 'listening'
								? '已确认听视频类别'
								: '内容类型待确认'}
					</T>
				</View>
			</ControlTarget>
			<View style={{ gap: 5, marginTop: 10 }}>
				{item.origins.map((origin) => (
					<View key={`${origin.subscription.creatorMid}:${origin.page}`}>
						<ControlTarget
							accessibilityRole='button'
							accessibilityLabel={`查看关注来源 UP 主 ${origin.creator.name}，mid ${origin.creator.mid}`}
							onPress={() => onCreator(origin.creator)}
							style={{ minHeight: 48, justifyContent: 'center' }}
						>
							<T size={12}>
								来自关注 · {origin.creator.name} ·{' '}
								{creatorScopeLabel[origin.subscription.scope]}
							</T>
						</ControlTarget>
						<T
							muted
							size={10}
						>
							第 {origin.page} 页缓存 · 读取于 {readTime(origin.fetchedAt)}
						</T>
					</View>
				))}
			</View>
			<ControlTarget
				accessibilityRole='button'
				accessibilityLabel={`核对关注投稿后以音乐播放 ${post.title}`}
				disabled={busy}
				onPress={() => onPlay(post.bvid, 'music')}
				style={{
					minHeight: 48,
					justifyContent: 'center',
					alignItems: 'flex-end',
				}}
			>
				<T
					size={12}
					style={{ color: theme.tokens.action.primary }}
				>
					以音乐播放
				</T>
			</ControlTarget>
		</Card>
	)
}

export function FollowingFeedPage({
	state,
	session,
	onCreator,
	onManage,
	onPlay,
	onSearch,
}: {
	state: ReturnType<FollowingFeedSession['getSnapshot']>
	session: FollowingFeedSession
	onCreator: (creator: Creator) => void
	onManage: () => void
	onPlay: (bvid: string, mode: 'music' | 'listening') => void
	onSearch: () => void
}) {
	const c = useTheme().tokens,
		snapshot = state.snapshot
	const responsive = !!useThemeRendering()?.controlRowLayout
	const coverageOpen = state.coverageOpen
	const list = useRef<FlatList<FollowingFeedItem>>(null)
	const restore = useRef<FeedScrollRestore | null>(null)
	const identity = useMemo(
		() => ({ session, filter: state.filter }),
		[session, state.filter],
	)
	const currentOwner = useCallback(() => {
		const owner = restore.current,
			current = session.getSnapshot()
		return owner?.active &&
			owner.identity === identity &&
			owner.session === session &&
			owner.filter === state.filter &&
			current.open &&
			!current.overlay &&
			current.filter === owner.filter
			? owner
			: null
	}, [session, state.filter, identity])
	const scheduleRestore = useCallback(() => {
		const owner = currentOwner()
		if (!owner || !owner.restoring || owner.viewport <= 0 || owner.content <= 0)
			return
		if (owner.frame !== null) cancelAnimationFrame(owner.frame)
		owner.commanded = null
		owner.acknowledged = false
		owner.frame = requestAnimationFrame(() => {
			owner.frame = null
			if (currentOwner() !== owner || !owner.restoring) return
			if (owner.target === 0) {
				owner.restoring = false
				return
			}
			const offset = Math.min(
				owner.target,
				Math.max(0, owner.content - owner.viewport),
			)
			owner.commanded = offset
			list.current?.scrollToOffset({ offset, animated: false })
		})
	}, [currentOwner])
	useLayoutEffect(() => {
		const previous = restore.current,
			reuseDimensions = previous?.identity === identity
		const owner: FeedScrollRestore = {
			identity,
			session,
			filter: state.filter,
			target: session.getScrollOffset(),
			viewport: reuseDimensions ? previous.viewport : 0,
			content: reuseDimensions ? previous.content : 0,
			active: true,
			restoring: true,
			frame: null,
			commanded: null,
			acknowledged: false,
		}
		restore.current = owner
		scheduleRestore()
		return () => {
			owner.active = false
			if (owner.frame !== null) cancelAnimationFrame(owner.frame)
		}
	}, [session, state.filter, identity, scheduleRestore])
	const rememberScrollEnd = useCallback(
		(event: NativeSyntheticEvent<NativeScrollEvent>) => {
			const owner = currentOwner()
			if (!owner || owner.restoring) return
			session.rememberScroll(event.nativeEvent.contentOffset.y)
		},
		[currentOwner, session],
	)
	const empty = snapshot
		? emptyText[snapshot.status]
		: {
				title: '本地关注更新尚未读取',
				message: '重新读取本地记录即可重试，不会请求网络。',
			}
	return (
		<FlatList
			ref={list}
			key={state.filter}
			testID='following-feed-page'
			data={snapshot?.items ?? []}
			keyExtractor={(item) => item.post.bvid}
			onLayout={(event) => {
				const owner = currentOwner()
				if (!owner) return
				owner.viewport = event.nativeEvent.layout.height
				scheduleRestore()
			}}
			onContentSizeChange={(_width, height) => {
				const owner = currentOwner()
				if (!owner) return
				owner.content = height
				scheduleRestore()
			}}
			onScroll={(event) => {
				const owner = currentOwner()
				if (!owner) return
				const y = event.nativeEvent.contentOffset.y
				if (!owner.restoring) {
					session.rememberScroll(y)
					return
				}
				if (owner.commanded === null) return
				if (Math.abs(y - owner.commanded) <= 1) {
					owner.acknowledged = true
					// A temporary content clamp acknowledges the command, not a new saved target.
					if (Math.abs(owner.commanded - owner.target) <= 1) {
						owner.restoring = false
						session.rememberScroll(y)
					}
				} else if (owner.acknowledged && owner.frame === null) {
					// A subsequent normal scroll can come from touch, accessibility or a keyboard.
					owner.restoring = false
					session.rememberScroll(y)
				}
			}}
			onScrollBeginDrag={(event) => {
				const owner = currentOwner()
				if (!owner) return
				owner.restoring = false
				if (owner.frame !== null) cancelAnimationFrame(owner.frame)
				owner.frame = null
				session.rememberScroll(event.nativeEvent.contentOffset.y)
			}}
			onScrollEndDrag={rememberScrollEnd}
			onMomentumScrollEnd={rememberScrollEnd}
			scrollEventThrottle={100}
			initialNumToRender={12}
			contentContainerStyle={{ padding: 20, paddingBottom: 24 }}
			ListHeaderComponent={
				<View style={{ gap: 10, marginBottom: 12 }}>
					<FollowingFeedHeader
						onBack={session.close}
						onManage={onManage}
						onSearch={onSearch}
						actions={[
							{ label: '重新读取本地更新', onPress: session.load },
							...(snapshot
								? [
										{
											label: coverageOpen
												? '收起缓存范围'
												: '查看缓存范围与缺页',
											onPress: () => session.setCoverageOpen(!coverageOpen),
										},
									]
								: []),
						]}
					/>
					<Button
						secondary
						onPress={() =>
							state.refresh.running
								? session.cancelRefresh()
								: void session.refresh()
						}
					>
						{state.refresh.running
							? `停止刷新 · ${state.refresh.attempted}/${state.refresh.total}`
							: '刷新关注更新'}
					</Button>
					{!!state.refresh.message && (
						<T
							muted
							size={12}
						>
							{state.refresh.message}
							{state.refresh.finishedAt
								? ` 上次结束：${new Date(state.refresh.finishedAt).toLocaleString()}`
								: ''}
						</T>
					)}
					<ControlRow
						controlMinWidthsDp={[72, 72, 72]}
						gapDp={8}
						style={{ flexDirection: 'row', gap: 8 }}
					>
						{(['all', 'music', 'listening'] as CreatorScope[]).map((filter) => (
							<ControlTarget
								minimumWidthDp={72}
								key={filter}
								accessibilityRole='tab'
								accessibilityLabel={`关注更新：${filter === 'all' ? '全部' : filter === 'music' ? '音乐' : '听视频'}`}
								accessibilityState={{ selected: state.filter === filter }}
								onPress={() => session.setFilter(filter)}
								style={{
									...(responsive ? { flex: 1 } : {}),
									minHeight: 48,
									paddingHorizontal: 12,
									justifyContent: 'center',
									borderBottomWidth: state.filter === filter ? 2 : 0,
									borderBottomColor: c.action.primary,
								}}
							>
								<T
									size={13}
									weight={state.filter === filter ? '700' : '400'}
								>
									{filter === 'all'
										? '全部'
										: filter === 'music'
											? '音乐'
											: '听视频'}
								</T>
							</ControlTarget>
						))}
					</ControlRow>
					{!!state.error && (
						<State
							title='本地更新读取未完成'
							message={state.error}
							retry={session.load}
						/>
					)}
					{state.stale && (
						<T size={12}>
							以下保留上次成功读取的“
							{snapshot?.filter === 'all'
								? '全部'
								: snapshot?.filter === 'music'
									? '音乐'
									: '听视频'}
							”内容，当前资格需重新读取后确认。
						</T>
					)}
					{!!state.playError && (
						<State
							title='播放准备未完成'
							message={state.playError}
						/>
					)}
					{state.playingBvid && (
						<Card>
							<T size={12}>正在核对原视频…</T>
							<Button
								secondary
								onPress={session.cancelPending}
							>
								取消本次播放
							</Button>
						</Card>
					)}
					{snapshot && (
						<>
							<T
								muted
								size={11}
							>
								已保存 {snapshot.coverage.cachedPostCount} 条投稿
								{state.filter !== 'all' ? ' · 筛选前' : ''}
							</T>
							{coverageOpen && (
								<T
									muted
									size={11}
								>
									{snapshot.coverage.cachedSubscriptions} 位已缓存 ·{' '}
									{snapshot.coverage.uncachedSubscriptions} 位尚未读取 ·{' '}
									{snapshot.coverage.partialSubscriptions} 位缓存仍有后续页
								</T>
							)}
							{coverageOpen && (
								<T
									muted
									size={11}
								>
									点击后核对原视频和分 P，尚未核验音轨可用性。
								</T>
							)}
							{coverageOpen &&
								snapshot.subscriptions.map((item) => (
									<Card key={item.creator.mid}>
										<ControlTarget
											accessibilityRole='button'
											accessibilityLabel={`查看缓存 UP 主 ${item.creator.name}，mid ${item.creator.mid}`}
											onPress={() => onCreator(item.creator)}
											style={{ minHeight: 48, justifyContent: 'center' }}
										>
											<T>{item.creator.name}</T>
										</ControlTarget>
										<T
											muted
											size={11}
										>
											{creatorScopeLabel[item.subscription.scope]} ·{' '}
											{item.status === 'uncached'
												? '尚未读取投稿'
												: item.status === 'empty'
													? '成功读取的缓存为空'
													: item.status === 'partial'
														? '仍有未读取的后续页'
														: '上次读取到平台末页，非最新全量保证'}
										</T>
										{item.cache && (
											<T
												muted
												size={10}
											>
												已保存第 1–{item.cache.lastPage} 页；
												{item.cache.pages.length === 1 ? '' : '各页分别读取；'}
												第 {item.cache.lastPage} 页读取于{' '}
												{readTime(item.cache.pages.at(-1)!.fetchedAt)}
											</T>
										)}
									</Card>
								))}
						</>
					)}
				</View>
			}
			ListEmptyComponent={
				state.error && !snapshot ? undefined : (
					<State
						title={empty.title}
						message={empty.message}
					/>
				)
			}
			renderItem={({ item }) => (
				<FeedRow
					item={item}
					busy={!!state.playingBvid}
					onPlay={onPlay}
					onCreator={onCreator}
				/>
			)}
		/>
	)
}
