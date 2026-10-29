import {
	checkCancelled,
	crc32,
	effectiveLimits,
	packageError,
	readThemeArchive,
	safePackagePath,
	utf8,
} from './theme-archive'
import {
	ThemePackageError,
	packageThemeIconNames,
	themePackageLimits,
	type DecodedThemeImage,
	type PackageResourceReference,
	type PackageThemeComponents,
	type PackageThemeIconStates,
	type PackageThemeIcons,
	type PackageThemeTokens,
	type ParsedThemeDocuments,
	type ThemeImageDecoder,
	type ThemePackageHost,
	type ThemePackageLimits,
	type ThemePackageManifest,
	type VerifiedThemePackage,
} from './theme-package-types'

export const packageCapabilities = Object.freeze([
	'semantic-colors',
	'icons',
	'backgrounds',
	'component-variants',
	'player-frame',
	'motion-presets',
	'dark-tokens',
	'responsive-touch-layout-v1',
	'package-icons-v1',
	'custom-progress-v1',
	'surface-art-v1',
	'collection-art-v1',
] as const)
function fail(message: string): never {
	return packageError('MANIFEST_INVALID', message)
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		fail('主题配置字段必须为对象')
	return value as Record<string, unknown>
}
function text(value: unknown, max = 256): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value !== value.trim() ||
		value.length > max ||
		Array.from(value).some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	)
		fail('主题文本字段无效')
	return value
}
function integer(value: unknown, min: number, max: number): number {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max
	)
		fail('主题数值字段超出范围')
	return value
}
function version(value: unknown) {
	const source = text(value, 80),
		match =
			/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
				source,
			)
	if (!match) fail('主题版本必须为规范语义版本')
	const numbers = match.slice(1, 4).map(Number),
		pre = match[4]?.split('.') ?? []
	if (
		numbers.some((n) => !Number.isSafeInteger(n)) ||
		pre.some(
			(part) =>
				/^[0-9]+$/.test(part) && part.length > 1 && part.startsWith('0'),
		)
	)
		fail('主题版本数值无效')
	return { source, numbers, pre }
}
function atLeast(
	actual: ReturnType<typeof version>,
	minimum: ReturnType<typeof version>,
): boolean {
	for (let i = 0; i < 3; i++)
		if (actual.numbers[i] !== minimum.numbers[i])
			return actual.numbers[i] > minimum.numbers[i]
	if (!actual.pre.length || !minimum.pre.length) return !actual.pre.length
	for (let i = 0; i < Math.max(actual.pre.length, minimum.pre.length); i++) {
		const a = actual.pre[i],
			b = minimum.pre[i]
		if (a === b) continue
		if (a === undefined || b === undefined) return b === undefined
		const an = /^[0-9]+$/.test(a),
			bn = /^[0-9]+$/.test(b)
		if (an !== bn) return !an
		return an && a.length !== b.length ? a.length > b.length : a > b
	}
	return true
}
function strings(value: unknown, max = 80): string[] {
	if (!Array.isArray(value) || value.length > 64) fail('主题能力列表无效')
	const result = value.map((entry) => text(entry, max))
	if (new Set(result).size !== result.length) fail('主题能力重复')
	return result
}
function exactKeys(raw: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(raw).some((key) => !allowed.includes(key)))
		fail('主题配置含尚未实现的功能字段')
}
function color(value: unknown): string {
	if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))
		fail('主题颜色必须为六位 HEX')
	return value
}
function tokens(value: unknown): PackageThemeTokens {
	const raw = object(value)
	exactKeys(raw, ['surface', 'text', 'action', 'state', 'border', 'lyric', 'progress', 'navigation'])
	const group = <T extends string>(
		name: string,
		keys: T[],
	): Record<T, string> => {
		const values = object(raw[name])
		exactKeys(values, keys)
		return Object.fromEntries(
			keys.map((key) => [key, color(values[key])]),
		) as Record<T, string>
	}
	return {
		surface: group('surface', ['base', 'card', 'tinted']),
		text: group('text', ['primary', 'secondary', 'inverse']),
		action: group('action', ['primary']),
		state: group('state', ['error']),
		border: group('border', ['subtle', 'strong']),
		lyric: group('lyric', ['active', 'inactive']),
		...(raw.progress !== undefined ? { progress: group('progress', ['track', 'fill', 'thumb']) } : {}),
		...(raw.navigation !== undefined ? { navigation: group('navigation', ['normal', 'selected']) } : {}),
	}
}
function choose<T extends string>(value: unknown, choices: readonly T[]): T {
	if (!choices.includes(value as T)) fail('主题组件变体不受支持')
	return value as T
}
function iconMappings(value: unknown): PackageThemeIcons {
	const raw = object(value)
	exactKeys(raw, [...packageThemeIconNames])
	const path = (pathValue: unknown): string => {
		const result = text(pathValue, 240)
		safePackagePath(result)
		if (!/^assets\/.+\.png$/.test(result))
			fail('主题图标必须引用 assets 内的静态 PNG')
		return result
	}
	const states = (stateValue: unknown): PackageThemeIconStates => {
		const state = object(stateValue)
		exactKeys(state, ['normal', 'selected'])
		return {
			normal: path(state.normal),
			...(state.selected !== undefined
				? { selected: path(state.selected) }
				: {}),
		}
	}
	return Object.fromEntries(
		Object.entries(raw).map(([name, iconValue]) => {
			const entry = object(iconValue)
			exactKeys(entry, ['light', 'dark'])
			return [
				name,
				{
					light: states(entry.light),
					...(entry.dark !== undefined ? { dark: states(entry.dark) } : {}),
				},
			]
		}),
	)
}
function componentConfig(value: unknown): PackageThemeComponents {
	const raw = object(value)
	exactKeys(raw, [
		'card',
		'button',
		'input',
		'navigation',
		'player',
		'progress',
		'layout',
		'icons',
	])
	const variant = (name: string) => {
		const part = object(raw[name])
		exactKeys(part, name === 'button' ? ['variant', 'minTouchDp'] : ['variant'])
		return choose(part.variant, ['rounded', 'leaf', 'comic'] as const)
	}
	const navigation = object(raw.navigation),
		player = object(raw.player),
		progress = object(raw.progress)
	exactKeys(navigation, ['discoverIcon'])
	exactKeys(player, ['frame'])
	exactKeys(progress, ['variant', 'thumb'])
	let thumb: PackageThemeComponents['progress']['thumb']
	if (progress.thumb !== undefined) {
		const rawThumb = object(progress.thumb)
		exactKeys(rawThumb, ['light', 'dark', 'sizeDp', 'dragLeft', 'dragRight'])
		const path = (pathValue: unknown) => {
			const result = text(pathValue, 240)
			safePackagePath(result)
			if (!/^assets\/.+\.png$/.test(result)) fail('滑块图片必须引用 assets 内的静态 PNG')
			return result
		}
		thumb = { light: path(rawThumb.light), sizeDp: integer(rawThumb.sizeDp, 16, 40),
			...(rawThumb.dark !== undefined ? { dark: path(rawThumb.dark) } : {}),
			...(rawThumb.dragLeft !== undefined ? { dragLeft: path(rawThumb.dragLeft) } : {}),
			...(rawThumb.dragRight !== undefined ? { dragRight: path(rawThumb.dragRight) } : {}) }
	}
	const minTouchDp = integer(object(raw.button).minTouchDp, 48, 96)
	let layout: PackageThemeComponents['layout']
	if (raw.layout !== undefined) {
		const values = object(raw.layout)
		exactKeys(values, ['compactMinTouchDp', 'narrowFallback'])
		layout = {
			narrowFallback: choose(values.narrowFallback, [
				'reject',
				'host-single-row',
			]),
			...(values.compactMinTouchDp !== undefined
				? {
						compactMinTouchDp: integer(
							values.compactMinTouchDp,
							48,
							minTouchDp,
						),
					}
				: {}),
		}
	}
	return {
		card: { variant: variant('card') },
		button: {
			variant: variant('button'),
			minTouchDp,
		},
		input: { variant: variant('input') },
		navigation: {
			discoverIcon: choose(navigation.discoverIcon, ['home', 'flower', 'star']),
		},
		player: { frame: choose(player.frame, ['square', 'arch', 'tilted']) },
		progress: {
			variant: choose(progress.variant, ['modern', 'pastoral', 'anime']),
			...(thumb ? { thumb } : {}),
		},
		...(layout ? { layout } : {}),
		...(raw.icons !== undefined ? { icons: iconMappings(raw.icons) } : {}),
	}
}

