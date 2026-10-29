/** Progress ticks have their own subscription so they do not rerender the app shell. */
export class PlaybackProgress {
	private value = { position: 0, duration: 0 }
	private listeners = new Set<() => void>()
	getSnapshot = () => this.value
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
	update(position: number, duration: number) {
		if (position === this.value.position && duration === this.value.duration) return
		this.value = { position, duration }
		for (const listener of this.listeners) listener()
	}
}
