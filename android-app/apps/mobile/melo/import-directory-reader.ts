import {
	DirectoryReadError,
	readExternalDirectory,
	type ExternalDirectoryInput,
	type ExternalDirectoryTransport,
} from './external-directory'

/** Bound admission to the actual transport promise, including after the public timeout. */
export function createImportDirectoryReader(
	transport: ExternalDirectoryTransport,
) {
	let active = false
	return async (input: ExternalDirectoryInput) => {
		if (active) throw new Error('上次目录读取仍在结束，请稍后再试。')
		active = true
		let started = false
		try {
			return await readExternalDirectory(input, (reference, signal) => {
				started = true
				return Promise.resolve()
					.then(() => transport(reference, signal))
					.finally(() => {
						active = false
					})
			})
		} catch (error) {
			if (input.signal?.aborted)
				throw new DirectoryReadError('cancelled', '目录读取已取消')
			throw error
		} finally {
			if (!started) active = false
		}
	}
}
