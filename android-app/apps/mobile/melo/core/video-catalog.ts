import type { ListeningPart, ListeningVideo } from '../listening-source'

import { Library, type Database } from './database'
import { json } from './import-validation'
import { validateSourceId } from './listening'
import { sourceId, type Source } from './model'

export const videoCatalogLimits = {
	parts: 1000,
	partBytes: 16 * 1024,
	headerBytes: 16 * 1024,
	videoBytes: 8 * 1024 * 1024,
} as const

export interface VideoSummary {
	bvid: string
	title: string
	uploader: string
	uploaderId: number
	artwork: string
	fetchedAt: number
	partCount: number
	lastVisited: { sourceId: string; inCurrentParts: boolean } | null
}
export interface StoredVideo extends VideoSummary {
	parts: ListeningPart[]
}
interface HeaderRow {
	bvid: string
	title: string
	uploader: string
	uploaderId: number
	artwork: string
	fetchedAt: number
	lastVisitedSourceId: string | null
	partCount: number
	visitedInCurrentParts: number
}

function bvid(value: string): void {
	if (typeof value !== 'string' || !/^BV[A-Za-z0-9]{10}$/.test(value))
		throw new Error('视频 BV 身份无效')
}
function title(value: string): void {
	if (typeof value !== 'string' || !value.trim())
		throw new Error('视频元数据缺少名称')
}
function validateSource(source: Source, videoBvid: string): void {
	if (
		!source ||
		source.bvid !== videoBvid ||
		!Number.isSafeInteger(source.cid) ||
		source.cid <= 0 ||
		source.id !== sourceId(videoBvid, source.cid)
	)
		throw new Error('视频分 P 音源身份不一致')
	validateSourceId(source.id)
	title(source.originalTitle)
	title(source.uploader)
	if (
		!Number.isSafeInteger(source.uploaderId) ||
		source.uploaderId <= 0 ||
		typeof source.artwork !== 'string' ||
		!Number.isFinite(source.duration) ||
		source.duration < 0 ||
		(source.performer !== null && typeof source.performer !== 'string') ||
		!['music', 'unclassified'].includes(source.domain) ||
		source.audioAvailability !== 'unknown'
	)
		throw new Error('视频分 P 音源元数据无效')
}
function validateVideo(video: ListeningVideo): void {
	bvid(video.bvid)
	title(video.title)
	title(video.uploader)
	if (
		!Array.isArray(video.parts) ||
		!video.parts.length ||
		video.parts.length > videoCatalogLimits.parts
	)
		throw new Error('视频分 P 数量无效或超过上限')
	json(video, videoCatalogLimits.videoBytes)
	const seen = new Set<number>()
	const first = video.parts[0].source
	for (const [index, part] of video.parts.entries()) {
		if (part.page !== index + 1) throw new Error('视频分 P 必须按连续页序保存')
		title(part.title)
		validateSource(part.source, video.bvid)
		if (seen.has(part.source.cid)) throw new Error('视频分 P CID 不能重复')
		seen.add(part.source.cid)
		if (
			part.source.originalTitle !== video.title ||
			part.source.uploader !== video.uploader ||
			part.source.uploaderId !== first.uploaderId ||
			part.source.artwork !== first.artwork
		)
			throw new Error('视频头与分 P 元数据不一致')
		json(part, videoCatalogLimits.partBytes)
	}
	json(
		{
			bvid: video.bvid,
			title: video.title,
			uploader: video.uploader,
			uploaderId: first.uploaderId,
			artwork: first.artwork,
		},
		videoCatalogLimits.headerBytes,
	)
}
function summary(row: HeaderRow): VideoSummary {
	bvid(row.bvid)
	let lastVisited: VideoSummary['lastVisited'] = null
	if (row.lastVisitedSourceId !== null) {
		validateSourceId(row.lastVisitedSourceId)
		if (!row.lastVisitedSourceId.startsWith(`bilibili:${row.bvid}:`))
			throw new Error('视频访问记录身份不一致')
		lastVisited = {
			sourceId: row.lastVisitedSourceId,
			inCurrentParts: row.visitedInCurrentParts === 1,
		}
	}
	return {
		bvid: row.bvid,
		title: row.title,
		uploader: row.uploader,
		uploaderId: row.uploaderId,
		artwork: row.artwork,
		fetchedAt: row.fetchedAt,
		partCount: row.partCount,
		lastVisited,
	}
}
const headerQuery = `SELECT v.*, count(p.page) partCount,
    coalesce(max(p.sourceId = v.lastVisitedSourceId), 0) visitedInCurrentParts
    FROM video_catalog v LEFT JOIN video_catalog_parts p ON p.bvid = v.bvid`

