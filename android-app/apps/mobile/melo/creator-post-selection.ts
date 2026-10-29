import { sourceId } from './core/model'
import type { CreatorPostCandidate } from './creator-api'
import { creatorMid, creatorSpaceUrl } from './creator-selection'
import { listeningSourceDetails, type ListeningVideo } from './listening-source'

/** Query context is never ownership. Only strict view data may become a Source. */
export function verifyCreatorPost(
	candidate: CreatorPostCandidate,
	video: ListeningVideo,
): void {
	if (video.bvid !== candidate.bvid || !video.parts.length)
		throw new Error('返回的视频身份不匹配，请刷新投稿后重试')
	const owner = creatorMid(video.parts[0].source.uploaderId)
	for (const { source } of video.parts) {
		if (
			source.bvid !== candidate.bvid ||
			!Number.isSafeInteger(source.cid) ||
			source.cid <= 0 ||
			source.id !== sourceId(candidate.bvid, source.cid) ||
			creatorMid(source.uploaderId) !== owner
		)
			throw new Error('原视频的上传者或分 P 信息不完整，请刷新投稿后重试')
	}
	if (candidate.ownerMid !== undefined) {
		creatorSpaceUrl(candidate.ownerMid)
		if (candidate.ownerMid !== owner)
			throw new Error('投稿的上传者资料已变化，请刷新投稿后重试')
	}
}

export async function resolveCreatorPost(
	candidate: CreatorPostCandidate,
	signal: AbortSignal,
	load = listeningSourceDetails,
) {
	const video = await load(candidate.bvid, signal)
	if (signal.aborted) throw new Error('已取消读取原视频')
	verifyCreatorPost(candidate, video)
	return video.parts[0].source
}
