import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { test } from 'node:test'

import JSZip from 'jszip'

import {
	crc32,
	inspectThemeArchive,
	readThemeArchive,
	safePackagePath,
	sha256,
	utf8,
} from '../core/theme-archive'
import {
	inspectThemePng,
	packageCapabilities,
	parseThemeDocuments,
	validateThemePackage,
} from '../core/theme-package'
import {
	ThemePackageError,
	themePackageLimits,
	type ThemeImageDecoder,
	type ThemePackageManifest,
} from '../core/theme-package-types'

const root = resolve(__dirname, '../../../../..')
const host = { appVersion: '0.4.0', capabilities: [...packageCapabilities] }
const base = new Uint8Array(
	readFileSync(join(root, 'theme-packages/paper-signal.melotheme')),
)
const nodeAdapter = createRequire(join(root, 'scripts/theme-package.cjs'))(
	'./lib/theme-package-node.cjs',
) as {
	createNodeImageDecoder(): ThemeImageDecoder
	loadSharp(): (bytes: Uint8Array) => {
		jpeg(): { toBuffer(): Promise<Uint8Array> }
	}
}
const decoder = nodeAdapter.createNodeImageDecoder()
const digest = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex')

void test('identical icon state PNGs decode once per validation while every resource hash is still checked', async () => {
	const bytes = await repack(async (zip, manifest) => {
		const original = manifest.assets[0]
		const copy = { ...original, path: 'assets/repeated-state.png' }
		zip.file(copy.path, await zip.file(original.path)!.async('uint8array'))
		manifest.assets.push(copy)
	})
	let calls = 0
	const counting: ThemeImageDecoder = { decodeImage: (...args) => {
		calls++
		return decoder.decodeImage(...args)
	} }
	const value = await validateThemePackage(bytes, host, counting)
	const unique = new Set(value.manifest.assets.map((asset) => asset.sha256)).size
	assert.ok(unique < value.manifest.assets.length)
	assert.equal(calls, unique)
	await validateThemePackage(bytes, host, counting)
	assert.equal(calls, unique * 2, 'no unchecked cross-load cache')
	const zip = await JSZip.loadAsync(bytes)
	const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
	manifest.assets.at(-1).sha256 = '0'.repeat(64)
	zip.file('manifest.json', JSON.stringify(manifest))
	await reject(validateThemePackage(await zip.generateAsync({ type: 'uint8array' }), host, counting), 'RESOURCE_INVALID')
})

void test('missing-capability host hook receives all missing IDs but cannot grant them or mutate package requirements', async () => {
	const zip = await JSZip.loadAsync(base)
	const manifest: ThemePackageManifest = JSON.parse(
		await zip.file('manifest.json')!.async('string'),
	)
	manifest.requiredCapabilities.push(
		'responsive-touch-layout-v1',
		'unknown-native-feature',
	)
	const input = {
		manifest,
		tokens: JSON.parse(await zip.file('tokens.json')!.async('string')),
		components: JSON.parse(await zip.file('components.json')!.async('string')),
	}
	const required = [...manifest.requiredCapabilities]
	for (const returned of [true, false]) {
		let seen: readonly string[] = []
		assert.throws(
			() =>
				parseThemeDocuments(input, {
					...host,
					capabilities: [],
					onMissingCapabilities: (missing) => {
						seen = [...missing]
						;(missing as string[]).splice(0)
						return returned
					},
				}),
			{ code: 'INCOMPATIBLE' },
		)
		assert.deepEqual(seen, required)
		assert.deepEqual(manifest.requiredCapabilities, required)
	}
})

