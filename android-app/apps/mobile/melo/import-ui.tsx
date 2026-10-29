import React, { useState } from 'react'
import { FlatList, Keyboard, Linking, ScrollView, View } from 'react-native'

import type { Source } from './core/model'
import {
	importEntryDescription,
	importProviderName,
	importTaskDescription,
} from './import-display'
import type { ImportSession, ImportState } from './import-session'
import { ThemeTextInput } from './theme-input'
import { ThemeSubpage as Subpage } from './theme-subpage'
import {
	Artwork,
	Button,
	Card,
	ControlTarget,
	Icon,
	IconButton,
	T,
	time,
	useTheme,
} from './ui'

interface Props {
	state: ImportState
	session: ImportSession
	onPreview: (source: Source) => void
	onOpenPlaylist: (playlistId: string) => void
	onBilibili: () => void
	onBilibiliTask: (taskId: string) => void
	playbackBusy: boolean
	playbackError: string | null
	onPage?: () => void
}

export function ImportEntry({ onPress }: { onPress: () => void }) {
	return (
		<ControlTarget
			accessibilityRole='button'
			accessibilityLabel='导入与恢复歌单'
			onPress={onPress}
			style={{ marginTop: 20 }}
		>
			<Card>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
					<Icon name='library' />
					<View style={{ flex: 1 }}>
						<T weight='600'>导入歌单</T>
						<T
							muted
							size={13}
						>
							B站，网易云音乐，QQ 音乐
						</T>
					</View>
					<Icon name='arrow' />
				</View>
			</Card>
		</ControlTarget>
	)
}

function Row({
	title,
	subtitle,
	onPress,
}: {
	title: string
	subtitle?: string
	onPress: () => void
}) {
	const c = useTheme().tokens
	return (
		<ControlTarget
			accessibilityRole='button'
			accessibilityLabel={title}
			onPress={onPress}
			style={{
				minHeight: 68,
				flexDirection: 'row',
				alignItems: 'center',
				gap: 12,
				paddingVertical: 12,
				borderBottomWidth: 1,
				borderBottomColor: c.border.subtle,
			}}
		>
			<View style={{ flex: 1, gap: 5 }}>
				<T
					weight='600'
					lines={1}
				>
					{title}
				</T>
				{!!subtitle && (
					<T
						muted
						size={13}
						lines={2}
					>
						{subtitle}
					</T>
				)}
			</View>
			<Icon
				name='arrow'
				size={18}
			/>
		</ControlTarget>
	)
}

