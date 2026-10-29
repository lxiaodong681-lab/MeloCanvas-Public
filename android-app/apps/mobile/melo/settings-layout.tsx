import React, { useState, type PropsWithChildren } from 'react'
import { View } from 'react-native'

import { ControlTarget, Icon, IconButton, T, useTheme, type IconName } from './ui'

export function PageHeader({ title, onBack, backLabel = '返回', disabled = false }: {
	title: string; onBack: () => void; backLabel?: string; disabled?: boolean
}) {
	return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8 }}>
		<IconButton name='back' label={backLabel} disabled={disabled} onPress={onBack} />
		<T size={22} weight='700' style={{ flex: 1 }}>{title}</T>
	</View>
}

/** Secondary help stays available without preceding the primary action. */
export function SettingsDetails({ title, children }: PropsWithChildren<{ title: string }>) {
	const [expanded, setExpanded] = useState(false)
	const c = useTheme().tokens
	return <View>
		<ControlTarget accessibilityRole='button' accessibilityLabel={title} accessibilityState={{ expanded }}
			onPress={() => setExpanded(!expanded)} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
			<T size={13} style={{ color: c.action.primary, flex: 1 }}>{title}</T><Icon name={expanded ? 'down' : 'arrow'} size={16} />
		</ControlTarget>
		{expanded && <View style={{ gap: 12, paddingBottom: 12 }}>{children}</View>}
	</View>
}

/** Shared compact settings layout. Actions remain owned by their existing sessions. */
export function SettingsGroup({
	title,
	children,
}: PropsWithChildren<{ title?: string }>) {
	const c = useTheme().tokens
	return (
		<View style={{ marginBottom: 22 }}>
			{!!title && (
				<T
					variant='caption'
					style={{ marginBottom: 9 }}
				>
					{title}
				</T>
			)}
			<View
				style={{
					backgroundColor: c.surface.card,
					borderRadius: 12,
					borderWidth: 1,
					borderColor: c.border.subtle,
					paddingHorizontal: 14,
				}}
			>
				{children}
			</View>
		</View>
	)
}

export function SettingsRow({
	label,
	detail,
	value,
	icon,
	onPress,
	disabled = false,
}: {
	label: string
	detail?: string
	value?: string
	icon?: IconName
	onPress: () => void
	disabled?: boolean
}) {
	const c = useTheme().tokens
	return (
		<ControlTarget
			accessibilityRole='button'
			accessibilityLabel={label}
			accessibilityState={{ disabled }}
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => ({
				minHeight: 54,
				flexDirection: 'row',
				alignItems: 'center',
				gap: 12,
				paddingVertical: 12,
				borderBottomWidth: 1,
				borderBottomColor: c.border.subtle,
				opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
			})}
		>
			{icon && (
				<Icon
					name={icon}
					size={20}
					color={c.text.secondary}
				/>
			)}
			<View style={{ flex: 1, minWidth: 0 }}>
				<T>{label}</T>
				{!!detail && (
					<T
						variant='caption'
						style={{ marginTop: 3 }}
					>
						{detail}
					</T>
				)}
			</View>
			{!!value && (
				<T
					variant='caption'
					style={{ flexShrink: 1 }}
				>
					{value}
				</T>
			)}
			<Icon
				name='arrow'
				size={16}
				color={c.text.secondary}
			/>
		</ControlTarget>
	)
}