/** Verified view metadata only. Each mutation owns its transaction; no playback or resume writes. */
export class VideoCatalog {
	private library: Library
	constructor(private db: Database) {
		this.library = new Library(db)
	}
	private atomic(action: () => void): void {
		this.db.execSync('BEGIN IMMEDIATE')
		try {
			action()
			this.db.execSync('COMMIT')
		} catch (error) {
			try {
				this.db.execSync('ROLLBACK')
			} catch {
				// SQLite can automatically roll back FULL; preserve the original error.
			}
			throw error
		}
	}
	save(video: ListeningVideo, fetchedAt: number): void {
		validateVideo(video)
		if (!Number.isSafeInteger(fetchedAt) || fetchedAt < 0)
			throw new Error('视频观察时间无效')
		this.atomic(() => {
			for (const part of video.parts) {
				const existing = this.library.get(part.source.id)
				if (existing) validateSource(existing, video.bvid)
				if (existing && existing.uploaderId !== part.source.uploaderId)
					throw new Error('已保存音源的 UP 身份与视频不一致，原记录已保留')
				this.library.save(part.source)
			}
			const first = video.parts[0].source
			this.db.runSync(
				`INSERT INTO video_catalog(bvid, title, uploader, uploaderId, artwork, fetchedAt)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(bvid) DO UPDATE SET title=excluded.title,
                uploader=excluded.uploader, uploaderId=excluded.uploaderId, artwork=excluded.artwork,
                fetchedAt=excluded.fetchedAt`,
				[
					video.bvid,
					video.title,
					video.uploader,
					first.uploaderId,
					first.artwork,
					fetchedAt,
				],
			)
			this.db.runSync('DELETE FROM video_catalog_parts WHERE bvid = ?', [
				video.bvid,
			])
			for (const part of video.parts)
				this.db.runSync(
					'INSERT INTO video_catalog_parts(bvid, page, sourceId, title) VALUES (?, ?, ?, ?)',
					[video.bvid, part.page, part.source.id, part.title],
				)
		})
	}
	list(): VideoSummary[] {
		return this.db
			.getAllSync<HeaderRow>(
				`${headerQuery} GROUP BY v.bvid ORDER BY v.bvid`,
				[],
			)
			.map(summary)
	}
	get(videoBvid: string): StoredVideo | null {
		bvid(videoBvid)
		// One statement keeps header, pointer and current parts in one SQLite read snapshot.
		const rows = this.db.getAllSync<
			Source & {
				videoTitle: string
				videoUploader: string
				videoUploaderId: number
				videoArtwork: string
				lastVisitedSourceId: string | null
				fetchedAt: number
				page: number
				partTitle: string
			}
		>(
			`SELECT s.*, v.title videoTitle, v.uploader videoUploader,
            v.uploaderId videoUploaderId, v.artwork videoArtwork, v.lastVisitedSourceId, v.fetchedAt,
            p.page, p.title partTitle FROM video_catalog v
            LEFT JOIN video_catalog_parts p ON p.bvid = v.bvid
            LEFT JOIN sources s ON s.id = p.sourceId WHERE v.bvid = ? ORDER BY p.page`,
			[videoBvid],
		)
		if (!rows.length) return null
		const parts = rows.map((row, index) => {
			const source: Source = {
				id: row.id,
				bvid: row.bvid,
				cid: row.cid,
				originalTitle: row.originalTitle,
				uploader: row.uploader,
				uploaderId: row.uploaderId,
				performer: row.performer,
				artwork: row.artwork,
				duration: row.duration,
				domain: row.domain,
				audioAvailability: row.audioAvailability,
			}
			validateSource(source, videoBvid)
			if (row.page !== index + 1 || row.uploaderId !== row.videoUploaderId)
				throw new Error('已存视频分 P 或 UP 身份不一致')
			return { page: row.page, title: row.partTitle, source }
		})
		const first = rows[0]
		return {
			...summary({
				bvid: videoBvid,
				title: first.videoTitle,
				uploader: first.videoUploader,
				uploaderId: first.videoUploaderId,
				artwork: first.videoArtwork,
				fetchedAt: first.fetchedAt,
				lastVisitedSourceId: first.lastVisitedSourceId,
				partCount: parts.length,
				visitedInCurrentParts: parts.some(
					(part) => part.source.id === first.lastVisitedSourceId,
				)
					? 1
					: 0,
			}),
			parts,
		}
	}
	recordVisitedPart(videoBvid: string, id: string): void {
		bvid(videoBvid)
		validateSourceId(id)
		this.atomic(() => {
			const source = this.library.get(id)
			if (
				!source ||
				source.bvid !== videoBvid ||
				source.id !== sourceId(videoBvid, source.cid) ||
				!this.db.getFirstSync('SELECT bvid FROM video_catalog WHERE bvid = ?', [
					videoBvid,
				])
			)
				throw new Error('最后访问分 P 必须属于已保存的视频和真实音源')
			this.db.runSync(
				'UPDATE video_catalog SET lastVisitedSourceId = ? WHERE bvid = ?',
				[id, videoBvid],
			)
		})
	}
}
