import { accountSession } from './account-runtime'
import { AccountSessionError } from './account-session'
import { request, signed } from './bilibili'
export const getSessionGeneration = accountSession.getGeneration
export async function requestAuthenticatedJson(
	path: string,
	params: Record<string, string>,
	signal?: AbortSignal,
): Promise<unknown> {
	if (accountSession.getSnapshot().status !== 'authenticated')
		throw new AccountSessionError('signed-out')
	if (!['/x/web-interface/view', '/x/player/wbi/v2'].includes(path))
		throw new AccountSessionError('invalid-response')
	const generation = getSessionGeneration()
	const query =
		path === '/x/player/wbi/v2'
			? await signed(params, signal)
			: new URLSearchParams(params).toString()
	if (generation !== getSessionGeneration())
		throw new AccountSessionError('stale-session')
	const result = await request<unknown>(`${path}?${query}`, signal)
	if (generation !== getSessionGeneration())
		throw new AccountSessionError('stale-session')
	return result
}
