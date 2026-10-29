import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type MutableRefObject } from 'react'
import { Keyboard, ScrollView, View } from 'react-native'
import { SettingsGroup, SettingsRow } from './settings-layout'

import type {
	BilibiliImportSession,
	BilibiliImportState,
} from './bilibili-import-session'
import { contentKinds, type ContentKind } from './core/import-mixed-types'
import type { ImportPlaylistTarget } from './core/import-playlist-types'
import { importEntryDescription, importTaskDescription } from './import-display'
import type { ListeningVideo } from './listening-source'
import { ThemeTextInput } from './theme-input'
import {
	Button,
	Card,
	ControlTarget,
	IconButton,
	T,
	shape,
	time,
	useTheme,
} from './ui'

export const contentKindNames: Record<ContentKind, string> = {
	song: '歌曲',
	musicCollection: '音乐合集（音乐类别）',
	audioDrama: '广播剧',
	audiobook: '有声小说',
	knowledge: '知识讲解',
	commentary: '解说',
	other: '其他长内容',
	unknown: '待分类',
}
export function BiliField({
	label,
	value,
	change,
	disabled,
}: {
	label: string
	value: string
	change: (value: string) => void
	disabled?: boolean
}) {
	const theme = useTheme(),
		c = theme.tokens
	return (
		<ThemeTextInput
			accessibilityLabel={label}
			value={value}
			onChangeText={change}
			editable={!disabled}
			autoCapitalize='none'
			autoCorrect={false}
			placeholder={label}
			placeholderTextColor={c.text.secondary}
			style={[
				shape(theme.components.input),
				{
					minHeight: 48,
					padding: 12,
					color: c.text.primary,
					backgroundColor: c.surface.card,
					borderWidth: 1,
					borderColor: c.border.strong,
				},
			]}
		/>
	)
}
export function BiliChoice({
	label,
	selected,
	disabled,
	press,
}: {
	label: string
	selected: boolean
	disabled?: boolean
	press: () => void
}) {
	const c = useTheme().tokens
	return (
		<ControlTarget
			minimumWidthDp={76}
			accessibilityRole='radio'
			accessibilityLabel={label}
			accessibilityState={{ checked: selected, disabled }}
			disabled={disabled}
			onPress={press}
			style={{
				padding: 12,
				minHeight: 48,
				borderRadius: 12,
				borderWidth: selected ? 2 : 1,
				borderColor: selected ? c.action.primary : c.border.strong,
			}}
		>
			<T weight={selected ? '700' : '400'}>
				{selected ? '● ' : '○ '}
				{label}
			</T>
		</ControlTarget>
	)
}
export function BiliPages<T>({
	items,
	render,
	label,
	page: controlled,
	change,
	keyFor,
}: {
	items: T[]
	render: (item: T, index: number) => ReactNode
	label: string
	page?: number
	change?: (page: number) => void
	keyFor: (item: T) => string
}) {
	const [local, setLocal] = useState(0)
	const page = Math.min(
		controlled ?? local,
		Math.max(0, Math.ceil(items.length / 20) - 1),
	)
	const select = change ?? setLocal
	return (
		<View style={{ gap: 10 }}>
			{items.slice(page * 20, page * 20 + 20).map((item, index) => (
				<View key={keyFor(item)}>{render(item, page * 20 + index)}</View>
			))}
			{items.length > 20 && (
				<>
					<T
						muted
						size={11}
					>
						{label}，{page + 1}/{Math.ceil(items.length / 20)} 页
					</T>
					<Button
						secondary
						disabled={page === 0}
						onPress={() => select(page - 1)}
					>
						上一页{label}
					</Button>
					<Button
						secondary
						disabled={(page + 1) * 20 >= items.length}
						onPress={() => select(page + 1)}
					>
						下一页{label}
					</Button>
				</>
			)}
		</View>
	)
}
export function BiliParts({
	video,
	cid,
	select,
}: {
	video: ListeningVideo
	cid: number | null
	select: (cid: number) => void
}) {
	return (
		<BiliPages
			key={video.bvid}
			label='真实分 P'
			items={video.parts}
			keyFor={(part) => part.source.id}
			render={(part) => (
				<BiliChoice
					label={`选择原视频 P${part.page} ${part.title}，CID ${part.source.cid}，${time(part.source.duration)}`}
					selected={cid === part.source.cid}
					press={() => select(part.source.cid)}
				/>
			)}
		/>
	)
}

