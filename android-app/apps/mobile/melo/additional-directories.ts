import type { ImportMetadata } from './core/import-types'
// Endpoint/field adaptation from PlaylistOut (MIT), a90e1a7f0a32f020c1e03829570673f993669c63.
// Copyright (c) 2026 LengxiQwQ. See licenses/playlistout-MIT.txt.
// MeloCanvas adds bounded reads, strict identity/count reconciliation and no credential handling.
import {
	readDirectoryHttp,
	type DirectoryFetch,
	type DirectoryHttpRequest,
} from './directory-http'
import {
	DirectoryReadError,
	externalDirectoryLimits,
	type ExternalDirectoryReference,
} from './external-directory'

type RecordValue = Record<string, unknown>
const object = (value: unknown): RecordValue => {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new DirectoryReadError('response', '平台目录对象缺失')
	return value as RecordValue
}
const decimal = (value: unknown): string => {
	if (typeof value === 'string' && /^[1-9][0-9]{0,127}$/.test(value))
		return value
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
		return String(value)
	throw new DirectoryReadError('response', '平台目录身份无效')
}
const count = (value: unknown): number => {
	const result =
		typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
	if (
		typeof result !== 'number' ||
		!Number.isSafeInteger(result) ||
		result < 0 ||
		result > 5000
	)
		throw new DirectoryReadError('limit', '平台原曲数无效或超过 5000 项')
	return result
}
const title = (value: unknown): string => {
	if (typeof value !== 'string' || !value.trim())
		throw new DirectoryReadError('response', '平台目录名称缺失')
	return value
}
const array = (value: unknown): unknown[] => {
	if (!Array.isArray(value))
		throw new DirectoryReadError('response', '平台未返回曲目列表')
	return value
}
const mobileAgent =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Version/16.6 Mobile/15E148 Safari/604.1'

