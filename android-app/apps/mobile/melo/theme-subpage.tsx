import React, { type PropsWithChildren } from 'react'
import { KeyboardAvoidingView, Modal, Platform, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { PageHeader } from './settings-layout'
import { useTheme } from './ui'

/** A single task surface; parent workshop content stays behind the native modal. */
export function ThemeSubpage({ title, onBack, children, scroll = true }: PropsWithChildren<{
	title: string; onBack: () => void; scroll?: boolean
}>) {
	const c = useTheme().tokens
	const insets = useSafeAreaInsets()
	return <Modal visible animationType='none' onRequestClose={onBack}>
		<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, backgroundColor: c.surface.base, paddingTop: insets.top, paddingBottom: insets.bottom }}>
			<PageHeader title={title} backLabel={`返回${title}的上一级`} onBack={onBack} />
			{scroll ? <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 16 }} keyboardShouldPersistTaps='handled'>{children}</ScrollView> : <View style={{ flex: 1 }}>{children}</View>}
		</KeyboardAvoidingView>
	</Modal>
}
