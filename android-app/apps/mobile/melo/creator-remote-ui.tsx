import React, { useState } from 'react'
import { View } from 'react-native'

import type { Creator } from './core/creators'
import type { CreatorPostCandidate } from './creator-api'
import type {
	CreatorRemoteSession,
	CreatorRemoteState,
} from './creator-remote-session'
import { creatorSearchView } from './creator-search-selection'
import type {
	CreatorSearchSession,
	CreatorSearchState,
} from './creator-search-session'
import { CreatorAvatar, creatorScopeLabel } from './creator-ui'
import type { SearchLocalFollowing } from './search-local-following'
import {
	Artwork,
	Button,
	Card,
	ControlRow,
	ControlTarget,
	State,
	T,
	shape,
	time,
	useTheme,
} from './ui'

function ReadError({
	message,
	onRetry,
	local = false,
}: {
	message: string
	onRetry?: () => void
	local?: boolean
}) {
	const theme = useTheme()
	return (
		<Card style={{ marginVertical: 12 }}>
			<T
				size={12}
				style={{ color: theme.tokens.state.error }}
			>
				{message}
			</T>
			{local && (
				<T
					muted
					size={11}
					style={{ marginTop: 8 }}
				>
					本地资料、关注和已保存音源仍可使用。
				</T>
			)}
			{onRetry && (
				<View style={{ marginTop: 12 }}>
					<Button
						secondary
						onPress={onRetry}
					>
						重试读取
					</Button>
				</View>
			)}
		</Card>
	)
}

