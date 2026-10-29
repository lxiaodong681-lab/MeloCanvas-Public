import type { search, sourceDetails } from './bilibili'
import { BilibiliRequestRestrictedError } from './bilibili-request-error'
import { sampleHeartSeeds, type HeartProfile } from './core/heart-profile'
import type { Source } from './core/model'
import { musicResults } from './search-session'

export interface HeartBatch {
	sources: Source[]
	queries: string[]
	message: string
}
export interface HeartDiscoveryPort {
	discover(signal: AbortSignal): Promise<HeartBatch>
}

/** Three explicit keyword queries, then at most twelve detail reads. Never submits a full library. */
export async function discoverHeart(
	profile: HeartProfile,
	fetchPage: typeof search,
	details: typeof sourceDetails,
	signal: AbortSignal,
	random: () => number = Math.random,
): Promise<HeartBatch> {
	const seeds = sampleHeartSeeds(profile, random)
	if (!seeds.length)
		throw new Error('先导入或收藏一些音乐，心动推荐才能了解你的偏好。')
	const known = new Set(profile.knownBvids),
		sources: Source[] = [],
		queries: string[] = []
	let failed = 0,
		detailReads = 0
	for (const seed of seeds) {
		if (signal.aborted) throw new Error('心动查找已取消')
		queries.push(seed.query)
		try {
			const page = await fetchPage(seed.query, 1, signal, 'relevance')
			for (const item of musicResults(page.items)
				.filter(
					(candidate) => candidate.duration > 0 && candidate.duration <= 900,
				)
				.slice(0, 8)) {
				if (signal.aborted) throw new Error('心动查找已取消')
				if (known.has(item.bvid) || detailReads >= 12) continue
				known.add(item.bvid)
				detailReads++
				try {
					const source = await details(item.bvid, signal)
					if (
						source.bvid !== item.bvid ||
						source.duration <= 0 ||
						source.duration > 900
					)
						continue
					sources.push(source)
				} catch (error) {
					if (error instanceof BilibiliRequestRestrictedError) throw error
					failed++
				}
				// Share the bounded detail budget across the three selected interests.
				if (detailReads >= queries.length * 4) break
			}
		} catch (error) {
			if (signal.aborted) throw new Error('心动查找已取消', { cause: error })
			if (error instanceof BilibiliRequestRestrictedError)
				return {
					sources,
					queries,
					message: 'B 站请求受限，已停止查找。已有候选仍可用，请稍后手动重试。',
				}
			failed++
		}
	}
	if (signal.aborted) throw new Error('心动查找已取消')
	// Fisher–Yates gives each candidate a fair place; preference weights select the interests above.
	for (let i = sources.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1))
		;[sources[i], sources[j]] = [sources[j], sources[i]]
	}
	return {
		sources,
		queries,
		message: failed
			? '部分请求未完成，保留已取得的候选。可稍后重新查找。'
			: sources.length
				? '按歌单关键词找到新候选；版本和曲风仍需你试听判断。'
				: '暂未找到音乐分区的新候选，可以再换一批关键词。',
	}
}
