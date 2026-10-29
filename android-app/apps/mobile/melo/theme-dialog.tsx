import React, { useEffect, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, View, type AlertButton, type AlertOptions } from 'react-native'

import { ControlTarget, T, useTheme } from './ui'

interface DialogRequest {
	title: string
	message?: string
	buttons: AlertButton[]
	options?: AlertOptions
}

function cancelDialog(value: DialogRequest) {
	if (value.options?.onDismiss) value.options.onDismiss()
	else value.buttons.find(button => button.style === 'cancel')?.onPress?.()
}

export function ConfirmationModal({ title, onCancel, children, testID, cancelable = true, backCancelable = cancelable }: {
	title: string
	onCancel: () => void
	children: React.ReactNode
	testID?: string
	cancelable?: boolean
	backCancelable?: boolean
}) {
	const theme = useTheme()
	return <Modal visible transparent animationType='none' onRequestClose={() => { if (backCancelable) onCancel() }}>
		<View testID={testID} style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#00000066' }}>
			<Pressable accessibilityLabel='关闭确认框' accessibilityRole='button' disabled={!cancelable}
				onPress={onCancel} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} />
			<View accessibilityViewIsModal style={{ backgroundColor: theme.tokens.surface.card, borderColor: theme.tokens.border.subtle, borderWidth: 1, borderRadius: 20, padding: 20, maxHeight: '80%' }}>
				<ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps='handled'>
					<T size={20} weight='700'>{title}</T>
					{children}
				</ScrollView>
			</View>
		</View>
	</Modal>
}

/** App confirmations follow the displayed theme, independently of the OS palette. */
export function useThemeDialog() {
	const theme = useTheme()
	const [request, setRequest] = useState<DialogRequest | null>(null)
	const pending = useRef<DialogRequest | null>(null)
	useEffect(() => () => {
		const value = pending.current
		pending.current = null
		if (value) cancelDialog(value)
	}, [])
	const dismiss = () => {
		const value = pending.current
		pending.current = null
		setRequest(null)
		if (value) cancelDialog(value)
	}
	const show = (title: string, message?: string, buttons: AlertButton[] = [{ text: '确定' }], options?: AlertOptions) => {
		if (pending.current) return
		const value = { title, message, buttons, options }
		pending.current = value
		setRequest(value)
	}
	const dialog = request ? <ConfirmationModal title={request.title} onCancel={dismiss} cancelable={!!request.options?.cancelable} backCancelable>
					{!!request.message && <T muted size={14}>{request.message}</T>}
					{request.buttons.map((button) => <ControlTarget key={button.text} accessibilityRole='button' accessibilityLabel={button.text}
						onPress={() => {
							if (pending.current !== request) return
							pending.current = null
							setRequest(null)
							button.onPress?.()
						}} style={{ minHeight: 48, justifyContent: 'center', paddingVertical: 12 }}>
						<T weight='600' style={{ color: button.style === 'destructive' ? theme.tokens.state.error : theme.tokens.action.primary }}>{button.text}</T>
					</ControlTarget>)}
	</ConfirmationModal> : null
	return { show, dialog }
}
