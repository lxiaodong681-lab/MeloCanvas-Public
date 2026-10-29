import CryptoJS from 'crypto-js'
import JSZip from 'jszip'

import {
	ThemePackageError,
	themePackageLimits,
	type ThemePackageFile,
	type ThemePackageLimits,
} from './theme-package-types'

export function packageError(
	code: ThemePackageError['code'],
	message: string,
): never {
	throw new ThemePackageError(code, message)
}
export function checkCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) packageError('CANCELLED', '主题包验证已取消')
}
export function effectiveLimits(
	overrides: Partial<ThemePackageLimits> = {},
): ThemePackageLimits {
	const result = { ...themePackageLimits }
	for (const key of Object.keys(overrides) as (keyof ThemePackageLimits)[]) {
		const value = overrides[key]
		if (
			value === undefined ||
			!Number.isSafeInteger(value) ||
			value <= 0 ||
			value > themePackageLimits[key]
		)
			packageError('LIMIT_EXCEEDED', '主题包限制只能收紧设计上限')
		result[key] = value
	}
	return result
}
function words(bytes: Uint8Array) {
	const values: number[] = []
	for (let i = 0; i < bytes.length; i++)
		values[i >>> 2] = (values[i >>> 2] || 0) | (bytes[i] << (24 - (i % 4) * 8))
	return CryptoJS.lib.WordArray.create(values, bytes.length)
}
export const sha256 = (bytes: Uint8Array): string =>
	CryptoJS.SHA256(words(bytes)).toString()