void test('真实ZIP紧凑配置须必需能力，缺失/optional/旧宿主不能忽略；旧包保持48', async () => {
	const legacy = await validateThemePackage(base, host, decoder)
	assert.equal(legacy.snapshot.components.button.minTouchDp, 48)
	assert.equal(legacy.snapshot.components.layout, undefined)
	const bytes = await repack(async (zip, manifest) => {
		manifest.requiredCapabilities.push('responsive-touch-layout-v1')
		const document = JSON.parse(
			await zip.file('components.json')!.async('string'),
		)
		document.components.button.minTouchDp = 96
		document.components.layout = {
			compactMinTouchDp: 72,
			narrowFallback: 'host-single-row',
		}
		zip.file('components.json', JSON.stringify(document))
	})
	const result = await validateThemePackage(bytes, host, decoder)
	assert.deepEqual(result.snapshot.components.layout, {
		compactMinTouchDp: 72,
		narrowFallback: 'host-single-row',
	})
	assert.equal(result.snapshot.components.button.minTouchDp, 96)
	for (const narrowFallback of ['reject', 'host-single-row']) {
		const noCompact = await repack(async (zip, manifest) => {
			manifest.requiredCapabilities.push('responsive-touch-layout-v1')
			const document = JSON.parse(
				await zip.file('components.json')!.async('string'),
			)
			document.components.layout = { narrowFallback }
			zip.file('components.json', JSON.stringify(document))
		})
		assert.deepEqual(
			(await validateThemePackage(noCompact, host, decoder)).snapshot.components
				.layout,
			{ narrowFallback },
		)
	}
	await reject(
		validateThemePackage(
			bytes,
			{
				...host,
				capabilities: host.capabilities.filter(
					(value) => value !== 'responsive-touch-layout-v1',
				),
			},
			decoder,
		),
		'INCOMPATIBLE',
	)
	for (const optional of [false, true]) {
		const unauthorized = await repack(async (zip, manifest) => {
			if (optional)
				manifest.optionalCapabilities.push('responsive-touch-layout-v1')
			const document = JSON.parse(
				await zip.file('components.json')!.async('string'),
			)
			document.components.layout = {
				compactMinTouchDp: 48,
				narrowFallback: 'reject',
			}
			zip.file('components.json', JSON.stringify(document))
		})
		await reject(
			validateThemePackage(unauthorized, host, decoder),
			'MANIFEST_INVALID',
		)
	}
})

void test('真实ZIP只接受有界明确紧凑策略，不能添加两行/脚本/额外布局字段', async () => {
	for (const layout of [
		null,
		{},
		{ compactMinTouchDp: 47, narrowFallback: 'reject' },
		{ compactMinTouchDp: 73, narrowFallback: 'reject' },
		{ compactMinTouchDp: 48.5, narrowFallback: 'reject' },
		{ compactMinTouchDp: '48', narrowFallback: 'reject' },
		{ narrowFallback: 'wrap' },
		{ narrowFallback: 'reject', rows: 2 },
	]) {
		const bytes = await repack(async (zip, manifest) => {
			manifest.requiredCapabilities.push('responsive-touch-layout-v1')
			const document = JSON.parse(
				await zip.file('components.json')!.async('string'),
			)
			document.components.button.minTouchDp = 72
			document.components.layout = layout
			zip.file('components.json', JSON.stringify(document))
		})
		await reject(validateThemePackage(bytes, host, decoder), 'MANIFEST_INVALID')
	}
})

