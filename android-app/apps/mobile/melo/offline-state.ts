import type { DownloadTask, Track } from '@bbplayer/orpheus'

/** Media3's persisted integer state at the UI/domain boundary. */
export const offlinePhase = (task: Pick<DownloadTask, 'state'>): number =>
	task.state

export const offlineSuffix = '&meloOffline=1'
export function offlinePlaybackTrack(task: DownloadTask): Track {
	if (
		offlinePhase(task) !== 3 ||
		task.verifiedComplete !== true ||
		!task.track?.sourceId ||
		task.contentLength <= 0
	)
		throw new Error('离线内容尚未通过完整性验证')
	return {
		...task.track,
		id: task.track.sourceId,
		url: task.track.url.replace(/&meloOffline=1$/, '') + offlineSuffix,
	}
}
export function offlineState(task: DownloadTask): string {
	if (offlinePhase(task) === 3)
		return task.verifiedComplete === true
			? '离线可听，已验证完整'
			: '内容不完整，需要重新保存'
	if (offlinePhase(task) === 0) return '等待 Wi-Fi 或下载队列'
	if (offlinePhase(task) === 1)
		return task.stopReason === 2
			? '网络已切换，连接 Wi-Fi 后手动继续'
			: '已取消 / 暂停，保留已下载部分'
	if (offlinePhase(task) === 2)
		return task.contentLength > 0
			? `正在保存，${Math.min(99, Math.floor((task.bytesDownloaded / task.contentLength) * 100))}%`
			: '正在确认完整长度'
	if (offlinePhase(task) === 4)
		return '保存失败，检查 Wi-Fi、容量和音源权限后重试'
	if (offlinePhase(task) === 5) return '正在移除离线副本'
	if (offlinePhase(task) === 7) return '正在重新保存'
	return '状态待确认'
}
export function offlineLimitBytes(input: string): number {
	if (!/^\d+(?:\.\d{1,3})?$/.test(input.trim()))
		throw new Error('请输入有效的 GiB 容量')
	const bytes = Math.floor(Number(input) * 1024 ** 3)
	if (
		!Number.isSafeInteger(bytes) ||
		bytes < 64 * 1024 ** 2 ||
		bytes > 64 * 1024 ** 3
	)
		throw new Error('容量范围为 0.063 至 64 GiB')
	return bytes
}
export const offlineBytes = (bytes: number) =>
	`${(Math.max(0, bytes) / 1024 ** 2).toFixed(1)} MiB`
