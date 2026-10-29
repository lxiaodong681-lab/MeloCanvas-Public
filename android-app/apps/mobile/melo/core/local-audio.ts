import type { Database } from './database'

export const localAudioUuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const isLocalAudioId = (id: string): boolean =>
	typeof id === 'string' &&
	id.startsWith('local:') &&
	localAudioUuidPattern.test(id.slice(6))
export function localAudioUri(id: string): string {
	if (!isLocalAudioId(id)) throw new Error('本地音频身份无效')
	return `orpheus://local-audio?id=${id.slice(6)}`
}
export interface LocalAudio {
	id: string
	originalName: string
	title: string
	artist: string
	durationSeconds: number
	bytes: number
	importedAt: number
}
export class LocalAudioStore {
	constructor(private db: Database) {}
	list(): LocalAudio[] {
		return this.db.getAllSync<LocalAudio>(
			'SELECT * FROM local_audio ORDER BY importedAt DESC, id',
			[],
		)
	}
	get(id: string): LocalAudio | null {
		if (!isLocalAudioId(id)) return null
		return this.db.getFirstSync<LocalAudio>(
			'SELECT * FROM local_audio WHERE id = ?',
			[id],
		)
	}
	add(audio: LocalAudio): void {
		if (
			!isLocalAudioId(audio.id) ||
			!audio.title.trim() ||
			!audio.originalName.trim() ||
			!Number.isFinite(audio.durationSeconds) ||
			audio.durationSeconds < 0 ||
			!Number.isSafeInteger(audio.bytes) ||
			audio.bytes <= 0 ||
			!Number.isSafeInteger(audio.importedAt) ||
			audio.importedAt < 0
		)
			throw new Error('本地音频信息无效')
		this.db.execSync('BEGIN IMMEDIATE')
		try {
			this.db.runSync(
				"INSERT INTO playback_sources (id, kind) VALUES (?, 'local')",
				[audio.id],
			)
			this.db.runSync(
				'INSERT INTO local_audio (id, originalName, title, artist, durationSeconds, bytes, importedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
				[
					audio.id,
					audio.originalName,
					audio.title,
					audio.artist,
					audio.durationSeconds,
					audio.bytes,
					audio.importedAt,
				],
			)
			this.db.execSync('COMMIT')
		} catch (error) {
			try {
				this.db.execSync('ROLLBACK')
			} catch {
				/* Preserve the write error. */
			}
			throw error
		}
	}
}
