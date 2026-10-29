import {
	ThemePackageError,
	themePackageLimits,
	type DecodedThemeImage,
	type ThemeImageDecoder,
	type ThemePackageLimits,
} from './core/theme-package-types'

type ImageLimits = Pick<
	ThemePackageLimits,
	'fileBytes' | 'imagePixels' | 'imageDimension' | 'decodedImageBytes'
>
export type ThemeImageDecodeBridge = (
	bytes: Uint8Array,
	limits: ImageLimits,
) => Promise<DecodedThemeImage>

const nativeDecode: ThemeImageDecodeBridge = async (bytes, limits) => {
	let native: typeof import('@bbplayer/native')
	try {
		native = await import('@bbplayer/native')
	} catch (cause) {
		throw new ThemePackageError('DECODER_REQUIRED', '缺少原生图片解码器', {
			cause,
		})
	}
	if (typeof native.decodeThemeImageAsync !== 'function')
		throw new ThemePackageError(
			'DECODER_REQUIRED',
			'当前原生版本不含图片解码器',
		)
	return native.decodeThemeImageAsync(bytes, limits)
}
const cancelled = () => new ThemePackageError('CANCELLED', '主题图片解码已取消')

/** Cancellation rejects only after native settles, so installer drain owns the real slot. */
export function createThemeImageDecoder(
	bridge: ThemeImageDecodeBridge = nativeDecode,
): ThemeImageDecoder {
	let busy = false
	return {
		decodeImage(bytes, limits, signal) {
			if (signal?.aborted) return Promise.reject(cancelled())
			const bounded = {} as ImageLimits
			for (const key of [
				'fileBytes',
				'imagePixels',
				'imageDimension',
				'decodedImageBytes',
			] as const) {
				const value = limits[key]
				if (
					!Number.isSafeInteger(value) ||
					value < 1 ||
					value > themePackageLimits[key]
				)
					return Promise.reject(
						new ThemePackageError(
							'LIMIT_EXCEEDED',
							'图片解码预算无效或超过宿主上限',
						),
					)
				bounded[key] = value
			}
			if (!bytes.byteLength || bytes.byteLength > bounded.fileBytes)
				return Promise.reject(
					new ThemePackageError('LIMIT_EXCEEDED', '图片输入字节超限'),
				)
			if (busy)
				return Promise.reject(
					new ThemePackageError('IMAGE_INVALID', '图片解码器忙，请稍后重试'),
				)
			busy = true
			let snapshot: Uint8Array
			try {
				snapshot = new Uint8Array(bytes)
			} catch (cause) {
				busy = false
				return Promise.reject(
					new ThemePackageError('IMAGE_INVALID', '无法复制图片字节', { cause }),
				)
			}
			return new Promise((resolve, reject) => {
				let settled = false
				const finish = (error?: unknown, value?: DecodedThemeImage) => {
					if (settled) return
					settled = true
					if (error) reject(error)
					else resolve(value!)
				}
				// UI cancellation can hide the operation immediately, but its promise
				// must not finish before the underlying native work releases admission.
				Promise.resolve()
					.then(() => {
						if (signal?.aborted) throw cancelled()
						return bridge(snapshot, Object.freeze(bounded))
					})
					.then(
						(image) => {
							busy = false
							if (signal?.aborted) {
								finish(cancelled())
								return
							}
							if (
								!image ||
								image.mime !== 'image/png' ||
								image.frames !== 1 ||
								!Number.isSafeInteger(image.width) ||
								!Number.isSafeInteger(image.height) ||
								image.width < 1 ||
								image.height < 1 ||
								image.width > bounded.imageDimension ||
								image.height > bounded.imageDimension ||
								image.width * image.height > bounded.imagePixels ||
								image.decodedBytes !== image.width * image.height * 4 ||
								image.decodedBytes > bounded.decodedImageBytes
							) {
								finish(
									new ThemePackageError(
										'IMAGE_INVALID',
										'原生图片解码结果不符合预算',
									),
								)
								return
							}
							finish(undefined, { ...image })
						},
						(cause: unknown) => {
							busy = false
							if (signal?.aborted) {
								finish(cancelled())
								return
							}
							const code =
								cause && typeof cause === 'object' && 'code' in cause
									? cause.code
									: ''
							finish(
								cause instanceof ThemePackageError
									? cause
									: new ThemePackageError(
											code === 'ERR_THEME_IMAGE_LIMIT'
												? 'LIMIT_EXCEEDED'
												: 'IMAGE_INVALID',
											code === 'ERR_THEME_IMAGE_BUSY'
												? '图片解码器忙，请稍后重试'
												: '图片无法完整解码',
											{ cause },
										),
							)
						},
					)
			})
		},
	}
}

export const themeImageDecoder = createThemeImageDecoder()
