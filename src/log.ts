/**
 * Logging helpers. Logs are sacred (CLAUDE.md) — every catch on the money/serve path logs before it
 * throws or maps to a status. Workers surface `console` to the dashboard tail, so these are thin
 * wrappers that keep a consistent, greppable prefix.
 */

export function logError(message: string, err?: unknown): void {
	if (err !== undefined) {
		console.error(`[snowsignals-x402] ${message}`, err);
	} else {
		console.error(`[snowsignals-x402] ${message}`);
	}
}

export function logInfo(message: string): void {
	console.log(`[snowsignals-x402] ${message}`);
}
