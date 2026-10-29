import * as DocumentPicker from 'expo-document-picker'
import { File, Paths } from 'expo-file-system'
import { deleteDatabaseSync, openDatabaseSync } from 'expo-sqlite'

import {
	getLibraryBackupModule,
	type InspectedLibraryBackup,
} from '../../../packages/native/src/LibraryBackupModule'

import { migrate } from './core/database'
import {
	exportLibraryBackup,
	mergeLibraryBackup,
	replaceLibraryBackup,
	hasLibraryBackupUndo,
	undoLibraryBackupReplacement,
	parseLibraryBackup,
	stageLibraryBackup,
	summarizeLibraryBackup,
} from './core/library-backup'

function resolveCover(name: string): string {
	if (!/^cover-[a-z0-9]+-[a-z0-9]+$/.test(name)) throw new Error('封面名称无效')
	return new File(Paths.document, 'melo-playlist-covers', name).uri
}
function withLive<T>(
	action: (db: ReturnType<typeof openDatabaseSync>) => T,
): T {
	const db = openDatabaseSync('melocanvas.db', { useNewConnection: true })
	try {
		migrate(db)
		return action(db)
	} finally {
		db.closeSync()
	}
}
function preflight(text: string): void {
	const name = `melo-backup-preflight-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
	const db = openDatabaseSync(name, { useNewConnection: true })
	try {
		migrate(db)
		stageLibraryBackup(db, text)
	} finally {
		db.closeSync()
		deleteDatabaseSync(name)
	}
}
export async function saveLibraryBackup(full: boolean): Promise<boolean> {
	const native = getLibraryBackupModule()
	if (typeof native.saveAsync !== 'function')
		throw new Error(
			'当前安装版本不支持保存到文件，请安装包含该功能的新版本。当前资料未修改。',
		)
	const text = withLive((db) => exportLibraryBackup(db, Date.now(), full))
	return native.saveAsync(text, full)
}
export async function shareLibraryBackup(full: boolean): Promise<void> {
	// Older native builds may lack sharing. Keep this optional capability out of
	// the startup import graph, but report its absence instead of claiming export.
	let Sharing: typeof import('expo-sharing')
	try {
		Sharing = await import('expo-sharing')
	} catch {
		throw new Error(
			'当前安装版本缺少系统分享组件，无法分享备份。可改用保存到文件，或安装包含该组件的新版本；当前资料未被修改。',
		)
	}
	if (!(await Sharing.isAvailableAsync()))
		throw new Error('此设备暂不支持系统分享，请改用保存到文件。')
	const text = withLive((db) => exportLibraryBackup(db, Date.now(), full))
	const uri = await getLibraryBackupModule().exportAsync(text, full)
	await Sharing.shareAsync(uri, {
		mimeType: 'application/zip',
		dialogTitle: full ? '分享完整音乐库备份' : '分享轻量音乐库备份',
		UTI: 'public.zip-archive',
	})
}
export async function chooseLibraryBackup(): Promise<InspectedLibraryBackup | null> {
	const result = await DocumentPicker.getDocumentAsync({
		type: ['application/zip', 'application/octet-stream'],
		copyToCacheDirectory: false,
		multiple: false,
	})
	if (result.canceled || !result.assets[0]) return null
	const native = getLibraryBackupModule()
	const inspected = await native.inspectAsync(result.assets[0].uri)
	try {
		if (
			!inspected.full &&
			parseLibraryBackup(inspected.catalogueJson).tables.settings.some(
				(row) => row.key === 'theme.state.v1',
			)
		)
			throw new Error('轻量备份不能包含需要主题文件的安装指针。')
		preflight(inspected.catalogueJson)
		return inspected
	} catch (error) {
		try {
			await native.discardAsync(inspected.token)
		} catch {
			/* Preserve validation failure. */
		}
		throw error
	}
}
export const previewLibraryBackup = (backup: InspectedLibraryBackup) =>
	summarizeLibraryBackup(parseLibraryBackup(backup.catalogueJson))
export async function restoreLibraryBackup(
	backup: InspectedLibraryBackup,
	mode: 'merge' | 'replace' = 'merge',
) {
	preflight(backup.catalogueJson)
	// Native publication does not overwrite anything, even if SQLite later fails. Such
	// immutable files are harmless recoverable extras, never deletion of current data.
	await getLibraryBackupModule().publishFilesAsync(backup.token)
	const result = withLive((db) => {
		if (mode === 'replace') {
			replaceLibraryBackup(db, backup.catalogueJson, resolveCover)
			return { inserted: 0, keptExisting: 0, skippedGroups: 0 }
		}
		return mergeLibraryBackup(db, backup.catalogueJson, resolveCover)
	})
	let cleanupWarning = false
	try {
		await getLibraryBackupModule().discardAsync(backup.token)
	} catch {
		cleanupWarning = true
	}
	return { ...result, cleanupWarning }
}
export const discardLibraryBackup = (backup: InspectedLibraryBackup) =>
	getLibraryBackupModule().discardAsync(backup.token)

export const canUndoLibraryBackup = () =>
	withLive((db) => hasLibraryBackupUndo(db))
export const undoLastLibraryBackup = () =>
	withLive((db) => undoLibraryBackupReplacement(db, resolveCover))
export const previewLibraryBackupMerge = (backup: InspectedLibraryBackup) =>
	withLive((db) =>
		mergeLibraryBackup(db, backup.catalogueJson, resolveCover, true),
	)
