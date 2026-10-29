/** A source restriction, not an incomplete payload or a retryable single query. */
export class BilibiliRequestRestrictedError extends Error {
	constructor() {
		// Never retain response text, challenge tokens or other server payloads.
		super('B 站请求受限，请稍后再试')
		this.name = 'BilibiliRequestRestrictedError'
	}
}

/** Keep the numeric API result so a batch can distinguish one unavailable video from a network failure. */
export class BilibiliApiError extends Error {
	constructor(readonly code: number, message: string) {
		super(message)
		this.name = 'BilibiliApiError'
	}
}