export function utf8(bytes: Uint8Array): string {
	try {
		return CryptoJS.enc.Utf8.stringify(words(bytes))
	} catch {
		return packageError('ARCHIVE_INVALID', '主题包含无效 UTF-8')
	}
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
	let n = value
	for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
	return n >>> 0
})
export function crc32(bytes: Uint8Array, previous = 0): number {
	let crc = previous ^ 0xffffffff
	for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8)
	return (crc ^ 0xffffffff) >>> 0
}
export function safePackagePath(path: string, directory = false): string {
	const file = directory ? path.slice(0, -1) : path
	if (
		!path ||
		path.length > 240 ||
		(directory && !path.endsWith('/')) ||
		path !== path.normalize('NFC') ||
		/[\\:%?#]/.test(path) ||
		Array.from(path).some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	)
		packageError('PATH_INVALID', '主题包路径不规范')
	const parts = file.split('/')
	if (
		parts.some(
			(part) =>
				!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(part) ||
				part.length > 64 ||
				/[. ]$/.test(part) ||
				/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
		)
	)
		packageError('PATH_INVALID', '主题包必须使用无歧义的包内相对路径')
	return file.normalize('NFC').toUpperCase().normalize('NFC')
}

interface ArchiveEntry {
	path: string
	directory: boolean
	size: number
	compressed: number
	crc: number
	start: number
	end: number
}
/** Metadata preflight only. STORE/DEFLATE decoding is delegated to locked JSZip. */
export function inspectThemeArchive(
	bytes: Uint8Array,
	limits: ThemePackageLimits,
): ArchiveEntry[] {
	if (!(bytes instanceof Uint8Array) || bytes.length > limits.archiveBytes)
		packageError('LIMIT_EXCEEDED', '主题压缩包超出上限')
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const range = (offset: number, length: number) => {
		if (offset < 0 || length < 0 || offset + length > bytes.length)
			packageError('ARCHIVE_INVALID', 'ZIP 数据被截断')
	}
	const u16 = (offset: number) => {
		range(offset, 2)
		return view.getUint16(offset, true)
	}
	const u32 = (offset: number) => {
		range(offset, 4)
		return view.getUint32(offset, true)
	}
	let end = -1
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
		if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) {
			end = i
			break
		}
	}
	if (end < 0) packageError('ARCHIVE_INVALID', 'ZIP 缺少完整目录结束记录')
	const count = u16(end + 10),
		centralSize = u32(end + 12),
		centralStart = u32(end + 16)
	if (
		count === 65535 ||
		centralSize === 0xffffffff ||
		centralStart === 0xffffffff
	)
		packageError('ARCHIVE_UNSUPPORTED', '首版主题包不支持 ZIP64')
	if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count)
		packageError('ARCHIVE_UNSUPPORTED', '首版主题包不支持分卷 ZIP')
	if (!count || count > limits.entries)
		packageError('LIMIT_EXCEEDED', 'ZIP 条目数量超限')
	if (centralStart + centralSize !== end)
		packageError('ARCHIVE_UNSUPPORTED', 'ZIP 目录布局不受支持')
	const entries: ArchiveEntry[] = [],
		keys = new Map<string, boolean>()
	let cursor = centralStart,
		declaredTotal = 0
	const extras = (
		offset: number,
		length: number,
		name: Uint8Array,
		decoded: string,
	) => {
		const stop = offset + length,
			seen = new Set<number>()
		range(offset, length)
		while (offset < stop) {
			if (offset + 4 > stop)
				packageError('ARCHIVE_INVALID', 'ZIP 额外字段被截断')
			const id = u16(offset),
				size = u16(offset + 2)
			offset += 4
			if (offset + size > stop || seen.has(id))
				packageError('ARCHIVE_INVALID', 'ZIP 额外字段不完整或重复')
			seen.add(id)
			if ([1, 0x9901, 0x000d, 0x756e].includes(id))
				packageError(
					'ARCHIVE_UNSUPPORTED',
					'ZIP64、加密或 Unix 链接额外字段不受支持',
				)
			if (
				id === 0x7075 &&
				(size < 5 ||
					bytes[offset] !== 1 ||
					u32(offset + 1) !== crc32(name) ||
					utf8(bytes.subarray(offset + 5, offset + size)) !== decoded)
			)
				packageError('PATH_INVALID', 'ZIP Unicode 路径别名不一致')
			offset += size
		}
	}
	for (let i = 0; i < count; i++) {
		range(cursor, 46)
		if (u32(cursor) !== 0x02014b50)
			packageError('ARCHIVE_INVALID', 'ZIP 中央目录损坏')
		const flags = u16(cursor + 8),
			method = u16(cursor + 10),
			crc = u32(cursor + 16),
			compressed = u32(cursor + 20),
			size = u32(cursor + 24)
		const nameLength = u16(cursor + 28),
			extraLength = u16(cursor + 30),
			commentLength = u16(cursor + 32),
			external = u32(cursor + 38),
			start = u32(cursor + 42)
		if (flags & 1) packageError('ARCHIVE_UNSUPPORTED', '不支持加密主题 ZIP')
		if (
			u16(cursor + 6) > 20 ||
			flags & ~0x080e ||
			![0, 8].includes(method) ||
			(method === 0 && flags & 6) ||
			u16(cursor + 34) ||
			[size, compressed, start].includes(0xffffffff)
		)
			packageError('ARCHIVE_UNSUPPORTED', 'ZIP 特性或压缩方式不受支持')
		range(cursor + 46, nameLength + extraLength + commentLength)
		const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength),
			path = utf8(rawName),
			directory = path.endsWith('/')
		if (!(flags & 0x0800) && rawName.some((value) => value > 127))
			packageError('ARCHIVE_UNSUPPORTED', '非 UTF-8 ZIP 文件名不受支持')
		const key = safePackagePath(path, directory),
			mode = external >>> 16,
			type = mode & 0xf000
		if (keys.has(key))
			packageError('PATH_INVALID', 'ZIP 路径重复或规范化后冲突')
		keys.set(key, directory)
		if (
			(type && type !== (directory ? 0x4000 : 0x8000)) ||
			(!directory && mode & 0o111) ||
			(!!(external & 0x10) !== directory && !!(external & 0x10))
		)
			packageError('PATH_INVALID', 'ZIP 链接、特殊文件或属性不一致')
		if (directory && (size || compressed || crc))
			packageError('ARCHIVE_INVALID', 'ZIP 目录不能含数据')
		if (
			size > limits.fileBytes ||
			size / Math.max(compressed, 1) > limits.expansionRatio ||
			(declaredTotal += size) > limits.totalBytes
		)
			packageError('LIMIT_EXCEEDED', 'ZIP 声明大小或膨胀比例超限')
		extras(cursor + 46 + nameLength, extraLength, rawName, path)
		range(start, 30)
		if (
			u32(start) !== 0x04034b50 ||
			u16(start + 6) !== flags ||
			u16(start + 8) !== method ||
			u16(start + 4) > 20
		)
			packageError('ARCHIVE_INVALID', 'ZIP 本地头与中央目录不一致')
		const localNameLength = u16(start + 26),
			localExtraLength = u16(start + 28),
			content = start + 30 + localNameLength + localExtraLength
		range(start + 30, localNameLength + localExtraLength)
		if (
			localNameLength !== rawName.length ||
			rawName.some((value, index) => value !== bytes[start + 30 + index])
		)
			packageError('PATH_INVALID', 'ZIP 本地路径与中央目录不一致')
		extras(start + 30 + localNameLength, localExtraLength, rawName, path)
		for (const [offset, expected] of [
			[14, crc],
			[18, compressed],
			[22, size],
		]) {
			const actual = u32(start + offset)
			if (actual !== expected && (!(flags & 8) || actual !== 0))
				packageError('ARCHIVE_INVALID', 'ZIP 本地长度或 CRC 不一致')
		}
		let finish = content + compressed
		range(content, compressed)
		if (flags & 8) {
			// A CRC may itself equal the optional descriptor signature. Match the
			// complete 32-bit form rather than treating its first word as a tag.
			const forms = [0, 4].filter(
				(signature) =>
					finish + signature + 12 <= centralStart &&
					(!signature || u32(finish) === 0x08074b50) &&
					u32(finish + signature) === crc &&
					u32(finish + signature + 4) === compressed &&
					u32(finish + signature + 8) === size,
			)
			if (!forms.length)
				packageError('ARCHIVE_INVALID', 'ZIP data descriptor 不一致')
			if (forms.length !== 1)
				packageError('ARCHIVE_UNSUPPORTED', 'ZIP data descriptor 形态有歧义')
			finish += forms[0] + 12
		}
		if (finish > centralStart)
			packageError('ARCHIVE_INVALID', 'ZIP 条目越过目录边界')
		entries.push({ path, directory, size, compressed, crc, start, end: finish })
		cursor += 46 + nameLength + extraLength + commentLength
	}
	if (cursor !== centralStart + centralSize)
		packageError('ARCHIVE_INVALID', 'ZIP 条目数量与目录长度不一致')
	let expectedStart = 0
	for (const entry of [...entries].sort((a, b) => a.start - b.start)) {
		if (entry.start !== expectedStart)
			packageError('ARCHIVE_UNSUPPORTED', 'ZIP 包含重叠、前缀或未索引的数据')
		expectedStart = entry.end
		const parts = entry.path.replace(/\/$/, '').split('/')
		for (let n = 1; n < parts.length; n++)
			if (
				keys.get(parts.slice(0, n).join('/').toUpperCase().normalize('NFC')) ===
				false
			)
				packageError('PATH_INVALID', 'ZIP 文件和目录路径冲突')
	}
	if (expectedStart !== centralStart)
		packageError('ARCHIVE_UNSUPPORTED', 'ZIP 本地数据未完整索引')
	return entries
}

