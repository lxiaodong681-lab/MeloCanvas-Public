interface PlayerLinking {
	getInitialURL(): Promise<string | null>
	addEventListener(
		event: 'url',
		listener: (event: { url: string }) => void,
	): { remove(): void }
}
export function isPlayerDeepLink(url: string | null): boolean {
	return url === 'orpheus://player' || url === 'melocanvas://player'
}
/** Navigation only. Player mode/state still come from the existing native sync. */
export function bindPlayerDeepLinks(
	linking: PlayerLinking,
	open: () => void,
): () => void {
	let active = true,
		receivedEvent = false
	const subscription = linking.addEventListener('url', ({ url }) => {
		if (!active || !isPlayerDeepLink(url)) return
		receivedEvent = true
		open()
	})
	void linking
		.getInitialURL()
		.then((url) => {
			if (active && !receivedEvent && isPlayerDeepLink(url)) open()
		})
		.catch(() => {})
	return () => {
		active = false
		subscription.remove()
	}
}
