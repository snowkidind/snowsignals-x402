/**
 * CurrencySingleFlight — one Durable Object instance per currency (DO name = currency). It coalesces
 * concurrent leftover fetches so two callers that both miss the cache on the same
 * `(kind, currency, tf, bucket)` row cause exactly ONE wholesale origin GET, and issues a single GET
 * per currency for exactly the timeframes that need fetching (Stage 2.2 / 4.3 / D6).
 *
 * Coordination-only: the in-flight map is in memory (no persistent storage). It calls the liveserv
 * origin with the house url-mode key. Fail loud — a missing key or a non-2xx origin throws; the
 * caller maps that to 503 and never settles.
 */
import type { Env } from "./env.js";
import type { PhaseKind, Reading, SingleFlightResult } from "./types.js";
import { logError } from "./log.js";

/** POST body the Worker sends to the DO: the currency's needed rows (cache misses only). */
export interface SingleFlightRequest {
	kind: PhaseKind;
	currency: string;
	/** One entry per timeframe that missed the cache; `cacheKey` encodes (kind, currency, tf, bucket). */
	needs: { tf: string; cacheKey: string }[];
}

export class CurrencySingleFlight {
	private readonly env: Env;
	/** cacheKey → in-flight reading promise; deleted once settled so the next bucket refetches. */
	private readonly inflight = new Map<string, Promise<Reading>>();

	constructor(_state: DurableObjectState, env: Env) {
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		let req: SingleFlightRequest;
		try {
			req = (await request.json()) as SingleFlightRequest;
		} catch (err) {
			logError("[CurrencySingleFlight] bad request body", err);
			return Response.json({ error: "invalid single-flight request" }, { status: 400 });
		}
		try {
			const readings = await this.resolve(req);
			const body: SingleFlightResult = { readings };
			return Response.json(body);
		} catch (err) {
			logError(`[CurrencySingleFlight] resolve failed for ${req.currency}`, err);
			return Response.json(
				{ error: err instanceof Error ? err.message : "single-flight resolve failed" },
				{ status: 502 },
			);
		}
	}

	/** Coalesce per cacheKey; one origin GET for the currency covering all not-already-in-flight tfs. */
	private async resolve(req: SingleFlightRequest): Promise<Record<string, Reading>> {
		const { kind, currency, needs } = req;

		const newTfs = needs.filter((n) => !this.inflight.has(n.cacheKey)).map((n) => n.tf);
		if (newTfs.length > 0) {
			// One shared fetch for the whole batch of new tfs; derive a per-tf promise from it.
			const shared = this.fetchOrigin(kind, currency, newTfs);
			for (const n of needs) {
				if (newTfs.includes(n.tf)) {
					this.inflight.set(
						n.cacheKey,
						shared.then((m) => m[n.tf] ?? null),
					);
				}
			}
		}

		const out: Record<string, Reading> = {};
		await Promise.all(
			needs.map(async (n) => {
				const p = this.inflight.get(n.cacheKey);
				if (!p) {
					throw new Error(`single-flight lost promise for ${n.cacheKey}`);
				}
				try {
					out[n.tf] = await p;
				} finally {
					if (this.inflight.get(n.cacheKey) === p) {
						this.inflight.delete(n.cacheKey);
					}
				}
			}),
		);
		return out;
	}

	/** One wholesale GET to the origin for `currency` over exactly `tfs`, with the house key. */
	private async fetchOrigin(
		kind: PhaseKind,
		currency: string,
		tfs: string[],
	): Promise<Record<string, Reading>> {
		const houseKey = this.env.HOUSE_API_KEY;
		if (!houseKey) {
			// Fail loud — no credential fallback (CLAUDE.md).
			throw new Error("HOUSE_API_KEY is not set");
		}
		const url =
			`${this.env.ORIGIN_URL}/v1/api/phase/${kind}` +
			`?currency=${encodeURIComponent(currency)}` +
			`&tf=${encodeURIComponent(tfs.join(","))}` +
			`&apiKey=${encodeURIComponent(houseKey)}`;

		const res = await fetch(url);
		if (!res.ok) {
			throw new Error(`origin ${kind} fetch for ${currency} returned ${res.status}`);
		}
		const body = (await res.json()) as { data?: Record<string, Record<string, Reading>> };
		const ccyData = body.data?.[currency];
		if (!ccyData) {
			throw new Error(`origin ${kind} response missing data for ${currency}`);
		}
		const out: Record<string, Reading> = {};
		for (const tf of tfs) {
			out[tf] = ccyData[tf] ?? null;
		}
		return out;
	}
}