export function CreatorSearchResults({
	state,
	session,
	following,
	preview,
	onOpen,
}: {
	state: CreatorSearchState
	session: CreatorSearchSession
	following?: SearchLocalFollowing & { refresh: () => void }
	preview?: { onViewAll: () => void; compact?: boolean }
	onOpen: (creator: Creator) => void
}) {
	const theme = useTheme()
	const view = creatorSearchView(state)
	const followingLabel = (mid: string) => {
		const scope = following?.scopes?.get(mid)
		return scope ? `已本地关注 · ${creatorScopeLabel[scope]}` : ''
	}
	if (preview?.compact) {
		const creator = state.items[0]
		if (!creator && !state.loading && !state.error) return null
		return (
			<View testID='creator-search-compact'>
				{creator ? (
					<ControlRow
						controlMinWidthsDp={[108, 64]}
						gapDp={8}
						style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
					>
						<ControlTarget
							minimumWidthDp={108}
							minimumHeightDp={64}
							accessibilityRole='button'
							accessibilityLabel={`查看搜索 UP 主 ${creator.name}，mid ${creator.mid}${followingLabel(creator.mid) ? `，${followingLabel(creator.mid)}` : ''}`}
							onPress={() => onOpen(creator)}
							style={{
								flex: 1,
								minHeight: 64,
								flexDirection: 'row',
								alignItems: 'center',
								gap: 10,
							}}
						>
							<CreatorAvatar
								creator={creator}
								size={40}
							/>
							<View style={{ flex: 1, gap: 4 }}>
								<T
									size={14}
									weight='600'
									lines={1}
								>
									{creator.name}
								</T>
								<T
									muted
									size={11}
									lines={1}
								>
									{followingLabel(creator.mid) || creator.bio || 'UP 主'}
								</T>
							</View>
						</ControlTarget>
						<ControlTarget
							fixedWidth
							minimumWidthDp={64}
							accessibilityRole='button'
							accessibilityLabel='查看全部 UP 主'
							onPress={preview.onViewAll}
							style={{
								minHeight: 48,
								justifyContent: 'center',
								alignItems: 'center',
							}}
						>
							<T
								size={12}
								style={{ color: theme.tokens.action.primary }}
							>
								全部 UP
							</T>
						</ControlTarget>
					</ControlRow>
				) : (
					<View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
						<T
							muted
							size={12}
							style={{ flex: 1 }}
						>
							{state.loading ? '正在搜索 UP 主…' : 'UP 主搜索暂时未完成'}
						</T>
						<ControlTarget
							minimumWidthDp={64}
							accessibilityRole='button'
							accessibilityLabel='查看全部 UP 主'
							onPress={preview.onViewAll}
							style={{ minHeight: 48, justifyContent: 'center' }}
						>
							<T
								size={12}
								style={{ color: theme.tokens.action.primary }}
							>
								查看
							</T>
						</ControlTarget>
					</View>
				)}
			</View>
		)
	}
	return (
		<View testID='creator-search-results'>
			{!!state.keyword && (
				<T
					muted
					size={11}
					style={{ marginBottom: 12 }}
				>
					“{state.keyword}” · 已加载 {state.items.length} 位 UP 主
				</T>
			)}
			{view === 'prompt' ? (
				<State
					title='寻找 UP 主'
					message='输入昵称、mid:123 或 space.bilibili.com 的 UP 主页链接，再提交搜索。'
				/>
			) : view === 'loading' ? (
				<State
					busy
					title='正在搜索 UP 主'
					message='从 B 站读取公开搜索结果'
				/>
			) : view === 'empty' ? (
				<State
					title='没有找到 UP 主'
					message='试试其他昵称或关键词。'
				/>
			) : view === 'interrupted' ? (
				<State
					title='搜索尚未完成'
					message='上次读取已取消，可以重新搜索当前关键词。'
					retry={() => {
						void session.find(state.keyword)
					}}
				/>
			) : null}
			{!!following?.error && (
				<ReadError
					message={following.error}
					onRetry={following.refresh}
				/>
			)}
			{(preview ? state.items.slice(0, 2) : state.items).map((creator) => (
				<ControlTarget
					minimumWidthDp={108}
					minimumHeightDp={90}
					key={creator.mid}
					accessibilityRole='button'
					accessibilityLabel={`查看搜索 UP 主 ${creator.name}，mid ${creator.mid}${followingLabel(creator.mid) ? `，${followingLabel(creator.mid)}` : ''}`}
					onPress={() => onOpen(creator)}
					style={{
						flexDirection: 'row',
						alignItems: 'center',
						gap: 12,
						minHeight: 90,
						borderBottomWidth: 1,
						borderBottomColor: theme.tokens.border.subtle,
						paddingVertical: 12,
					}}
				>
					<CreatorAvatar
						creator={creator}
						size={48}
					/>
					<View style={{ flex: 1, gap: 5 }}>
						<T
							weight='600'
							size={14}
							lines={2}
						>
							{creator.name}
						</T>
						<T
							muted
							size={10}
						>
							Bilibili · mid {creator.mid}
						</T>
						{!!followingLabel(creator.mid) && (
							<T
								size={11}
								style={{ color: theme.tokens.action.primary }}
							>
								{followingLabel(creator.mid)}
							</T>
						)}
						<T
							muted
							size={11}
							lines={2}
						>
							{creator.bio || '暂无搜索简介'}
						</T>
					</View>
				</ControlTarget>
			))}
			{!!state.error && (
				<ReadError
					message={state.error}
					onRetry={
						state.failedPage === null
							? undefined
							: () => {
									void session.retry()
								}
					}
				/>
			)}
			{preview && state.items.length > 0 && (
				<Button
					secondary
					onPress={preview.onViewAll}
				>
					查看全部 UP 主
				</Button>
			)}
			{!preview && state.more && !state.error && (
				<View style={{ marginTop: 16 }}>
					<Button
						secondary
						disabled={state.loading}
						onPress={() => {
							void session.loadMore()
						}}
					>
						{state.loading ? '正在读取下一页…' : '加载更多 UP 主'}
					</Button>
				</View>
			)}
		</View>
	)
}

export function CreatorProfileRead({
	state,
	session,
}: {
	state: CreatorRemoteState
	session: CreatorRemoteSession
}) {
	return (
		<View style={{ marginTop: 14, gap: 12 }}>
			<Button
				secondary
				disabled={state.profileLoading}
				onPress={() => {
					void session.refreshProfile()
				}}
			>
				{state.profileLoading ? '正在读取 UP 资料…' : '刷新 UP 资料'}
			</Button>
			{!!state.profileError && (
				<ReadError
					message={state.profileError}
					local
					onRetry={() => {
						void session.refreshProfile()
					}}
				/>
			)}
			{state.profileUpdated && (
				<T
					muted
					size={11}
					style={{ marginTop: 9 }}
				>
					已读取 UP 资料
				</T>
			)}
		</View>
	)
}

