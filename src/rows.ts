/**
 * The per-row serve pipeline. The ROW `(kind, currency, tf, bucket)` is the unit of cache, cost, and
 * single-flight (D2/D6) — never the whole request. A warm row is served from KV and never re-bought;
 * missing rows are fetched wholesale, grouped per currency through the single-flight DO, then cached.
 *
 *   basketRows → readCache → fetchLeftovers(need) → loadCache(fresh) → assemble(basket, have, fresh)
 *
 * Fail loud throughout: a missing binding, a non-2xx single-flight, or a requested row that resolved
 * to no reading throws — no empty-array / stale / partial-basket serve (Ground rule 2).
 */
import type { Env } from "./env.js";
import type { PhaseKind, Reading, ResolvedRow, Row, ShapedPhaseData, SingleFlightResult } from "./types.js";
import type { SingleFlightRequest } from "./singleflight.js";
import { TF_SECONDS, UPDATES_TTL_SECONDS } from "./config.js";
import { parseBasket, type PricingModel } from "./pricing.js";

/** The KV value stored per row — wrapped so a cached `null` reading is distinct from a cache miss. */
export interface CachedReading {
	reading: Reading;
}

// Cloudflare KV requires expirationTtl ≥ 60s. Boundary correctness does NOT rely on the TTL — the
// cache KEY carries the bucket (next-close), so once a bar closes the key changes and the stale value
// is simply never queried again. Flooring the TTL at this minimum is therefore safe.
const KV_MIN_TTL_SECONDS = 60;

/** The cache bucket for a row: boundary = UTC next-close epoch seconds; updates = minute index. */
function bucketFor(kind: PhaseKind, tf: string, now = Date.now()): string {
	if (kind === "updates") {
		return String(Math.floor(now / 60_000));
	}
	const seconds = TF_SECONDS[tf];
	if (!seconds) {
		throw new Error(`no TF_SECONDS entry for tf ${tf}`);
	}
	const nowSec = Math.floor(now / 1000);
	const nextClose = (Math.floor(nowSec / seconds) + 1) * seconds;
	return String(nextClose);
}

/** Expand the validated basket into per-row records with their cache keys (Stage 4.1). */
export function basketRows(kind: PhaseKind, query: URLSearchParams, model: PricingModel): Row[] {
	const { currencies, tfs } = parseBasket(query, model);
	const now = Date.now();
	const rows: Row[] = [];
	for (const currency of currencies) {
		for (const tf of tfs) {
			const bucket = bucketFor(kind, tf, now);
			rows.push({ kind, currency, tf, bucket, cacheKey: `${kind}:${currency}:${tf}:${bucket}` });
		}
	}
	return rows;
}

/** Split rows into `have` (warm in KV) and `need` (missing/expired) (Stage 4.2). */
export async function readCache(
	env: Env,
	rows: Row[],
): Promise<{ have: ResolvedRow[]; need: Row[] }> {
	if (!env.PHASE_CACHE) {
		throw new Error("PHASE_CACHE KV binding is not configured");
	}
	const cache = env.PHASE_CACHE;
	const have: ResolvedRow[] = [];
	const need: Row[] = [];
	await Promise.all(
		rows.map(async (row) => {
			const cached = (await cache.get(row.cacheKey, "json")) as CachedReading | null;
			if (cached === null) {
				need.push(row);
			} else {
				have.push({ ...row, reading: cached.reading });
			}
		}),
	);
	return { have, need };
}

/**
 * Fetch the missing rows wholesale, grouped PER CURRENCY through that currency's single-flight DO
 * (Stage 4.3). Each currency gets one DO call for exactly its needed tfs — rectangular, so a `have`
 * row is never included. A non-2xx DO response or a missing tf fails loud (→ 503, no settle).
 */
export async function fetchLeftovers(env: Env, need: Row[]): Promise<ResolvedRow[]> {
	if (need.length === 0) {
		return [];
	}
	if (!env.CURRENCY_SINGLEFLIGHT) {
		throw new Error("CURRENCY_SINGLEFLIGHT Durable Object binding is not configured");
	}
	const namespace = env.CURRENCY_SINGLEFLIGHT;

	const byCurrency = new Map<string, Row[]>();
	for (const row of need) {
		const list = byCurrency.get(row.currency);
		if (list) {
			list.push(row);
		} else {
			byCurrency.set(row.currency, [row]);
		}
	}

	const fresh: ResolvedRow[] = [];
	await Promise.all(
		[...byCurrency.entries()].map(async ([currency, rows]) => {
			const stub = namespace.get(namespace.idFromName(currency));
			const body: SingleFlightRequest = {
				kind: rows[0].kind,
				currency,
				needs: rows.map((r) => ({ tf: r.tf, cacheKey: r.cacheKey })),
			};
			const res = await stub.fetch("https://single-flight/resolve", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				throw new Error(`single-flight for ${currency} returned ${res.status}`);
			}
			const { readings } = (await res.json()) as SingleFlightResult;
			for (const row of rows) {
				const reading = readings[row.tf];
				if (reading === undefined) {
					throw new Error(`single-flight for ${currency} missing tf ${row.tf}`);
				}
				fresh.push({ ...row, reading });
			}
		}),
	);
	return fresh;
}

/** TTL for a freshly-fetched row: updates = 60s; boundary = seconds to next close (floored at 60). */
function ttlFor(row: ResolvedRow, nowSec: number): number {
	if (row.kind === "updates") {
		return UPDATES_TTL_SECONDS;
	}
	const secondsToClose = Number(row.bucket) - nowSec;
	return Math.max(secondsToClose, KV_MIN_TTL_SECONDS);
}

/** Write freshly-fetched rows into KV with the per-kind TTL (Stage 4.4). */
export async function loadCache(env: Env, freshRows: ResolvedRow[]): Promise<void> {
	if (freshRows.length === 0) {
		return;
	}
	if (!env.PHASE_CACHE) {
		throw new Error("PHASE_CACHE KV binding is not configured");
	}
	const cache = env.PHASE_CACHE;
	const nowSec = Math.floor(Date.now() / 1000);
	await Promise.all(
		freshRows.map((row) => {
			const value: CachedReading = { reading: row.reading };
			return cache.put(row.cacheKey, JSON.stringify(value), { expirationTtl: ttlFor(row, nowSec) });
		}),
	);
}

/**
 * Project the resolved rows down to `currency → tf → reading|null` for EXACTLY the caller's requested
 * rows (Stage 4.5). Extra rows a shared per-currency batch fetched for a concurrent caller are
 * discarded. A requested row with no reading in have+fresh fails loud (no partial-basket serve).
 */
export function assemble(
	requestedRows: Row[],
	have: ResolvedRow[],
	fresh: ResolvedRow[],
): ShapedPhaseData {
	const byKey = new Map<string, Reading>();
	for (const row of have) {
		byKey.set(row.cacheKey, row.reading);
	}
	for (const row of fresh) {
		byKey.set(row.cacheKey, row.reading);
	}

	const out: ShapedPhaseData = {};
	for (const row of requestedRows) {
		if (!byKey.has(row.cacheKey)) {
			throw new Error(`assemble: no reading resolved for ${row.cacheKey}`);
		}
		(out[row.currency] ??= {})[row.tf] = byKey.get(row.cacheKey) ?? null;
	}
	return out;
}
