import {
	importTaskLimits as limits,
	type ImportDirectoryEntry,
	type ImportDirectorySnapshot,
	type ImportMetadata,
	type ExternalImportProvider,
} from './core/import-types'

export interface ExternalDirectoryReference {
	provider: ExternalImportProvider
	originalPlaylistId: string
}
export interface ExternalDirectoryInput {
	url: string
	taskId: string
	taskVersion: number
	signal?: AbortSignal
}
export type DirectoryErrorCode =
	| 'invalid-input'
	| 'invalid-link'
	| 'permission'
	| 'platform'
	| 'response'
	| 'incomplete'
	| 'limit'
	| 'network'
	| 'timeout'
	| 'cancelled'
	| 'redirect'
export class DirectoryReadError extends Error {
	constructor(
		readonly code: DirectoryErrorCode,
		message: string,
		readonly diagnostics: Record<string, string | number> = {},
		/** Bounded directory evidence, never permission to treat a partial read as complete. */
		readonly snapshot?: ImportDirectorySnapshot,
	) {
		super(message)
		this.name = 'DirectoryReadError'
	}
}
export type ExternalDirectoryTransport = (
	reference: ExternalDirectoryReference,
	signal: AbortSignal,
) => Promise<Uint8Array>
export const externalDirectoryLimits = {
	responseBytes: limits.directoryBytes,
	timeoutMs: 30000,
} as const

function fail(code: DirectoryErrorCode, message: string): never {
	throw new DirectoryReadError(code, message)
}
function decimal(value: unknown): string {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
		return String(value)
	if (typeof value === 'string' && /^[1-9][0-9]{0,127}$/.test(value))
		return value
	return fail('response', '平台目录身份无效或超出安全整数范围')
}

