import type { OnlineLyricCandidate } from './online-lyrics'

export interface LyricMatchTrack {
	sourceId: string
	title: string
	performer?: string | null
	durationSeconds?: number
}

/** Keep the original title for evidence; the UP name is never a performer. */
export function lyricSearchTitle(title: string): string {
	const clean = title.replace(/【[^】]*】/g, '').trim()
	const quoted = [...clean.matchAll(/《([^》]+)》|「([^」]+)」/g)]
	const song = quoted.at(-1)
	// Video titles can name both a game/film and its song. A sole leading
	// work name followed by concert context is not itself the song title.
	const workContext = song && quoted.length === 1 && song.index === 0 &&
		/主题曲|主題曲|周年|交响|交響|音乐会|音樂會|音乐现场|音樂現場|演唱会|演唱會|原声|原聲|配乐|配樂|OST/i.test(clean.slice(song[0].length))
	const value = song && !workContext
		? song[1] || song[2]
		: clean.replace(/[《》「」]/g, ' ').replace(/\s+/g, ' ')
	return value.trim() || title.trim()
}

function normalized(text: string): string {
	return text
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, '')
}

function pairs(value: string): Set<string> {
	const chars = Array.from(value)
	return new Set(chars.slice(1).map((char, index) => chars[index] + char))
}

function overlap(left: string, right: string): number {
	if (!left || !right) return 0
	if (left === right) return 1
	if (
		Math.min(left.length, right.length) >= 3 &&
		(left.includes(right) || right.includes(left))
	)
		return 0.9
	const a = pairs(left)
	const b = pairs(right)
	if (!a.size || !b.size) return 0
	return (2 * [...a].filter((part) => b.has(part)).length) / (a.size + b.size)
}

function versions(text: string): string[] {
	const rules: [RegExp, string][] = [
		[/\bgame[\s-]*size\b|ゲームサイズ/i, 'game-size'],
		[/\btv[\s-]*size\b|テレビサイズ/i, 'tv-size'],
		[/\bshort[\s-]*(?:ver(?:sion)?|size)\b|短版|剪辑版|剪輯版/i, 'short-version'],
		[/\bfull[\s-]*(?:ver(?:sion)?|size|length)\b|完整版|完全版|フル(?:サイズ|バージョン)/i, 'full-length'],
		[/翻唱|\bcover\b/i, 'cover'],
		[/现场|現場|演唱会|演唱會|\blive\b/i, 'live'],
		[/伴奏|纯音乐|純音樂|instrumental|karaoke/i, 'instrumental'],
		[/加速|慢速|sped.?up|slowed/i, 'speed'],
		[/填词|填詞|翻填|改词|改詞/i, 'rewritten'],
		[/日语版|日語版|日文版|日语填词|日語填詞/i, 'japanese-version'],
		[/中文版|中文填词|中文填詞|汉化|漢化/i, 'chinese-version'],
		[/英语版|英語版|英文版|英文填词|英文填詞/i, 'english-version'],
	]
	return rules.filter(([pattern]) => pattern.test(text)).map(([, name]) => name)
}

export function lyricVersionConflict(
	requestedTitle: string,
	foundTitle: string,
): boolean {
	const requested = versions(requestedTitle),
		found = versions(foundTitle)
	return (
		requested.some((version) => !found.includes(version)) ||
		found.some((version) => !requested.includes(version))
	)
}

/** Title metadata only, bounded independently of the surrounding lyric body. */
export function lyricTitleTags(raw: string): string[] {
	return raw
		.slice(0, 16_384)
		.replace(/^\uFEFF/, '')
		.split(/\r?\n/, 64)
		.flatMap((line) => {
			const match = /^\s*\[ti:([^\]\r\n]{1,512})\]\s*$/i.exec(line)
			return match ? [match[1]] : []
		})
}

const titleBrackets = /\([^()]{0,128}\)|\[[^[\]]{0,128}\]|【[^【】]{0,128}】/g