async function reject(
	promise: Promise<unknown>,
	code: ThemePackageError['code'],
) {
	let output: unknown
	await assert.rejects(
		promise.then((value) => {
			output = value
			return value
		}),
		(error: unknown) => {
			assert.ok(error instanceof ThemePackageError)
			assert.equal(error.code, code)
			return true
		},
	)
	assert.equal(
		output,
		undefined,
		'failed packages must not produce a Verified result',
	)
}
async function repack(
	change: (zip: JSZip, manifest: ThemePackageManifest) => void | Promise<void>,
	streamFiles = false,
): Promise<Uint8Array> {
	const zip = await JSZip.loadAsync(base),
		manifest = JSON.parse(
			await zip.file('manifest.json')!.async('string'),
		) as ThemePackageManifest
	await change(zip, manifest)
	zip.file('manifest.json', JSON.stringify(manifest), { createFolders: false })
	return zip.generateAsync({
		type: 'uint8array',
		platform: 'UNIX',
		compression: 'DEFLATE',
		streamFiles,
	})
}
function image(
	zip: JSZip,
	manifest: ThemePackageManifest,
	path: string,
	bytes: Uint8Array,
) {
	zip.file(path, bytes, { createFolders: false })
	const asset = {
		path,
		mime: 'image/png' as const,
		bytes: bytes.length,
		sha256: digest(bytes),
	}
	const index = manifest.assets.findIndex((entry) => entry.path === path)
	if (index < 0) manifest.assets.push(asset)
	else manifest.assets[index] = asset
}
function headers(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
		end = bytes.length - 22
	assert.equal(view.getUint32(end, true), 0x06054b50)
	const central = view.getUint32(end + 16, true),
		result: {
			name: string
			central: number
			local: number
			extra: number
			extraLength: number
		}[] = []
	let offset = central
	for (let i = 0; i < view.getUint16(end + 10, true); i++) {
		assert.equal(view.getUint32(offset, true), 0x02014b50)
		const length = view.getUint16(offset + 28, true),
			extraLength = view.getUint16(offset + 30, true)
		result.push({
			name: utf8(bytes.subarray(offset + 46, offset + 46 + length)),
			central: offset,
			local: view.getUint32(offset + 42, true),
			extra: offset + 46 + length,
			extraLength,
		})
		offset += 46 + length + extraLength + view.getUint16(offset + 32, true)
	}
	return { view, end, central, entries: result }
}
function chunk(type: string, data: Uint8Array) {
	const result = new Uint8Array(data.length + 12),
		view = new DataView(result.buffer)
	view.setUint32(0, data.length)
	result.set(new TextEncoder().encode(type), 4)
	result.set(data, 8)
	view.setUint32(
		result.length - 4,
		crc32(result.subarray(4, result.length - 4)),
	)
	return result
}
function joinBytes(...parts: Uint8Array[]) {
	const output = new Uint8Array(
		parts.reduce((sum, part) => sum + part.length, 0),
	)
	let offset = 0
	for (const part of parts) {
		output.set(part, offset)
		offset += part.length
	}
	return output
}

void test('正式原创ZIP完整验证真实PNG、实际SHA/长度与可序列化动态资源快照，未安装', async () => {
	const value = await validateThemePackage(base, host, decoder)
	assert.equal(value.manifest.id, 'example.paper-signal')
	assert.equal(value.snapshot.package.archiveSha256, digest(base))
	assert.equal(value.files.length, 7)
	for (const file of value.files) {
		assert.equal(file.sha256, digest(file.bytes))
		if (file.image)
			assert.equal(
				file.image.decodedBytes,
				file.image.width * file.image.height * 4,
			)
	}
	assert.equal(value.files.filter((file) => file.image).length, 3)
	assert.deepEqual(value.snapshot.assets.hero, {
		kind: 'package',
		path: 'assets/header.png',
		sha256: value.manifest.assets[0].sha256,
		mime: 'image/png',
	})
	assert.ok(
		value.snapshot.warnings.some((warning) =>
			warning.includes('widget-theme-v1'),
		),
	)
	assert.deepEqual(JSON.parse(JSON.stringify(value.snapshot)), value.snapshot)
})

void test('无真实decoder拒绝产出Verified；独立配置解析不带安装成功标记', async () => {
	await reject(
		validateThemePackage(base, host, undefined as unknown as ThemeImageDecoder),
		'DECODER_REQUIRED',
	)
	const zip = await JSZip.loadAsync(base)
	const documents = {
		manifest: JSON.parse(await zip.file('manifest.json')!.async('string')),
		tokens: JSON.parse(await zip.file('tokens.json')!.async('string')),
		components: JSON.parse(await zip.file('components.json')!.async('string')),
	}
	const parsed = parseThemeDocuments(documents, host)
	assert.equal('files' in parsed, false)
	assert.equal('snapshot' in parsed, false)
	for (const manifest of [
		{ ...documents.manifest, format: 'melocanvas-lab-json' },
		{
			...documents.manifest,
			format: undefined,
			entry: { tokens: 'inline', components: 'inline' },
		},
	])
		assert.throws(
			() => parseThemeDocuments({ ...documents, manifest }, host),
			/不兼容/,
		)
})

