import type { Library } from './core/database'
import type { ListeningLibrary, ResumePoint } from './core/listening'
import type { Source } from './core/model'
import type { ListeningResume } from './listening-ui'

export function readPlaybackMetadata(
	library: Pick<Library, 'get'>,
	listening: Pick<ListeningLibrary, 'listResumePoints'> &
		Partial<
			Pick<ListeningLibrary, 'canProjectResume' | 'projectionGeneration'>
		>,
	currentSourceId: string | undefined,
	nativePoints: ResumePoint[],
): { current: Source | null; items: ListeningResume[]; error: string } {
	let error = ''
	const source = (id: string) => {
		try {
			return library.get(id)
		} catch {
			error = '本地音源信息暂时无法读取，当前音频仍保留，请稍后重试。'
			return null
		}
	}
	const current = currentSourceId ? source(currentSourceId) : null
	const points = new Map<string, ResumePoint>()
	try {
		for (const point of listening.listResumePoints())
			points.set(point.sourceId, point)
	} catch {
		error = '本地续听记录暂时无法读取，当前音频仍保留，请稍后重试。'
	}
	try {
		for (const point of nativePoints) {
			if (listening.canProjectResume?.(point.sourceId) === false) continue
			const saved = points.get(point.sourceId)
			if (
				!saved ||
				saved.updatedAt <= point.updatedAt ||
				(listening.projectionGeneration?.() ?? 0) > 0
			)
				points.set(point.sourceId, point)
		}
	} catch {
		error = '本地续听记录暂时无法读取，当前音频仍保留，请稍后重试。'
	}

	const items = [...points.values()]
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.flatMap((point) => {
			const item = source(point.sourceId)
			return item ? [{ source: item, point }] : []
		})
	return { current, items, error }
}
