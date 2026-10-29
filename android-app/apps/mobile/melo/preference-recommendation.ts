import type { SearchItem } from './core/model'

export interface PreferenceResultBatch {
	items: SearchItem[]
	retrievedAt: number
}

export interface PreferenceCandidate {
	item: SearchItem
	/** First query that supplied this candidate's original metadata. */
	seed: string
	retrievedAt: number
	/** Query evidence only, never verified artist or genre identity. */
	hits: { seed: string; retrievedAt: number }[]
}

/** In-memory projection only: one turn per query, one candidate per BV. */
export function preferenceCandidates(
	seeds: readonly string[],
	results: ReadonlyMap<string, PreferenceResultBatch>,
): PreferenceCandidate[] {
	const candidates = new Map<string, PreferenceCandidate>()
	for (const seed of seeds) {
		const batch = results.get(seed)
		if (!batch) continue
		for (const item of batch.items) {
			const existing = candidates.get(item.bvid)
			if (existing) {
				if (!existing.hits.some((hit) => hit.seed === seed))
					existing.hits.push({ seed, retrievedAt: batch.retrievedAt })
			} else {
				candidates.set(item.bvid, {
					item,
					seed,
					retrievedAt: batch.retrievedAt,
					hits: [{ seed, retrievedAt: batch.retrievedAt }],
				})
			}
		}
	}
	const queues = seeds.map((seed) => results.get(seed)?.items ?? [])
	const cursors = queues.map(() => 0)
	const seen = new Set<string>()
	const ordered: PreferenceCandidate[] = []
	let added: boolean
	do {
		added = false
		for (let i = 0; i < queues.length; i++) {
			const queue = queues[i]
			while (cursors[i] < queue.length && seen.has(queue[cursors[i]].bvid))
				cursors[i]++
			if (cursors[i] >= queue.length) continue
			const item = queue[cursors[i]++]
			seen.add(item.bvid)
			ordered.push(candidates.get(item.bvid)!)
			added = true
		}
	} while (added)
	return ordered
}
