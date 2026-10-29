import { parseAndMergeLyrics, type LyricLine } from '@bbplayer/splash'

import {
	automaticLyricCandidates,
	loadedLyricVersionText,
	lyricVersionConflict,
	lyricSearchTitle,
	type LyricMatchTrack,
} from './online-lyrics-ranking'

export type OnlineLyricSource = 'netease' | 'qqmusic' | 'kugou'
export interface OnlineLyricCandidate {
	source: OnlineLyricSource
	title: string
	artist: string
	duration: number
	remoteId: number | string
}
export interface OnlineLyricRaw {
	lrc?: string
	tlyric?: string
	romalrc?: string
}
export interface OnlineLyricProvider {
	source: OnlineLyricSource
	search(
		keyword: string,
		limit: number,
		signal: AbortSignal,
	): Promise<OnlineLyricCandidate[]>
	load(
		candidate: OnlineLyricCandidate,
		signal: AbortSignal,
	): Promise<OnlineLyricRaw>
}
export interface OnlineLyricResult {
	sourceId: string
	candidate: OnlineLyricCandidate
	raw: OnlineLyricRaw
	lines: LyricLine[]
}
export type OnlineLyricFailure =
	| 'cancelled'
	| 'timeout'
	| 'unavailable'
	| 'empty'
	| 'invalid'
	| 'unmatched'
export class OnlineLyricError extends Error {
	constructor(readonly code: OnlineLyricFailure) {
		super(code)
		this.name = 'OnlineLyricError'
	}
}
export interface OnlineLyricOptions {
	signal?: AbortSignal
	timeoutMs?: number
}

const MAX_TEXT = 1024 * 1024
function candidateValid(
	candidate: OnlineLyricCandidate,
	source: OnlineLyricSource,
): boolean {
	return (
		candidate.source === source &&
		typeof candidate.title === 'string' &&
		!!candidate.title.trim() &&
		typeof candidate.artist === 'string' &&
		Number.isFinite(candidate.duration) &&
		candidate.duration >= 0 &&
		(source === 'netease'
			? Number.isSafeInteger(candidate.remoteId) &&
				Number(candidate.remoteId) > 0
			: typeof candidate.remoteId === 'string' &&
				/^[a-zA-Z0-9_-]{1,128}$/.test(candidate.remoteId))
	)
}
function parse(raw: OnlineLyricRaw): LyricLine[] {
	for (const text of [raw.lrc, raw.tlyric, raw.romalrc]) {
		if (
			text !== undefined &&
			(typeof text !== 'string' || text.length > MAX_TEXT)
		)
			throw new OnlineLyricError('invalid')
	}
	if (!raw.lrc?.trim()) throw new OnlineLyricError('empty')
	let lines: LyricLine[]
	try {
		lines = parseAndMergeLyrics({
			lrc: raw.lrc,
			tlyric: raw.tlyric,
			romalrc: raw.romalrc,
		})
	} catch {
		throw new OnlineLyricError('invalid')
	}
	if (!lines.some((line) => line.content.trim()))
		throw new OnlineLyricError('empty')
	if (
		lines.length > 20000 ||
		lines.some(
			(line) =>
				!Number.isFinite(line.startTime) ||
				line.startTime < 0 ||
				!Number.isFinite(line.endTime) ||
				line.endTime < line.startTime,
		)
	)
		throw new OnlineLyricError('invalid')
	return lines
}
function keywordValid(keyword: string): string {
	const value = keyword.trim()
	if (!value || value.length > 200) throw new OnlineLyricError('invalid')
	return value
}
async function bounded<T>(
	work: (signal: AbortSignal) => Promise<T>,
	options: OnlineLyricOptions,
): Promise<T> {
	const controller = new AbortController()
	const duration = options.timeoutMs ?? 15000
	if (!Number.isFinite(duration) || duration <= 0 || duration > 60000)
		throw new OnlineLyricError('invalid')
	let timer: ReturnType<typeof setTimeout> | undefined
	let rejectAbort: ((error: OnlineLyricError) => void) | undefined
	const abort = (code: 'cancelled' | 'timeout') => {
		controller.abort()
		rejectAbort?.(new OnlineLyricError(code))
	}
	const onAbort = () => abort('cancelled')
	const cancelled = new Promise<never>((_, reject) => {
		rejectAbort = reject
	})
	options.signal?.addEventListener('abort', onAbort, { once: true })
	try {
		if (options.signal?.aborted) throw new OnlineLyricError('cancelled')
		timer = setTimeout(() => abort('timeout'), duration)
		return await Promise.race([
			Promise.resolve().then(() => work(controller.signal)),
			cancelled,
		])
	} catch (error) {
		throw error instanceof OnlineLyricError
			? error
			: new OnlineLyricError('unavailable')
	} finally {
		if (timer !== undefined) clearTimeout(timer)
		options.signal?.removeEventListener('abort', onAbort)
		controller.abort()
	}
}

