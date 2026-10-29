import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { test, type TestContext } from 'node:test'

import JSZip from 'jszip'

import { crc32, sha256 } from '../core/theme-archive'
import type {
	PackageThemeTokens,
	ThemePackageManifest,
} from '../core/theme-package-types'

const root = resolve(__dirname, '../../../../..')
const base = readFileSync(join(root, 'theme-packages/paper-signal.melotheme'))
const referenceHost = JSON.parse(
	readFileSync(join(root, 'theme-packages/reference-host.json'), 'utf8'),
) as { appVersion: string; capabilities: string[] }
interface ContrastPair {
	usage: string
	foregroundToken: string
	backgroundToken: string
	foreground: string
	background: string
	ratio: number
	normalText: boolean
	largeText: boolean
}
type ModeReport =
	| { status: 'audited'; pairs: ContrastPair[] }
	| { status: 'unassessed'; reason: string }
interface ContrastReport {
	status: string
	package: { id: string; version: string; archiveSha256: string }
	targetHost: { appVersion: string; capabilities: string[] }
	scope: string
	modes: { light: ModeReport; dark: ModeReport }
	summary: {
		auditedPairCount: number
		normalTextFailures: number
		largeTextFailures: number
	}
	notAssessed: string[]
	warnings: string[]
	decoder: string
	installed: false
}
const { contrastRatio, auditTokenGroup } = createRequire(import.meta.url)(
	join(root, 'scripts/lib/theme-token-contrast.cjs'),
) as {
	contrastRatio(this: void, foreground: string, background: string): number
	auditTokenGroup(this: void, tokens: PackageThemeTokens): ContrastPair[]
}
const light = JSON.parse(
	readFileSync(join(root, 'theme-packages/example/tokens.json'), 'utf8'),
).light as PackageThemeTokens

function directory(context: TestContext) {
	const path = mkdtempSync(join(tmpdir(), 'melo-theme-contrast-'))
	context.after(() => {
		if (
			!resolve(path).startsWith(resolve(tmpdir()) + sep) ||
			!basename(path).startsWith('melo-theme-contrast-')
		)
			throw new Error('Refusing cleanup outside this test directory')
		rmSync(path, { recursive: true })
	})
	return path
}
function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
	const result = spawnSync(
		process.execPath,
		[join(root, 'scripts/theme-contrast.cjs'), ...args],
		{ cwd: root, encoding: 'utf8', timeout: 30000, env },
	)
	assert.equal(result.error, undefined)
	assert.equal(result.signal, null)
	return result
}
function report(args: string[]) {
	const result = cli(args)
	assert.equal(result.stderr, '')
	return {
		status: result.status,
		value: JSON.parse(result.stdout) as ContrastReport,
	}
}
function solid(tokens: PackageThemeTokens, color: string) {
	for (const group of Object.values(tokens))
		for (const key of Object.keys(group))
			(group as Record<string, string>)[key] = color
}
async function archive(
	path: string,
	change: (
		zip: JSZip,
		manifest: ThemePackageManifest,
		tokens: { light: PackageThemeTokens; dark?: PackageThemeTokens },
	) => void,
) {
	const zip = await JSZip.loadAsync(base)
	const manifest = JSON.parse(
		await zip.file('manifest.json')!.async('string'),
	) as ThemePackageManifest
	const tokens = JSON.parse(await zip.file('tokens.json')!.async('string')) as {
		light: PackageThemeTokens
		dark?: PackageThemeTokens
	}
	change(zip, manifest, tokens)
	zip.file('manifest.json', JSON.stringify(manifest))
	zip.file('tokens.json', JSON.stringify(tokens))
	writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))
	return path
}
function chunk(name: string, bytes: Uint8Array) {
	const value = Buffer.alloc(bytes.length + 12)
	value.writeUInt32BE(bytes.length, 0)
	value.write(name, 4, 'ascii')
	value.set(bytes, 8)
	value.writeUInt32BE(crc32(value.subarray(4, -4)), value.length - 4)
	return value
}