interface DestinationDraft {
	append: boolean
	playlistId: string | null
	name: string
	skipSongs: boolean
	skipVideos: boolean
}
const defaultDestinationDraft = (task: BilibiliImportState['task']): DestinationDraft => ({
	append: false,
	playlistId: null,
	name: task ? importTaskDescription(task).name : '',
	skipSongs: false,
	skipVideos: false,
})

function Destination({
	state,
	session,
	organize = false,
	draft,
	onDraftChange,
}: {
	state: BilibiliImportState
	session: BilibiliImportSession
	organize?: boolean
	draft?: DestinationDraft
	onDraftChange: (draft: Partial<DestinationDraft>) => void
}) {
	const form = draft ?? defaultDestinationDraft(state.task)
	const { append, playlistId, name, skipSongs, skipVideos } = form
	const change = onDraftChange
	const chosen = organize
			? (state.task?.entries.filter(
					(entry) => entry.entryId === state.entryId,
				) ?? [])
			: session.selected(),
		songs = chosen.filter(
			(entry) => session.kind(entry.entryId) === 'song',
		).length
	const command = organize ? state.organizationCommand : state.command
	const busy = !!command || state.busy
	return (
		<View style={{ gap: 12 }}>
			<T
				size={20}
				weight='700'
			>
				{organize ? '明确整理原待分类项' : '保存所选原目录条目'}
			</T>
			{organize && (
				<T size={12}>整理这份原收藏并保留来源记录，不会改动它的副本。</T>
			)}
			<T
				muted
				size={12}
			>
				{chosen.length} 个出现项，歌曲 {songs} ·
				其他按内容类型分流到听视频收藏或待分类。
			</T>
			{songs > 0 ? (
				<>
					<BiliChoice
						label='为歌曲新建音乐歌单'
						selected={!append}
						disabled={busy}
						press={() => change({ append: false })}
					/>
					<BiliChoice
						label='歌曲加入已有音乐歌单'
						selected={append}
						disabled={busy}
						press={() => change({ append: true })}
					/>
					{append ? (
						state.playlists.map((playlist) => (
							<BiliChoice
								key={playlist.id}
								label={`目标音乐歌单 ${playlist.name}`}
								selected={playlistId === playlist.id}
								disabled={busy}
								press={() => change({ playlistId: playlist.id })}
							/>
						))
					) : (
						<BiliField
							label='本地音乐歌单名称'
							value={name}
							change={(nextName) => change({ name: nextName })}
							disabled={busy}
						/>
					)}
				</>
			) : (
				<T>本次没有歌曲，不创建空音乐歌单。</T>
			)}
			{!organize && (
				<>
					<BiliChoice
						label='歌曲重复：保留全部出现项（默认）'
						selected={!skipSongs}
						disabled={busy}
						press={() => change({ skipSongs: false })}
					/>
					<BiliChoice
						label='歌曲重复：跳过目标歌单已存在的确认音源'
						selected={skipSongs}
						disabled={busy}
						press={() => change({ skipSongs: true })}
					/>
					<BiliChoice
						label='视频重复：保留全部出现项（默认）'
						selected={!skipVideos}
						disabled={busy}
						press={() => change({ skipVideos: false })}
					/>
					<BiliChoice
						label='视频重复：跳过同收藏类别已存在的 BV'
						selected={skipVideos}
						disabled={busy}
						press={() => change({ skipVideos: true })}
					/>
				</>
			)}
			<T
				muted
				size={11}
			>
				未确认 CID 的歌曲保留为待匹配条目；目录或 CID
				核验不代表存在可用独立音轨。
			</T>
			{!command ? (
				<Button
					disabled={!chosen.length || state.busy}
					onPress={() => {
						let target: ImportPlaylistTarget | null = null
						if (songs) {
							const selected = state.playlists.find(
								(playlist) => playlist.id === playlistId,
							)
							if (append && !selected) {
								session.reportError(new Error('请选择目标音乐歌单'))
								return
							}
							target = append
								? {
										kind: 'append',
										playlistId: selected!.id,
										expectedUpdatedAt: selected!.updatedAt,
									}
								: { kind: 'create', playlistId: session.newId(), name }
						}
						if (organize) session.prepareOrganization(target)
						else
							session.prepare(
								target,
								skipSongs ? 'skip-existing-source' : 'keep-all',
								skipVideos ? 'skip-existing-video' : 'keep-all',
							)
					}}
				>
					核对保存内容
				</Button>
			) : (
				<>
					<T size={12}>
						本次将保存 {organize ? 1 : state.command!.itemIds.length}{' '}
						项。失败后可重试，返回可重新核对。
					</T>
					<Button
						disabled={state.busy}
						onPress={organize ? session.organize : session.commit}
					>
						{state.busy
							? '正在保存…'
							: organize
								? '明确整理原项到所选去向'
								: '确认保存本次内容'}
					</Button>
				</>
			)}
		</View>
	)
}

