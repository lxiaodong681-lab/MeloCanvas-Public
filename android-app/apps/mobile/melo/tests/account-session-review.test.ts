import assert from 'node:assert/strict'
import test from 'node:test'

import { AccountSession } from '../account-session'

void test('a superseded login waiting for native pause cannot delete a newer saved account', async () => {
	let release!: () => void
	const oldPause = new Promise<void>((resolve) => {
		release = resolve
	})
	let pauses = 0
	let stored: string | null = null
	let native = ''
	const session = new AccountSession({
		read: async () => stored,
		write: async (value) => {
			stored = value
		},
		remove: async () => {
			stored = null
		},
		verify: async (cookie) => ({
			mid: cookie === 'new-account' ? '2' : '1',
			name: 'synthetic',
		}),
		setNativeCookie: (cookie) => {
			native = cookie
		},
		setOfflineAccess: () => {},
		pause: () => (++pauses === 2 ? oldPause : Promise.resolve()),
		fetch: async () => new Response('{}'),
	})
	const oldLogin = session.login('old-account')
	await new Promise((resolve) => setImmediate(resolve))
	await session.login('new-account')
	assert.equal(stored, 'new-account')
	release()
	await assert.rejects(oldLogin, /变更/)
	assert.equal(native, 'new-account')
	assert.equal(session.getSnapshot().account?.mid, '2')
	assert.equal(
		stored,
		'new-account',
		'the current credential must survive the stale login continuation',
	)
})