/** A parsed configuration is not an installable package and cannot bypass byte checks. */
export function parseThemeDocuments(
	input: { manifest: unknown; tokens: unknown; components: unknown },
	host: ThemePackageHost,
): ParsedThemeDocuments {
	const raw = object(input.manifest),
		warnings: string[] = []
	if (raw.format !== 'melocanvas-theme' || raw.schemaVersion !== 1)
		packageError(
			'INCOMPATIBLE',
			'只接受首个正式 ZIP 主题结构；设计 inline 与 lab-json 不兼容',
		)
	const id = text(raw.id, 100)
	if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(id))
		fail('主题 ID 必须为稳定作者命名空间')
	const packageVersion = version(raw.version),
		minimum = version(raw.minAppVersion)
	if (!atLeast(version(host.appVersion), minimum))
		packageError('INCOMPATIBLE', '主题要求较新的 App 版本')
	const requiredCapabilities = strings(raw.requiredCapabilities),
		optionalCapabilities = strings(raw.optionalCapabilities)
	if (
		requiredCapabilities.some((capability) =>
			optionalCapabilities.includes(capability),
		)
	)
		fail('主题必需和可选能力不能重叠')
	const supported = (capability: string) =>
		(packageCapabilities as readonly string[]).includes(capability) &&
		host.capabilities.includes(capability)
	const missing = requiredCapabilities.filter(
		(capability) => !supported(capability),
	)
	if (missing.length) {
		host.onMissingCapabilities?.(missing)
		packageError('INCOMPATIBLE', '主题要求宿主尚未实现的必需能力')
	}
	for (const capability of optionalCapabilities)
		if (!supported(capability))
			warnings.push(`可选能力未启用，使用宿主回退：${capability}`)
	for (const capability of [
		'semantic-colors',
		'icons',
		'component-variants',
		'player-frame',
		'motion-presets',
	])
		if (!requiredCapabilities.includes(capability))
			fail(`基础主题必须声明必需能力：${capability}`)
	const entry = object(raw.entry)
	exactKeys(entry, ['tokens', 'components'])
	if (
		entry.tokens !== 'tokens.json' ||
		entry.components !== 'components.json' ||
		raw.fallback !== 'melocanvas.builtin.modern'
	)
		fail('主题入口或内置回退无效')
	if (
		!Array.isArray(raw.assets) ||
		raw.assets.length > themePackageLimits.assets
	)
		fail('主题资源索引无效或超限')
	const paths = new Set<string>()
	const assets = raw.assets.map((assetEntry) => {
		const asset = object(assetEntry)
		exactKeys(asset, ['path', 'mime', 'bytes', 'sha256'])
		const path = text(asset.path, 240),
			key = safePackagePath(path)
		if (!/^(assets|previews)\/.+\.png$/.test(path) || paths.has(key))
			fail('主题资源路径或重复索引无效')
		paths.add(key)
		if (asset.mime !== 'image/png')
			packageError(
				'RESOURCE_INVALID',
				'当前只支持实际静态 PNG；其他资源类型尚未实现校验',
			)
		const digest = text(asset.sha256, 64)
		if (!/^[0-9a-f]{64}$/.test(digest)) fail('主题资源 SHA-256 无效')
		return {
			path,
			mime: 'image/png' as const,
			bytes: integer(asset.bytes, 1, themePackageLimits.fileBytes),
			sha256: digest,
		}
	})
	const previews = strings(raw.previews, 240)
	if (
		!previews.length ||
		previews.length > 8 ||
		previews.some(
			(path) =>
				!path.startsWith('previews/') ||
				!assets.some((asset) => asset.path === path),
		)
	)
		fail('主题预览必须引用索引内资源')
	for (const key of Object.keys(raw))
		if (
			![
				'format',
				'schemaVersion',
				'id',
				'version',
				'name',
				'author',
				'minAppVersion',
				'license',
				'entry',
				'fallback',
				'requiredCapabilities',
				'optionalCapabilities',
				'assets',
				'previews',
			].includes(key)
		)
			warnings.push(`未使用的清单元数据字段：${key}`)
	const tokenDocument = object(input.tokens)
	exactKeys(tokenDocument, ['light', 'dark'])
	const light = tokens(tokenDocument.light),
		dark =
			tokenDocument.dark === undefined ? undefined : tokens(tokenDocument.dark)
	if (
		dark &&
		!requiredCapabilities.includes('dark-tokens') &&
		!optionalCapabilities.includes('dark-tokens')
	)
		fail('深色 token 组必须声明对应能力')
	if (dark && !supported('dark-tokens'))
		warnings.push('宿主未支持深色组，使用宿主内置深色回退')
	const document = object(input.components)
	if ((light.navigation || dark?.navigation) && !requiredCapabilities.includes('surface-art-v1'))
		fail('导航配色必须声明 surface-art-v1 必需能力')
	exactKeys(document, ['components', 'decorations', 'motion'])
	const components = componentConfig(document.components),
		decorations = object(document.decorations),
		motion = object(document.motion)
	if (light.progress || dark?.progress || components.progress.thumb) {
		if (!requiredCapabilities.includes('custom-progress-v1'))
			fail('自定义进度条必须声明 custom-progress-v1 必需能力')
		if ((components.progress.thumb?.dragLeft || components.progress.thumb?.dragRight) && !requiredCapabilities.includes('collection-art-v1')) fail('滑块方向图片必须声明 collection-art-v1')
		for (const path of [components.progress.thumb?.light, components.progress.thumb?.dark, components.progress.thumb?.dragLeft, components.progress.thumb?.dragRight])
			if (path !== undefined && !assets.some((asset) => asset.path === path))
				fail('滑块图片引用未索引的资源')
	}
	if (
		components.layout &&
		!requiredCapabilities.includes('responsive-touch-layout-v1')
	)
		fail('紧凑触控配置必须声明 responsive-touch-layout-v1 必需能力')
	if (components.icons) {
		if (!requiredCapabilities.includes('package-icons-v1'))
			fail('包内图标配置必须声明 package-icons-v1 必需能力')
		for (const [name, icon] of Object.entries(components.icons)) {
			for (const states of [icon.light, icon.dark]) {
				if (!states) continue
				for (const path of [states.normal, states.selected])
					if (
						path !== undefined &&
						!assets.some((asset) => asset.path === path)
					)
						fail('主题图标引用未索引的资源')
			}
			if (!icon.dark)
				warnings.push(`深色图标资源缺失，宿主须回退矢量图标：${name}`)
		}
	}
	exactKeys(decorations, ['hero', 'backdrop', 'banner', 'navigation', 'pageHeader', 'profileBackground', 'avatarFrame'])
	exactKeys(motion, ['durationMs', 'respectReducedMotion'])
	const resultDecorations: ParsedThemeDocuments['decorations'] = {}
	for (const slot of ['hero', 'backdrop', 'banner', 'navigation', 'pageHeader', 'profileBackground', 'avatarFrame'] as const)
		if (decorations[slot] !== undefined) {
			if ((slot === 'profileBackground' || slot === 'avatarFrame') && !requiredCapabilities.includes('collection-art-v1')) fail('资料背景与头像挂件必须声明 collection-art-v1')
			if (slot === 'banner' || slot === 'navigation' || slot === 'pageHeader') {
				if (!requiredCapabilities.includes('surface-art-v1')) fail('主视觉与导航背景必须声明 surface-art-v1 必需能力')
			}
			const path = text(decorations[slot], 240)
			if (!assets.some((asset) => asset.path === path))
				fail('主题装饰引用未声明的资源')
			if (
				!requiredCapabilities.includes('backgrounds') &&
				!optionalCapabilities.includes('backgrounds')
			)
				fail('主题装饰必须声明 backgrounds 能力')
			if (supported('backgrounds')) resultDecorations[slot] = path
			else warnings.push(`装饰槽未启用，使用内置回退：${slot}`)
		}
	if (motion.respectReducedMotion !== true) fail('主题必须尊重减少动态设置')
	const manifest: ThemePackageManifest = {
		format: 'melocanvas-theme',
		schemaVersion: 1,
		id,
		version: packageVersion.source,
		name: text(raw.name),
		author: text(raw.author),
		minAppVersion: minimum.source,
		license: text(raw.license, 512),
		entry: { tokens: 'tokens.json', components: 'components.json' },
		fallback: 'melocanvas.builtin.modern',
		requiredCapabilities,
		optionalCapabilities,
		assets,
		previews,
	}
	return {
		manifest,
		tokens: { light, ...(dark && supported('dark-tokens') ? { dark } : {}) },
		components,
		decorations: resultDecorations,
		motion: {
			durationMs: integer(motion.durationMs, 0, 500),
			respectReducedMotion: true,
		},
		warnings,
	}
}

