import { type SavedLyrics, validateSavedLyrics } from './lyrics'
import type { OnlineLyricResult } from './online-lyrics'
import { lyricTitleTags } from './online-lyrics-ranking'

/** Store only lyric metadata/body, never service request headers or account data. */
export function cacheOnlineLyrics(
	result: OnlineLyricResult,
	now = Date.now(),
): SavedLyrics {
	const lines = result.lines.map((line) => ({
		text: line.content,
		atMs: line.startTime,
		endMs: line.endTime,
		...(line.translation ? { translation: line.translation } : {}),
		...(line.romaji ? { romaji: line.romaji } : {}),
	}))
	const body = lines
		.map((line) => {
			const ms = Math.round(line.atMs)
			const min = Math.floor(ms / 60000)
			const sec = Math.floor((ms % 60000) / 1000)
			return `[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}]${line.text.replace(/[\r\n]/g, ' ')}`
		})
		.join('\n')
	const titleTags = lyricTitleTags(result.raw.lrc ?? '')
	const raw = [...titleTags.map((title) => `[ti:${title}]`), body].join('\n')
	return validateSavedLyrics(
		{
			version: 1,
			sourceId: result.sourceId,
			filename: result.candidate.title.slice(0, 512),
			raw,
			importedAt: now,
			offsetMs: 0,
			online: {
				provider: result.candidate.source,
				remoteId: result.candidate.remoteId,
				title: result.candidate.title,
				artist: result.candidate.artist,
				lines,
			},
		},
		result.sourceId,
	)
}
export const lyricProviderLabels = {
	netease: '网易云',
	qqmusic: 'QQ 音乐',
	kugou: '酷狗',
} as const
export function onlineLyricsFailure(error: unknown): string {
	const code =
		error && typeof error === 'object' && 'code' in error ? error.code : ''
	if (code === 'empty') return '暂未找到可显示的歌词，请试试歌名搜索。'
	if (code === 'unmatched') return '暂未确认合适的演唱版本，请用上方歌名搜索选择歌词。'
	if (code === 'timeout') return '歌词服务响应超时，请重试或换个关键词。'
	if (code === 'invalid') return '歌词数据暂不可用，请换一个候选。'
	return '歌词服务暂不可用，可稍后重试；已保存的歌词不会被清除。'
}