void test('锁定JSZip生成的STORE/DEFLATE、signed/unsigned data descriptor和目录项可验证', async () => {
	for (const compression of ['STORE', 'DEFLATE'] as const) {
		const zip = await JSZip.loadAsync(base)
		zip.folder('assets')
		const bytes = await zip.generateAsync({
			type: 'uint8array',
			platform: 'UNIX',
			compression,
			streamFiles: true,
		})
		assert.equal(
			(await validateThemePackage(bytes, host, decoder)).manifest.id,
			'example.paper-signal',
		)
	}
	const signed = await repack(() => {}, true),
		raw = headers(signed)
	const at = raw.central - 16
	assert.equal(raw.view.getUint32(at, true), 0x08074b50)
	const unsigned = joinBytes(signed.subarray(0, at), signed.subarray(at + 4))
	new DataView(unsigned.buffer).setUint32(
		unsigned.length - 22 + 16,
		raw.central - 4,
		true,
	)
	assert.equal(
		(await validateThemePackage(unsigned, host, decoder)).files.length,
		7,
	)
})

void test('Unicode UTF-8路径额外字段可用，NFC和大小写规范冲突与别名不一致拒绝', async () => {
	const bytes = await repack(async (zip, manifest) => {
		image(
			zip,
			manifest,
			'assets/é.png',
			await zip.file('assets/header.png')!.async('uint8array'),
		)
	})
	assert.equal(
		(await validateThemePackage(bytes, host, decoder)).manifest.assets.length,
		4,
	)
	const alias = new Uint8Array(bytes),
		raw = headers(alias),
		unicode = raw.entries.find((entry) => entry.name === 'assets/é.png')!
	assert.ok(unicode.extraLength > 0)
	alias[unicode.extra + 4 + 5] = 'X'.charCodeAt(0)
	await reject(validateThemePackage(alias, host, decoder), 'PATH_INVALID')
	for (const name of ['assets/e\u0301.png', 'assets/HEADER.png']) {
		const bad = await repack((zip) => {
			zip.file(name, 'bytes', { createFolders: false })
		})
		await reject(validateThemePackage(bad, host, decoder), 'PATH_INVALID')
	}
})

void test('原始ZIP同名entry不能被JSZip后值覆盖掩盖；local/central不同名拒绝', async () => {
	const duplicate = new Uint8Array(base),
		raw = headers(duplicate),
		license = raw.entries.find((entry) => entry.name === 'LICENSE.txt')!
	for (const offset of [license.central + 46, license.local + 30])
		duplicate.set(new TextEncoder().encode('tokens.json'), offset)
	await reject(validateThemePackage(duplicate, host, decoder), 'PATH_INVALID')
	const mismatch = new Uint8Array(base),
		first = headers(mismatch).entries[0]
	mismatch[first.local + 30] = 'x'.charCodeAt(0)
	await reject(validateThemePackage(mismatch, host, decoder), 'PATH_INVALID')
})

void test('路径穿越/盘符/根路径/NUL/反斜杠/Windows保留名/目录文件冲突均拒绝', async () => {
	for (const name of [
		'../escape.png',
		'/root.png',
		'C:/root.png',
		'assets/a\u0000.png',
		'assets\\a.png',
		'assets/NUL.png',
		'assets/a./file.png',
	]) {
		await reject(
			validateThemePackage(
				await repack((zip) => {
					zip.file(name, 'x', { createFolders: false })
				}),
				host,
				decoder,
			),
			'PATH_INVALID',
		)
	}
	await reject(
		validateThemePackage(
			await repack((zip) => {
				zip.file('assets/header.png/child.png', 'x', { createFolders: false })
			}),
			host,
			decoder,
		),
		'PATH_INVALID',
	)
	assert.throws(() => safePackagePath('assets/./a.png'), /相对路径/)
})

void test('ZIP符号链接、特殊文件和加密/ZIP64/不支持压缩明确拒绝', async () => {
	for (const unixPermissions of [0o120777, 0o010644])
		await reject(
			validateThemePackage(
				await repack((zip) => {
					zip.file('assets/link.png', 'target', {
						createFolders: false,
						unixPermissions,
					})
				}),
				host,
				decoder,
			),
			'PATH_INVALID',
		)
	const encrypted = new Uint8Array(base),
		e = headers(encrypted),
		first = e.entries[0]
	for (const offset of [first.central + 8, first.local + 6])
		e.view.setUint16(offset, e.view.getUint16(offset, true) | 1, true)
	await reject(
		validateThemePackage(encrypted, host, decoder),
		'ARCHIVE_UNSUPPORTED',
	)
	const zip64 = new Uint8Array(base),
		z = headers(zip64)
	z.view.setUint16(z.end + 10, 65535, true)
	await reject(
		validateThemePackage(zip64, host, decoder),
		'ARCHIVE_UNSUPPORTED',
	)
	const method = new Uint8Array(base),
		m = headers(method),
		one = m.entries[0]
	m.view.setUint16(one.central + 10, 99, true)
	m.view.setUint16(one.local + 8, 99, true)
	await reject(
		validateThemePackage(method, host, decoder),
		'ARCHIVE_UNSUPPORTED',
	)
})