function SourcePicker({
	state,
	session,
	onPreview,
	onOpenPlaylist,
	playbackBusy,
	playbackError,
}: Props) {
	const c = useTheme().tokens
	const entry = state.task?.entries.find(
		(value) => value.entryId === state.entryId,
	)
	const original = entry && importEntryDescription(entry, state.task!.provider)
	const source = session.selectedSource()
	async function choose(bvid: string) {
		Keyboard.dismiss()
		if (await session.readVideo(bvid)) {
			const video = session.getSnapshot().video
			if (video?.parts.length === 1)
				session.selectCid(video.parts[0].source.cid)
		}
	}
	return (
		<View style={{ flex: 1 }}>
			<View style={{ paddingHorizontal: 20, paddingBottom: 12, gap: 8 }}>
				<T
					weight='600'
					lines={1}
				>
					{original?.title}
				</T>
				<T
					muted
					size={13}
					lines={1}
				>
					{original?.artists}，
					{original?.duration ? time(original.duration) : ''}
				</T>
				<View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
					<ThemeTextInput
						accessibilityLabel='导入候选关键词或BV号'
						value={state.query}
						onChangeText={session.setQuery}
						onSubmitEditing={() => void session.searchCandidates()}
						placeholder='歌名、歌手或 BV 号'
						style={{
							flex: 1,
							height: 48,
							borderRadius: 12,
							paddingHorizontal: 12,
							backgroundColor: c.surface.card,
							color: c.text.primary,
							borderWidth: 1,
							borderColor: c.border.subtle,
						}}
					/>
					<IconButton
						name='search'
						label='搜索音源'
						disabled={state.searching}
						onPress={() => void session.searchCandidates()}
					/>
				</View>
				{!!(state.error || playbackError) && (
					<T
						size={13}
						style={{ color: c.state.error }}
					>
						{state.error || playbackError}
					</T>
				)}
				{state.videoBusy && (
					<T
						muted
						size={13}
					>
						正在读取音源…
					</T>
				)}
			</View>
			{state.video ? (
				<FlatList
					data={state.video.parts}
					keyExtractor={(part) => String(part.source.cid)}
					initialNumToRender={8}
					windowSize={5}
					contentContainerStyle={{ paddingHorizontal: 20 }}
					ListHeaderComponent={
						<View style={{ gap: 10, marginBottom: 12 }}>
							<T
								weight='600'
								lines={2}
							>
								{state.video.title}
							</T>
							<View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
							<ControlTarget fixedWidth minimumWidthDp={112} accessibilityRole='button' accessibilityLabel='返回搜索结果'
								onPress={session.showSearchResults} style={{ minHeight: 48, justifyContent: 'center', paddingRight: 12 }}>
								<T size={13} style={{ color: c.action.primary }}>返回搜索结果</T>
							</ControlTarget>
							<ControlTarget fixedWidth minimumWidthDp={96} accessibilityRole='button' accessibilityLabel='查看原视频'
								style={{ minHeight: 48, justifyContent: 'center', paddingLeft: 12 }}
								onPress={session.createOriginalVideoAction(
									state.video.bvid,
									(url) => Linking.openURL(url),
								)}
							>
								<T size={13} style={{ color: c.action.primary }}>查看原视频</T>
							</ControlTarget>
							</View>
						</View>
					}
					renderItem={({ item: part }) => (
						<ControlTarget
							accessibilityRole='radio'
							accessibilityLabel={`选择分P ${part.page} ${part.title}`}
							accessibilityState={{
								checked: part.source.cid === state.selectedCid,
							}}
							onPress={() => session.selectCid(part.source.cid)}
							style={{
								minHeight: 68,
								flexDirection: 'row',
								alignItems: 'center',
								gap: 12,
								paddingVertical: 12,
								borderBottomWidth: 1,
								borderBottomColor: c.border.subtle,
							}}
						>
							<View style={{ flex: 1, gap: 4 }}>
								<T
									size={16}
									lines={2}
								>
									{part.title}
								</T>
								<T
									muted
									size={13}
								>
									{time(part.source.duration)}
								</T>
							</View>
							{part.source.cid === state.selectedCid && (
								<Icon
									name='check'
									color={c.action.primary}
								/>
							)}
						</ControlTarget>
					)}
				/>
			) : (
				<FlatList
					data={state.candidates}
					keyExtractor={(item) => item.bvid}
					keyboardShouldPersistTaps='handled'
					initialNumToRender={8}
					windowSize={5}
					contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16 }}
					renderItem={({ item }) => (
						<ControlTarget
							accessibilityRole='button'
							accessibilityLabel={`选择音源 ${item.originalTitle}`}
							disabled={state.videoBusy}
							onPress={() => void choose(item.bvid)}
							style={{
								flexDirection: 'row',
								alignItems: 'center',
								gap: 12,
								minHeight: 84,
								paddingVertical: 12,
								borderBottomWidth: 1,
								borderBottomColor: c.border.subtle,
							}}
						>
							<Artwork
								uri={item.artwork}
								size={48}
							/>
							<View style={{ flex: 1, gap: 5 }}>
								<T
									size={16}
									weight='600'
									lines={2}
								>
									{item.originalTitle}
								</T>
								<T
									size={13}
									muted
									lines={1}
								>
									{item.uploader}，{time(item.duration)}
								</T>
							</View>
							<Icon
								name='arrow'
								size={18}
							/>
						</ControlTarget>
					)}
					ListEmptyComponent={
						<View style={{ paddingVertical: 36 }}>
							<T muted>
								{state.searching
									? '正在搜索音源…'
									: state.searchError ||
										'没有找到合适音源，试试修改歌名或输入 BV 号。'}
							</T>
						</View>
					}
					ListFooterComponent={
						state.searchMore ? (
							<Button
								secondary
								disabled={state.searching}
								onPress={() => void session.searchCandidates(true)}
							>
								加载更多
							</Button>
						) : null
					}
				/>
			)}
			{state.video && (
				<View
					style={{
						padding: 16,
						gap: 10,
						backgroundColor: c.surface.card,
						borderTopWidth: 1,
						borderTopColor: c.border.subtle,
					}}
				>
					<View style={{ flexDirection: 'row', gap: 12 }}>
						<View style={{ flex: 1 }}>
							<Button
								secondary
								disabled={!source || playbackBusy}
								onPress={() => source && onPreview(source)}
							>
								试听
							</Button>
						</View>
						<View style={{ flex: 2 }}>
							<Button
								disabled={!source || state.videoBusy}
								onPress={() => {
									const playlistId = session.applySelectedSource()
									if (playlistId) onOpenPlaylist(playlistId)
									else if (playlistId === '') session.back()
								}}
							>
								使用这个音源
							</Button>
						</View>
					</View>
				</View>
			)}
		</View>
	)
}