void test('solid sRGB ratio matches black/white 21 and identical 1, is symmetric and rejects non-HEX', () => {
	assert.equal(contrastRatio('#000000', '#ffffff'), 21)
	assert.equal(contrastRatio('#AABBCC', '#aabbcc'), 1)
	assert.equal(
		contrastRatio('#123456', '#abcdef'),
		contrastRatio('#abcdef', '#123456'),
	)
	for (const bad of ['#fff', '#ffffff80', 'white', '#zzzzzz'])
		assert.throws(() => contrastRatio(bad, '#ffffff'), /six-digit HEX/)
})

void test('normal/large targets compare unrounded ratios on both sides of each threshold', () => {
	for (const [color, target, expected] of [
		['#777777', 'normalText', false],
		['#767676', 'normalText', true],
		['#959595', 'largeText', false],
		['#949494', 'largeText', true],
	] as const) {
		const tokens = structuredClone(light)
		tokens.text.primary = color
		tokens.surface.base = '#ffffff'
		const row = auditTokenGroup(tokens)[0]
		assert.equal(row[target], expected)
		assert.equal(row.ratio, contrastRatio(color, '#ffffff'))
		if (!expected)
			assert.equal(
				row.ratio.toFixed(1),
				target === 'normalText' ? '4.5' : '3.0',
			)
	}
})

void test('eight rows preserve original colours and map actual text/card/button/navigation/error uses without mutation', () => {
	const tokens = structuredClone(light),
		before = structuredClone(tokens)
	tokens.text.primary = '#243A35'
	before.text.primary = '#243A35'
	const rows = auditTokenGroup(tokens)
	assert.equal(rows.length, 8)
	assert.deepEqual(
		rows.map((row) => [row.foregroundToken, row.backgroundToken]),
		[
			['text.primary', 'surface.base'],
			['text.secondary', 'surface.base'],
			['text.primary', 'surface.card'],
			['text.secondary', 'surface.card'],
			['text.inverse', 'action.primary'],
			['action.primary', 'surface.tinted'],
			['action.primary', 'surface.base'],
			['state.error', 'surface.card'],
		],
	)
	assert.equal(rows[0].foreground, '#243A35')
	assert.deepEqual(tokens, before)
	rows[0].foreground = '#000000'
	assert.deepEqual(tokens, before)
})

void test('real ZIP with real Sharp yields scoped report, original archive hash, and absent dark is unassessed', () => {
	const result = report([join(root, 'theme-packages/paper-signal.melotheme')])
	assert.equal(result.status, 0)
	assert.equal(result.value.status, 'valid-package-contrast-report')
	assert.equal(result.value.scope, 'solid-semantic-token-pairs-only')
	assert.equal(result.value.package.archiveSha256, sha256(base))
	assert.deepEqual(result.value.targetHost, referenceHost)
	assert.deepEqual(result.value.modes.dark, {
		status: 'unassessed',
		reason: 'absent',
	})
	assert.equal(result.value.summary.auditedPairCount, 8)
	assert.equal(result.value.summary.normalTextFailures, 0)
	assert.equal(result.value.installed, false)
	assert.match(result.value.decoder, /^sharp /)
	assert.match(result.value.notAssessed.join(' '), /whole-theme accessibility/)
	assert.deepEqual(
		base,
		readFileSync(join(root, 'theme-packages/paper-signal.melotheme')),
	)
})