export function CreatorPostsRead({
	state,
	session,
	playbackBusy,
	onPlay,
}: {
	state: CreatorRemoteState
	session: CreatorRemoteSession
	playbackBusy: boolean
	onPlay: (post: CreatorPostCandidate, mode: 'music' | 'listening') => void
}) {
	const lastRead = state.postsReadTimes.at(-1)
	const [readDetailsOpen, setReadDetailsOpen] = useState(false)
	return (
		<View
			style={{ marginTop: 24 }}
			testID='creator-platform-posts'
		>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
				<T
					size={18}
					weight='700'
					style={{ flex: 1 }}
				>
					投稿
				</T>
				<ControlTarget
					minimumWidthDp={72}
					accessibilityRole='button'
					accessibilityLabel={
						readDetailsOpen ? '收起投稿读取范围' : '展开投稿读取范围'
					}
					accessibilityState={{ expanded: readDetailsOpen }}
					onPress={() => setReadDetailsOpen((value) => !value)}
					style={{ minHeight: 48, justifyContent: 'center' }}
				>
					<T
						muted
						size={12}
					>
						读取范围
					</T>
				</ControlTarget>
			</View>
			{readDetailsOpen && (
				<T
					muted
					size={11}
					style={{ marginTop: 9, marginBottom: 14 }}
				>
					按平台分页读取，可能包含合作投稿，上传者以原视频为准。
				</T>
			)}
			<View
				testID='creator-post-filter-controls'
				style={{ marginBottom: 14 }}
			>
				<ControlRow
					controlMinWidthsDp={[64, 64, 80]}
					gapDp={8}
					style={{ flexDirection: 'row', gap: 8 }}
				>
					{(['all', 'music', 'listening'] as const).map((filter) => (
						<ControlTarget
							key={filter}
							minimumWidthDp={filter === 'listening' ? 80 : 64}
							accessibilityRole='tab'
							accessibilityLabel={`UP 投稿筛选${filter === 'all' ? '全部' : filter === 'music' ? '音乐' : '听视频'}`}
							accessibilityState={{ selected: state.postFilter === filter }}
							onPress={() => session.setPostFilter(filter)}
							style={{
								flex: 1,
								minHeight: 48,
								justifyContent: 'center',
								alignItems: 'center',
								paddingHorizontal: 10,
							}}
						>
							<T weight={state.postFilter === filter ? '700' : '400'}>
								{filter === 'all'
									? '全部'
									: filter === 'music'
										? '音乐'
										: '听视频'}
							</T>
						</ControlTarget>
					))}
				</ControlRow>
				{readDetailsOpen && (
					<T
						muted
						size={11}
						style={{ marginTop: 6 }}
					>
						仅筛选本地已读取投稿；音乐含已确认歌曲与音乐合集，类别未知仅在全部显示。
					</T>
				)}
				{state.page > 0 && !state.filterError && !state.cacheError && (
					<T
						muted
						size={11}
						style={{ marginTop: 5 }}
					>
						当前可见 {state.visiblePosts.length} 项
						{state.more ? ' · 还有未读取的投稿页' : ''}
					</T>
				)}
			</View>
			{state.page === 0 && state.cacheStatus === 'ready' && (
				<T
					size={11}
					muted
					style={{ marginBottom: 12 }}
				>
					尚无本地投稿缓存，加载后才会访问平台。
				</T>
			)}
			<Button
				secondary
				disabled={state.postsLoading || state.cacheStatus === 'failed'}
				onPress={() => {
					void session.readPosts()
				}}
			>
				{state.postsLoading && state.page === 0
					? '正在读取投稿…'
					: state.page === 0
						? '加载 UP 投稿'
						: '刷新 UP 投稿'}
			</Button>
			{readDetailsOpen && state.page > 0 && (
				<T
					muted
					size={11}
					style={{ marginTop: 12 }}
				>
					本地缓存 · 已读取至第 {state.page} 页 · {state.posts.length} 项（按 BV
					去重展示） ·{' '}
					{state.total === null ? '平台总数未知' : `平台记录 ${state.total} 项`}
				</T>
			)}
			{readDetailsOpen && !!lastRead && (
				<T
					muted
					size={11}
					style={{ marginTop: 5 }}
				>
					第 {lastRead.page} 页读取时间 ·{' '}
					{new Date(lastRead.fetchedAt).toLocaleString()}
				</T>
			)}
			{readDetailsOpen && state.page > 0 && (
				<T
					muted
					size={11}
					style={{ marginTop: 5 }}
				>
					各页分别读取，保留平台当时的默认顺序，不代表实时或完整投稿列表。
				</T>
			)}
			{!!state.postsNotice && (
				<T
					size={12}
					style={{ marginTop: 12 }}
				>
					{state.postsNotice}
				</T>
			)}
			{!!state.cacheError && (
				<ReadError
					message={state.cacheError}
					local
					onRetry={
						state.cacheStatus !== 'failed' && state.failedPage !== null
							? () => {
									void session.retryPosts()
								}
							: undefined
					}
				/>
			)}
			{state.cacheStatus === 'failed' && (
				<Button
					secondary
					onPress={session.reloadPostsCache}
					disabled={state.postsLoading}
				>
					重新读取本地投稿缓存
				</Button>
			)}
			<View testID='creator-post-filter-status'>
				{!!state.filterError && (
					<ReadError
						message={state.filterError}
						onRetry={state.postsLoading ? undefined : session.reloadPostsCache}
					/>
				)}
				{!!state.posts.length &&
					!state.visiblePosts.length &&
					!state.filterError &&
					!state.cacheError && (
						<State
							title='当前筛选没有已确认的投稿'
							message={
								state.more
									? '未读取的分页可能还有内容，可以查看全部或显式加载更多。'
									: '可以切换到全部，查看类别未知或其他类型的已读取投稿。'
							}
						/>
					)}
			</View>
			{state.page > 0 &&
				!state.posts.length &&
				!state.postsError &&
				!state.cacheError &&
				!state.filterError && (
					<State
						title='已缓存的读取结果没有投稿'
						message='可以查看本地已保存音源，或在原站空间浏览。'
					/>
				)}
			{state.visiblePosts.map((post) => (
				<CandidateRow
					key={post.bvid}
					post={post}
					busy={playbackBusy}
					onPlay={onPlay}
				/>
			))}
			{!!state.postsError && (
				<ReadError
					message={state.postsError}
					local
					onRetry={() => {
						void session.retryPosts()
					}}
				/>
			)}
			{state.more &&
				!state.postsError &&
				!state.cacheError &&
				!state.restartRequired && (
					<View style={{ marginTop: 14 }}>
						<Button
							secondary
							disabled={state.postsLoading}
							onPress={() => {
								void session.loadMore()
							}}
						>
							{state.postsLoading ? '正在读取下一页…' : '加载更多投稿'}
						</Button>
					</View>
				)}
		</View>
	)
}