/** Only explicit title/edition headers, never general verses or author lines. */
export function loadedLyricVersionText(
	candidateTitle: string,
	raw: string,
	openingLines: readonly string[],
): string {
	const song = normalized(
		candidateTitle.normalize('NFKC').replace(titleBrackets, ''),
	)
	const headings: string[] = []
	if (song) {
		for (const line of openingLines.slice(0, 3)) {
			if (line.length > 1024) continue
			for (const part of line.normalize('NFKC').split(/\s+[-–—]\s+/)) {
				const editions = [...part.matchAll(titleBrackets)].map((match) => match[0])
				if (
					normalized(part.replace(titleBrackets, '')) === song &&
					editions.some((edition) =>
						versions(edition).length || /录音室|錄音室|studio|原唱|original/i.test(edition),
					)
				)
					headings.push(part)
			}
		}
	}
	return [candidateTitle, ...lyricTitleTags(raw), ...headings].join('\n')
}

export function lyricCandidateEvidence(
	candidate: OnlineLyricCandidate,
	track: LyricMatchTrack,
) {
	const query = lyricSearchTitle(track.title)
	const title = normalized(candidate.title)
	// Bilingual Bilibili titles often contain both a Chinese name and its English title.
	const names = [
		query,
		...(query.match(
			/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu,
		) ?? []),
	]
	const similarity = Math.max(
		...names.map((name) => overlap(normalized(name), title)),
	)
	const artist = normalized(candidate.artist)
	const performer = normalized(track.performer || '')
	const artistMatches =
		!!artist &&
		(performer
			? performer.includes(artist) || artist.includes(performer)
			: normalized(track.title).includes(artist))
	const artistConflict = !!performer && !!artist && !artistMatches
	const sourceDuration =
		typeof track.durationSeconds === 'number' &&
		Number.isFinite(track.durationSeconds) &&
		track.durationSeconds > 0
			? track.durationSeconds
			: null
	const durationDifference =
		sourceDuration !== null &&
		Number.isFinite(candidate.duration) &&
		candidate.duration > 0
			? Math.abs(sourceDuration - candidate.duration)
			: null
	// A short MV intro/outro is plausible; a substantially different length
	// must stay manual even when the title or singer matches.
	const durationConflict =
		sourceDuration !== null && durationDifference !== null &&
		durationDifference > Math.max(15, sourceDuration * 0.1)
	const versionConflict = lyricVersionConflict(track.title, candidate.title)
	const closeDuration = durationDifference !== null && durationDifference <= 5
	const eligible =
		!artistConflict &&
		!versionConflict &&
		!durationConflict &&
		(similarity >= 0.9 ||
			(similarity >= 0.7 && (artistMatches || closeDuration)))
	return {
		eligible,
		artistMatches,
		score:
			similarity * 100 +
			(artistMatches ? 25 : 0) +
			(closeDuration ? 15 : 0) -
			(artistConflict ? 50 : 0) -
			(versionConflict ? 35 : 0),
		durationDifference,
		warnings: [
			...(artistConflict ? ['演唱者不同'] : []),
			...(versionConflict ? ['演唱版本或语言标注不同'] : []),
			...(durationDifference !== null && durationDifference > 5
				? [`时长相差 ${Math.round(durationDifference)} 秒`]
				: []),
			...(durationConflict ? ['时长差异过大，仅供人工核对'] : []),
		],
	}
}

export function rankLyricCandidates(
	candidates: readonly OnlineLyricCandidate[],
	track: LyricMatchTrack,
) {
	return candidates
		.map((candidate, index) => ({
			candidate,
			index,
			evidence: lyricCandidateEvidence(candidate, track),
		}))
		.sort((a, b) => b.evidence.score - a.evidence.score || a.index - b.index)
}

/** Duration can rank versions within a singer, but cannot identify a singer. */
export function automaticLyricCandidates(
	candidates: readonly OnlineLyricCandidate[],
	track: LyricMatchTrack,
) {
	const all = rankLyricCandidates(candidates, track)
	const ranked = all.filter(
		(item) => item.evidence.eligible && normalized(item.candidate.artist),
	)
	const direct = ranked.filter((item) => item.evidence.artistMatches)
	// Once the performer is known, an unsuccessful load must not fall back
	// to an unverified or conflicting singer.
	if (normalized(track.performer || '')) return direct
	const named = new Set(direct.map((item) => normalized(item.candidate.artist)))
	if (named.size === 1) return direct
	if (named.size > 1) return []
	// Reject a known title singer's unsuitable versions rather than silently
	// substituting another singer just because its duration is closer.
	if (all.some((item) => item.evidence.artistMatches)) return []
	const singers = new Set(ranked.map((item) => normalized(item.candidate.artist)))
	return singers.size === 1 ? ranked : []
}
