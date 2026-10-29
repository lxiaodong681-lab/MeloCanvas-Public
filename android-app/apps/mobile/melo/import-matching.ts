import type { ImportTaskEntry } from './core/import-types'
import type { SearchItem } from './core/model'
import { importEntryDescription } from './import-display'
import type { ListeningVideo } from './listening-source'

const normalized = (value: string) =>
	value
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, '')
const editions = [
	/\blive\b|现场|演唱会/i,
	/cover|翻唱/i,
	/伴奏|instrumental|off vocal/i,
	/remix|混音|加速|慢速/i,
]

export function importMatchScore(
	entry: ImportTaskEntry,
	provider: string,
	title: string,
	duration: number,
	uploader = '',
) {
	const original = importEntryDescription(entry, provider)
	const wanted = normalized(original.title),
		actual = normalized(title)
	if (!wanted || !actual.includes(wanted)) return -1
	if (
		editions.some(
			(pattern) => pattern.test(original.title) !== pattern.test(title),
		)
	)
		return -1
	const difference =
		original.duration === null ? 0 : Math.abs(original.duration - duration)
	if (original.duration && difference > Math.max(30, original.duration * 0.15))
		return -1
	const artist = original.artists
		.split(' / ')
		.some((name) =>
			normalized(`${title} ${uploader}`).includes(normalized(name)),
		)
	return 100 + (actual === wanted ? 15 : 0) + (artist ? 20 : 0) - difference
}

export function rankImportCandidates(
	entry: ImportTaskEntry,
	provider: string,
	items: SearchItem[],
) {
	return items
		.map((item) => ({
			item,
			score: importMatchScore(
				entry,
				provider,
				item.originalTitle,
				item.duration,
				item.uploader,
			),
		}))
		.filter((value) => value.score >= 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 3)
		.map((value) => value.item)
}

export function matchImportPart(
	entry: ImportTaskEntry,
	provider: string,
	video: ListeningVideo,
) {
	return (
		video.parts
			.map((part) => ({
				part,
				score: importMatchScore(
					entry,
					provider,
					video.parts.length === 1 ? video.title : part.title,
					part.source.duration,
					video.uploader,
				),
			}))
			.filter((value) => value.score >= 0)
			.sort((a, b) => b.score - a.score)[0]?.part.source ?? null
	)
}
