import React from 'react'

import { SettingsRow } from './settings-layout'
import { useThemeDialog } from './theme-dialog'

export function AccountSignOut({ onSignOut }: { onSignOut: () => void }) {
	const confirmation = useThemeDialog()
	return <>
		<SettingsRow label='退出 B 站账号' onPress={() => confirmation.show(
			'退出 B 站账号？',
			'退出后需要重新登录。本机音乐、喜欢和歌单会保留。',
			[
				{ text: '取消', style: 'cancel' },
				{ text: '退出账号', style: 'destructive', onPress: onSignOut },
			],
			{ cancelable: true },
		)} />
		{confirmation.dialog}
	</>
}
