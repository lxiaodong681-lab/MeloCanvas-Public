import { Orpheus } from '@bbplayer/orpheus'
import * as DocumentPicker from 'expo-document-picker'
import { Directory, File, Paths } from 'expo-file-system'

import { localAudioUuidPattern } from './core/local-audio'
import type { LocalAudioFiles } from './local-audio-import'

export const localAudioFiles: LocalAudioFiles = {
	async pick() {
		const result = await DocumentPicker.getDocumentAsync({
			type: 'audio/*',
			multiple: false,
			copyToCacheDirectory: true,
		})
		if (result.canceled || !result.assets.length) return null
		const asset = result.assets[0]
		// Expo Android creates a unique copy under this exact cache directory.
		// Never delete the user-selected URI outside our own picker cache.
		const cacheDirectory = new Directory(Paths.cache, 'DocumentPicker')
		const selected = new File(asset.uri)
		const owned = selected.parentDirectory.uri === cacheDirectory.uri
		return {
			uri: asset.uri,
			name: asset.name,
			release: () => {
				if (owned && selected.exists) selected.delete()
			},
		}
	},
	async prepare(picked) {
		const uuid = Orpheus.newLocalAudioUuid()
		if (!localAudioUuidPattern.test(uuid))
			throw new Error('无法创建本地音频身份，请重试')
		const directory = new Directory(Paths.document, 'melo-local-audio')
		directory.create({ intermediates: true, idempotent: true })
		const target = new File(directory, uuid)
		if (target.exists) throw new Error('文件身份冲突，请重试')
		const discard = () => {
			if (target.exists) target.delete()
		}
		try {
			const original = new File(picked.uri)
			if (original.size > Paths.availableDiskSpace)
				throw new Error('存储空间不足，请释放空间后重试')
			await original.copy(target)
			const metadata = await Orpheus.probeLocalAudio(uuid)
			const originalName = picked.name.trim() || '本地音频'
			return {
				audio: {
					id: `local:${uuid}`,
					originalName,
					title: metadata.title?.trim() || originalName,
					artist: metadata.artist?.trim() || '',
					durationSeconds: metadata.durationSeconds,
					bytes: metadata.bytes,
					importedAt: Date.now(),
				},
				discard,
			}
		} catch (error) {
			try {
				discard()
			} catch {
				/* Preserve original error. */
			}
			if (error instanceof Error && /LocalAudio/.test(error.message))
				throw new Error(
					'无法读取音频信息或格式不受支持，请选择完整的音频文件。',
					{ cause: error },
				)
			throw error
		}
	},
}