void test('valid low-contrast ZIP exits 2 but existing validate still succeeds with unchanged output contract', async (context) => {
	const path = await archive(
		join(directory(context), 'low.melotheme'),
		(_zip, _manifest, tokens) => {
			solid(tokens.light, '#eeeeee')
		},
	)
	const before = readFileSync(path),
		result = report([path])
	assert.equal(result.status, 2)
	assert.equal(result.value.status, 'valid-package-contrast-report')
	assert.equal(result.value.modes.light.status, 'audited')
	if (result.value.modes.light.status !== 'audited')
		throw new Error('Missing light audit')
	assert.ok(
		result.value.modes.light.pairs.every(
			(row) => row.ratio === 1 && !row.normalText && !row.largeText,
		),
	)
	assert.equal(result.value.summary.normalTextFailures, 8)
	assert.equal(result.value.summary.largeTextFailures, 8)
	const old = spawnSync(
		process.execPath,
		[join(root, 'scripts/theme-package.cjs'), 'validate', path],
		{
			cwd: root,
			encoding: 'utf8',
			timeout: 30000,
		},
	)
	assert.equal(old.error, undefined)
	assert.equal(old.status, 0, old.stderr)
	const value = JSON.parse(old.stdout)
	assert.equal(value.status, 'validated-reference-package')
	assert.equal(value.installed, false)
	assert.equal('modes' in value, false)
	assert.equal(value.archiveSha256, result.value.package.archiveSha256)
	assert.deepEqual(readFileSync(path), before)
})

void test('dark is audited only when present and supported; unsupported group is explicitly unassessed', async (context) => {
	const dir = directory(context)
	const path = await archive(
		join(dir, 'dark.melotheme'),
		(_zip, manifest, tokens) => {
			manifest.optionalCapabilities.push('dark-tokens')
			tokens.dark = structuredClone(tokens.light)
			solid(tokens.dark, '#111111')
		},
	)
	const supported = report([path])
	assert.equal(supported.status, 2)
	assert.equal(supported.value.modes.dark.status, 'audited')
	assert.equal(supported.value.summary.auditedPairCount, 16)
	assert.equal(supported.value.summary.normalTextFailures, 8)
	const hostPath = join(dir, 'light-only-host.json')
	writeFileSync(
		hostPath,
		JSON.stringify({
			...referenceHost,
			capabilities: referenceHost.capabilities.filter(
				(value) => value !== 'dark-tokens',
			),
		}),
	)
	const unsupported = report([path, hostPath])
	assert.equal(unsupported.status, 0)
	assert.deepEqual(unsupported.value.modes.dark, {
		status: 'unassessed',
		reason: 'unsupported-by-target-host',
	})
	assert.equal(unsupported.value.summary.auditedPairCount, 8)
	assert.ok(
		unsupported.value.warnings.some((value) => value.includes('深色组')),
	)
})

void test('invalid ZIP and valid-header/CRC/hash PNG with undecodable pixels exit 1 without any quality report', async (context) => {
	const dir = directory(context),
		truncated = join(dir, 'truncated.melotheme')
	writeFileSync(truncated, base.subarray(0, base.length - 20))
	const badImage = await archive(
		join(dir, 'bad-image.melotheme'),
		(zip, manifest) => {
			// Correct PNG structure/CRC and index; only full pixel decoding can reject IDAT.
			const header = Buffer.alloc(13)
			header.writeUInt32BE(1, 0)
			header.writeUInt32BE(1, 4)
			header[8] = 8
			header[9] = 6
			const png = Buffer.concat([
				Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
				chunk('IHDR', header),
				chunk('IDAT', new Uint8Array([0, 0, 0, 0])),
				chunk('IEND', new Uint8Array()),
			])
			const entry = manifest.assets.find(
				(value) => value.path === 'assets/header.png',
			)!
			entry.bytes = png.length
			entry.sha256 = sha256(png)
			zip.file(entry.path, png)
		},
	)
	for (const [path, code] of [
		[truncated, 'ARCHIVE_INVALID'],
		[badImage, 'IMAGE_INVALID'],
	]) {
		const result = cli([path])
		assert.equal(result.status, 1)
		assert.equal(result.stdout, '')
		assert.deepEqual(Object.keys(JSON.parse(result.stderr)).sort(), [
			'code',
			'message',
			'status',
		])
		assert.equal(JSON.parse(result.stderr).status, 'invalid-package')
		assert.equal(JSON.parse(result.stderr).code, code)
	}
})