export function BilibiliImportPage({
	backRef,
	state,
	session,
	onHub,
	onPreview,
	onPlaylist,
	onPlayPlaylist,
	onLibrary,
	playbackBusy,
	playbackError,
}: {
	backRef?: MutableRefObject<(() => boolean) | null>
	state: BilibiliImportState
	session: BilibiliImportSession
	onHub: () => void
	onPreview: () => void
	onPlaylist: (id: string) => void
	onPlayPlaylist?: (id: string) => void
	onLibrary: (bucket: 'listening' | 'unclassified') => void
	playbackBusy: boolean
	playbackError: string | null
}) {
	const scroll = useRef<ScrollView | null>(null),
		actionY = useRef(0),
		c = useTheme().tokens
	const [showKinds, setShowKinds] = useState(false)
	const [taskPage, setTaskPage] = useState<'home' | 'entries' | 'history'>('home')
	const [destinationDrafts, setDestinationDrafts] = useState<
		Record<string, DestinationDraft>
	>({})
	const destinationKey = `${state.task?.taskId ?? ''}:destination`
	const organizationKey = `${state.task?.taskId ?? ''}:entry:${state.entryId ?? ''}`
	const scrollKey = `${state.route}:${state.task?.taskId ?? state.favoriteId}:${state.entryId ?? ''}:${state.folderAccess}${state.route === 'task' && taskPage !== 'home' ? `:${taskPage}` : ''}`
	const restoreOffset = useMemo(
		() => session.scrollOffset(scrollKey),
		[session, scrollKey],
	)
	const top = () => {
		session.rememberScroll(scrollKey, 0)
		scroll.current?.scrollTo({ y: 0, animated: false })
	}
	const focusActions = () =>
		scroll.current?.scrollTo({ y: actionY.current, animated: false })
	useEffect(() => {
		setShowKinds(false)
		const frame = requestAnimationFrame(() =>
			scroll.current?.scrollTo({ y: restoreOffset, animated: false }),
		)
		return () => cancelAnimationFrame(frame)
	}, [scrollKey, restoreOffset])
	useEffect(() => {
		if (state.video) {
			const frame = requestAnimationFrame(focusActions)
			return () => cancelAnimationFrame(frame)
		}
	}, [state.video, state.selectedCid])
	useEffect(() => { setTaskPage('home') }, [state.task?.taskId])
	useLayoutEffect(() => {
		if (!backRef) return
		backRef.current = () => {
			if (state.route !== 'task' || taskPage === 'home') return false
			setTaskPage('home')
			return true
		}
		return () => { backRef.current = null }
	}, [backRef, state.route, taskPage])
	const task = state.task,
		selected = session.selected(),
		processed = session.processed()
	const entry = task?.entries.find((item) => item.entryId === state.entryId)
	const original = entry ? importEntryDescription(entry, 'bilibili') : null
	const collection = state.collection
	const blocked = state.busy || state.transportBusy
	return (
		<ScrollView
			ref={scroll}
			key={scrollKey}
			onScroll={(event) =>
				session.rememberScroll(scrollKey, event.nativeEvent.contentOffset.y)
			}
			scrollEventThrottle={100}
			keyboardShouldPersistTaps='handled'
			contentContainerStyle={{ padding: 20, paddingBottom: 90, gap: 12 }}
		>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
				<IconButton
					name='back'
					label='返回B站导入上一步'
					onPress={() => {
						if (state.route === 'task' && taskPage !== 'home') { setTaskPage('home'); return }
						if (
							state.route === 'folders' ||
							state.route === 'task' ||
							state.route === 'result'
						)
							onHub()
						else session.back()
					}}
				/>
				<T
					size={23}
					weight='700'
					style={{ flex: 1 }}
				>
					{state.route === 'task' && taskPage === 'entries' ? '调整导入条目' : state.route === 'task' && taskPage === 'history' ? '导入历史' : 'B站收藏夹导入'}
				</T>
				<IconButton
					name='close'
					label='关闭B站收藏夹导入'
					onPress={session.close}
				/>
			</View>
			{!!state.error && (
				<Card>
					<T style={{ color: c.state.error }}>{state.error}</T>
				</Card>
			)}
			{!!state.notice && <T size={12}>{state.notice}</T>}
			{state.transportBusy && !state.busy && (
				<T
					size={11}
					muted
				>
					上一请求仍在结束，请稍候。
				</T>
			)}
			{(state.busy || collection?.loading) && (
				<Button
					secondary
					onPress={session.cancelRead}
				>
					取消本次读取
				</Button>
			)}
			{state.route === 'folders' && (
				<>
					{state.mineAvailable && (
						<>
							<Button
								testID='read-my-bilibili-favorites'
								disabled={blocked}
								onPress={() => {
									Keyboard.dismiss()
									void session.readMyFolders()
								}}
							>
								{state.folderAccess === 'account'
									? '重新读取我的收藏夹'
									: '读取我的收藏夹'}
							</Button>
							<Button
								secondary
								testID='show-public-bilibili-favorites'
								disabled={blocked}
								onPress={session.usePublicFolders}
							>
								其他 UP 的公开收藏夹
							</Button>
						</>
					)}
					{state.folderAccess === 'account' ? (
						<T size={13}>
							当前账号：{state.folderAccount?.name ?? '请重新核验'}
							。选择收藏夹即可导入为本地歌单，不会修改 B 站收藏。多 P 视频默认第一 P，播放时可切换。
						</T>
					) : (
						<>
							<T size={13}>
								输入 UP 主
								mid，读取其公开可见目录；此路径不使用账号读取私有夹。读取和导入不会修改
								B 站收藏。
							</T>
							<BiliField
								label='B站收藏夹所属UP的mid'
								value={state.mid}
								change={session.setMid}
								disabled={state.busy}
							/>
							<Button
								disabled={blocked || !state.mid}
								onPress={() => {
									Keyboard.dismiss()
									void session.readFolders()
								}}
							>
								读取可见收藏夹
							</Button>
						</>
					)}
					{state.folders && (
						<>
							<T size={12}>
								{state.folders.observedCount} 个{state.folderAccess === 'account' ? '本人收藏夹' : '公开收藏夹'}，选择后自动导入，多 P 默认第一 P
							</T>
							{!state.folders.folders.length && (
								<Card>
									<T>
										{state.folderAccess === 'account'
											? '当前账号本次明确返回空目录；不推断其他未返回的收藏夹。'
											: '本次明确返回空公开目录；不代表账号没有私有收藏。'}
									</T>
								</Card>
							)}
							<BiliPages
								label='可见收藏夹'
								items={state.folders.folders}
								keyFor={(folder) => folder.folderId}
								render={(folder) => (
									<Button
										secondary
										disabled={blocked}
										onPress={() => {
											void session.importFolder(folder.folderId)
										}}
									>
										导入收藏夹 {folder.title}，{folder.mediaCount} 项
									</Button>
								)}
							/>
						</>
					)}
				</>
			)}
			{state.quick ? (
				<Card>
					<View style={{ gap: 12 }}>
						<T size={21} weight='700'>{state.quick.title}</T>
						<T>
							{state.quick.phase === 'done' ? '导入完成' : state.busy ? '正在导入…' : '导入已暂停'}
						</T>
						<T muted size={13}>
							{state.quick.phase === 'reading' || !state.task
								? `已读取 ${collection?.loadedCount ?? 0} / ${collection?.reportedTotal ?? '…'} 项`
								: `已处理 ${state.quick.processed} / ${state.quick.total} 项${state.quick.unavailable.length ? `，暂不可用 ${state.quick.unavailable.length} 项` : ''}`}
						</T>
						<T muted size={12}>保留收藏夹顺序，多 P 默认第一 P；播放选项中可切换分 P。</T>
						{!!state.quick.skipped && <T size={12}>已略过 {state.quick.skipped} 项非视频内容。</T>}
						{!state.busy && state.quick.phase !== 'done' && (
							<Button disabled={blocked || !!collection?.restartRequired} onPress={() => { void session.continueFavoriteImport() }}>继续导入</Button>
						)}
						{!!collection?.restartRequired && <T size={12}>收藏夹内容在读取期间发生变化，请返回重新选择。</T>}
						{!!collection?.error && <T style={{ color: c.state.error }}>{collection.error.message}</T>}
						{state.quick.playlistId && (
							<>
								{onPlayPlaylist && state.quick.total > state.quick.unavailable.length + state.quick.skipped && <Button onPress={() => onPlayPlaylist(state.quick!.playlistId!)}>播放歌单</Button>}
								<Button secondary onPress={() => onPlaylist(state.quick!.playlistId!)}>查看歌单</Button>
							</>
						)}
						{!!state.quick.unavailable.length && (
							<>
								<T weight='600'>暂不可用的项目</T>
								<T size={12} muted>已在歌单原位置保留，播放时跳过，可稍后重试。</T>
								<BiliPages label='暂不可用项目' items={state.quick.unavailable} keyFor={(item) => item.entryId} render={(item) => <View style={{ gap: 4 }}><T>{item.title}</T><T size={12} muted>{item.reason}</T></View>} />
							</>
						)}
					</View>
				</Card>
			) : state.route === 'collection' && collection && (
				<>
					<T
						size={20}
						weight='700'
					>
						收藏夹 {state.favoriteId}
					</T>
					<T>
						已接纳 {collection.pages.length} 页 / {collection.loadedCount} 项 ·
						报告总数 {collection.reportedTotal ?? '未知'}
					</T>
					{collection.indexCount !== null && (
						<T size={12} muted>
							真实索引 {collection.indexCount} 项，已核对页中 {collection.missingDetailCount} 项未返回详情，保留原位置且不可播放。
						</T>
					)}
					<T
						muted
						size={12}
					>
						每次读取一页。读取期间收藏夹可能变化，读完整后才能保存在本机。
					</T>
					{!!collection.error && (
						<T style={{ color: c.state.error }}>{collection.error.message}</T>
					)}
					{collection.restartRequired ? (
						<T>分页证据变化，需返回重新选择并开始新的目录版本。</T>
					) : (
						!collection.directory && (
							<Button
								disabled={blocked || collection.loading}
								onPress={() => {
									void session.nextPage()
								}}
							>
								{collection.error || collection.phase === 'cancelled'
									? '重读尚未接纳的这一页'
									: '显式读取下一页'}
							</Button>
						)
					)}
					{collection.directory && (
						<>
							{!collection.loadedCount && (
								<Card>
									<T>
										收藏夹明确返回 0 项。本次可保存空目录记录，不会创建空歌单。
									</T>
								</Card>
							)}
							<Button onPress={session.saveDirectory}>
								保存完整目录任务到本机
							</Button>
						</>
					)}
				</>
			)}
			{state.route === 'task' && task && !state.quick && (
				<>
					<T
						size={20}
						weight='700'
					>
						{importTaskDescription(task).name}
					</T>
					{taskPage === 'home' && <>
					<T muted size={12}>{task.entryCount} 项，保留此前选择的分 P，其余使用第一 P。</T>
					<Button disabled={blocked || processed.size === task.entryCount} onPress={() => { void session.importCurrentTask() }}>导入歌单</Button>
					<SettingsGroup>
						<SettingsRow label='调整导入条目' onPress={() => setTaskPage('entries')} />
						<SettingsRow label='导入历史' onPress={() => setTaskPage('history')} />
					</SettingsGroup>
					</>}
					{taskPage === 'entries' && <>
					{typeof task.originalMetadata.missingDetailCount === 'number' && task.originalMetadata.missingDetailCount > 0 && (
						<T size={12} muted>
							其中 {task.originalMetadata.missingDetailCount} 项仅保留真实索引身份，平台未返回详情；不可播放，未判断失效原因。
						</T>
					)}
					<Button
						disabled={!selected.length}
						onPress={session.openDestination}
					>
						核对保存去向，已选 {selected.length}
					</Button>
					<BiliPages
						label='原目录条目'
						items={task.entries}
						keyFor={(item) => item.entryId}
						page={state.page}
						change={(page) => {
							session.setPage(page)
							top()
						}}
						render={(item) => {
							const info = importEntryDescription(item, 'bilibili'),
								done = processed.has(item.entryId)
							return (
								<Card>
									<View style={{ gap: 8 }}>
										<T weight='600'>
											{item.originalPosition + 1}. {info.title}
										</T>
										<T
											muted
											size={12}
										>
											{info.artists}，{' '}
											{info.duration === null
												? '原时长缺失'
												: time(info.duration)}
										</T>
										<T size={12}>
											{contentKindNames[session.kind(item.entryId)]}，{' '}
											{done
												? '已处理（含跳过）'
												: item.review.state === 'confirmed'
												? item.review.candidates.find((candidate) => candidate.candidateId === item.review.confirmation?.candidateId)?.evidence.method === 'favorite-default-first-part' ? '默认第一 P' : '已选择分 P'
													: '尚未确认分 P'}
										</T>
										{!done && (
											<ControlTarget
												accessibilityRole='checkbox'
												accessibilityLabel={`选择原目录第${item.originalPosition + 1}项 ${info.title}`}
												accessibilityState={{ checked: item.selected }}
												onPress={() =>
													session.setSelected(item.entryId, !item.selected)
												}
												style={{ minHeight: 48, justifyContent: 'center' }}
											>
												<T>{item.selected ? '☑ 已选择' : '□ 未选择'}</T>
											</ControlTarget>
										)}
										<Button
											secondary
											onPress={() => session.openEntry(item.entryId)}
										>
											查看原条目并人工核对
										</Button>
									</View>
								</Card>
							)
						}}
					/>
					</>}
					{taskPage === 'history' && <>
					{!task.history.length && !task.organizations.length && <T muted>暂无导入历史</T>}
					{!!task.history.length && (
						<>
							<T weight='700'>本机处理历史</T>
							<BiliPages
								label='提交历史'
								items={task.history}
								keyFor={(event) => event.receipt.commitId}
								render={(event) =>
									event.kind === 'mixed' ? (
										<Button
											secondary
											onPress={() => session.openReceipt(event.receipt)}
										>
											查看混合保存结果，{event.receipt.results.length} 项
										</Button>
									) : (
										<T size={12}>
											历史音乐提交，{event.receipt.results.length}{' '}
											项（含跳过），原记录保留。
										</T>
									)
								}
							/>
						</>
					)}
					{!!task.organizations.length && (
						<>
							<T weight='700'>独立原项整理历史</T>
							<BiliPages
								label='整理历史'
								items={task.organizations}
								keyFor={(receipt) => receipt.operationId}
								render={(receipt) => (
									<Button
										secondary
										onPress={() => session.openOrganizationReceipt(receipt)}
									>
										查看已整理原项，{contentKindNames[receipt.contentKind]}
									</Button>
								)}
							/>
						</>
					)}
					</>}
				</>
			)}
			{state.route === 'entry' && entry && original && (
				<>
					<T
						size={21}
						weight='700'
					>
						{original.title}
					</T>
					<T size={12}>
						{original.artists}，{' '}
						{original.duration === null
							? '原时长缺失'
							: time(original.duration)}
					</T>
					<T
						size={11}
						muted
					>
						原媒体 {entry.originalEntryId ?? '身份未提供'}，BV{' '}
						{session.originalBvid() ?? '未提供'}，未核验独立音轨
					</T>
					<T weight='600'>
						人工内容类型：{contentKindNames[session.kind(entry.entryId)]}
					</T>
					{(!processed.has(entry.entryId) || state.organizationItem) && (
						<Button
							secondary
							onPress={() => setShowKinds((value) => !value)}
						>
							修改人工内容类型
						</Button>
					)}
					{showKinds && (
						<BiliPages
							label='内容类别'
							items={contentKinds.slice()}
							keyFor={(kind) => kind}
							render={(kind) => (
								<BiliChoice
									label={contentKindNames[kind]}
									selected={session.kind(entry.entryId) === kind}
									press={() => {
										session.setKind(kind)
										setShowKinds(false)
										top()
									}}
								/>
							)}
						/>
					)}
					{processed.has(entry.entryId) && (
						<T size={12}>该出现项已处理；原提交与跳过历史保留。</T>
					)}
					{state.organizationItem && (
						<Button
							disabled={session.kind(entry.entryId) === 'unknown'}
							onPress={session.openOrganization}
						>
							按人工类型明确整理原待分类项
						</Button>
					)}
					<Button
						secondary
						disabled={!session.originalBvid() || blocked}
						onPress={() => {
							void session.readVideo()
						}}
					>
						读取原BV真实分 P
					</Button>
					{entry.originalMetadata.detailState === 'not-returned' ? (
						<T>平台未返回此索引条目的详情，原身份和位置已保留；当前不可播放，不自动确认音源或判断失效原因。</T>
					) : !session.originalBvid() && (
						<T>原条目无可核验 BV；保留原证据，可按未知内容保存到待分类。</T>
					)}
					{state.video && (
						<>
							<View
								onLayout={(event) => {
									actionY.current = event.nativeEvent.layout.y
									focusActions()
								}}
							>
								<Card>
									<View style={{ gap: 10 }}>
										<T weight='700'>原视频分 P 操作</T>
										<T>
											当前选择 CID {state.selectedCid ?? '尚未选择'} ·
											不会默认首 P
										</T>
										<Button
											disabled={
												!state.selectedCid ||
												(processed.has(entry.entryId) &&
													!state.organizationItem &&
													(!state.binding || state.binding.sourceId !== null))
											}
											onPress={session.confirmCid}
										>
											明确确认所选原BV/CID
										</Button>
										{state.binding?.sourceId === null && (
											<Button
												disabled={entry.review.state !== 'confirmed'}
												onPress={session.resolvePending}
											>
												补全原歌单待匹配项（不重导）
											</Button>
										)}
										<Button
											secondary
											disabled={
												!state.selectedCid ||
												state.playback.busy ||
												playbackBusy
											}
											onPress={onPreview}
										>
											{session.kind(entry.entryId) === 'song'
												? '试听所选歌曲（不自动确认）'
												: '以听视频试听所选分P（不自动确认）'}
										</Button>
										{!!state.playback.error && (
											<T style={{ color: c.state.error }}>
												{state.playback.error}
											</T>
										)}
										{!!playbackError && (
											<T style={{ color: c.state.error }}>{playbackError}</T>
										)}
										<T
											muted
											size={11}
										>
											{entry.review.state === 'confirmed'
												? `已保存确认：${entry.review.confirmation?.sourceId}`
												: '尚未保存人工CID确认'}
											；播放失败不改变原确认。
										</T>
									</View>
								</Card>
							</View>
							<BiliParts
								video={state.video}
								cid={state.selectedCid}
								select={(cid) => {
									session.selectCid(cid)
									focusActions()
								}}
							/>
						</>
					)}
				</>
			)}
			{state.route === 'destination' && (
				<Destination
					key={task?.taskId}
					draft={destinationDrafts[destinationKey]}
					onDraftChange={(draft) => setDestinationDrafts((current) => ({
						...current,
						[destinationKey]: {
							...defaultDestinationDraft(task),
							...current[destinationKey],
							...draft,
						},
					}))}
					state={state}
					session={session}
				/>
			)}
			{state.route === 'organization' && (
				<Destination
					key={`organization:${task?.taskId}:${state.entryId}`}
					draft={destinationDrafts[organizationKey]}
					onDraftChange={(draft) => setDestinationDrafts((current) => ({
						...current,
						[organizationKey]: {
							...defaultDestinationDraft(task),
							...current[organizationKey],
							...draft,
						},
					}))}
					state={state}
					session={session}
					organize
				/>
			)}
			{state.route === 'organized' && state.organizationReceipt && (
				<>
					<T
						size={21}
						weight='700'
					>
						原待分类项整理完成
					</T>
					<T>
						{contentKindNames[state.organizationReceipt.contentKind]}，已整理到
						{state.organizationReceipt.targetKind === 'playlist'
							? '音乐歌单'
							: '听视频收藏'}
						，原条目及来源记录保留。
					</T>
					<T
						muted
						size={12}
					>
						初次提交与原证据保持。
						{state.organizationReceipt.targetKind === 'playlist' &&
						state.organizationReceipt.sourceId === null
							? '歌曲尚未确认 CID，原项可继续补全。'
							: '独立音轨可用性仍未核验。'}
					</T>
					{state.organizationReceipt.targetKind === 'playlist' ? (
						<Button
							onPress={() => onPlaylist(state.organizationReceipt!.targetId)}
						>
							打开整理后的真实音乐歌单
						</Button>
					) : (
						<Button onPress={() => onLibrary('listening')}>
							打开整理后的真实听视频收藏
						</Button>
					)}
					<Button
						secondary
						onPress={() => {
							const receipt = state.organizationReceipt!
							session.openTask(receipt.taskId)
							session.openEntry(receipt.entryId)
						}}
					>
						返回原项审核与补全
					</Button>
				</>
			)}
			{state.route === 'result' && state.receipt && !state.quick && (
				<>
					<T
						size={21}
						weight='700'
					>
						本次本机保存结果
					</T>
					<T>
						音乐歌单：新增 {state.receipt.counts.playlist.added} / 跳过{' '}
						{state.receipt.counts.playlist.skipped}；待匹配歌曲{' '}
						{state.receipt.counts.playlist.withoutConfirmedCid}
					</T>
					<T>
						听视频收藏：新增 {state.receipt.counts.listening.added} / 跳过{' '}
						{state.receipt.counts.listening.skipped}
					</T>
					<T>
						待分类：新增 {state.receipt.counts.unclassified.added} / 跳过{' '}
						{state.receipt.counts.unclassified.skipped}
					</T>
					<T
						muted
						size={12}
					>
						未选 {state.receipt.counts.unselected}，未处理{' '}
						{state.receipt.counts.unprocessed}。读取目录或确认分 P
						不代表音轨可用。
					</T>
					{state.receipt.playlistId && (
						<Button onPress={() => onPlaylist(state.receipt!.playlistId!)}>
							打开本次音乐歌单
						</Button>
					)}
					<Button onPress={() => onLibrary('listening')}>
						打开真实听视频收藏
					</Button>
					<Button
						secondary
						onPress={() => onLibrary('unclassified')}
					>
						打开真实待分类列表
					</Button>
					<Button
						secondary
						onPress={() => {
							if (state.task) session.openTask(state.task.taskId)
						}}
					>
						返回本机原目录任务
					</Button>
				</>
			)}
		</ScrollView>
	)
}
