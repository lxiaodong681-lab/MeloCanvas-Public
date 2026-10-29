import { kugouApi } from '../src/lib/api/kugou/api'
import { neteaseApi } from '../src/lib/api/netease/api'
import { qqMusicApi } from '../src/lib/api/qqmusic/api'

import {
	createOnlineLyricsService,
	OnlineLyricError,
	type OnlineLyricProvider,
} from './online-lyrics'

/** Reuse BBPlayer providers; no Bilibili store, account token or native player here.
 * Existing react-native-nitro-fetch/Nitro Modules must be linked in the native build.
 * Network availability is not implied by offline fixture coverage.
 */
export const onlineLyricProviders: readonly OnlineLyricProvider[] = [
	{
		source: 'netease',
		async search(keyword, limit, signal) {
			const result = await neteaseApi.search(
				{ keywords: keyword, limit },
				signal,
			)
			if (result.isErr()) throw new OnlineLyricError('unavailable')
			return result.value
		},
		async load(candidate, signal) {
			if (typeof candidate.remoteId !== 'number')
				throw new OnlineLyricError('invalid')
			const result = await neteaseApi.getLyrics(candidate.remoteId, signal)
			if (result.isErr()) throw new OnlineLyricError('unavailable')
			return neteaseApi.parseLyrics(result.value)
		},
	},
	{
		source: 'qqmusic',
		async search(keyword, limit, signal) {
			const result = await qqMusicApi.search(keyword, limit, signal)
			if (result.isErr()) throw new OnlineLyricError('unavailable')
			return result.value
		},
		async load(candidate, signal) {
			if (typeof candidate.remoteId !== 'string')
				throw new OnlineLyricError('invalid')
			const result = await qqMusicApi.getLyrics(candidate.remoteId, signal)
			if (result.isErr()) throw new OnlineLyricError('unavailable')
			return qqMusicApi.parseLyrics(result.value)
		},
	},
	{
		source: 'kugou',
		async search(keyword, limit, signal) {
			const result = await kugouApi.search(keyword, limit, signal)
			if (result.isErr()) throw new OnlineLyricError('unavailable')
			return result.value
		},
		async load(candidate, signal) {
			if (typeof candidate.remoteId !== 'string')
				throw new OnlineLyricError('invalid')
			const result = await kugouApi.getLyrics(candidate.remoteId, signal)
			if (result.isErr()) throw new OnlineLyricError('unavailable')
			return kugouApi.parseLyrics(result.value)
		},
	},
]
export const onlineLyricsService =
	createOnlineLyricsService(onlineLyricProviders)
