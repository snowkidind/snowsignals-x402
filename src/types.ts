/**
 * Shared shapes for the gateway serve path. `boundary` = last closed-bar deterministic truth,
 * `updates` = intra-bar read (mirrors liveserv's PhaseKind / phasePackageReader). A row is the unit
 * of cache, cost, and single-flight: `(kind, currency, tf, bucket)`.
 */

export type PhaseKind = "boundary" | "updates";

/** One phase reading, as liveserv projects it: currency → tf → this (or null when no reading yet). */
export interface PhasePoint {
	ts: string;
	phase: string;
	label: string;
}

/** A tf's reading, or null when liveserv has no reading for it yet. */
export type Reading = PhasePoint | null;

/** One billable/cacheable row of the requested basket. */
export interface Row {
	kind: PhaseKind;
	currency: string;
	tf: string;
	/** UTC next-close epoch seconds (boundary) or minute index (updates) — see rows.ts. */
	bucket: string;
	/** `${kind}:${currency}:${tf}:${bucket}` — the per-row cache + single-flight key. */
	cacheKey: string;
}

/** A row plus its resolved reading (from cache or a fresh leftover fetch). */
export interface ResolvedRow extends Row {
	reading: Reading;
}

/** The response body from a single-flight Durable Object fetch: tf → reading. */
export interface SingleFlightResult {
	readings: Record<string, Reading>;
}
