import type { PlaybackMode } from './core/listening'
import { sourceId, type SearchItem, type Source } from './core/model'
import type { ListeningVideo } from './listening-source'

interface ListeningSelectionActions {
	load: (bvid: string, signal: AbortSignal) => Promise<ListeningVideo>
	current: () => { mode: PlaybackMode; playing: boolean }
	confirm: () => Promise<boolean>
	play: (source: Source, relatedSources: Source[]) => Promise<boolean>
}

/** Only callers with a previously verified complete view/catalog may supply a snapshot. */
export function validateSuppliedListeningVideo(
	video: ListeningVideo,
	expectedBvid: string,
): void {
	if (
		!/^BV[A-Za-z0-9]{10}$/.test(expectedBvid) ||
		video.bvid !== expectedBvid ||
		typeof video.title !== 'string' ||
		!video.title.trim() ||
		typeof video.uploader !== 'string' ||
		!video.uploader.trim() ||
		!Array.isArray(video.parts) ||
		video.parts.length === 0 ||
		video.parts.length > 1000
	)
		throw new Error('已核验视频目录的身份或完整性无效，请重新读取')
	const cids = new Set<number>()
	for (const [index, part] of video.parts.entries()) {
		const source = part.source
		if (
			part.page !== index + 1 ||
			typeof part.title !== 'string' ||
			!part.title.trim() ||
			!source ||
			source.bvid !== expectedBvid ||
			!Number.isSafeInteger(source.cid) ||
			source.cid <= 0 ||
			source.id !== sourceId(expectedBvid, source.cid) ||
			cids.has(source.cid) ||
			!Number.isFinite(source.duration) ||
			source.duration < 0
		)
			throw new Error('已核验分 P 身份、顺序或时长无效，请重新读取')
		cids.add(source.cid)
	}
}

export async function loadListeningSelectionVideo(
	bvid: string,
	signal: AbortSignal,
	load: (bvid: string, signal: AbortSignal) => Promise<ListeningVideo>,
	supplied?: ListeningVideo,
): Promise<ListeningVideo> {
	if (supplied) validateSuppliedListeningVideo(supplied, bvid)
	return supplied ?? load(bvid, signal)
}

/** Resolve a complete, explicit same-BV queue before touching the live player. */
export async function selectListening(
	item: Pick<SearchItem, 'bvid'> | Source,
	signal: AbortSignal,
	actions: ListeningSelectionActions,
): Promise<ListeningVideo | null> {
	if (signal.aborted) return null
	const video = await actions.load(item.bvid, signal)
	if (signal.aborted) return null
	const part =
		'cid' in item
			? video.parts.find((candidate) => candidate.source.cid === item.cid)
			: video.parts[0]
	if (!part)
		throw new Error('该分 P 已变更或不可用，原进度已保留，请重新选择分 P')
	const current = actions.current()
	if (current.mode === 'music' && current.playing) {
		const confirmed = await actions.confirm()
		if (!confirmed || signal.aborted) return null
	}
	const success = await actions.play(
		part.source,
		video.parts.map((entry) => entry.source),
	)
	return success && !signal.aborted ? video : null
}