void test('真实压缩炸弹、目录/文件/总量限额均在完整膨胀之前拒绝', async () => {
	const bomb = await repack((zip) => {
		zip.file('assets/bomb.png', 'x'.repeat(200000), { createFolders: false })
	})
	await reject(validateThemePackage(bomb, host, decoder), 'LIMIT_EXCEEDED')
	for (const limits of [
		{ archiveBytes: 100 },
		{ totalBytes: 1000 },
		{ fileBytes: 1024 },
		{ entries: 2 },
		{ jsonBytes: 10 },
		{ assets: 2 },
	])
		await reject(
			validateThemePackage(base, host, decoder, { limits }),
			'LIMIT_EXCEEDED',
		)
})

void test('谎报未压缩长度不能绕过实际流字节上限，不先累计全部输出', async () => {
	const bytes = await repack((zip) => {
		zip.file('assets/bomb.png', 'x'.repeat(128000), { createFolders: false })
	})
	const raw = headers(bytes),
		target = raw.entries.find((entry) => entry.name === 'assets/bomb.png')!
	raw.view.setUint32(target.central + 24, 1000, true)
	raw.view.setUint32(target.local + 22, 1000, true)
	assert.doesNotThrow(() =>
		inspectThemeArchive(bytes, { ...themePackageLimits }),
	)
	await reject(
		readThemeArchive(bytes, { ...themePackageLimits }),
		'LIMIT_EXCEEDED',
	)
})

void test('截断、真实CRC失败与实际文件长度/hash篡改不产Verified', async () => {
	await reject(
		validateThemePackage(base.subarray(0, base.length - 5), host, decoder),
		'ARCHIVE_INVALID',
	)
	const corrupt = new Uint8Array(base),
		raw = headers(corrupt),
		first = raw.entries[0]
	const wrong = raw.view.getUint32(first.central + 16, true) ^ 1
	raw.view.setUint32(first.central + 16, wrong, true)
	raw.view.setUint32(first.local + 14, wrong, true)
	await reject(validateThemePackage(corrupt, host, decoder), 'ARCHIVE_INVALID')
	for (const change of ['bytes', 'sha256'] as const)
		await reject(
			validateThemePackage(
				await repack((_zip, manifest) => {
					if (change === 'bytes') manifest.assets[0].bytes++
					else manifest.assets[0].sha256 = '0'.repeat(64)
				}),
				host,
				decoder,
			),
			'RESOURCE_INVALID',
		)
})

void test('未知required/宿主未实现能力/版本不兼容拒绝，可选能力显式回退', async () => {
	await reject(
		validateThemePackage(
			await repack((_zip, manifest) => {
				manifest.requiredCapabilities.push('execute-js')
			}),
			host,
			decoder,
		),
		'INCOMPATIBLE',
	)
	await reject(
		validateThemePackage(base, { ...host, capabilities: [] }, decoder),
		'INCOMPATIBLE',
	)
	await reject(
		validateThemePackage(
			base,
			{ ...host, appVersion: '0.4.0-beta.1' },
			decoder,
		),
		'INCOMPATIBLE',
	)
	await reject(
		validateThemePackage(
			await repack((_zip, manifest) => {
				manifest.minAppVersion = '0.5.0'
			}),
			host,
			decoder,
		),
		'INCOMPATIBLE',
	)
	assert.ok(
		(await validateThemePackage(base, host, decoder)).snapshot.warnings.some(
			(value) => value.includes('widget'),
		),
	)
})

