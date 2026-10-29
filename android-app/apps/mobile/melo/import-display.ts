import { externalImportProviders, type ExternalImportProvider } from './core/import-types'
import type {
	ImportMetadata,
	ImportTaskDetail,
	ImportTaskEntry,
} from './core/import-types'

function object(value: unknown): ImportMetadata {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as ImportMetadata)
		: {}
}
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const presentText = (value: unknown) => (text(value).trim() ? text(value) : '')
const count = (value: unknown) =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
		? value
		: null

/** Strict source evidence for batch search; never infer missing performer/version. */
export function importBatchQuery(
	entry: Pick<ImportTaskEntry, 'originalMetadata'>,
	provider: string,
): string {
	if (!externalImportProviders.includes(provider as ExternalImportProvider)) return ''
	const original = entry.originalMetadata
	const track =
		original.track && typeof original.track === 'object'
			? object(original.track)
			: original
	const title = presentText(track.name) || presentText(track.title)
	const artists = track.ar ?? track.singer ?? track.artists
	const names = Array.isArray(artists)
		? artists
				.map((artist) =>
					presentText(
						typeof artist === 'string' ? artist : object(artist).name,
					),
				)
				.filter(Boolean)
		: [presentText(artists)].filter(Boolean)
	return title && names.length ? importOriginalQuery(entry, provider) : ''
}

/** Only parsed source fields, never the display's missing-information labels. */
export function importOriginalQuery(
	entry: Pick<ImportTaskEntry, 'originalMetadata'>,
	provider: string,
): string {
	if (!externalImportProviders.includes(provider as ExternalImportProvider)) return ''
	const original = entry.originalMetadata
	const track =
		original.track && typeof original.track === 'object'
			? object(original.track)
			: original
	const title = presentText(track.name) || presentText(track.title)
	const artists = track.ar ?? track.singer ?? track.artists
	const names = Array.isArray(artists)
		? artists
				.map((artist) =>
					presentText(
						typeof artist === 'string' ? artist : object(artist).name,
					).trim(),
				)
				.filter(Boolean)
		: [presentText(artists).trim()].filter(Boolean)
	return [title.trim(), ...names].filter(Boolean).join(' ')
}

const validDuration = (value: number | null) =>
	value !== null && Number.isFinite(value) && value > 0 ? value : null

/** Seconds from the original provider and the explicitly selected part only. */
export function importDurationComparison(
	original: number | null,
	selected: number | null,
) {
	const originalSeconds = validDuration(original),
		selectedSeconds = validDuration(selected)
	return {
		originalSeconds,
		selectedSeconds,
		differenceSeconds:
			originalSeconds !== null && selectedSeconds !== null
				? Math.round((selectedSeconds - originalSeconds) * 1000) / 1000
				: null,
	}
}

export function importEntryDescription(
	entry: Pick<ImportTaskEntry, 'originalMetadata' | 'originalEntryId'>,
	provider: string,
) {
	const original = entry.originalMetadata
	if (provider === 'bilibili') {
		const media = object(original.media)
		const uploader = presentText(object(media.upper).name)
		return {
			title:
				(original.detailState === 'not-returned' ? '平台未返回详情（不可播放）' : '') ||
				presentText(media.title) ||
				(entry.originalEntryId
					? `原标题缺失（原条目 ${entry.originalEntryId}）`
					: '原标题缺失'),
			// Legacy display slots: these labels do not classify an UP as an artist or a video as an album.
			artists: uploader ? `UP 主：${uploader}` : 'UP 主信息缺失',
			album: 'B站原目录条目',
			duration:
				typeof media.duration === 'number' &&
				Number.isFinite(media.duration) &&
				media.duration >= 0
					? media.duration
					: null,
		}
	}
	const track =
		original.track && typeof original.track === 'object'
			? object(original.track)
			: original
	const artists = track.ar ?? track.singer ?? track.artists
	const names = Array.isArray(artists)
		? artists
				.map((artist) =>
					typeof artist === 'string' ? artist : text(object(artist).name),
				)
				.filter(Boolean)
				.join(' / ')
		: text(artists)
	const album = track.al ?? track.album
	const rawDuration = provider === 'netease' ? track.dt : track.interval
	const duration =
		typeof rawDuration === 'number' &&
		Number.isFinite(rawDuration) &&
		rawDuration >= 0
			? rawDuration / (provider === 'netease' ? 1000 : 1)
			: null
	return {
		title:
			text(track.name) ||
			text(track.title) ||
			(entry.originalEntryId
				? `原平台条目 ${entry.originalEntryId}`
				: '原条目信息待读取'),
		artists: names || '表演者信息待读取',
		album: text(object(album).name) || text(album) || '专辑信息待读取',
		duration,
	}
}
export function importTaskDescription(task: ImportTaskDetail) {
	if (task.provider === 'bilibili') {
		const original = task.originalMetadata
		const page = Array.isArray(original.pages)
			? original.pages.find((value) => object(value).page === 1)
			: null
		const info = object(object(page).info)
		const folderId =
			typeof info.id === 'number' && Number.isSafeInteger(info.id)
				? String(info.id)
				: info.id
		const name =
			folderId === task.originalPlaylistId ? presentText(info.title) : ''
		const expected = count(original.reportedTotal),
			read = count(original.observedCount)
		return {
			name: name || `B站收藏夹 ${task.originalPlaylistId}（名称缺失）`,
			expected,
			read,
			incomplete:
				original.completeness !== 'complete' ||
				expected === null ||
				read === null ||
				expected !== read ||
				read !== task.entryCount,
		}
	}
	const playlist = object(task.originalMetadata.playlist)
	const directory = object(task.originalMetadata.directory)
	return {
		name:
			text(playlist.name) ||
			text(playlist.dissname) ||
			text(task.originalMetadata.name) ||
			`歌单 ${task.originalPlaylistId}`,
		expected:
			typeof directory.expectedCount === 'number'
				? directory.expectedCount
				: task.entryCount,
		read:
			typeof directory.readMetadataCount === 'number'
				? directory.readMetadataCount
				: task.entryCount,
		incomplete: directory.status === 'incomplete',
	}
}
export const importProviderName = (provider: string) =>
	({netease:'网易云歌单',qq:'QQ 歌单',kugou:'酷狗歌单',kuwo:'酷我歌单',qishui:'汽水歌单',bilibili:'B站收藏夹'} as Record<string,string>)[provider] ?? '外部歌单'

export const importReviewLabel = {
	pending: '尚未匹配',
	'needs-review': '候选待确认',
	'not-found': '尚未找到',
	unreadable: '暂时无法读取',
	confirmed: '已人工确认',
} as const

/** View-only review filtering. Preserve occurrence identity and directory order. */
export const importReviewFilters = [
	'all',
	'pending',
	'needs-review',
	'not-found',
	'unreadable',
	'confirmed',
] as const
export type ImportReviewFilter = (typeof importReviewFilters)[number]
export function filterImportEntries(
	entries: ImportTaskEntry[],
	filter: ImportReviewFilter,
) {
	return filter === 'all'
		? entries
		: entries.filter((entry) => entry.review.state === filter)
}
