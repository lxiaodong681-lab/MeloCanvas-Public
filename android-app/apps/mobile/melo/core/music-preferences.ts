import type { Database } from './database'

export const musicPreferencesKey = 'music.preferences.v1'
export interface MusicPreferences {
	version: 1
	welcomeCompleted: boolean
	/** User-declared search seeds, not inferred artist or genre identities. */
	genres: string[]
	artists: string[]
}
export const emptyMusicPreferences = (): MusicPreferences => ({
	version: 1,
	welcomeCompleted: false,
	genres: [],
	artists: [],
})
function containsControlCharacter(seed: string): boolean {
	for (let index = 0; index < seed.length; index++) {
		const code = seed.charCodeAt(index)
		if (code < 32 || code === 127) return true
	}
	return false
}
function validSeeds(value: unknown, limit: number): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= limit &&
		value.every(
			(seed) =>
				typeof seed === 'string' &&
				seed.length > 0 &&
				seed.length <= 60 &&
				seed.trim() === seed &&
				!containsControlCharacter(seed),
		) &&
		new Set(value).size === value.length
	)
}
export function preferenceSeeds(value: MusicPreferences): string[] {
	return [...new Set([...value.artists, ...value.genres])]
}
export function parseMusicPreferences(text: string): MusicPreferences {
	if (text.length > 10000) throw new Error('音乐偏好记录过大，原记录已保留')
	const data: unknown = JSON.parse(text)
	if (!data || typeof data !== 'object' || Array.isArray(data))
		throw new Error('音乐偏好记录无效，原记录已保留')
	const value = data as Record<string, unknown>
	if (
		Object.keys(value).sort().join(',') !==
			'artists,genres,version,welcomeCompleted' ||
		value.version !== 1 ||
		typeof value.welcomeCompleted !== 'boolean' ||
		!validSeeds(value.genres, 8) ||
		!validSeeds(value.artists, 8)
	)
		throw new Error('音乐偏好版本或内容无效，原记录已保留')
	return {
		version: 1,
		welcomeCompleted: value.welcomeCompleted,
		genres: [...value.genres],
		artists: [...value.artists],
	}
}
export class MusicPreferencesStore {
	constructor(private readonly db: Database) {}
	load(): MusicPreferences {
		const row = this.db.getFirstSync<{ value: string }>(
			'SELECT value FROM settings WHERE key=?',
			[musicPreferencesKey],
		)
		return row ? parseMusicPreferences(row.value) : emptyMusicPreferences()
	}
	/** One transaction, and never replace an unreadable previous preference record. */
	save(value: MusicPreferences, expected?: MusicPreferences): void {
		const next = parseMusicPreferences(JSON.stringify(value))
		this.db.execSync('BEGIN IMMEDIATE')
		try {
			const current = this.load()
			if (
				expected &&
				JSON.stringify(current) !==
					JSON.stringify(parseMusicPreferences(JSON.stringify(expected)))
			)
				throw new Error('音乐偏好已更新，请重新打开后再编辑；当前记录已保留。')
			this.db.runSync(
				'INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
				[musicPreferencesKey, JSON.stringify(next)],
			)
			this.db.execSync('COMMIT')
		} catch (error) {
			try {
				this.db.execSync('ROLLBACK')
			} catch {
				/* Preserve the original error. */
			}
			throw error
		}
	}
}