void test('不执行未声明文件/字体或任意组件字段，CSS注入和小于48dp配置拒绝', async () => {
	await reject(
		validateThemePackage(
			await repack((zip) => {
				zip.file('assets/code.js', 'throw 1')
			}),
			host,
			decoder,
		),
		'RESOURCE_INVALID',
	)
	await reject(
		validateThemePackage(
			await repack((zip) => {
				zip.file('assets/font.ttf', 'font')
			}),
			host,
			decoder,
		),
		'RESOURCE_INVALID',
	)
	for (const change of [
		(document: Record<string, unknown>) => {
			document.fonts = {}
		},
		(document: Record<string, unknown>) => {
			;(
				object(document.components).button as Record<string, unknown>
			).minTouchDp = 20
		},
	]) {
		await reject(
			validateThemePackage(
				await repack(async (zip) => {
					const value = JSON.parse(
						await zip.file('components.json')!.async('string'),
					) as Record<string, unknown>
					change(value)
					zip.file('components.json', JSON.stringify(value))
				}),
				host,
				decoder,
			),
			'MANIFEST_INVALID',
		)
	}
	await reject(
		validateThemePackage(
			await repack(async (zip) => {
				const value = JSON.parse(await zip.file('tokens.json')!.async('string'))
				value.light.action.primary = 'url(https://example.com)'
				zip.file('tokens.json', JSON.stringify(value))
			}),
			host,
			decoder,
		),
		'MANIFEST_INVALID',
	)
})
function object(value: unknown) {
	return value as Record<string, unknown>
}

void test('真实JPEG伪装PNG、截断PNG与像素预算在完整decode前拒绝', async () => {
	const zip = await JSZip.loadAsync(base),
		png = await zip.file('assets/header.png')!.async('uint8array')
	const jpeg = await nodeAdapter.loadSharp()(png).jpeg().toBuffer()
	for (const bytes of [jpeg, png.subarray(0, png.length - 12)])
		await reject(
			validateThemePackage(
				await repack((targetZip, manifest) =>
					image(targetZip, manifest, 'assets/header.png', bytes),
				),
				host,
				decoder,
			),
			'IMAGE_INVALID',
		)
	await reject(
		validateThemePackage(base, host, decoder, { limits: { imagePixels: 100 } }),
		'LIMIT_EXCEEDED',
	)
	await reject(
		validateThemePackage(base, host, decoder, {
			limits: { decodedImageBytes: 100 },
		}),
		'LIMIT_EXCEEDED',
	)
})

void test('CRC和PNG块合法但IDAT不能真实解码时仍拒绝，不信读头成功', async () => {
	const zip = await JSZip.loadAsync(base),
		png = await zip.file('assets/header.png')!.async('uint8array'),
		ihdr = png.subarray(8, 33)
	const bad = joinBytes(
		png.subarray(0, 8),
		ihdr,
		chunk('IDAT', new Uint8Array([0, 0, 0, 0])),
		chunk('IEND', new Uint8Array()),
	)
	assert.deepEqual(inspectThemePng(bad, { ...themePackageLimits }), {
		width: 512,
		height: 256,
	})
	let calls = 0
	const tracking: ThemeImageDecoder = {
		decodeImage: async (...args) => {
			calls++
			return decoder.decodeImage(...args)
		},
	}
	await reject(
		validateThemePackage(
			await repack((targetZip, manifest) =>
				image(targetZip, manifest, 'assets/header.png', bad),
			),
			host,
			tracking,
		),
		'IMAGE_INVALID',
	)
	assert.equal(calls, 1)
})

void test('拒绝动画PNG和不诚实/不完整decoder结果', async () => {
	const zip = await JSZip.loadAsync(base),
		png = await zip.file('assets/header.png')!.async('uint8array')
	const frames = new Uint8Array(8)
	new DataView(frames.buffer).setUint32(0, 2)
	const animated = joinBytes(
		png.subarray(0, 33),
		chunk('acTL', frames),
		png.subarray(33),
	)
	await reject(
		validateThemePackage(
			await repack((targetZip, manifest) =>
				image(targetZip, manifest, 'assets/header.png', animated),
			),
			host,
			decoder,
		),
		'IMAGE_INVALID',
	)
	for (const change of [
		{ frames: 2 },
		{ mime: 'image/jpeg' },
		{ decodedBytes: 0 },
		{ width: 1 },
	]) {
		const bad: ThemeImageDecoder = {
			decodeImage: async (...args) =>
				({ ...(await decoder.decodeImage(...args)), ...change }) as Awaited<
					ReturnType<ThemeImageDecoder['decodeImage']>
				>,
		}
		await reject(validateThemePackage(base, host, bad), 'IMAGE_INVALID')
	}
})