/** No account/session argument: these providers must never receive Bilibili credentials.
 * Consumers retain sourceId and discard results after navigation or account changes.
 * This layer does not write a cache or claim that an automatic match is exact.
 */
export function createOnlineLyricsService(
	providers: readonly OnlineLyricProvider[],
) {
	const bySource = new Map(
		providers.map((provider) => [provider.source, provider]),
	)
	if (bySource.size !== providers.length) throw new OnlineLyricError('invalid')
	const loadFrom = async (
		sourceId: string,
		candidate: OnlineLyricCandidate,
		signal: AbortSignal,
	): Promise<OnlineLyricResult> => {
		const provider = bySource.get(candidate.source)
		if (
			!sourceId.trim() ||
			!provider ||
			!candidateValid(candidate, provider.source)
		)
			throw new OnlineLyricError('invalid')
		const raw = await provider.load(candidate, signal)
		if (signal.aborted) throw new OnlineLyricError('cancelled')
		return { sourceId, candidate: { ...candidate }, raw, lines: parse(raw) }
	}
	return {
		async search(keyword: string, options: OnlineLyricOptions = {}) {
			const query = keywordValid(keyword)
			if (options.signal?.aborted) throw new OnlineLyricError('cancelled')
			const results = await Promise.all(
				providers.map(async (provider) => {
					try {
						const candidates = await bounded(
							async (signal) =>
								(await provider.search(query, 20, signal))
									.filter((candidate) =>
										candidateValid(candidate, provider.source),
									)
									.slice(0, 20),
							options,
						)
						return { source: provider.source, candidates, available: true }
					} catch (error) {
						if (
							error instanceof OnlineLyricError &&
							(error.code === 'cancelled' || error.code === 'invalid')
						)
							throw error
						return { source: provider.source, candidates: [], available: false }
					}
				}),
			)
			if (options.signal?.aborted) throw new OnlineLyricError('cancelled')
			return {
				candidates: results.flatMap((result) => result.candidates),
				unavailable: results
					.filter((result) => !result.available)
					.map((result) => result.source),
			}
		},
		load(
			sourceId: string,
			candidate: OnlineLyricCandidate,
			options: OnlineLyricOptions = {},
		) {
			return bounded((signal) => loadFrom(sourceId, candidate, signal), options)
		},
		match(
			track: LyricMatchTrack,
			options: OnlineLyricOptions = {},
		) {
			const deadline = Date.now() + (options.timeoutMs ?? 15000)
			return bounded(async (signal) => {
				if (!track.sourceId.trim()) throw new OnlineLyricError('invalid')
				const query = keywordValid(lyricSearchTitle(track.title))
				// A bounded search window lets metadata, rather than network speed,
				// decide the result. A stalled provider cannot block the others.
				const results = await Promise.all(providers.map(async (provider) => {
					try {
						return await bounded(async (searchSignal) =>
							(await provider.search(query, 10, searchSignal))
								.filter((candidate) => candidateValid(candidate, provider.source)).slice(0, 10),
						{ signal, timeoutMs: Math.min(options.timeoutMs ?? 15000, 3000) })
					} catch {
						return []
					}
				}))
				if (signal.aborted) throw new OnlineLyricError('cancelled')
				const ranked = automaticLyricCandidates(results.flat(), track)
				if (!ranked.length) throw new OnlineLyricError('unmatched')
				const attempts = ranked.slice(0, 3)
				let loadedVersionConflict = false
				for (const [index, { candidate }] of attempts.entries()) {
					if (signal.aborted) throw new OnlineLyricError('cancelled')
					const remainingMs = deadline - Date.now()
					if (remainingMs <= 0) throw new OnlineLyricError('timeout')
					try {
						// Keep ranking priority, but reserve time for the remaining
						// candidates and delivery even if this provider ignores abort.
						const result = await bounded(
							(loadSignal) => loadFrom(track.sourceId, candidate, loadSignal),
							{
								signal,
								timeoutMs: Math.min(3000, remainingMs / (attempts.length - index + 1)),
							},
						)
						const loadedTitle = loadedLyricVersionText(
							candidate.title,
							result.raw.lrc ?? '',
							result.lines.slice(0, 3).map((line) => line.content),
						)
						if (lyricVersionConflict(track.title, loadedTitle)) {
							loadedVersionConflict = true
							continue
						}
						return result
					} catch {
						if (signal.aborted) throw new OnlineLyricError('cancelled')
					}
				}
				throw new OnlineLyricError(
					loadedVersionConflict ? 'unmatched' : 'unavailable',
				)
			}, options)
		},
	}
}
