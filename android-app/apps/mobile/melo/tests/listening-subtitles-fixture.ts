import type { AccountSnapshot } from '../account-session'
import {
	BilibiliSubtitleProvider,
	type SubtitleTarget,
} from '../bilibili-subtitles'
import { ListeningSubtitlesSession } from '../listening-subtitles-session'

export const subtitleTarget: SubtitleTarget = {
	bvid: 'BV1vT411i7ET',
	cid: 123,
	page: 1,
}
export const subtitleTracks = [
	{
		id_str: '101',
		lan: 'zh-CN',
		lan_doc: '中文',
		subtitle_url: 'https://aisubtitle.hdslb.com/bfs/subtitle/fixture-zh.json',
	},
	{
		id_str: '102',
		lan: 'en-US',
		lan_doc: 'English',
		subtitle_url: 'https://aisubtitle.hdslb.com/bfs/subtitle/fixture-en.json',
	},
]
export const subtitlePayload = {
	body: [
		{ from: 1, to: 2, content: '第一句字幕' },
		{ from: 4, to: 8, content: '第二句字幕' },
		{ from: 4, to: 6, content: '同时出现的字幕' },
	],
}
export const subtitleView = () => ({
	bvid: subtitleTarget.bvid,
	aid: 100,
	pages: [
		{ page: 1, cid: 123, duration: 100 },
		{ page: 2, cid: 456, duration: 100 },
	],
})
export const subtitleMetadata = (cid = 123) => ({
	aid: 100,
	cid,
	login_mid: 1,
	subtitle: { subtitles: subtitleTracks },
})
export function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
export async function settleSubtitles() {
	for (let i = 0; i < 24; i++) await Promise.resolve()
}
export function subtitleFixture() {
	let accountState: AccountSnapshot = {
		status: 'authenticated',
		generation: 1,
		account: { mid: '88', name: '合成账号' },
		error: null,
		reason: null,
	}
	const listeners = new Set<() => void>()
	const account = {
		getSnapshot: () => accountState,
		getGeneration: () => accountState.generation,
		subscribe: (listener: () => void) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}
	const api: {
		path: string
		params: Record<string, string>
		signal?: AbortSignal
	}[] = []
	const bodies: { url: string; signal?: AbortSignal }[] = []
	let metadata: (cid: number) => unknown = subtitleMetadata
	let body: (url: string) => unknown = () => subtitlePayload
	let failure: 'login-required' | 'restricted' | 'unavailable' = 'unavailable'
	const session = new ListeningSubtitlesSession(
		account,
		(getCurrentTarget) =>
			new BilibiliSubtitleProvider({
				getCurrentTarget,
				getSessionGeneration: account.getGeneration,
				requestAuthenticatedJson: async (path, params, signal) => {
					api.push({ path, params, signal })
					return path === '/x/web-interface/view'
						? subtitleView()
						: metadata(Number(params.cid))
				},
				classifyFailure: () => failure,
				requestSubtitleBody: async (url, signal) => {
					bodies.push({ url, signal })
					return { status: 200, url, body: JSON.stringify(await body(url)) }
				},
			}),
	)
	return {
		account,
		session,
		api,
		bodies,
		setMetadata: (read: typeof metadata) => {
			metadata = read
		},
		setBody: (read: typeof body) => {
			body = read
		},
		setFailure: (value: typeof failure) => {
			failure = value
		},
		setAccount: (
			status: AccountSnapshot['status'],
			nextGeneration = accountState.generation + 1,
		) => {
			accountState = { ...accountState, status, generation: nextGeneration }
			listeners.forEach((listener) => listener())
		},
		get accountListeners() {
			return listeners.size
		},
	}
}
