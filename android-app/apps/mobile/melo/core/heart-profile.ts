import type { RecentMusicHistoryEntry } from '@bbplayer/orpheus'

import type { Database } from './database'
import type { Source } from './model'
import { playlistItemFromRow, type PlaylistItemRow } from './playlist-import'

export interface HeartSeed {
	query: string
	weight: number
	origin: 'playlist' | 'liked' | 'history'
}
export interface HeartProfile {
	seeds: HeartSeed[]
	knownBvids: string[]
	playlistCount: number
}
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {}
const query = (value: string) =>
	value
		.replace(/<[^>]*>/g, '')
		.replace(/[\r\n\t]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 60)

/** Local metadata only. An uploader is never treated as a performer; no playlist names leave the device. */
export function readHeartProfile(
	db: Database,
	history: readonly RecentMusicHistoryEntry[],
): HeartProfile {
	const sources = db.getAllSync<Source>('SELECT * FROM sources', [])
	const byId = new Map(sources.map((source) => [source.id, source]))
	const rejected = new Set(
		db
			.getAllSync<{ taskId: string; entryId: string }>(
				"SELECT taskId,entryId FROM import_content_reviews WHERE kind!='song'",
				[],
			)
			.map((row) => JSON.stringify([row.taskId, row.entryId])),
	)
	const groups = new Map<string, Map<string, string[]>>()
	for (const row of db.getAllSync<PlaylistItemRow>(
		'SELECT * FROM playlist_items ORDER BY playlistId,position',
		[],
	)) {
		const item = playlistItemFromRow(row),
			origin = item.importOrigin
		if (origin && rejected.has(JSON.stringify([origin.taskId, origin.entryId])))
			continue
		const source = item.sourceId ? byId.get(item.sourceId) : undefined
		const metadata = object(origin?.originalMetadata),
			track = object(metadata.track ?? metadata)
		const artists = track.ar ?? track.singer ?? track.artists
		const names = Array.isArray(artists)
			? artists
					.map((artist) => text(object(artist).name) || text(artist))
					.filter(Boolean)
			: []
		const title =
			text(track.name) ||
			text(track.title) ||
			text(object(metadata.media).title) ||
			source?.originalTitle ||
			''
		const terms = (
			names.length ? names : source?.performer ? [source.performer] : [title]
		)
			.map(query)
			.filter(Boolean)
		if (!terms.length) continue
		let group = groups.get(item.playlistId)
		if (!group) groups.set(item.playlistId, (group = new Map()))
		// Copies and repeated occurrences do not multiply one song's influence within a list.
		const identity =
			item.sourceId ??
			JSON.stringify([origin?.provider, origin?.originalEntryId, terms])
		group.set(identity, [...new Set(terms)])
	}
	const seeds = new Map<string, HeartSeed>()
	const add = (term: string, weight: number, origin: HeartSeed['origin']) => {
		const value = query(term)
		if (!value) return
		const key = value.toLocaleLowerCase(),
			previous = seeds.get(key)
		if (previous) previous.weight += weight
		else seeds.set(key, { query: value, weight, origin })
	}
	// Equal total weight per list: a huge imported list cannot drown out smaller favourites.
	for (const group of groups.values())
		for (const terms of group.values())
			for (const term of terms)
				add(term, 10 / groups.size / group.size / terms.length, 'playlist')
	const liked = db.getAllSync<{ sourceId: string }>(
		'SELECT sourceId FROM likes',
		[],
	)
	for (const row of liked) {
		const source = byId.get(row.sourceId)
		if (source?.domain === 'music')
			add(source.performer || source.originalTitle, 3 / liked.length, 'liked')
	}
	const recent = [
		...new Map(
			history.slice(0, 100).map((item) => [item.sourceId, item]),
		).values(),
	]
	for (const item of recent) {
		const source = byId.get(item.sourceId)
		// Only actual native music events, with a known music Source. Never search history or an UP name.
		if (source?.domain === 'music')
			add(
				source.performer || source.originalTitle,
				0.5 / recent.length,
				'history',
			)
	}
	return {
		seeds: [...seeds.values()],
		knownBvids: [...new Set(sources.map((source) => source.bvid))],
		playlistCount: groups.size,
	}
}

/** Three weighted draws, deduplicated. Keeping weights between draws prevents a tiny
 * history-only tail from becoming a mandatory query when a list has few artists. */
export function sampleHeartSeeds(
	profile: HeartProfile,
	random: () => number = Math.random,
): HeartSeed[] {
	const pool = profile.seeds,
		selected = new Map<string, HeartSeed>()
	const total = pool.reduce((sum, seed) => sum + seed.weight, 0)
	for (let draw = 0; pool.length && draw < 3; draw++) {
		let remaining = random() * total
		let index = 0
		for (; index < pool.length - 1; index++) {
			remaining -= pool[index].weight
			if (remaining < 0) break
		}
		selected.set(pool[index].query, pool[index])
	}
	return [...selected.values()]
}