/** Header/chunk/CRC preflight only. A trusted decoder must still decode all pixels. */
export function inspectThemePng(
	bytes: Uint8Array,
	limits: ThemePackageLimits,
): { width: number; height: number } {
	const signature = [137, 80, 78, 71, 13, 10, 26, 10]
	if (signature.some((value, index) => bytes[index] !== value))
		packageError('IMAGE_INVALID', '资源声明 PNG 但实际格式不匹配')
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let offset = 8,
		width = 0,
		height = 0,
		seenData = false
	while (offset < bytes.length) {
		if (offset + 12 > bytes.length) packageError('IMAGE_INVALID', 'PNG 被截断')
		const length = view.getUint32(offset),
			end = offset + length + 12
		if (end > bytes.length) packageError('IMAGE_INVALID', 'PNG 块长度越界')
		const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
		if (
			!/^[A-Za-z]{4}$/.test(type) ||
			crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)
		)
			packageError('IMAGE_INVALID', 'PNG 块校验失败')
		if (['acTL', 'fcTL', 'fdAT'].includes(type))
			packageError('IMAGE_INVALID', '主题图片不支持动画或多帧 PNG')
		if (offset === 8 && (type !== 'IHDR' || length !== 13))
			packageError('IMAGE_INVALID', 'PNG 缺少规范 IHDR')
		if (type === 'IHDR') {
			if (offset !== 8 || length !== 13)
				packageError('IMAGE_INVALID', 'PNG IHDR 重复或无效')
			width = view.getUint32(offset + 8)
			height = view.getUint32(offset + 12)
			if (
				!width ||
				!height ||
				width > limits.imageDimension ||
				height > limits.imageDimension ||
				width * height > limits.imagePixels ||
				width * height * 4 > limits.decodedImageBytes
			)
				packageError('LIMIT_EXCEEDED', 'PNG 像素或解码预算超限')
			if (
				![1, 2, 4, 8].includes(bytes[offset + 16]) ||
				![0, 2, 3, 4, 6].includes(bytes[offset + 17]) ||
				bytes[offset + 18] ||
				bytes[offset + 19] ||
				bytes[offset + 20] > 1
			)
				packageError('IMAGE_INVALID', '首版仅支持不超过 8 bit 的规范静态 PNG')
		}
		if (type === 'IDAT') seenData = true
		if (/^[A-Z]/.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type))
			packageError('IMAGE_INVALID', 'PNG 含未知必需块')
		if (type === 'IEND') {
			if (length || end !== bytes.length || !seenData)
				packageError('IMAGE_INVALID', 'PNG 结束记录不完整或含尾随数据')
			return { width, height }
		}
		offset = end
	}
	return packageError('IMAGE_INVALID', 'PNG 缺少完整 IEND')
}

