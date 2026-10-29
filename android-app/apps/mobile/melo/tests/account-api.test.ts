import assert from 'node:assert/strict'
import test from 'node:test'

import {
	accountDiagnosticCode,
	diagnosticPublicHostname,
	syntheticHostnameMatches,
	configureAccountNetwork,
	normalizeLoginCookies,
	generateLoginQr,
	pollLoginQr,
	verifyAccount,
} from '../account-api'
const signal = () => new AbortController().signal
const envelope = (data: unknown, headers?: HeadersInit) =>
	new Response(JSON.stringify({ code: 0, data }), { headers })

void test('QR validation emits only fixed branch codes without exposing synthetic inputs', async () => {
	const valid = {
		qrcode_key: 'synthetickey',
		url: 'https://passport.bilibili.com/scan?key=synthetic-only',
	}
	const cases: [Record<string, unknown>, string][] = [
		[{ ...valid, qrcode_key: 123 }, 'generate-key-type'],
		[{ ...valid, qrcode_key: 'bad!' }, 'generate-key-format'],
		[{ ...valid, qrcode_key: 'x'.repeat(257) }, 'generate-key-format'],
		[{ ...valid, url: null }, 'generate-url-type'],
		[{ ...valid, url: 'not-a-url' }, 'generate-url-parse'],
		[{ ...valid, url: 'http://passport.bilibili.com/scan' }, 'generate-url-protocol'],
		[{ ...valid, url: 'https://evil.test/scan' }, 'generate-url-host'],
		[{ ...valid, url: 'https://synthetic-user@passport.bilibili.com/scan' }, 'generate-url-credentials'],
		[{ ...valid, url: 'https://:synthetic-password@passport.bilibili.com/scan' }, 'generate-url-credentials'],
	]
	for (const [data, expected] of cases) {
		configureAccountNetwork(async () => envelope(data))
		await assert.rejects(generateLoginQr(signal()), (error: unknown) => {
			assert.equal(accountDiagnosticCode(error).split('/host=')[0], expected)
			assert.ok(error instanceof Error)
			assert.ok(!error.message.includes('synthetic'))
			assert.ok(!('cause' in error))
			return true
		})
	}
	configureAccountNetwork(async () => envelope(valid))
	assert.deepEqual(await generateLoginQr(signal()), {
		key: valid.qrcode_key,
		url: valid.url,
	})
})
void test('public hostname diagnostics reject URL components and mask token-like labels', () => {
	for (const host of ['passport.bilibili.com', 'login.example.com', 'Passport.Bilibili.com'])
		assert.equal(diagnosticPublicHostname(host), host)
	for (const value of [null, '', 'https://passport.bilibili.com/path?key=synthetic', 'user@passport.bilibili.com', 'passport.bilibili.com:443', 'a..com', '中文.example.com', 'a'.repeat(254)])
		assert.equal(diagnosticPublicHostname(value), 'domain-invalid')
	for (const host of ['0123456789abcdef.example.com', 'abc123xyz987.example.com', 'abcdefghijklmnop.example.com', '12345678.example.com'])
		assert.equal(diagnosticPublicHostname(host), 'domain-masked')
	assert.equal(syntheticHostnameMatches(), true)
})
void test('cookie parser strips attributes and unrelated/foreign cookies without decoding secrets', () => {
	assert.equal(
		normalizeLoginCookies(
			'SESSDATA=synthetic%2Fvalue; Domain=.bilibili.com; HttpOnly; Secure, bili_jct=csrf; Domain=.bilibili.com, DedeUserID=123; Expires=Wed, 21 Oct 2026 07:28:00 GMT, other=drop',
		),
		'SESSDATA=synthetic%2Fvalue; bili_jct=csrf; DedeUserID=123',
	)
	assert.throws(() =>
		normalizeLoginCookies(
			'SESSDATA=bad; Domain=evil.test, bili_jct=x, DedeUserID=1',
		),
	)
	assert.throws(() =>
		normalizeLoginCookies('SESSDATA=two words, bili_jct=x, DedeUserID=1'),
	)
})
void test('QR generation accepts only expected passport HTTPS QR and validates key', async () => {
	configureAccountNetwork(async () =>
		envelope({
			qrcode_key: 'synthetickey',
			url: 'https://passport.bilibili.com/h5-app/passport/login/scan?key=synthetic',
		}),
	)
	assert.equal((await generateLoginQr(signal())).key, 'synthetickey')
	for (const url of [
		'https://evil.test/scan',
		'http://passport.bilibili.com/scan',
		'https://user:secret@passport.bilibili.com/scan',
		'https://evilaccount.bilibili.com/scan',
		'https://account.bilibili.com.evil.test/scan',
		'https://account.bilibili.com@evil.test/scan',
		'http://account.bilibili.com/scan',
		'https://user:secret@account.bilibili.com/scan',
	]) {
		configureAccountNetwork(async () =>
			envelope({ qrcode_key: 'synthetickey', url }),
		)
		await assert.rejects(generateLoginQr(signal()), /无法验证/)
	}
	configureAccountNetwork(async () =>
		envelope({
			qrcode_key: 'synthetickey',
			url: 'https://account.bilibili.com/scan?key=synthetic',
		}),
	)
	assert.deepEqual(await generateLoginQr(signal()), {
		key: 'synthetickey',
		url: 'https://account.bilibili.com/scan?key=synthetic',
	})
})
void test('poll states do not report login before server success and verified account', async () => {
	for (const [code, status] of [
		[86101, 'waiting'],
		[86090, 'scanned'],
		[86038, 'expired'],
	] as const) {
		configureAccountNetwork(async () => envelope({ code }))
		assert.deepEqual(await pollLoginQr('synthetickey', signal()), { status })
	}
	configureAccountNetwork(async () => envelope({ code: 0 }))
	await assert.rejects(pollLoginQr('synthetickey', signal()), /无法验证/)
})
void test('identity verification uses only fixed API and rejects guest, malformed id, expired response', async () => {
	configureAccountNetwork(async (url, init) => {
		assert.equal(url, 'https://api.bilibili.com/x/web-interface/nav')
		assert.equal(new Headers(init.headers).get('Cookie'), 'synthetic')
		return envelope({ isLogin: true, mid: 123, uname: '测试' })
	})
	assert.deepEqual(await verifyAccount('synthetic', signal()), {
		mid: '123',
		name: '测试',
	})
	configureAccountNetwork(async () => envelope({ isLogin: false }))
	await assert.rejects(verifyAccount('synthetic', signal()), /失效/)
	configureAccountNetwork(async () =>
		envelope({ isLogin: true, mid: 0, uname: '测试' }),
	)
	await assert.rejects(verifyAccount('synthetic', signal()), /无法验证/)
	configureAccountNetwork(
		async () => new Response(JSON.stringify({ code: -101 })),
	)
	await assert.rejects(verifyAccount('synthetic', signal()), /失效/)
})
void test('network exception details containing credentials are never surfaced', async () => {
	configureAccountNetwork(async () => {
		throw new Error('SESSDATA=do-not-surface')
	})
	await assert.rejects(
		generateLoginQr(signal()),
		(error: unknown) =>
			error instanceof Error &&
			!error.message.includes('SESSDATA') &&
			!('cause' in error),
	)
})
void test('only explicit unauthorized nav is expired; transient and restriction HTTP do not revoke', async () => {
	configureAccountNetwork(async () => new Response('', { status: 401 }))
	await assert.rejects(
		verifyAccount('synthetic', signal()),
		(error: unknown) =>
			error instanceof Error && 'code' in error && error.code === 'expired',
	)
	for (const status of [403, 412, 429, 500]) {
		configureAccountNetwork(async () => new Response('', { status }))
		await assert.rejects(
			verifyAccount('synthetic', signal()),
			(error: unknown) =>
				error instanceof Error && 'code' in error && error.code === 'network',
		)
	}
})
void test('missing or malformed login status is not evidence of expired account', async () => {
	for (const data of [
		{},
		{ isLogin: 'false' },
		{ isLogin: true, mid: 'not-number', uname: '合成' },
	]) {
		configureAccountNetwork(async () => envelope(data))
		await assert.rejects(
			verifyAccount('synthetic', signal()),
			(error: unknown) =>
				error instanceof Error &&
				'code' in error &&
				error.code === 'invalid-response',
		)
	}
})
void test('QR diagnostics expose only fixed stages, never transport or body details', async () => {
	const { AccountDiagnosticError } =
		await import('../account-api')
	for (const [transport, expected] of [
		[
			async () => {
				throw new AccountDiagnosticError('bridge-unavailable')
			},
			'generate-transport/bridge-unavailable',
		],
		[
			async () => {
				throw new Error('PRIVATE-URL-COOKIE')
			},
			'generate-transport',
		],
		[async () => new Response('PRIVATE-BODY'), 'generate-json'],
		[
			async () =>
				envelope({
					qrcode_key: 'synthetickey',
					url: 'https://private.invalid/secret',
				}),
			'generate-url-host/host=private.invalid/synthetic=true',
		],
	] as const) {
		configureAccountNetwork(transport)
		await assert.rejects(generateLoginQr(signal()), (error) => {
			assert.equal(accountDiagnosticCode(error), expected)
			assert.ok(!String(error).includes('PRIVATE'))
			return true
		})
	}
})

void test('verified Bilibili avatar is public HTTPS metadata, invalid avatars do not block login', async () => {
 for (const [face, expected] of [['http://i0.hdslb.com/bfs/face/a.jpg', 'https://i0.hdslb.com/bfs/face/a.jpg'], ['https://evil.test/avatar.jpg', undefined], ['broken', undefined]]) {
  configureAccountNetwork(async () => envelope({ isLogin: true, mid: 123, uname: '用户', face }))
  const account = await verifyAccount('synthetic-cookie', signal())
  assert.equal(account.avatar, expected)
  assert.equal(account.mid, '123')
 }
})