/** Parse only known playlist routes; never dereference the supplied link or follow short links. */
export function parseExternalDirectoryUrl(
	input: string,
): ExternalDirectoryReference {
	if (typeof input !== 'string' || input.length > 8192)
		fail('invalid-link', '请粘贴歌单链接或分享文字')
	// Extract URLs independently of the sharing app's prose. Never fetch the
	// supplied URL: the validated playlist ID goes to our fixed provider endpoint.
	const links = input.match(/https?:\/\/[^\s<>"“”「」《》（）()]+/gi) ?? []
	if (links.length !== 1) fail('invalid-link', '请一次粘贴一个歌单的分享链接')
	input = links[0].replace(/[，。；！、,;!]+$/, '')
	if (
		typeof input !== 'string' ||
		input.length > 2048 ||
		input.trim() !== input ||
		// oxlint-disable-next-line no-control-regex -- reject URL control characters before URL normalizes them.
		/[\s\\\u0000-\u001f\u007f]/.test(input)
	)
		fail('invalid-link', '请提供完整的对应平台歌单链接')
	let url: URL
	try {
		url = new URL(input)
	} catch {
		return fail('invalid-link', '歌单链接无效')
	}
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.port ||
		/%/.test(url.pathname)
	)
		fail('invalid-link', '不支持此歌单链接形式')
	let provider: ExternalDirectoryReference['provider'],
		route = url
	if (url.hostname === 'music.163.com' || url.hostname === 'y.music.163.com') {
		provider = 'netease'
		if (url.hash) {
			if (
				url.pathname !== '/' ||
				url.search ||
				!url.hash.startsWith('#/playlist?')
			)
				fail('invalid-link', '不支持此网易云歌单路径')
			route = new URL(url.hash.slice(1), url.origin)
		}
		if (!['/playlist', '/m/playlist'].includes(route.pathname) || route.hash)
			fail('invalid-link', '链接不是网易云歌单')
	} else if (url.hostname === 'y.qq.com') {
		provider = 'qq'
		if (url.hash) fail('invalid-link', '不支持此 QQ 歌单片段')
		const pathId = /^\/n\/ryqq\/playlist\/([1-9][0-9]{0,127})$/.exec(
			url.pathname,
		)?.[1]
		if (pathId) {
			if (url.searchParams.has('id'))
				fail('invalid-link', '歌单链接包含重复身份')
			return { provider, originalPlaylistId: pathId }
		}
		if (url.pathname !== '/n/m/detail/taoge/index.html')
			fail('invalid-link', '链接不是 QQ 歌单')
	} else if (['www.kuwo.cn', 'kuwo.cn', 'm.kuwo.cn'].includes(url.hostname)) {
		const id = /^(?:\/newh5app)?\/playlist_detail\/([1-9][0-9]{0,127})\/?$/.exec(url.pathname)?.[1]
		if (!id || url.hash || ['id','pid','playlistId'].some(key => url.searchParams.has(key))) fail('invalid-link', '请提供酷我 playlist_detail/… 完整歌单链接')
		return {provider:'kuwo', originalPlaylistId:id}
	} else if (['www.kugou.com', 'm.kugou.com'].includes(url.hostname)) {
		const id = /^\/songlist\/(gcid_[A-Za-z0-9]{1,100})\/?$/.exec(url.pathname)?.[1]
		if (!id || url.hash || ['id','gid','global_specialid'].some(key => url.searchParams.has(key))) fail('invalid-link', '请提供酷狗 songlist/gcid_… 完整分享链接；暂不读取短链或登录歌单')
		return {provider:'kugou', originalPlaylistId:id}
	} else if (['www.qishui.com','qishui.com','qishui.douyin.com','music.douyin.com'].includes(url.hostname)) {
		if (!['/share/playlist','/qishui/share/playlist'].includes(url.pathname) || url.hash) fail('invalid-link', '请在浏览器打开汽水分享短链后，复制含 playlist_id 的完整歌单地址')
		const ids = url.searchParams.getAll('playlist_id')
		if (ids.length !== 1 || !/^[1-9][0-9]{0,127}$/.test(ids[0]) || ['id','playlistId'].some(key => url.searchParams.has(key))) fail('invalid-link', '汽水歌单 ID 缺失、重复或无效')
		return {provider:'qishui', originalPlaylistId:ids[0]}
	} else
		return fail('invalid-link', '请提供已支持平台的官方完整歌单链接，不读取短链')
	const ids = route.searchParams.getAll('id')
	if (ids.length !== 1 || !/^[1-9][0-9]{0,127}$/.test(ids[0]))
		fail('invalid-link', '歌单 ID 缺失、重复或无效')
	return { provider, originalPlaylistId: ids[0] }
}

function record(value: unknown): ImportMetadata {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		fail('response', '平台目录响应缺少对象字段')
	return value as ImportMetadata
}
function count(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		fail('response', '平台未提供有效原曲数')
	if (value > limits.entries) fail('limit', '原歌单超过 5000 项目录上限')
	return value
}
function without(value: ImportMetadata, names: string[]): ImportMetadata {
	return Object.fromEntries(
		Object.entries(value).filter(([key]) => !names.includes(key)),
	)
}
function utf8(value: string): number {
	return new TextEncoder().encode(value).byteLength
}
function metadataBudget(value: ImportMetadata, maxBytes: number): void {
	function depth(item: unknown, level: number): void {
		if (level > limits.metadataDepth) fail('limit', '原平台元数据嵌套超过上限')
		if (typeof item === 'number' && !Number.isFinite(item))
			fail('response', '原平台元数据包含非有限数值')
		if (item && typeof item === 'object') {
			for (const child of Object.values(item)) depth(child, level + 1)
		}
	}
	depth(value, 0)
	if (utf8(JSON.stringify(value)) > maxBytes)
		fail('limit', '原平台元数据超过保存上限')
}
function snapshotBudget(snapshot: ImportDirectorySnapshot): void {
	metadataBudget(snapshot.originalMetadata, limits.playlistMetadataBytes)
	for (const entry of snapshot.entries)
		metadataBudget(entry.originalMetadata, limits.entryMetadataBytes)
	if (utf8(JSON.stringify(snapshot)) > limits.directoryBytes)
		fail('limit', '目录快照超过 8MiB 保存上限')
}
function trackId(
	track: ImportMetadata,
	provider: ExternalImportProvider,
): string | null {
	if (provider === 'qq' && track.mid !== undefined && track.mid !== '') {
		if (
			typeof track.mid !== 'string' ||
			!/^[A-Za-z0-9]{1,128}$/.test(track.mid)
		)
			fail('response', 'QQ 原曲 mid 无效')
		return track.mid
	}
	return track.id === undefined || track.id === null ? null : decimal(track.id)
}
function fullMetadata(
	track: ImportMetadata,
	provider: ExternalImportProvider,
): boolean {
	const artists = provider === 'netease' ? track.ar : track.singer
	const album = provider === 'netease' ? track.al : track.album
	const duration = provider === 'netease' ? track.dt : track.interval
	return (
		typeof track.name === 'string' &&
		!!track.name.trim() &&
		Array.isArray(artists) &&
		artists.every(
			(artist) =>
				!!artist &&
				typeof artist === 'object' &&
				!Array.isArray(artist) &&
				typeof artist.name === 'string',
		) &&
		!!album &&
		typeof album === 'object' &&
		!Array.isArray(album) &&
		typeof album.name === 'string' &&
		typeof duration === 'number' &&
		Number.isFinite(duration) &&
		duration >= 0
	)
}
function decodeDirectory(
	input: ExternalDirectoryInput,
	ref: ExternalDirectoryReference,
	bytes: Uint8Array,
): ImportDirectorySnapshot {
	if (!(bytes instanceof Uint8Array))
		fail('response', '目录读取器未返回字节数据')
	if (bytes.byteLength > externalDirectoryLimits.responseBytes)
		fail('limit', '平台响应超过 8MiB 读取上限')
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	} catch {
		return fail('response', '平台目录响应不是有效 UTF-8 JSON')
	}
	const envelope = record(parsed),
		{ provider, originalPlaylistId } = ref
	if (typeof envelope.code !== 'number' || !Number.isSafeInteger(envelope.code))
		fail('response', '平台目录响应缺少状态码')
	if (envelope.code !== (provider === 'netease' ? 200 : 0))
		throw new DirectoryReadError('platform', '平台未允许读取此歌单', {
			platformCode: envelope.code,
		})
	let playlist: ImportMetadata, envelopeMetadata: ImportMetadata
	if (provider === 'netease') {
		playlist = record(envelope.playlist)
		envelopeMetadata = without(envelope, ['playlist'])
	} else {
		const data = record(envelope.data)
		if (!Array.isArray(data.cdlist) || data.cdlist.length !== 1)
			fail('response', '平台响应缺少唯一歌单目录')
		playlist = record(data.cdlist[0])
		envelopeMetadata = {
			...without(envelope, ['data']),
			data: without(data, ['cdlist']),
		}
	}
	if (
		(provider === 'kugou' ? playlist.disstid : decimal(provider === 'netease' ? playlist.id : playlist.disstid)) !==
		originalPlaylistId
	)
		fail('response', '平台返回的歌单身份与请求不一致')
	const playlistName =
		provider === 'netease' ? playlist.name : playlist.dissname
	if (typeof playlistName !== 'string' || !playlistName.trim())
		fail('response', '平台目录缺少原歌单名称')
	const expectedCount = count(
		provider === 'netease' ? playlist.trackCount : playlist.songnum,
	)
	const rawTracks = provider === 'netease' ? playlist.tracks : playlist.songlist
	// A missing list is never evidence for a genuine empty playlist.
	if (!Array.isArray(rawTracks))
		fail('response', '平台目录缺少原曲列表，不能当作空歌单')
	if (rawTracks.length > limits.entries)
		fail('limit', '平台返回条目超过 5000 项')
	if (rawTracks.length > expectedCount)
		fail('response', '平台原曲数与返回条目数矛盾')
	const tracks = rawTracks.map(record)
	const rawIds = provider === 'netease' ? playlist.trackIds : undefined
	if (rawIds !== undefined && !Array.isArray(rawIds))
		fail('response', '网易云原目录身份列表无效')
	if (Array.isArray(rawIds) && rawIds.length > limits.entries)
		fail('limit', '原目录身份超过 5000 项')
	if (Array.isArray(rawIds) && rawIds.length > expectedCount)
		fail('response', '原目录身份数大于原曲数')
	const entries: ImportDirectoryEntry[] = []
	let readMetadataCount = 0
	const add = (
		position: number,
		id: string | null,
		track: ImportMetadata | null,
		directoryItem: ImportMetadata | null,
		returnedPosition: number | null,
	) => {
		const read = id !== null && track !== null && fullMetadata(track, provider)
		if (read) readMetadataCount++
		entries.push({
			entryId: `${provider}:${originalPlaylistId}:position:${position}`,
			originalEntryId: id,
			originalPosition: position,
			originalMetadata: {
				track,
				directoryItem,
				returnedPosition,
				metadataStatus: read ? 'read' : 'unread',
			},
		})
	}
	if (Array.isArray(rawIds)) {
		const ids = rawIds.map((item) => record(item)),
			assigned = new Map<
				number,
				{ track: ImportMetadata; returnedPosition: number }
			>()
		const positions = new Map<string, number[]>()
		ids.forEach((item, index) => {
			const id = decimal(item.id)
			positions.set(id, [...(positions.get(id) ?? []), index])
		})
		tracks.forEach((track, index) => {
			const id = trackId(track, provider)
			if (id === null) fail('response', '网易云详情缺少可与原目录对账的曲目 ID')
			const position = positions.get(id)?.shift()
			if (position === undefined)
				fail('response', '网易云详情曲目不属于返回的原目录身份列表')
			assigned.set(position, { track, returnedPosition: index })
		})
		ids.forEach((item, position) => {
			const detail = assigned.get(position)
			add(
				position,
				decimal(item.id),
				detail?.track ?? null,
				item,
				detail?.returnedPosition ?? null,
			)
		})
	} else
		tracks.forEach((track, position) =>
			add(position, trackId(track, provider), track, null, position),
		)
	const knownIdentityCount = entries.filter(
		(entry) => entry.originalEntryId !== null,
	).length
	const complete =
		entries.length === expectedCount && readMetadataCount === expectedCount
	const identityListComplete =
		Array.isArray(rawIds) && rawIds.length === expectedCount
	const reconciliation = {
		expectedCount,
		returnedEntryCount: entries.length,
		directoryIdentityPositionCount: identityListComplete ? entries.length : 0,
		knownIdentityCount,
		readMetadataCount,
		returnedTrackCount: tracks.length,
		unreadMetadataCount: expectedCount - readMetadataCount,
	}
	const snapshot: ImportDirectorySnapshot = {
		taskId: input.taskId,
		taskVersion: input.taskVersion,
		...ref,
		originalMetadata: {
			playlist: without(
				playlist,
				provider === 'netease' ? ['tracks', 'trackIds'] : ['songlist'],
			),
			envelope: envelopeMetadata,
			directory: {
				status: complete ? 'complete' : 'incomplete',
				positionBasis: identityListComplete
					? 'directory-identities'
					: 'returned-order',
				...reconciliation,
			},
		},
		entries,
	}
	// Error evidence must satisfy the same storage budget as a successful directory.
	snapshotBudget(snapshot)
	if (!complete)
		throw new DirectoryReadError(
			'incomplete',
			'原歌单目录或曲目元数据未读完整，不能按完整目录导入',
			reconciliation,
			snapshot,
		)
	return snapshot
}

