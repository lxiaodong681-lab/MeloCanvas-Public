import assert from 'node:assert/strict'
import test from 'node:test'

import {
	AccountSession,
	AccountSessionError,
	type AccountDependencies,
} from '../account-session'
const identity = { mid: '123', name: '合成测试账号' }
function fixture(overrides: Partial<AccountDependencies> = {}) {
	let stored: string | null = null
	let native = ''
	let offline = false
	let paused = 0
	const calls: RequestInit[] = []
	const session = new AccountSession({
		read: async () => stored,
		write: async (value) => {
			stored = value
		},
		remove: async () => {
			stored = null
		},
		verify: async () => identity,
		setNativeCookie: (value) => {
			native = value
		},
		setOfflineAccess: (enabled) => {
			offline = enabled
		},
		pause: async () => {
			paused++
		},
		fetch: async (_, init) => {
			calls.push(init)
			return new Response('{}')
		},
		...overrides,
	})
	return {
		session,
		calls,
		stored: () => stored,
		native: () => native,
		offline: () => offline,
		paused: () => paused,
	}
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
void test('empty restore stays signed out and disables native playback', async () => {
	const f = fixture()
	await f.session.restore()
	assert.equal(f.session.getSnapshot().status, 'signed-out')
	assert.equal(f.native(), '')
	assert.ok(f.paused() >= 1)
})
void test('verified login stores only through secure boundary and exposes no secret in snapshot', async () => {
	const f = fixture()
	await f.session.login('synthetic-only')
	assert.equal(f.stored(), 'synthetic-only')
	assert.equal(f.native(), 'synthetic-only')
	assert.deepEqual(f.session.getSnapshot().account, identity)
	assert.ok(!JSON.stringify(f.session.getSnapshot()).includes('synthetic-only'))
})
void test('failed identity cannot open gate or save credential', async () => {
	const f = fixture({
		verify: async () => {
			throw new AccountSessionError('expired')
		},
	})
	await assert.rejects(f.session.login('synthetic'), /失效/)
	assert.notEqual(f.session.getSnapshot().status, 'authenticated')
	assert.equal(f.native(), '')
	assert.equal(f.stored(), null)
})
void test('secure storage failure keeps native and app closed', async () => {
	const f = fixture({
		write: async () => {
			throw new Error('sensitive synthetic body')
		},
	})
	await assert.rejects(f.session.login('synthetic'), /安全/)
	assert.equal(f.native(), '')
	assert.equal(f.session.getSnapshot().status, 'error')
	assert.ok(!JSON.stringify(f.session.getSnapshot()).includes('sensitive'))
})
void test('sign out cancels verification completion and clears saved/native state', async () => {
	const check = deferred<typeof identity>()
	const f = fixture({ verify: () => check.promise })
	const login = f.session.login('synthetic')
	await new Promise((resolve) => setImmediate(resolve))
	await f.session.signOut()
	check.resolve(identity)
	await assert.rejects(login, /变更/)
	assert.equal(f.native(), '')
	assert.equal(f.stored(), null)
	assert.equal(f.session.getSnapshot().status, 'signed-out')
})
void test('generation prevents old response after account changes', async () => {
	const pending = deferred<Response>()
	const f = fixture({ fetch: () => pending.promise })
	await f.session.login('one')
	const req = f.session.authorizedFetch(
		'https://api.bilibili.com/x/web-interface/view',
	)
	await f.session.signOut()
	pending.resolve(new Response('{}'))
	await assert.rejects(req, /变更/)
})
void test('cookie never sent to foreign origin, CDN, http, or URL credentials', async () => {
	const f = fixture()
	await f.session.login('synthetic')
	for (const url of [
		'https://api.bilibili.com.evil.test/a',
		'https://aisubtitle.hdslb.com/a',
		'http://api.bilibili.com/a',
		'https://user:pw@api.bilibili.com/a',
	])
		await assert.rejects(f.session.authorizedFetch(url))
	assert.equal(f.calls.length, 0)
})
void test('authenticated request disables ambient cookies and redirects, uses private credential', async () => {
	const f = fixture()
	await f.session.login('synthetic')
	await f.session.authorizedFetch(
		'https://api.bilibili.com/x/web-interface/nav',
		{ headers: { Cookie: 'should-not-use' } },
	)
	assert.equal(new Headers(f.calls[0].headers).get('Cookie'), 'synthetic')
	assert.equal(f.calls[0].redirect, 'error')
	assert.equal(f.calls[0].credentials, 'omit')
})
void test('signed out request cannot hit network', async () => {
	const f = fixture()
	await f.session.restore()
	await assert.rejects(
		f.session.authorizedFetch('https://api.bilibili.com/x/a'),
		/登录/,
	)
	assert.equal(f.calls.length, 0)
})
void test('storage clearing failure remains visibly blocked', async () => {
	const f = fixture({
		remove: async () => {
			throw new Error('failure')
		},
	})
	await assert.rejects(f.session.signOut())
	assert.equal(f.native(), '')
	assert.equal(f.session.getSnapshot().status, 'error')
})
void test('restore validates stored identity before native activation', async () => {
	const check = deferred<typeof identity>()
	const f = fixture({
		read: async () => 'stored synthetic',
		verify: () => check.promise,
	})
	const restore = f.session.restore()
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(f.native(), '')
	assert.equal(f.session.getSnapshot().status, 'checking')
	check.resolve(identity)
	await restore
	assert.equal(f.native(), 'stored synthetic')
})
void test('expired restored credential is removed rather than used as guest', async () => {
	let cleared = false
	const f = fixture({
		read: async () => 'synthetic',
		remove: async () => {
			cleared = true
		},
		verify: async () => {
			throw new AccountSessionError('expired')
		},
	})
	await f.session.restore()
	assert.equal(cleared, true)
	assert.equal(f.session.getSnapshot().status, 'signed-out')
	assert.equal(f.native(), '')
})
void test('UI cancellation during verification cannot activate login later', async () => {
	const check = deferred<typeof identity>()
	const f = fixture({ verify: () => check.promise })
	const controller = new AbortController()
	const login = f.session.login('synthetic', controller.signal)
	await new Promise((resolve) => setImmediate(resolve))
	controller.abort()
	check.resolve(identity)
	await assert.rejects(login, /变更/)
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(f.native(), '')
	assert.equal(f.stored(), null)
	assert.equal(f.session.getSnapshot().status, 'signed-out')
})
void test('UI cancellation during secure write removes the late saved credential', async () => {
	const writing = deferred<void>()
	let saved: string | null = null
	const f = fixture({
		write: async (value) => {
			await writing.promise
			saved = value
		},
		remove: async () => {
			saved = null
		},
	})
	const controller = new AbortController()
	const login = f.session.login('synthetic', controller.signal)
	await new Promise((resolve) => setImmediate(resolve))
	controller.abort()
	writing.resolve()
	await assert.rejects(login, /变更/)
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(saved, null)
	assert.equal(f.native(), '')
})
void test('read-only account boundary rejects writes before network', async () => {
	const f = fixture()
	await f.session.login('synthetic')
	await assert.rejects(
		f.session.authorizedFetch('https://api.bilibili.com/x/a', {
			method: 'POST',
			body: 'x',
		}),
	)
	assert.equal(f.calls.length, 0)
})
void test('previously saved account with transient verification failure grants only offline access', async () => {
	const f = fixture({
		read: async () => 'previously verified synthetic',
		verify: async () => {
			throw new AccountSessionError('network')
		},
	})
	await f.session.restore()
	assert.equal(f.session.getSnapshot().status, 'offline')
	assert.equal(f.session.getSnapshot().reason, 'network')
	assert.equal(f.offline(), true)
	assert.equal(f.native(), '')
	await assert.rejects(
		f.session.authorizedFetch('https://api.bilibili.com/x/a'),
		/登录/,
	)
	await f.session.signOut()
	assert.equal(f.offline(), false)
})
void test('first login network failure does not grant offline or save unverified credential', async () => {
	const f = fixture({
		verify: async () => {
			throw new AccountSessionError('network')
		},
	})
	await assert.rejects(f.session.login('synthetic'))
	assert.equal(f.offline(), false)
	assert.equal(f.stored(), null)
	assert.equal(f.native(), '')
})
void test('storage deletion still runs if pausing fails', async () => {
	let cleared = false
	const f = fixture({
		pause: async () => {
			throw new Error('pause failed')
		},
		remove: async () => {
			cleared = true
		},
	})
	await assert.rejects(f.session.signOut())
	assert.equal(cleared, true)
	assert.equal(f.native(), '')
})
void test('unrecognized verification response preserves saved state without authenticating or granting offline', async () => {
	let removed = false
	const f = fixture({
		read: async () => 'previously verified synthetic',
		remove: async () => {
			removed = true
		},
		verify: async () => {
			throw new AccountSessionError('invalid-response')
		},
	})
	await f.session.restore()
	assert.equal(removed, false)
	assert.equal(f.session.getSnapshot().status, 'error')
	assert.equal(f.session.getSnapshot().reason, 'invalid-response')
	assert.equal(f.offline(), false)
	assert.equal(f.native(), '')
})
