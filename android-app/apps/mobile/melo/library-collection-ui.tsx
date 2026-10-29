import React, { useState, type ReactNode } from 'react'
import { Modal, Pressable, ScrollView, View } from 'react-native'

import { Artwork, ControlRow, ControlTarget, T, shape, useTheme } from './ui'

export interface CollectionAction {
	label: string
	onPress: () => void
	disabled?: boolean
}

/** Secondary tools stay one tap away without competing with the music list. */
export function CollectionMenu({
	label,
	actions,
	trigger,
}: {
	label: string
	actions: CollectionAction[]
	trigger?: ReactNode
}) {
	const [open, setOpen] = useState(false)
	const theme = useTheme()
	return (
		<>
			<ControlTarget
				fixed
				accessibilityRole='button'
				accessibilityLabel={label}
				onPress={() => setOpen(true)}
				style={{
					minWidth: 48,
					minHeight: 48,
					alignItems: 'center',
					justifyContent: 'center',
				}}
			>
				{trigger ?? <T size={24}>⋯</T>}
			</ControlTarget>
			<Modal
				visible={open}
				transparent
				animationType='none'
				onRequestClose={() => setOpen(false)}
			>
				<View
					style={{
						flex: 1,
						justifyContent: 'flex-end',
						backgroundColor: '#00000066',
					}}
				>
					<Pressable
						accessibilityRole='button'
						accessibilityLabel='关闭操作菜单'
						onPress={() => setOpen(false)}
						style={{
							position: 'absolute',
							top: 0,
							right: 0,
							bottom: 0,
							left: 0,
						}}
					/>
					<View
						accessibilityViewIsModal
						style={[
							shape(theme.components.card),
							{
								backgroundColor: theme.tokens.surface.card,
								padding: 20,
								paddingBottom: 32,
								maxHeight: '70%',
							},
						]}
					>
						<T
							size={16}
							weight='600'
						>
							{label}
						</T>
						<ScrollView
							keyboardShouldPersistTaps='handled'
							style={{ marginTop: 10 }}
						>
							{actions.map((action) => (
								<ControlTarget
									key={action.label}
									accessibilityRole='button'
									accessibilityLabel={action.label}
									disabled={action.disabled}
									accessibilityState={{ disabled: !!action.disabled }}
									onPress={() => {
										setOpen(false)
										action.onPress()
									}}
									style={{
										minHeight: 52,
										paddingVertical: 14,
										opacity: action.disabled ? 0.45 : 1,
									}}
								>
									<T>{action.label}</T>
								</ControlTarget>
							))}
						</ScrollView>
						<ControlTarget
							accessibilityRole='button'
							accessibilityLabel='取消操作'
							onPress={() => setOpen(false)}
							style={{
								minHeight: 48,
								alignItems: 'center',
								justifyContent: 'center',
								marginTop: 8,
							}}
						>
							<T muted>取消</T>
						</ControlTarget>
					</View>
				</View>
			</Modal>
		</>
	)
}

export function CollectionSongRow({
	title,
	subtitle,
	artwork,
	onPlay,
	disabled,
	trailing,
}: {
	title: string
	subtitle: string
	artwork?: string
	onPlay: () => void
	disabled?: boolean
	trailing?: ReactNode
}) {
	const theme = useTheme()
	return (
		<ControlRow
			controlMinWidthsDp={trailing ? [116, 48] : [116]}
			gapDp={8}
			style={{
				flexDirection: 'row',
				alignItems: 'center',
				gap: 8,
				paddingVertical: 6,
				borderBottomWidth: 1,
				borderBottomColor: theme.tokens.border.subtle,
			}}
		>
			<ControlTarget
				minimumWidthDp={116}
				minimumHeightDp={64}
				accessibilityRole='button'
				accessibilityLabel={`播放 ${title}`}
				disabled={disabled}
				onPress={onPlay}
				style={{
					flex: 1,
					minHeight: 64,
					flexDirection: 'row',
					alignItems: 'center',
					gap: 12,
				}}
			>
				<Artwork
					uri={artwork}
					size={46}
					style={shape(theme.components.card)}
				/>
				<View style={{ flex: 1, minWidth: 0, gap: 4 }}>
					<T
						size={15}
						weight='600'
						lines={2}
					>
						{title}
					</T>
					<T
						size={12}
						muted
						lines={1}
					>
						{subtitle}
					</T>
				</View>
			</ControlTarget>
			{trailing}
		</ControlRow>
	)
}