export async function readExternalDirectory(
	input: ExternalDirectoryInput,
	transport: ExternalDirectoryTransport,
): Promise<ImportDirectorySnapshot> {
	if (
		typeof input.taskId !== 'string' ||
		!input.taskId ||
		input.taskId.trim() !== input.taskId ||
		input.taskId.includes('\0') ||
		input.taskId.length > limits.idLength ||
		!Number.isSafeInteger(input.taskVersion) ||
		input.taskVersion < 1
	)
		fail('invalid-input', '导入任务身份或版本无效')
	const ref = parseExternalDirectoryUrl(input.url)
	if (input.signal?.aborted) fail('cancelled', '目录读取已取消')
	const controller = new AbortController()
	let timedOut = false
	const cancel = () => controller.abort()
	input.signal?.addEventListener('abort', cancel, { once: true })
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, externalDirectoryLimits.timeoutMs)
	let rejectAbort: (() => void) | undefined
	try {
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = () =>
				reject(
					new DirectoryReadError(
						timedOut ? 'timeout' : 'cancelled',
						timedOut ? '目录读取超时' : '目录读取已取消',
					),
				)
			controller.signal.addEventListener('abort', rejectAbort, { once: true })
		})
		const bytes = await Promise.race([
			transport(ref, controller.signal),
			aborted,
		])
		if (controller.signal.aborted)
			fail(timedOut ? 'timeout' : 'cancelled', '目录读取已终止')
		return decodeDirectory(input, ref, bytes)
	} catch (error) {
		if (input.signal?.aborted) fail('cancelled', '目录读取已取消')
		if (timedOut) fail('timeout', '目录读取超时')
		if (error instanceof DirectoryReadError) throw error
		throw new DirectoryReadError('network', '目录网络读取失败')
	} finally {
		clearTimeout(timer)
		input.signal?.removeEventListener('abort', cancel)
		if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
	}
}
