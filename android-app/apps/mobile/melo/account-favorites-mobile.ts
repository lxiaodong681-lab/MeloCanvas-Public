import { createAccountFavorites } from './account-favorites'
import { accountSession } from './account-runtime'

export const mobileAccountFavorites = createAccountFavorites(accountSession)
