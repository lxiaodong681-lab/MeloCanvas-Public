import * as DocumentPicker from 'expo-document-picker'
import { Directory, File, Paths } from 'expo-file-system'
import { Image } from 'react-native'

import type { PlaylistCoverFiles } from './playlist-cover-files'

export const playlistCoverFiles: PlaylistCoverFiles = {
	async pick() {
		const result = await DocumentPicker.getDocumentAsync({
			type: 'image/*',
			copyToCacheDirectory: true,
			multiple: false,
		})
		if (result.canceled || !result.assets.length) return null
		const uri = result.assets[0].uri
		await Image.getSize(uri)
		return uri
	},
	async persist(uri) {
		const directory = new Directory(Paths.document, 'melo-playlist-covers')
		directory.create({ intermediates: true, idempotent: true })
		const target = new File(
			directory,
			`cover-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
		)
		if (target.exists) throw new Error('封面文件冲突，请重新保存')
		const discard = () => {
			if (target.exists) target.delete()
		}
		try {
			await new File(uri).copy(target)
		} catch (error) {
			try {
				discard()
			} catch {
				/* Keep original copy failure. */
			}
			throw error
		}
		return { uri: target.uri, discard }
	},
}