function CandidateRow({
	post,
	busy,
	onPlay,
}: {
	post: CreatorPostCandidate
	busy: boolean
	onPlay: (post: CreatorPostCandidate, mode: 'music' | 'listening') => void
}) {
	const theme = useTheme()
	const [more, setMore] = useState(false)
	return (
		<View
			style={{
				paddingVertical: 13,
				borderBottomWidth: 1,
				borderBottomColor: theme.tokens.border.subtle,
			}}
		>
			<ControlRow
				controlMinWidthsDp={[164, 48]}
				gapDp={10}
				style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
			>
				<ControlTarget
					minimumHeightDp={68}
					accessibilityRole='button'
					accessibilityLabel={`核对并收听投稿 ${post.title}`}
					disabled={busy}
					onPress={() => onPlay(post, 'listening')}
					style={{
						flexDirection: 'row',
						alignItems: 'center',
						flex: 1,
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
							size={13}
							weight='600'
							lines={2}
						>
							{post.title}
						</T>
						<T
							muted
							size={10}
						>
							{time(post.duration)} ·{' '}
							{new Date(post.publishedAt).toLocaleDateString()}
						</T>
					</View>
				</ControlTarget>
				<ControlTarget
					fixed
					accessibilityRole='button'
					accessibilityLabel={`投稿更多 ${post.title}`}
					accessibilityState={{ expanded: more }}
					onPress={() => setMore(!more)}
					style={{ minWidth: 48, minHeight: 48, justifyContent: 'center' }}
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
					accessibilityLabel={`核对后以音乐播放 ${post.title}`}
					disabled={busy}
					onPress={() => {
						setMore(false)
						onPlay(post, 'music')
					}}
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
			)}
		</View>
	)
}