interface ByteStream {
	on(event: 'data', handler: (chunk: Uint8Array) => void): ByteStream
	on(event: 'error', handler: (error: unknown) => void): ByteStream
	on(event: 'end', handler: () => void): ByteStream
	pause(): ByteStream
	resume(): ByteStream
}

export async function readThemeArchive(
	input: Uint8Array,
	limits: ThemePackageLimits,
	signal?: AbortSignal,
): Promise<{ archiveSha256: string; files: ThemePackageFile[] }> {
	checkCancelled(signal)
	if (!(input instanceof Uint8Array) || input.length > limits.archiveBytes)
		packageError('LIMIT_EXCEEDED', '主题压缩包超出上限')
	const bytes = new Uint8Array(input),
		entries = inspectThemeArchive(bytes, limits)
	let zip: JSZip
	try {
		zip = await JSZip.loadAsync(bytes, {
			checkCRC32: false,
			createFolders: false,
		})
	} catch (cause) {
		throw new ThemePackageError('ARCHIVE_INVALID', 'ZIP 无法读取', { cause })
	}
	let total = 0
	const files: ThemePackageFile[] = []
	for (const entry of entries) {
		checkCancelled(signal)
		if (entry.directory) continue
		const file = zip.file(entry.path)
		if (!file || file.unsafeOriginalName !== entry.path)
			packageError('PATH_INVALID', 'ZIP 解码路径不一致')
		const cap = entry.path.endsWith('.json')
			? limits.jsonBytes
			: entry.path === 'LICENSE.txt'
				? limits.licenseBytes
				: limits.fileBytes
		if (entry.size > cap) packageError('LIMIT_EXCEEDED', '主题文件声明长度超限')
		const content = await new Promise<Uint8Array>((resolve, reject) => {
			const stream = (
				file as JSZip.JSZipObject & {
					internalStream(type: 'uint8array'): ByteStream
				}
			).internalStream('uint8array')
			const chunks: Uint8Array[] = []
			let size = 0,
				crc = 0,
				settled = false
			const fail = (error: unknown) => {
				if (settled) return
				settled = true
				stream.pause()
				signal?.removeEventListener('abort', abort)
				reject(error)
			}
			const abort = () =>
				fail(new ThemePackageError('CANCELLED', '主题包验证已取消'))
			signal?.addEventListener('abort', abort, { once: true })
			stream
				.on('data', (chunk) => {
					if (settled) return
					if (signal?.aborted) return abort()
					if (
						size + chunk.length > cap ||
						total + chunk.length > limits.totalBytes ||
						size + chunk.length > entry.size
					)
						return fail(
							new ThemePackageError(
								'LIMIT_EXCEEDED',
								'ZIP 实际解压字节超出预算或声明',
							),
						)
					size += chunk.length
					total += chunk.length
					crc = crc32(chunk, crc)
					chunks.push(new Uint8Array(chunk))
				})
				.on('error', (cause) =>
					fail(
						new ThemePackageError('ARCHIVE_INVALID', 'ZIP 解压失败', { cause }),
					),
				)
				.on('end', () => {
					if (settled) return
					if (size !== entry.size || crc !== entry.crc)
						return fail(
							new ThemePackageError(
								'ARCHIVE_INVALID',
								'ZIP 实际长度或 CRC 校验失败',
							),
						)
					settled = true
					signal?.removeEventListener('abort', abort)
					const output = new Uint8Array(size)
					let offset = 0
					for (const chunk of chunks) {
						output.set(chunk, offset)
						offset += chunk.length
					}
					resolve(output)
				})
				.resume()
		})
		files.push({ path: entry.path, bytes: content, sha256: sha256(content) })
	}
	return { archiveSha256: sha256(bytes), files }
}