export function ImportPage(props: Props) {
	const { state, session, onOpenPlaylist } = props
	const c = useTheme().tokens
	const [tutorial, setTutorial] = useState(false)
	const [historyOpen, setHistoryOpen] = useState(false)
	const running = state.reading || state.batch?.phase === 'running'
	const task = state.task
	const description = task && importTaskDescription(task)
	const start = async () => {
		Keyboard.dismiss()
		const id = await session.importPlaylist()
		if (id) onOpenPlaylist(id)
	}
	const back = () => {
		if (state.route === 'entry' && state.binding)
			onOpenPlaylist(state.binding.playlistId)
		else session.back()
	}
	return (
		<View
			testID='import-page'
			style={{ flex: 1, backgroundColor: c.surface.base }}
		>
			<View
				style={{
					flexDirection: 'row',
					alignItems: 'center',
					gap: 10,
					paddingHorizontal: 12,
					paddingVertical: 8,
					borderBottomWidth: 1,
					borderBottomColor: c.border.subtle,
				}}
			>
				<IconButton
					name='back'
					label='返回导入上一步'
					onPress={back}
				/>
				<T
					size={22}
					weight='700'
					style={{ flex: 1 }}
				>
					{state.route === 'entry' ? '更换音源' : '导入歌单'}
				</T>
				<IconButton
					name='close'
					label='关闭歌单导入'
					onPress={session.close}
				/>
			</View>
			{state.route === 'entry' ? (
				<SourcePicker {...props} />
			) : (
				<>
					<ScrollView
						key={state.route}
						keyboardShouldPersistTaps='handled'
						contentContainerStyle={{ padding: 20, gap: 16 }}
					>
						{!!state.error && (
							<Card>
								<T
									size={13}
									style={{ color: c.state.error }}
								>
									{state.error}
								</T>
							</Card>
						)}
						{state.route === 'home' && (
							<>
								<T
									muted
									size={13}
								>
									选择歌单来源
								</T>
								<Card>
									<Row
										title='网易云音乐'
										subtitle='粘贴分享链接，自动匹配 B站音源'
										onPress={() => session.chooseProvider('netease')}
									/>
									<Row
										title='QQ 音乐'
										subtitle='粘贴分享链接，自动匹配 B站音源'
										onPress={() => session.chooseProvider('qq')}
									/>
									<Row
										title='B站收藏夹'
										subtitle='导入收藏夹里的音乐'
										onPress={props.onBilibili}
									/>
									<Row title='酷我音乐' subtitle='公开歌单完整链接，核对全部分页' onPress={() => session.chooseProvider('kuwo')} />
									<Row title='汽水音乐' subtitle='完整歌单链接；仅歌曲目录，不含抖音原声' onPress={() => session.chooseProvider('qishui')} />
									<Row title='酷狗音乐' subtitle='公开分享目录；平台可能只返回部分歌曲' onPress={() => session.chooseProvider('kugou')} />
								</Card>
								<Card><Row title='导入记录' onPress={() => setHistoryOpen(true)} /></Card>
							</>
						)}
						{state.route === 'input' && (
							<>
								<T
									size={22}
									weight='700'
								>
									{importProviderName(state.provider ?? '')}
								</T>
								<T
									muted
									size={13}
								>
									粘贴歌单链接或整段分享文字，自动匹配音源。
								</T>
								{['kuwo','qishui','kugou'].includes(state.provider ?? '') && <T size={12} muted>请使用官方完整链接。短链可先在浏览器打开后复制地址；仅读取公开歌曲目录，不登录其他平台，不读取其音频。平台限量返回时会明确提示未读完整。</T>}
								<ThemeTextInput
									accessibilityLabel='外部歌单完整链接'
									multiline
									value={state.url}
									onChangeText={session.setUrl}
									editable={!running}
									placeholder='粘贴歌单链接或分享文字'
									autoCapitalize='none'
									style={{
										minHeight: 140,
										textAlignVertical: 'top',
										padding: 16,
										borderRadius: 16,
										color: c.text.primary,
										backgroundColor: c.surface.card,
										borderWidth: 1,
										borderColor: c.border.subtle,
									}}
								/>
								<ControlTarget
									accessibilityRole='button'
									accessibilityLabel='查看导入教程'
									onPress={() => setTutorial(!tutorial)}
									style={{ minHeight: 48, justifyContent: 'center' }}
								>
									<T
										size={13}
										style={{ color: c.action.primary }}
									>
										如何复制歌单链接？
									</T>
								</ControlTarget>
							</>
						)}
						{(state.route === 'task' ||
							state.route === 'destination' ||
							state.route === 'result') &&
							task && (
								<>
									<T
										size={22}
										weight='700'
									>
										{description?.name}
									</T>
									<T
										muted
										size={13}
									>
										{importProviderName(task.provider)}，{task.entryCount} 首
									</T>
									{description?.incomplete && (
										<T size={13}>
											平台未返回全部歌曲，目前已读取 {description.read}{' '}
											首，缺失信息的条目也会保留。
										</T>
									)}
									<Card>
										<T weight='600'>
											{running
												? '正在自动匹配音源'
												: state.receipt
													? '歌单已导入'
													: '准备导入'}
										</T>
										<T
											muted
											size={13}
											style={{ marginTop: 8 }}
										>
											{state.batch
												? `已处理 ${state.batch.completed} / ${state.batch.budget} 首，暂未匹配 ${state.batch.empty} 首`
												: '按原歌单顺序保存'}
										</T>
										{running && (
											<View
												style={{
													height: 4,
													marginTop: 16,
													backgroundColor: c.surface.tinted,
													borderRadius: 2,
												}}
											>
												<View
													style={{
														height: 4,
														width: `${Math.round((100 * (state.batch?.completed ?? 0)) / Math.max(1, state.batch?.budget ?? 1))}%`,
														backgroundColor: c.action.primary,
														borderRadius: 2,
													}}
												/>
											</View>
										)}
									</Card>
									<T
										size={13}
										muted
									>
										{running
											? '可以暂停，稍后继续；已匹配的结果会保存。'
											: '歌曲菜单中可更换音源。'}
									</T>
									<Card>
										{task.entries.slice(0, 5).map((entry) => {
											const info = importEntryDescription(entry, task.provider)
											return (
												<View
													key={entry.entryId}
													style={{
														flexDirection: 'row',
														gap: 12,
														paddingVertical: 12,
														alignItems: 'center',
													}}
												>
													<T
														muted
														size={13}
													>
														{entry.originalPosition + 1}
													</T>
													<View style={{ flex: 1, gap: 5 }}>
														<T
															lines={1}
															size={16}
														>
															{info.title}
														</T>
														<T
															muted
															lines={1}
															size={13}
														>
															{info.artists}
														</T>
													</View>
													{entry.review.state === 'confirmed' && (
														<Icon
															name='check'
															color={c.action.primary}
															size={18}
														/>
													)}
												</View>
											)
										})}
										{task.entryCount > 5 && (
											<T
												muted
												size={13}
											>
												共 {task.entryCount} 首，全部按顺序导入
											</T>
										)}
									</Card>
								</>
							)}
					</ScrollView>
					{state.route !== 'home' && (
						<View
							style={{
								padding: 16,
								gap: 8,
								backgroundColor: c.surface.card,
								borderTopWidth: 1,
								borderTopColor: c.border.subtle,
							}}
						>
							<Button
								disabled={
									running || (state.route === 'input' && !state.url.trim())
								}
								onPress={() => void start()}
							>
								{state.reading
									? '正在读取歌单…'
									: running
										? `正在匹配 ${state.batch?.completed ?? 0}/${state.batch?.budget ?? 0}`
										: task?.commits.length
											? '补匹配并打开歌单'
											: state.batch?.phase === 'paused'
												? '继续导入'
												: '导入歌单'}
							</Button>
							{running && (
								<Button
									secondary
									onPress={
										state.reading ? session.cancelRead : session.pauseBatch
									}
								>
									暂停导入
								</Button>
							)}
							{!!state.unsaved && (
								<Button
									secondary
									onPress={() => {
										if (session.saveDirectory()) void start()
									}}
								>
									重试保存
								</Button>
							)}
						</View>
					)}
				</>
			)}
			{historyOpen && state.route === 'home' && <Subpage title='导入记录' onBack={() => setHistoryOpen(false)} scroll={false}>
				<FlatList
					data={state.tasks}
					keyExtractor={item => item.taskId}
					initialNumToRender={10}
					maxToRenderPerBatch={10}
					windowSize={5}
					contentContainerStyle={{ padding: 20 }}
					ListEmptyComponent={<T muted>暂无导入记录</T>}
					renderItem={({ item }) => <Row
						title={importProviderName(item.provider) + '，' + item.entryCount + ' 首'}
						subtitle={new Date(item.createdAt).toLocaleDateString()}
						onPress={() => item.provider === 'bilibili' ? props.onBilibiliTask(item.taskId) : session.openTask(item.taskId)}
					/>}
				/>
			</Subpage>}

								{tutorial && state.route === 'input' && (
									<Subpage title='导入教程' onBack={() => setTutorial(false)}>
										<T size={13}>
											1. 在原音乐软件打开歌单，选择“分享 → 复制链接”。{'\n\n'}2.
											将分享文字粘贴到这里，点击“导入歌单”。{'\n\n'}3.
											自动匹配完成后即可播放。版本不合适时，点击歌曲右侧“⋯ →
											更换音源”。{'\n\n'}
											歌单需公开可访问，未匹配的歌曲也会保留。
										</T>
									</Subpage>
								)}
		</View>
	)
}
