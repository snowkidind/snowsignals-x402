/**
 * Settlement accounting (Stage 5.3). One KV key per settled payment, keyed by TX HASH (not payer) —
 * idempotent and audit-friendly. No aggregate counter (a KV-only running total would race and is not
 * the source of truth; the merchant address on Base is).
 */
import type { Env } from "./env.js";
import type { PhaseKind } from "./types.js";

export interface SettlementRecord {
	tx_hash: string;
	endpoint: string;
	kind: PhaseKind;
	/** Billable rows in the request (|currencies| × |tfs|). */
	rows: number;
	/** Retail micro-USD charged (what the 402 quoted). */
	amount: number;
	/** How many of those rows were served warm from cache (margin insight; not re-bought). */
	cache_hit_rows: number;
	ts: number;
}

/** Persist one settlement under `settle:<tx_hash>`. Fails loud on a missing KV binding. */
export async function recordSettlement(env: Env, record: SettlementRecord): Promise<void> {
	if (!env.PHASE_CACHE) {
		throw new Error("PHASE_CACHE KV binding is not configured");
	}
	await env.PHASE_CACHE.put(`settle:${record.tx_hash}`, JSON.stringify(record));
}
