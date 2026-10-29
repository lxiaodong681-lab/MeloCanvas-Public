import { Image } from 'expo-image'
import { Directory, File, Paths } from 'expo-file-system'
import React, { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { useThemeDialog } from './theme-dialog'

import type { Library } from './core/database'
import { playlistCoverFiles } from './playlist-cover-mobile'
import { ControlTarget, Icon, useTheme, useThemeRendering } from './ui'

export function ProfileAvatar({ library, accountId, accountAvatar, onNotice }: {
	library: Pick<Library, 'setting' | 'setSetting'>
	accountId?: string
	accountAvatar?: string
	onNotice: (message: string) => void
}) {
	const theme = useTheme()
	const frame = useThemeRendering()?.surfaceArt?.avatarFrame
	// Keep the face inside the pendant's central opening, with decorations above it.
	const avatarSize = frame ? 50 : 64
	const confirmation = useThemeDialog()
	const id = accountId || library.setting('profile.lastAccount') || 'offline'
	const key = `profile.avatar.${id}`
	const [custom, setCustom] = useState(() => library.setting(key))
	const [busy, setBusy] = useState(false)
	const alive = useRef(true)
	useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
	useEffect(() => {
		setCustom(library.setting(key))
		if (accountId) {
			library.setSetting('profile.lastAccount', accountId)
			if (accountAvatar) library.setSetting(`profile.bilibiliAvatar.${accountId}`, accountAvatar)
		}
	}, [library, key, accountId, accountAvatar])
	const uri = custom || accountAvatar || library.setting(`profile.bilibiliAvatar.${id}`)
	async function choose() {
		setBusy(true)
		let target: File | null = null
		try {
			const picked = await playlistCoverFiles.pick()
			if (!picked || !alive.current) return
			const directory = new Directory(Paths.document, 'melo-profile-avatars')
			directory.create({ intermediates: true, idempotent: true })
			target = new File(directory, `avatar-${Date.now()}-${Math.random().toString(36).slice(2)}`)
			await new File(picked).copy(target)
			if (!alive.current) { target.delete(); return }
			library.setSetting(key, target.uri)
			setCustom(target.uri)
		} catch {
			try { if (target?.exists) target.delete() } catch { /* Preserve the saved avatar. */ }
			if (alive.current) onNotice('头像保存失败，请重新选择图片')
		} finally { if (alive.current) setBusy(false) }
	}
	return <><View style={{ width: frame ? 88 : 64, height: frame ? 88 : 64, alignItems: 'center', justifyContent: 'center' }}>
		<ControlTarget accessibilityRole='button' accessibilityLabel='修改头像' disabled={busy}
		onPress={() => confirmation.show('头像', '手动设置的头像会保存在本机，重新登录不会覆盖。', [
			{ text: '选择图片', onPress: () => void choose() },
			...(custom ? [{ text: '使用 B 站头像', onPress: () => {
				try { library.setSetting(key, ''); setCustom('') } catch { onNotice('头像设置保存失败') }
			} }] : []),
			{ text: '取消', style: 'cancel' },
		])}
		style={{ width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.tokens.surface.tinted }}>
		{uri ? <Image source={{ uri }} style={{ width: avatarSize, height: avatarSize }} contentFit='cover' /> : <Icon name='user' size={32} color={theme.tokens.action.primary} />}
	</ControlTarget>
	{frame && <View testID='theme-avatar-frame' pointerEvents='none' style={{ position: 'absolute', inset: 0 }}>
		<Image source={frame} style={{ width: 88, height: 88 }} contentFit='contain' transition={0} accessible={false} />
	</View>}</View>{confirmation.dialog}</>
}
