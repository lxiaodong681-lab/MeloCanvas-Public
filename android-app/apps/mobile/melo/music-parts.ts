import type { BilibiliRequest } from './bilibili'
import { BilibiliReadGate, readBilibiliView } from './bilibili-import-network'
import type { VideoCatalog } from './core/video-catalog'
import type { ListeningVideo } from './listening-source'

export interface MusicPartsIdentity {
	bvid: string
	entryId: string
	sourceId: string
}

/** Imported favorites already cache all parts. Ordinary music fetches the original video only on demand. */
export async function readMusicParts(
	catalog: VideoCatalog,
	gate: BilibiliReadGate,
	load: (bvid: string, signal: AbortSignal) => BilibiliRequest<ListeningVideo>,
	bvid: string,
	signal: AbortSignal,
	isCurrent: () => boolean,
): Promise<ListeningVideo | null> {
	if (signal.aborted || !isCurrent()) return null
	const stored = catalog.get(bvid)
	if (stored) return stored
	const video = await readBilibiliView(gate, load, bvid, signal)
	if (signal.aborted || !isCurrent()) return null
	if (video.bvid !== bvid) throw new Error('返回的分 P 不属于当前视频')
	catalog.save(video, Date.now())
	return video
}
