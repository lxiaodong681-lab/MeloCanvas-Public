import { eapi } from '../src/lib/api/netease/crypto'
import { readAdditionalDirectory } from './additional-directories'

import { readDirectoryHttp, type DirectoryFetch } from './directory-http'
import {
	DirectoryReadError,
	type ExternalDirectoryReference,
	type ExternalDirectoryTransport,
} from './external-directory'
export type { DirectoryFetch, DirectoryHttpResponse } from './directory-http'

/** Reuses the existing platform endpoint/payload contract, without its unbounded body reader. */
export function externalDirectoryRequest(ref: ExternalDirectoryReference): {
	url: string
	method: 'GET' | 'POST'
	headers: Record<string, string>
	body?: string
} {
	if (
		!['netease', 'qq'].includes(ref.provider) ||
		!/^[1-9][0-9]{0,127}$/.test(ref.originalPlaylistId)
	)
		throw new DirectoryReadError('invalid-input', '平台歌单身份无效')
	if (ref.provider === 'netease') {
		const encoded = eapi('/api/v6/playlist/detail', {
			s: '0',
			id: ref.originalPlaylistId,
			n: '1000',
			t: '0',
			header: {
				osver: '',
				deviceId: '',
				os: 'iphone',
				appver: '9.0.90',
				__csrf: '',
			},
			// Existing request.ts supports e_r=false; do not buffer/decrypt an unbounded binary reply.
			e_r: false,
		})
		return {
			url: 'https://interface3.music.163.com/eapi/v6/playlist/detail',
			method: 'POST' as const,
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Referer: 'https://music.163.com',
				'User-Agent': 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)',
			},
			body: new URLSearchParams(encoded).toString(),
		}
	}
	const params = new URLSearchParams({
		id: ref.originalPlaylistId,
		format: 'json',
		newsong: '1',
		platform: 'jqspaframe.json',
	})
	return {
		url: `https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg?${params.toString()}`,
		method: 'GET' as const,
		headers: {
			Referer: 'http://y.qq.com',
			'User-Agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0',
		},
	}
}

export function createExternalDirectoryTransport(
	fetcher: DirectoryFetch,
): ExternalDirectoryTransport {
	return async (ref, signal) => {
		if (signal.aborted)
			throw new DirectoryReadError('cancelled', '目录读取已取消')
		if (['kuwo','kugou','qishui'].includes(ref.provider)) return readAdditionalDirectory(ref, fetcher, signal)
		return readDirectoryHttp(fetcher, externalDirectoryRequest(ref), signal)
	}
}
