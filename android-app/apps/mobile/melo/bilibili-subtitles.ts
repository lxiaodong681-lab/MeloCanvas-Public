/** Bilibili subtitle adapter. Account transport owns credentials and WBI signing.
 * No response text, signed CDN URLs or account material is logged/persisted here.
 */
export type SubtitleFailure =
	| 'login-required'
	| 'restricted'
	| 'unavailable'
	| 'invalid-response'
	| 'identity-mismatch'
	| 'cancelled'
	| 'stale'

export class BilibiliSubtitleError extends Error {
	constructor(readonly reason: SubtitleFailure) {
		super(`Bilibili subtitle: ${reason}`)
		this.name = 'BilibiliSubtitleError'
	}
}
export interface SubtitleTarget {
	bvid: string
	cid: number
	page: number
}
export interface SubtitleTrack {
	id: string
	language: string
	label: string
	/** Raw platform flags, not a claim that a language label proves provenance. */
	platformAiType: number | null
	platformAiStatus: number | null
}
export interface SubtitleLine {
	startMs: number
	endMs: number
	text: string
}
export interface SubtitleDocument {
	target: SubtitleTarget
	track: SubtitleTrack
	generation: number
	lines: SubtitleLine[]
}
export interface SubtitleDependencies {
	getSessionGeneration(): number
	/** Read the actual currently selected P, including while an old request runs. */
	getCurrentTarget(): SubtitleTarget | null
	/** Returns unwrapped data; /x/player/wbi/v2 must use existing WBI signing. */
	requestAuthenticatedJson(
		path: string,
		params: Record<string, string>,
		signal?: AbortSignal,
	): Promise<unknown>
	/** Translate transport failures without retaining server messages or causes. */
	classifyFailure(
		error: unknown,
	): 'login-required' | 'restricted' | 'unavailable'
	/** Required native transport: fixed CDN allowlist, NO_COOKIES, no redirects,
	 * 2 MiB bounded read and 15s timeout. No ambient fetch fallback. */
	requestSubtitleBody(
		url: string,
		signal?: AbortSignal,
	): Promise<{
		status: number
		body: string
		url: string
	}>
}
const record = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
const positiveInteger = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const fail = (reason: SubtitleFailure): never => {
	throw new BilibiliSubtitleError(reason)
}
const sameTarget = (a: SubtitleTarget | null, b: SubtitleTarget) =>
	a?.bvid === b.bvid && a.cid === b.cid && a.page === b.page
const validTarget = (target: SubtitleTarget) =>
	/^BV[0-9A-Za-z]{10}$/.test(target.bvid) &&
	positiveInteger(target.cid) &&
	positiveInteger(target.page)
const label = (value: unknown, limit: number): string => {
	if (
		typeof value !== 'string' ||
		!value ||
		value.length > limit ||
		Array.from(value).some((character) => {
			const code = character.charCodeAt(0)
			return code < 32 && ![9, 10, 13].includes(code)
		})
	)
		return fail('invalid-response')
	return value
}
const platformFlag = (value: unknown): number | null =>
	typeof value === 'number' && Number.isSafeInteger(value) ? value : null
