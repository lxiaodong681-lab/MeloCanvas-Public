import { fetch } from 'expo/fetch'

import { getAccountAccess } from './account-access'
import { accountSession } from './account-runtime'
import { createAccountDirectoryFetch } from './account-directory-fetch'

import {
	createBilibiliFavoriteFoldersTransport,
	readBilibiliFavoriteFolders,
	type BilibiliFavoriteFoldersInput,
} from './bilibili-favorite-folders'

/** Raw body lifetime for callers that own a real-settlement admission gate. */
export const mobileBilibiliFavoriteFoldersTransport =
	createBilibiliFavoriteFoldersTransport(
		createAccountDirectoryFetch(fetch, getAccountAccess, accountSession.subscribe),
	)

/** Single read convenience only; does not serialize concurrent callers. */
export function readMobileBilibiliFavoriteFolders(
	input: BilibiliFavoriteFoldersInput,
) {
	return readBilibiliFavoriteFolders(
		input,
		mobileBilibiliFavoriteFoldersTransport,
	)
}
