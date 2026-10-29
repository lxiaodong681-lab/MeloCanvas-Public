import { fetch } from 'expo/fetch'

import { getAccountAccess } from './account-access'
import { accountSession } from './account-runtime'
import { createAccountDirectoryFetch } from './account-directory-fetch'

import {
	readExternalDirectory,
	type ExternalDirectoryInput,
} from './external-directory'
import { createExternalDirectoryTransport } from './external-directory-transport'

const transport = createExternalDirectoryTransport(
	createAccountDirectoryFetch(fetch, getAccountAccess, accountSession.subscribe),
)

/** Explicit mobile entry: no UI, credentials, candidate search or local writes. */
export function readMobileExternalDirectory(input: ExternalDirectoryInput) {
	return readExternalDirectory(input, transport)
}