function subtitleUrl(value: unknown): string {
	if (typeof value !== 'string') return fail('invalid-response')
	let url: URL
	try {
		url = new URL(value.startsWith('//') ? `https:${value}` : value)
	} catch {
		return fail('invalid-response')
	}
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.port ||
		url.hash ||
		!['aisubtitle.hdslb.com', 'i0.hdslb.com'].includes(url.hostname) ||
		!url.pathname.startsWith('/bfs/subtitle/')
	)
		return fail('restricted')
	return url.href
}
/** Keeps line ends, repetitions, simultaneous lines and gaps. Never creates word timing. */
export function parseSubtitleLines(
	payload: unknown,
	durationMs: number,
): SubtitleLine[] {
	const body = record(payload)?.body
	if (
		!Number.isFinite(durationMs) ||
		durationMs <= 0 ||
		!Array.isArray(body) ||
		body.length > 20000
	)
		return fail('invalid-response')
	return body
		.map((raw): SubtitleLine => {
			const row = record(raw)
			if (
				!row ||
				typeof row.from !== 'number' ||
				typeof row.to !== 'number' ||
				!Number.isFinite(row.from) ||
				!Number.isFinite(row.to) ||
				row.from < 0 ||
				row.to <= row.from ||
				row.to * 1000 > durationMs + 1000
			)
				return fail('invalid-response')
			const startMs = Math.round(row.from * 1000),
				endMs = Math.round(row.to * 1000)
			if (
				!Number.isSafeInteger(startMs) ||
				!Number.isSafeInteger(endMs) ||
				endMs <= startMs
			)
				return fail('invalid-response')
			return { startMs, endMs, text: label(row.content, 10000) }
		})
		.sort((a, b) => a.startMs - b.startMs)
}
export function activeSubtitleLines(
	lines: readonly SubtitleLine[],
	positionMs: number,
): SubtitleLine[] {
	if (!Number.isFinite(positionMs) || positionMs < 0) return []
	return lines.filter(
		(line) => line.startMs <= positionMs && positionMs < line.endMs,
	)
}
interface Discovery {
	target: SubtitleTarget
	generation: number
	intent: number
	durationMs: number
	tracks: Map<string, { track: SubtitleTrack; url: string }>
}
export class BilibiliSubtitleProvider {
	private intent = 0
	private loadIntent = 0
	private discovery: Discovery | null = null
	constructor(private readonly dependencies: SubtitleDependencies) {}
	/** Call on logout, P change or provider unmount; also guarded by target/generation reads. */
	invalidate(): void {
		this.intent++
		this.loadIntent++
		this.discovery = null
	}
	private check(
		state: Pick<Discovery, 'target' | 'generation' | 'intent'>,
		signal?: AbortSignal,
	): void {
		if (signal?.aborted) fail('cancelled')
		if (
			state.intent !== this.intent ||
			state.generation !== this.dependencies.getSessionGeneration() ||
			!sameTarget(this.dependencies.getCurrentTarget(), state.target)
		)
			fail('stale')
	}
	private async guarded<T>(
		state: Discovery,
		action: () => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		this.check(state, signal)
		try {
			const value = await action()
			this.check(state, signal)
			return value
		} catch (error) {
			this.check(state, signal)
			if (error instanceof BilibiliSubtitleError) throw error
			throw new BilibiliSubtitleError(this.dependencies.classifyFailure(error))
		}
	}
	async discover(
		target: SubtitleTarget,
		signal?: AbortSignal,
	): Promise<{
		status: 'tracks' | 'no-tracks'
		target: SubtitleTarget
		generation: number
		tracks: SubtitleTrack[]
	}> {
		target = { ...target }
		this.invalidate()
		if (!validTarget(target)) return fail('identity-mismatch')
		const state: Discovery = {
			target: { ...target },
			generation: this.dependencies.getSessionGeneration(),
			intent: this.intent,
			durationMs: 0,
			tracks: new Map(),
		}
		const view = record(
			await this.guarded(
				state,
				() =>
					this.dependencies.requestAuthenticatedJson(
						'/x/web-interface/view',
						{ bvid: target.bvid },
						signal,
					),
				signal,
			),
		)
		if (
			!view ||
			view.bvid !== target.bvid ||
			!positiveInteger(view.aid) ||
			!Array.isArray(view.pages)
		)
			return fail('identity-mismatch')
		const page = view.pages
			.map(record)
			.find((part) => part?.page === target.page)
		if (
			!page ||
			page.cid !== target.cid ||
			typeof page.duration !== 'number' ||
			!Number.isFinite(page.duration) ||
			page.duration <= 0
		)
			return fail('identity-mismatch')
		state.durationMs = page.duration * 1000
		const metadata = record(
			await this.guarded(
				state,
				() =>
					this.dependencies.requestAuthenticatedJson(
						'/x/player/wbi/v2',
						{ aid: String(view.aid), cid: String(target.cid) },
						signal,
					),
				signal,
			),
		)
		// Missing identity is not evidence of a match. Never fall back to unsigned legacy metadata.
		if (
			!metadata ||
			metadata.cid !== target.cid ||
			(metadata.aid !== undefined && metadata.aid !== view.aid)
		)
			return fail('identity-mismatch')
		if (metadata.login_mid === 0) return fail('login-required')
		const subtitles = record(metadata.subtitle)?.subtitles
		if (!Array.isArray(subtitles) || subtitles.length > 100)
			return fail('invalid-response')
		for (const raw of subtitles) {
			const row = record(raw)
			if (!row) return fail('invalid-response')
			const id =
				typeof row.id_str === 'string'
					? row.id_str
					: positiveInteger(row.id)
						? String(row.id)
						: ''
			if (!/^\d{1,30}$/.test(id) || state.tracks.has(id))
				return fail('invalid-response')
			const track: SubtitleTrack = {
				id,
				language: label(row.lan, 64),
				label: label(row.lan_doc, 200),
				platformAiType: platformFlag(row.ai_type),
				platformAiStatus: platformFlag(row.ai_status),
			}
			state.tracks.set(id, { track, url: subtitleUrl(row.subtitle_url) })
		}
		this.check(state, signal)
		this.discovery = state
		return {
			status: state.tracks.size ? 'tracks' : 'no-tracks',
			target: { ...state.target },
			generation: state.generation,
			tracks: [...state.tracks.values()].map(({ track }) => ({ ...track })),
		}
	}
	async load(trackId: string, signal?: AbortSignal): Promise<SubtitleDocument> {
		const ownLoad = ++this.loadIntent
		const state = this.discovery
		if (!state) return fail('stale')
		this.check(state, signal)
		const selected = state.tracks.get(trackId)
		if (!selected) return fail('identity-mismatch')
		const payload = await this.guarded(
			state,
			async () => {
				if (typeof this.dependencies.requestSubtitleBody !== 'function')
					return fail('restricted')
				const response = await this.dependencies.requestSubtitleBody(
					selected.url,
					signal,
				)
				if (response.status === 401) return fail('login-required')
				if ([403, 412, 429].includes(response.status)) return fail('restricted')
				if (response.status >= 300 && response.status < 400)
					return fail('restricted')
				if (
					!Number.isInteger(response.status) ||
					response.status < 200 ||
					response.status >= 300
				)
					return fail('unavailable')
				if (response.url !== selected.url) return fail('restricted')
				const text = response.body
				// Defense after the native bounded read, not a JS streaming size guarantee.
				if (typeof text !== 'string' || text.length > 2000000)
					return fail('invalid-response')
				try {
					return JSON.parse(text) as unknown
				} catch {
					return fail('invalid-response')
				}
			},
			signal,
		)
		if (ownLoad !== this.loadIntent) return fail('stale')
		return {
			target: { ...state.target },
			track: { ...selected.track },
			generation: state.generation,
			lines: parseSubtitleLines(payload, state.durationMs),
		}
	}
}
