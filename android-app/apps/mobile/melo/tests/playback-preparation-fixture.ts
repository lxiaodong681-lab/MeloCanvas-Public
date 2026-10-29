import type { PlaybackPreparationPort } from '../playback-intent'

/** Contract model only; production native guard behavior is verified separately. */
export function preparationPort(
	onReserve: () => Promise<void> = async () => {},
	onCancel: () => Promise<void> = async () => {},
): PlaybackPreparationPort {
	let current = 0
	return {
		reservePlayback: async () => {
			const token = ++current
			await onReserve()
			return { token }
		},
		isPreparationCurrent: async ({ token }) => token === current,
		cancelPreparation: async ({ token }) => {
			if (token === current) {
				current++
				await onCancel()
			}
		},
	}
}
