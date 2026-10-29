import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import * as api from '../account-api'
import * as session from '../account-session'
const source = ts.transpileModule(
	readFileSync(new URL('../account-native-fetch.ts', import.meta.url), 'utf8'),
	{
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	},
).outputText
function load(
	bridge: unknown,
	headers: unknown = Headers,
	response: unknown = Response,
) {
	const exports: Record<
		string,
		(url: string, init: RequestInit) => Promise<Response>
	> = {}
	runInNewContext(source, {
		exports,
		require: (id: string) =>
			id === '@bbplayer/orpheus'
				? { Orpheus: { bilibiliAccountRequest: bridge } }
				: id === './account-api'
					? api
					: session,
		Headers: headers,
		Response: response,
	})
	return exports.fetchNativeBilibili
}
const good = async () => ({ status: 200, body: '{"code":0}', setCookie: '' })
void test('native diagnostics separate unavailable bridge and compatibility without leaking values', async () => {
	for (const [fetcher, expected] of [
		[load(undefined), 'bridge-unavailable'],
		[
			load(async () => {
				throw { code: 'ERR_UNEXPECTED', message: 'PRIVATE' }
			}),
			'native-request-failed/native-unexpected',
		],
		[
			load(async () => {
				throw { code: 'PRIVATE', message: 'PRIVATE' }
			}),
			'native-request-failed',
		],
		[
			load(async () => {
				throw new Error('PRIVATE-COOKIE-URL')
			}),
			'native-request-failed',
		],
		[load(good, null), 'headers-unavailable'],
		[load(good, Headers, null), 'response-unavailable'],
		[
			load(good, function incompatibleConstructor() {
				throw new Error('PRIVATE')
			}),
			'response-invalid',
		],
		[
			load(good, Headers, function incompatibleConstructor() {
				throw new Error('PRIVATE')
			}),
			'response-invalid',
		],
		[
			load(async () => ({ status: '200', body: 'PRIVATE', setCookie: '' })),
			'response-invalid',
		],
	] as const) {
		await assert.rejects(
			fetcher('https://passport.bilibili.com/synthetic', {}),
			(error) => {
				assert.equal(api.accountDiagnosticCode(error), expected)
				assert.equal((error as session.AccountSessionError).code, 'network')
				assert.ok(!String(error).includes('PRIVATE'))
				return true
			},
		)
	}
	assert.equal(
		(await load(good)('https://passport.bilibili.com/synthetic', {})).status,
		200,
	)
})
