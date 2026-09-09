/**
 * Module-level tuning constants for the SnowSignals x402 gateway.
 *
 * Ground rule 4 (CLAUDE.md): `const` for tuning, secrets via `wrangler secret`. These are NOT env
 * knobs and NOT config flags — a value that changes the economics (the retail multiplier, the cache
 * horizons) lives here in source so it diffs and reverts cleanly.
 */

/** Retail = wholesale (the liveserv debit) × this. The gateway's margin (D1). */
export const RETAIL_MULTIPLIER = 3;

/** How long a fetched pricing model is trusted before we refetch it from the origin (~24h). */
export const PRICING_TTL_SECONDS = 86400;

/**
 * `updates` cache horizon. 60s is the refresh floor of the intra-bar phase read (`phase.committed`
 * arrives ~once/minute). NOT 10s — that is the wrong clock (Anti-patterns / D3).
 */
export const UPDATES_TTL_SECONDS = 60;

/** The liveserv origin the gateway resells. All origin paths hang off `${ORIGIN_URL}/v1/api/...`. */
export const ORIGIN_URL = "https://snowsignals.io";

/**
 * Seconds per timeframe — replicated from liveserv/src/constants/phase.ts (TF_SECONDS). Used to
 * compute a `boundary` row's cache bucket (its next UTC close) and its cache TTL (seconds to that
 * close). A closed boundary is deterministic truth; the bucket only rolls when a new bar closes.
 */
export const TF_SECONDS: Record<string, number> = {
	"15m": 900,
	"1h": 3600,
	"2h": 7200,
	"4h": 14400,
	"1d": 86400,
	"1w": 604800,
};
