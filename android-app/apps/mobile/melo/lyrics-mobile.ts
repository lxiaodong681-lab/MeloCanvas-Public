import * as DocumentPicker from 'expo-document-picker'
import { Directory, File, Paths } from 'expo-file-system'

import { maxLyricsBytes, parseLyrics } from './lyrics'

export async function pickLyrics(): Promise<{
	filename: string
	raw: string
} | null> {
	const result = await DocumentPicker.getDocumentAsync({
		type: '*/*',
		multiple: false,
		copyToCacheDirectory: true,
	})
	if (result.canceled || !result.assets.length) return null
	const asset = result.assets[0]
	const file = new File(asset.uri)
	const owned =
		file.parentDirectory.uri ===
		new Directory(Paths.cache, 'DocumentPicker').uri
	try {
		if (!/\.(lrc|txt)$/i.test(asset.name))
			throw new Error('请选择 .lrc 或 .txt 歌词文件')
		if (file.size > maxLyricsBytes) throw new Error('歌词文件不能超过 256 KiB')
		const raw = await file.text()
		if (raw.includes('\uFFFD'))
			throw new Error('无法识别文件编码，请先另存为 UTF-8')
		parseLyrics(raw)
		return { filename: asset.name, raw }
	} finally {
		// Only remove the owned temporary copy, never the user's source file.
		if (owned && file.exists) file.delete()
	}
}
