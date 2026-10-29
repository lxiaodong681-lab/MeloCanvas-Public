import { fetch } from 'expo/fetch'

import { getAccountAccess } from './account-access'
import { accountSession } from './account-runtime'
import { createAccountDirectoryFetch } from './account-directory-fetch'

import {
	createBilibiliFavoriteTransport,
	readBilibiliFavoritePage,
	type BilibiliFavoriteInput,
} from './bilibili-favorite'
import { createBilibiliFavoriteIndexTransport } from './bilibili-favorite-index'

export const mobileBilibiliFavoriteTransport = createBilibiliFavoriteTransport(
	createAccountDirectoryFetch(fetch, getAccountAccess, accountSession.subscribe),
)
export const mobileBilibiliFavoriteIndexTransport = createBilibiliFavoriteIndexTransport(
	createAccountDirectoryFetch(fetch, getAccountAccess, accountSession.subscribe),
)
export function readMobileBilibiliFavoritePage(input: BilibiliFavoriteInput) {
	return readBilibiliFavoritePage(input, mobileBilibiliFavoriteTransport)
}
