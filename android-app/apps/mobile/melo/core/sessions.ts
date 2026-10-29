import type { Database } from './database'
import {
	validatePosition,
	validateUpdatedAt,
	type PlaybackMode,
} from './listening'
import { validateQueueEntry, type QueueEntry } from './queue'

export interface PlaybackSession {
	mode: PlaybackMode
	entries: QueueEntry[]
	currentEntryId: string | null
	currentSourceId: string | null
	positionSeconds: number
	speed: number
	updatedAt: number
}

function validateMode(mode: PlaybackMode): void {
	if (mode !== 'music' && mode !== 'listening') throw new Error('播放模式无效')
}

function validateSession(session: PlaybackSession): void {
	validateMode(session.mode)
	validatePosition(session.positionSeconds)
	validateUpdatedAt(session.updatedAt)
	if (!Array.isArray(session.entries)) throw new Error('播放队列无效')
	for (const entry of session.entries) validateQueueEntry(entry, session.mode)
	if (
		new Set(session.entries.map((entry) => entry.entryId)).size !==
		session.entries.length
	)
		throw new Error('播放队列包含重复条目')
	if (
		!Number.isFinite(session.speed) ||
		session.speed < 0.1 ||
		session.speed > 3
	)
		throw new Error('播放速度无效')
	if (session.currentEntryId === null) {
		if (session.currentSourceId !== null || session.positionSeconds !== 0)
			throw new Error('空当前项不能保存音源或位置')
	} else {
		const current = session.entries.find(
			(entry) => entry.entryId === session.currentEntryId,
		)
		if (!current || current.sourceId !== session.currentSourceId)
			throw new Error('当前项与播放队列音源不一致')
	}
}

export class SessionStore {
	constructor(private db: Database) {}

	getSession(mode: PlaybackMode): PlaybackSession | null {
		validateMode(mode)
		const row = this.db.getFirstSync<Omit<PlaybackSession, 'entries'>>(
			'SELECT * FROM playback_sessions WHERE mode = ?',
			[mode],
		)
		if (!row) return null
		const session = {
			...row,
			entries: this.db
				.getAllSync<QueueEntry>(
					'SELECT entryId, sourceId FROM playback_session_items WHERE mode = ? ORDER BY ordinal',
					[mode],
				)
				.map((item) => ({ ...item })),
		}
		validateSession(session)
		return session
	}

	saveSession(session: PlaybackSession): void {
		validateSession(session)
		this.db.execSync('BEGIN IMMEDIATE')
		try {
			this.db.runSync(
				`INSERT INTO playback_sessions (mode, currentSourceId, positionSeconds, speed, updatedAt, currentEntryId) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(mode) DO UPDATE SET currentSourceId=excluded.currentSourceId,
                positionSeconds=excluded.positionSeconds, speed=excluded.speed,
                updatedAt=excluded.updatedAt, currentEntryId=excluded.currentEntryId`,
				[
					session.mode,
					session.currentSourceId,
					session.positionSeconds,
					session.speed,
					session.updatedAt,
					session.currentEntryId,
				],
			)
			this.db.runSync('DELETE FROM playback_session_items WHERE mode = ?', [
				session.mode,
			])
			for (const [ordinal, entry] of session.entries.entries())
				this.db.runSync(
					'INSERT INTO playback_session_items (mode, ordinal, entryId, sourceId) VALUES (?, ?, ?, ?)',
					[session.mode, ordinal, entry.entryId, entry.sourceId],
				)
			this.db.execSync('COMMIT')
		} catch (error) {
			try {
				this.db.execSync('ROLLBACK')
			} catch {
				// SQLite may already have rolled back (for example SQLITE_FULL).
				// Preserve the original write error for diagnosis.
			}
			throw error
		}
	}
}
