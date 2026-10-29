import React from 'react'
import { ScrollView, View } from 'react-native'

import type { FmSession } from './fm-session'
import { Artwork, Button, Card, IconButton, State, T, useTheme } from './ui'

export function FmPage({
	state,
	session,
	onClose,
	onStart,
	onExit,
	onPlayer,
	onResume,
	onSearch,
	onLibrary,
	playbackError,
}: {
	state: ReturnType<FmSession['getSnapshot']>
	session: FmSession
	onClose: () => void
	onStart: () => void
	onExit: () => void
	onPlayer: () => void
	onResume: () => void
	onSearch: () => void
	onLibrary: () => void
	playbackError: string
}) {
	const c = useTheme().tokens
	return (
		<ScrollView
			testID='fm-page'
			contentContainerStyle={{ padding: 20, paddingBottom: 24, gap: 14 }}
		>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
				<IconButton
					name='back'
					label='返回私人 FM 之前的页面'
					onPress={onClose}
				/>
				<T
					size={23}
					weight='700'
					style={{ flex: 1 }}
				>
					私人 FM
				</T>
			</View>
			<Card>
				<T
					size={14}
					weight='700'
				>
					{state.contextId
						? state.selected
							? '当前为私人 FM'
							: '私人 FM 已暂存'
						: '私人 FM · 心动推荐'}
				</T>
				<T
					size={12}
					muted
					style={{ marginTop: 8 }}
				>
					{state.contextId
						? '退出 FM 后，恢复进入前的队列、进度与播放状态。'
						: '可以播放本机候选，或按歌单查找新音乐。确认后暂存当前播放状态并开始 FM，退出时恢复。'}
				</T>
			</Card>
			{!!state.error && (
				<State
					title='播放操作未完成'
					message={state.error}
				/>
			)}
			{!!playbackError && (
				<T style={{ color: c.state.error }}>{playbackError}</T>
			)}
			{state.contextId ? (
				<>
					<Button
						disabled={state.busy}
						onPress={state.selected ? onPlayer : onResume}
					>
						{state.selected ? '打开 FM 播放器' : '返回音乐并继续 FM'}
					</Button>
					<Button
						secondary
						disabled={state.busy}
						onPress={onExit}
					>
						{state.busy ? '正在处理…' : '退出私人 FM 并恢复原播放'}
					</Button>
					{!!state.refillMessage && (
						<T
							size={12}
							muted
						>
							{state.refillMessage}
						</T>
					)}
					{state.selected && (
						<Button
							secondary
							disabled={state.busy || state.refill === 'loading'}
							onPress={() => {
								void session.retryRefill()
							}}
						>
							{state.refill === 'loading'
								? '正在检查本机候选…'
								: '再检查本机候选'}
						</Button>
					)}
				</>
			) : (
				<>
					<Card>
						<T weight='700'>心动推荐（试验）</T>
						<T size={12} muted>综合各平台已导入的音乐歌单和喜欢，播放记录只作少量参考。点击后向 B 站发送最多三个歌手或歌曲关键词，不上传完整歌单。新候选优先，之后补充本机音乐。</T>
						<Button disabled={state.busy || state.heartLoading} onPress={() => { void session.loadHeartCandidates() }}>
							{state.heartLoading ? '正在寻找新的声音…' : '按我的歌单找一批'}
						</Button>
						{!!state.heartQueries?.length && <T size={12} muted>本次关键词：{state.heartQueries.join('、')}</T>}
						{!!state.heartMessage && <T size={12}>{state.heartMessage}</T>}
						{state.heartLoading && <Button secondary onPress={session.cancelPending}>停止查找</Button>}
					</Card>
					{state.candidateError ? (
						<State
							title='本机候选暂时无法读取'
							message={state.candidateError}
							retry={session.loadCandidates}
						/>
					) : !state.candidates.length ? (
						<State
							title='暂时没有合格的本机候选'
							message='先搜索歌曲、核对版本并保存到音乐库，再来开始私人 FM。'
						/>
					) : (
						<T size={13}>
							本批 {state.candidates.length} 首{state.heartSelected ? '心动' : '本机'}候选 · 候选耗尽后停止
						</T>
					)}
					<Button
						disabled={
							state.busy || state.heartLoading || !!state.candidateError || !state.candidates.length
						}
						onPress={onStart}
					>
						{state.busy ? '正在准备 FM…' : '确认开始私人 FM'}
					</Button>
					{!state.candidateError &&
						state.candidates.map(({ source }) => (
							<View
								key={source.id}
								style={{
									flexDirection: 'row',
									gap: 10,
									alignItems: 'center',
									minHeight: 60,
								}}
							>
								<Artwork
									uri={source.artwork}
									style={{ width: 48, height: 48, borderRadius: 8 }}
								/>
								<View style={{ flex: 1 }}>
									<T
										size={13}
										lines={2}
									>
										{source.originalTitle}
									</T>
									<T
										size={11}
										muted
										lines={1}
									>
										UP · {source.uploader}
									</T>
								</View>
							</View>
						))}
					<Button
						secondary
						disabled={state.busy}
						onPress={session.loadCandidates}
					>
						重新检查本机候选
					</Button>
				</>
			)}
			{state.busy && (
				<Button
					secondary
					onPress={session.cancelPending}
				>
					取消本次播放准备
				</Button>
			)}
			<View style={{ flexDirection: 'row', gap: 10 }}>
				<View style={{ flex: 1 }}>
					<Button
						secondary
						onPress={onSearch}
					>
						搜索歌曲
					</Button>
				</View>
				<View style={{ flex: 1 }}>
					<Button
						secondary
						onPress={onLibrary}
					>
						打开音乐库
					</Button>
				</View>
			</View>
		</ScrollView>
	)
}
