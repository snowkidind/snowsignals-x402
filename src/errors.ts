/**
 * A request-level error that carries the HTTP status the gateway should return. Used for caller
 * mistakes (bad currency/tf, over-cap basket) that are rejected BEFORE any payment is required —
 * fail loud with the right status rather than issuing a 402 for an invalid request.
 */
export class RequestError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "RequestError";
	}
}