void test('取消和只收紧限制不产Verified；哈希/CRC使用独立已知向量', async () => {
	const controller = new AbortController()
	controller.abort()
	await reject(
		validateThemePackage(base, host, decoder, { signal: controller.signal }),
		'CANCELLED',
	)
	await reject(
		validateThemePackage(base, host, decoder, {
			limits: { fileBytes: themePackageLimits.fileBytes + 1 },
		}),
		'LIMIT_EXCEEDED',
	)
	assert.equal(
		sha256(new TextEncoder().encode('abc')),
		'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
	)
	assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
})

void test('真实Sharp进行中取消可捕获且子进程不崩溃或悬挂', () => {
	const script = `
const assert = require('node:assert/strict');
const { createNodeImageDecoder, loadThemeCore, mobileRequire } = require('./scripts/lib/theme-package-node.cjs');
(async () => {
  const zip = await mobileRequire('jszip').loadAsync(require('node:fs').readFileSync('theme-packages/paper-signal.melotheme'));
  const png = await zip.file('assets/header.png').async('uint8array');
  const controller = new AbortController();
  const pending = createNodeImageDecoder().decodeImage(png, loadThemeCore().themePackageLimits, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await new Promise(resolve => setTimeout(resolve, 50));
  console.log('cancel-caught');
})().catch(error => { console.error(error); process.exitCode = 1; });`
	assert.match(
		execFileSync(process.execPath, ['-e', script], {
			cwd: root,
			timeout: 10000,
		}).toString(),
		/cancel-caught/,
	)
})

void test('作者build/validate命令实际完整解码，可复现ZIP且失败不覆盖已有输出', () => {
	const directory = mkdtempSync(join(tmpdir(), 'melocanvas-theme-author-'))
	if (
		!resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
		!basename(directory).startsWith('melocanvas-theme-author-')
	)
		throw new Error('Refusing cleanup outside test root')
	try {
		const cli = join(root, 'scripts/theme-package.cjs'),
			source = join(root, 'theme-packages/example'),
			a = join(directory, 'a.melotheme'),
			b = join(directory, 'b.melotheme')
		for (const output of [a, b])
			execFileSync(process.execPath, [cli, 'build', source, output], {
				timeout: 30000,
			})
		assert.deepEqual(readFileSync(a), readFileSync(b))
		assert.equal(
			JSON.parse(
				execFileSync(process.execPath, [cli, 'validate', a], {
					timeout: 30000,
				}).toString(),
			).installed,
			false,
		)
		const badSource = join(directory, 'source')
		mkdirSync(join(badSource, 'artwork'), { recursive: true })
		for (const name of [
			'source.json',
			'tokens.json',
			'components.json',
			'LICENSE.txt',
			'artwork/header.svg',
			'artwork/home.svg',
			'artwork/player.svg',
		])
			writeFileSync(join(badSource, name), readFileSync(join(source, name)))
		const file = join(badSource, 'source.json'),
			raw = JSON.parse(readFileSync(file, 'utf8'))
		raw.manifest.requiredCapabilities.push('execute-js')
		writeFileSync(file, JSON.stringify(raw))
		const before = readFileSync(a)
		assert.throws(
			() =>
				execFileSync(process.execPath, [cli, 'build', badSource, a], {
					timeout: 30000,
					stdio: 'pipe',
				}),
			/Command failed/,
		)
		assert.deepEqual(readFileSync(a), before)
		raw.manifest.requiredCapabilities.pop()
		for (const extension of ['svg', 'SVG', 'txt', 'png']) {
			const relative = `artwork/review.${extension}`
			writeFileSync(
				join(badSource, relative),
				'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>void 0</script><rect width="64" height="64"/></svg>',
			)
			raw.images['assets/header.png'] = relative
			writeFileSync(file, JSON.stringify(raw))
			assert.throws(
				() =>
					execFileSync(process.execPath, [cli, 'build', badSource, a], {
						timeout: 30000,
						stdio: 'pipe',
					}),
				/no disguised files, scripts or references/,
			)
			assert.deepEqual(readFileSync(a), before)
		}
	} finally {
		rmSync(directory, { recursive: true })
	}
})
