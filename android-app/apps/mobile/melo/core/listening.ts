import type { Database } from './database'
import {
	authorizeResumeSession,
	beginResumeActivation,
	observeResumeSession,
	type ResumeProjectionEntry,
	canProjectResume,
	grantResumeProjection,
	resumeProjectionGeneration,
} from './resume-projection'

export type PlaybackMode = 'music' | 'listening'

export interface ResumePoint {
	sourceId: string
	positionSeconds: number
	durationSeconds: number
	completed: boolean
	updatedAt: number
}

type ResumeRow = Omit<ResumePoint, 'completed'> & { completed: number }

export function validateSourceId(id: string): void {
	if (!/^bilibili:BV[A-Za-z0-9]{10}:[1-9][0-9]*$/.test(id))
		throw new Error('音源身份无效')
	const cid = Number(id.slice(id.lastIndexOf(':') + 1))
	if (!Number.isSafeInteger(cid)) throw new Error('音源身份无效')
}

export function validatePosition(value: number): void {
	if (!Number.isFinite(value) || value < 0)
		throw new Error('播放位置或时长无效')
}

export function validateUpdatedAt(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error('播放记录时间无效')
}

function validateResumePoint(point: ResumePoint): void {
	validateSourceId(point.sourceId)
	validatePosition(point.positionSeconds)
	validatePosition(point.durationSeconds)
	validateUpdatedAt(point.updatedAt)
	if (
		typeof point.completed !== 'boolean' ||
		(point.durationSeconds > 0 && point.positionSeconds > point.durationSeconds)
	)
		throw new Error('续听记录无效')
}

function resumePoint(row: ResumeRow): ResumePoint {
	if (row.completed !== 0 && row.completed !== 1)
		throw new Error('续听记录无效')
	const point = { ...row, completed: row.completed === 1 }
	validateResumePoint(point)
	return point
}

export class ListeningLibrary {
	constructor(private db: Database) {}

	authorizeResumeSession = (
		entries: ResumeProjectionEntry[],
		selectedSourceId: string,
		generation: number,
	) => authorizeResumeSession(this.db, entries, selectedSourceId, generation)
	observeResumeSession = (
		entries: ResumeProjectionEntry[],
		currentSourceId: string | null,
	) => observeResumeSession(this.db, entries, currentSourceId)
	beginResumeActivation = (generation: number) => beginResumeActivation(this.db, generation)
	projectionGeneration = () => resumeProjectionGeneration(this.db)
	canProjectResume = (sourceId: string) => canProjectResume(this.db, sourceId)
	grantResumeProjection = (sourceId: string, generation: number) =>
		grantResumeProjection(this.db, sourceId, generation)

	getResumePoint(sourceId: string): ResumePoint | null {
		validateSourceId(sourceId)
		const row = this.db.getFirstSync<ResumeRow>(
			'SELECT * FROM resume_points WHERE sourceId = ?',
			[sourceId],
		)
		return row ? resumePoint(row) : null
	}

	saveResumePoint(point: ResumePoint): void {
		validateResumePoint(point)
		this.db.runSync(
			`INSERT INTO resume_points VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(sourceId) DO UPDATE SET positionSeconds=excluded.positionSeconds,
            durationSeconds=excluded.durationSeconds, completed=excluded.completed,
            updatedAt=excluded.updatedAt`,
			[
				point.sourceId,
				point.positionSeconds,
				point.durationSeconds,
				point.completed ? 1 : 0,
				point.updatedAt,
			],
		)
	}

	listResumePoints(): ResumePoint[] {
		return this.db
			.getAllSync<ResumeRow>(
				'SELECT * FROM resume_points ORDER BY updatedAt DESC, sourceId',
				[],
			)
			.map(resumePoint)
	}
}