export async function readAdditionalDirectory(
	ref: ExternalDirectoryReference,
	fetcher: DirectoryFetch,
	signal: AbortSignal,
): Promise<Uint8Array> {
	let bytesRead = 0
	const read = async (request: DirectoryHttpRequest) => {
		const bytes = await readDirectoryHttp(fetcher, request, signal)
		bytesRead += bytes.length
		if (bytesRead > externalDirectoryLimits.responseBytes)
			throw new DirectoryReadError('limit', '歌单分页累计响应超过 8MiB')
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	}
	const id = ref.originalPlaylistId,
		songs: ImportMetadata[] = [],
		fingerprints = new Set<string>()
	let name = '',
		total = -1,
		cursor = '0'
	const pageCursors = new Set<string>()
	for (let page = 1; page <= 50; page++) {
		if (signal.aborted)
			throw new DirectoryReadError('cancelled', '目录读取已取消')
		let raw: unknown[],
			next: string | null = null
		if (ref.provider === 'kuwo') {
			decimal(id)
			const data = object(
				JSON.parse(
					await read({
						url: `https://m.kuwo.cn/newh5app/wapi/api/www/playlist/playListInfo?pid=${id}&pn=${page}&rn=100`,
						method: 'GET',
						headers: {
							'User-Agent': mobileAgent,
							Referer: `https://m.kuwo.cn/newh5app/playlist_detail/${id}`,
						},
					}),
				),
			)
			if (data.code !== 200)
				throw new DirectoryReadError('platform', '酷我未允许读取此歌单')
			const list = object(data.data)
			if (decimal(list.id) !== id)
				throw new DirectoryReadError('response', '酷我返回了不同歌单')
			if (total !== -1 && count(list.total) !== total)
				throw new DirectoryReadError(
					'incomplete',
					'读取期间歌单曲数发生变化，请重试',
				)
			total = count(list.total)
			name = title(list.name)
			raw = array(list.musicList)
			if (songs.length + raw.length < total) next = String(page + 1)
			for (const value of raw) {
				const song = object(value)
				songs.push({
					id: decimal(song.rid),
					name: title(song.name),
					singer: [
						{ name: typeof song.artist === 'string' ? song.artist : '' },
					],
					album: { name: typeof song.album === 'string' ? song.album : '' },
					interval: typeof song.duration === 'number' ? song.duration : null,
				})
			}
		} else if (ref.provider === 'qishui') {
			decimal(id)
			const data = object(
				JSON.parse(
					await read({
						url: 'https://beta-luna.douyin.com/luna/playlist/detail',
						method: 'POST',
						headers: {
							'User-Agent': 'Luna/19.1.0 Android',
							'Content-Type': 'application/json; charset=utf-8',
						},
						body: JSON.stringify({ playlist_id: id, cursor, count: 200 }),
					}),
				),
			)
			const list = object(data.playlist)
			if (decimal(list.id) !== id)
				throw new DirectoryReadError('response', '汽水返回了不同歌单')
			if (total !== -1 && count(list.count_tracks) !== total)
				throw new DirectoryReadError(
					'incomplete',
					'读取期间歌单曲数发生变化，请重试',
				)
			total = count(list.count_tracks)
			name = title(list.title)
			raw = array(data.media_resources)
			// The public endpoint omits protobuf false on its final page. Accept that
			// only when the returned song count independently proves completion.
			if (
				typeof data.has_more !== 'boolean' &&
				!(data.has_more === undefined && songs.length + raw.length === total)
			)
				throw new DirectoryReadError('response', '汽水分页结束标记缺失')
			if (data.has_more) next = decimal(data.next_cursor)
			for (const value of raw) {
				const media = object(value)
				if (media.type !== 'track')
					throw new DirectoryReadError(
						'incomplete',
						'该汽水目录包含非歌曲内容，暂不能作为完整音乐歌单导入',
					)
				const song = object(object(object(media.entity).track_wrapper).track)
				songs.push({
					id: decimal(song.id),
					name: title(song.name),
					singer: array(song.artists).map((artist) => ({
						name: title(object(artist).name),
					})),
					album: { name: title(object(song.album).name) },
					interval:
						typeof song.duration === 'number' ? song.duration / 1000 : null,
				})
			}
		} else if (ref.provider === 'kugou') {
			if (!/^gcid_[A-Za-z0-9]{1,100}$/.test(id))
				throw new DirectoryReadError(
					'invalid-link',
					'目前支持酷狗 songlist/gcid_… 完整分享链接',
				)
			const html = await read({
				url: `https://m.kugou.com/songlist/${id}/`,
				method: 'GET',
				headers: { 'User-Agent': mobileAgent },
			})
			const payload = html.match(/window\.\$output\s*=\s*(\{.+?\});/s)?.[1]
			if (!payload)
				throw new DirectoryReadError('response', '酷狗分享页没有可读取的目录')
			const data = object(JSON.parse(payload)),
				info = object(data.info),
				list = object(info.listinfo)
			if (data.encode_gic !== id)
				throw new DirectoryReadError('response', '酷狗返回了不同歌单')
			total = count(list.count)
			name = title(list.name)
			raw = array(info.songs)
			for (const value of raw) {
				const song = object(value),
					artists = array(song.singerinfo).map((artist) => ({
						name: title(object(artist).name),
					}))
				const originalName = title(song.name),
					prefix = artists.map((artist) => artist.name).join('、') + ' - '
				songs.push({
					id: decimal(song.mixsongid),
					name: originalName.startsWith(prefix)
						? originalName.slice(prefix.length)
						: originalName,
					singer: artists,
					album: { name: title(object(song.albuminfo).name) },
					interval:
						typeof song.timelen === 'number' ? song.timelen / 1000 : null,
				})
			}
		} else throw new DirectoryReadError('invalid-input', '未知歌单来源')
		const fingerprint = JSON.stringify(
			raw.map((value) => {
				const item = object(value)
				return item.id ?? item.rid ?? item.mixsongid
			}),
		)
		if (
			fingerprints.has(fingerprint) ||
			(next !== null && (next === cursor || pageCursors.has(next)))
		)
			throw new DirectoryReadError(
				'incomplete',
				'平台重复返回相同分页，目录未读完整',
			)
		fingerprints.add(fingerprint)
		if (songs.length > 5000 || songs.length > total)
			throw new DirectoryReadError('response', '曲目数与平台原曲数矛盾')
		if (next === null) break
		if (!raw.length || page === 50)
			throw new DirectoryReadError('incomplete', '平台分页未结束，目录未读完整')
		pageCursors.add(next)
		cursor = next
	}
	// Shared decoder keeps occurrence order and marks count/metadata mismatches as incomplete evidence.
	return new TextEncoder().encode(
		JSON.stringify({
			code: 0,
			data: {
				cdlist: [
					{
						disstid: id,
						dissname: name,
						songnum: total,
						songlist: songs,
						directoryScope:
							ref.provider === 'qishui'
								? 'qishui-tracks-only'
								: 'public-playlist',
					},
				],
			},
		}),
	)
}
