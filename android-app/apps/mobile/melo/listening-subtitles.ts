import { Orpheus } from '@bbplayer/orpheus'

import { accountSession } from './account-runtime'
import { AccountSessionError } from './account-session'
import { request, signed } from './bilibili'
import { BilibiliRequestRestrictedError } from './bilibili-request-error'
import { BilibiliSubtitleProvider } from './bilibili-subtitles'
import { ListeningSubtitlesSession } from './listening-subtitles-session'

/** Reuses the configured account API transport, WBI signer and isolated native CDN reader.
 * The CDN bridge accepts only the URL; account headers never enter this call.
 */
export function createListeningSubtitlesSession(): ListeningSubtitlesSession {
	return new ListeningSubtitlesSession(
		accountSession,
		(getCurrentTarget) =>
			new BilibiliSubtitleProvider({
				getCurrentTarget,
				getSessionGeneration: accountSession.getGeneration,
				async requestAuthenticatedJson(path, params, signal) {
					const query =
						path === '/x/player/wbi/v2'
							? await signed(params, signal)
							: new URLSearchParams(params).toString()
					return request(`${path}?${query}`, signal)
				},
				classifyFailure(error) {
					if (
						accountSession.getSnapshot().status !== 'authenticated' ||
						(error instanceof AccountSessionError &&
							['signed-out', 'expired', 'stale-session'].includes(error.code))
					)
						return 'login-required'
					if (
						error instanceof BilibiliRequestRestrictedError ||
						(error instanceof Error &&
							/B 站返回 -403(?:，|$)|HTTP 403/.test(error.message))
					)
						return 'restricted'
					return 'unavailable'
				},
				async requestSubtitleBody(url) {
					// Native bounds the read to 15s; the provider rejects an aborted/stale reply.
					return Orpheus.bilibiliSubtitleRequest(url)
				},
			}),
	)
}