void test('usage, missing input and unavailable trusted decoder are execution errors, never a quality PASS', () => {
	for (const result of [
		cli([]),
		cli([join(root, 'test-results/this-file-does-not-exist.melotheme')]),
		cli([join(root, 'theme-packages/paper-signal.melotheme')], {
			...process.env,
			MELO_THEME_SHARP: join(root, 'test-results/no-sharp'),
		}),
	]) {
		assert.equal(result.status, 3)
		assert.equal(result.stdout, '')
		assert.equal(JSON.parse(result.stderr).status, 'execution-error')
	}
	assert.equal(cli(['--help']).status, 0)
})

for (const [name, host] of [
	['invalid-version', { ...referenceHost, appVersion: 'not-semver' }],
	[
		'string-capabilities',
		{ ...referenceHost, capabilities: referenceHost.capabilities.join(',') },
	],
] as const)
	void test(`invalid host configuration ${name} is execution-error rather than package-invalid or audit success`, (context) => {
		const hostPath = join(directory(context), 'host.json')
		writeFileSync(hostPath, JSON.stringify(host))
		const result = cli([
			join(root, 'theme-packages/paper-signal.melotheme'),
			hostPath,
		])
		assert.equal(result.status, 3, result.stderr || result.stdout)
		assert.equal(result.stdout, '')
		assert.equal(JSON.parse(result.stderr).status, 'execution-error')
		assert.equal(JSON.parse(result.stderr).code, 'HOST_CONFIG_INVALID')
	})

void test('host object/field types and unsafe or noncanonical core versions are configuration errors before package validation', (context) => {
	const dir = directory(context)
	const malformed: unknown[] = [
		null,
		[],
		'host',
		{},
		{ ...referenceHost, capabilities: null },
		{ ...referenceHost, capabilities: ['semantic-colors', 1] },
		...[
			null,
			'01.0.0',
			'1.0.0-01',
			'9007199254740992.0.0',
			'1.9007199254740992.0',
			'1.0.9007199254740992',
			'1.0.0\n',
			`1.0.0+${'a'.repeat(75)}`,
		].map((appVersion) => ({ ...referenceHost, appVersion })),
	]
	for (const [index, value] of malformed.entries()) {
		const hostPath = join(dir, `host-${index}.json`)
		writeFileSync(hostPath, JSON.stringify(value))
		const result = cli([
			join(root, 'theme-packages/paper-signal.melotheme'),
			hostPath,
		])
		assert.equal(result.status, 3, result.stdout || result.stderr)
		assert.equal(result.stdout, '')
		assert.equal(JSON.parse(result.stderr).status, 'execution-error')
		assert.equal(JSON.parse(result.stderr).code, 'HOST_CONFIG_INVALID')
	}
})

void test('valid core prerelease/build/safe maximum versions and host-only extra capabilities keep their existing semantics', (context) => {
	const dir = directory(context)
	const capabilities = [
		...referenceHost.capabilities,
		'',
		'icons',
		...Array.from(
			{ length: 70 },
			(_, index) => `future-${index}-${'x'.repeat(81)}`,
		),
	]
	for (const [index, appVersion] of [
		'0.4.1-beta.0+author.001',
		'1.0.0-beta.999999999999999999999999+001',
		'9007199254740991.0.0+author.01',
	].entries()) {
		const hostPath = join(dir, `valid-${index}.json`)
		writeFileSync(
			hostPath,
			JSON.stringify({
				appVersion,
				capabilities,
				note: 'ignored host metadata',
			}),
		)
		const result = report([
			join(root, 'theme-packages/paper-signal.melotheme'),
			hostPath,
		])
		assert.equal(result.status, 0)
		assert.deepEqual(result.value.targetHost, { appVersion, capabilities })
	}
})