export async function validateThemePackage(
	bytes: Uint8Array,
	host: ThemePackageHost,
	decoder: ThemeImageDecoder,
	options: { limits?: Partial<ThemePackageLimits>; signal?: AbortSignal } = {},
): Promise<VerifiedThemePackage> {
	if (!decoder || typeof decoder.decodeImage !== 'function')
		packageError(
			'DECODER_REQUIRED',
			'缺少真实完整图片解码器，主题包不能通过完整验证',
		)
	const limits = effectiveLimits(options.limits),
		{ signal } = options
	const archive = await readThemeArchive(bytes, limits, signal),
		byPath = new Map(archive.files.map((file) => [file.path, file]))
	const json = (path: string): unknown => {
		const file = byPath.get(path)
		if (!file) fail(`主题包缺少 ${path}`)
		try {
			return JSON.parse(utf8(file.bytes)) as unknown
		} catch (cause) {
			throw new ThemePackageError(
				'MANIFEST_INVALID',
				`主题配置无法读取：${path}`,
				{ cause },
			)
		}
	}
	const parsed = parseThemeDocuments(
		{
			manifest: json('manifest.json'),
			tokens: json('tokens.json'),
			components: json('components.json'),
		},
		host,
	)
	if (parsed.manifest.assets.length > limits.assets)
		packageError('LIMIT_EXCEEDED', '主题资源数量超限')
	const license = byPath.get('LICENSE.txt')
	if (
		!license ||
		!utf8(license.bytes).trim() ||
		license.bytes.length > limits.licenseBytes
	)
		fail('主题包必须含非空 LICENSE.txt')
	const allowed = new Set([
		'manifest.json',
		'tokens.json',
		'components.json',
		'LICENSE.txt',
		...parsed.manifest.assets.map((asset) => asset.path),
	])
	if (
		archive.files.some((file) => !allowed.has(file.path)) ||
		allowed.size !== archive.files.length
	)
		packageError('RESOURCE_INVALID', '主题包含未声明文件或缺少声明资源')
	// Bilibili themes often reuse the same PNG for several icon states. Keep only
	// verified metadata within this validation, never decoded bitmaps across loads.
	const decoded = new Map<string, DecodedThemeImage>()
	for (const asset of parsed.manifest.assets) {
		checkCancelled(signal)
		const file = byPath.get(asset.path)
		if (
			!file ||
			file.bytes.length !== asset.bytes ||
			file.sha256 !== asset.sha256
		)
			packageError(
				'RESOURCE_INVALID',
				`主题资源实际长度或哈希不匹配：${asset.path}`,
			)
		const header = inspectThemePng(file.bytes, limits)
		const thumb = parsed.components.progress.thumb
		if (thumb && [thumb.light, thumb.dark, thumb.dragLeft, thumb.dragRight].includes(asset.path) &&
			(header.width > 256 || header.height > 256 || file.bytes.length > 256 * 1024))
			packageError('LIMIT_EXCEEDED', '滑块图片限 256×256 像素和 256 KiB，避免播放时加载大图')
		let image: DecodedThemeImage
		try {
			image = decoded.get(file.sha256) ??
				await decoder.decodeImage(
					new Uint8Array(file.bytes),
					Object.freeze({ ...limits }),
					signal,
				)
		} catch (cause) {
			checkCancelled(signal)
			throw new ThemePackageError(
				'IMAGE_INVALID',
				`主题图片无法完整解码：${asset.path}`,
				{ cause },
			)
		}
		checkCancelled(signal)
		if (
			!image ||
			image.mime !== 'image/png' ||
			image.frames !== 1 ||
			image.width !== header.width ||
			image.height !== header.height ||
			image.decodedBytes !== header.width * header.height * 4 ||
			image.decodedBytes > limits.decodedImageBytes
		)
			packageError('IMAGE_INVALID', '图片真实解码结果与资源声明或预算不一致')
		file.image = { ...image }
		decoded.set(file.sha256, { ...image })
	}
	checkCancelled(signal)
	const resources: PackageResourceReference[] = parsed.manifest.assets.map(
		(asset) => ({
			kind: 'package',
			path: asset.path,
			sha256: asset.sha256,
			mime: asset.mime,
		}),
	)
	const reference = (path: string | undefined) =>
		path ? resources.find((asset) => asset.path === path)! : undefined
	// The brand is deliberately only minted after every byte and decoder check.
	return {
		manifest: parsed.manifest,
		files: archive.files,
		snapshot: {
			schemaVersion: 1,
			package: {
				id: parsed.manifest.id,
				version: parsed.manifest.version,
				archiveSha256: archive.archiveSha256,
			},
			tokens: parsed.tokens,
			components: parsed.components,
			motion: parsed.motion,
			assets: {
				hero: reference(parsed.decorations.hero) ?? {
					kind: 'builtin',
					theme: 'modern',
					role: 'hero',
				},
				backdrop: reference(parsed.decorations.backdrop) ?? null,
				...(parsed.decorations.banner ? { banner: reference(parsed.decorations.banner) } : {}),
				...(parsed.decorations.navigation ? { navigation: reference(parsed.decorations.navigation) } : {}),
				...(parsed.decorations.pageHeader ? { pageHeader: reference(parsed.decorations.pageHeader) } : {}),
				...(parsed.decorations.profileBackground ? { profileBackground: reference(parsed.decorations.profileBackground) } : {}),
				...(parsed.decorations.avatarFrame ? { avatarFrame: reference(parsed.decorations.avatarFrame) } : {}),
			},
			resources,
			warnings: parsed.warnings,
		},
	} as VerifiedThemePackage
}
