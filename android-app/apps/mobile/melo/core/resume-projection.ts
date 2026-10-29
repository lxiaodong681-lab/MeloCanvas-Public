import type { Database } from './database'

/** Internal projection ownership, never exported as catalogue/user history. */
export function resumeProjectionGeneration(db: Database): number {
	return (
		db.getFirstSync<{ generation: number }>(
			'SELECT generation FROM resume_projection_epoch WHERE id = 1',
			[],
		)?.generation ?? 0
	)
}
export function fenceResumeProjection(db: Database): void {
	db.runSync(
		'INSERT INTO resume_projection_epoch VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET generation = generation + 1',
		[],
	)
	db.runSync('DELETE FROM resume_projection_grants', [])
	db.runSync('DELETE FROM resume_projection_session', [])
}
export function canProjectResume(db: Database, sourceId: string): boolean {
	const generation = resumeProjectionGeneration(db)
	return (
		generation === 0 ||
		!!db.getFirstSync(
			'SELECT sourceId FROM resume_projection_grants WHERE sourceId = ? AND generation = ?',
			[sourceId, generation],
		)
	)
}
export function grantResumeProjection(
	db: Database,
	sourceId: string,
	generation: number,
): void {
	if (generation === 0 || generation !== resumeProjectionGeneration(db)) return
	db.runSync(
		'INSERT INTO resume_projection_grants(sourceId,generation) VALUES (?,?) ON CONFLICT(sourceId) DO UPDATE SET generation=excluded.generation',
		[sourceId, generation],
	)
}

export interface ResumeProjectionEntry {
	entryId: string
	sourceId: string
}
/** Grant queue ownership without projecting historical points for unplayed entries. */
export function authorizeResumeSession(
	db: Database,
	entries: ResumeProjectionEntry[],
	selectedSourceId: string,
	generation: number,
): void {
	if (generation === 0 || generation !== resumeProjectionGeneration(db)) return
	// A successful explicit replacement ends the former queue's projection ownership.
	// Its points remain in SQLite, but stale native points outside the new queue cannot resurrect.
	db.runSync('DELETE FROM resume_projection_grants', [])
	db.runSync(
		'INSERT INTO resume_projection_session(id,generation,entriesJson) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,entriesJson=excluded.entriesJson',
		[generation, JSON.stringify(entries)],
	)
	grantResumeProjection(db, selectedSourceId, generation)
}
export function observeResumeSession(
	db: Database,
	entries: ResumeProjectionEntry[],
	currentSourceId: string | null,
): void {
	if (
		!currentSourceId ||
		!entries.some((entry) => entry.sourceId === currentSourceId)
	)
		return
	const generation = resumeProjectionGeneration(db)
	if (generation === 0 || canProjectResume(db, currentSourceId)) return
	const session = db.getFirstSync<{ generation: number; entriesJson: string }>(
		'SELECT generation,entriesJson FROM resume_projection_session WHERE id = 1',
		[],
	)
	if (
		session?.generation === generation &&
		session.entriesJson === JSON.stringify(entries)
	)
		grantResumeProjection(db, currentSourceId, generation)
}

/** Crash-safe revoke before a native replacement can expose a different queue. */
export function beginResumeActivation(db: Database, expectedGeneration: number): number {
	db.execSync('BEGIN IMMEDIATE')
	try {
		if (resumeProjectionGeneration(db) !== expectedGeneration)
			throw new Error('续听资料已经更新，请重新选择播放。')
		fenceResumeProjection(db)
		const generation = resumeProjectionGeneration(db)
		db.execSync('COMMIT')
		return generation
	} catch (cause) {
		db.execSync('ROLLBACK')
		throw cause
	}
}
