import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { assemble, basketRows, fetchLeftovers, readCache } from "../src/rows.js";
import { CurrencySingleFlight, type SingleFlightRequest } from "../src/singleflight.js";
import type { PricingModel } from "../src/pricing.js";
import type { Env } from "../src/env.js";
import type { PhasePoint, ResolvedRow, Row, SingleFlightResult } from "../src/types.js";

const MODEL: PricingModel = {
	base_rate_micro_usd: 2314,
	multiplier_tiers: [{ max_rows: null, factor: 1 }],
	currencies: ["BTC", "ETH", "GRAM", "SOL", "TRX"],
	tfs: ["15m", "1h", "2h", "4h", "1d", "1w"],
};

function point(tag: string): PhasePoint {
	return { ts: `2026-09-09T00:00:00Z`, phase: `establishing_bull`, label: tag };
}

function makeKV(initial: Record<string, string> = {}) {
	const store = new Map<string, string>(Object.entries(initial));
	return {
		store,
		get: async (key: string, type?: string) => {
			const v = store.get(key);
			if (v == null) {
				return null;
			}
			return type === "json" ? JSON.parse(v) : v;
		},
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
	};
}

/**
 * Mock single-flight namespace: records every DO call's request body and answers with a reading per
 * requested tf. `idFromName` is identity so one stub exists per currency.
 */
function makeDONamespace() {
	const calls: SingleFlightRequest[] = [];
	const namespace = {
		idFromName: (name: string) => name,
		get: (_id: string) => ({
			fetch: async (_url: string, init?: { body?: string }) => {
				const body = JSON.parse(String(init?.body)) as SingleFlightRequest;
				calls.push(body);
				const readings: Record<string, PhasePoint | null> = {};
				for (const need of body.needs) {
					readings[need.tf] = point(`${body.currency}:${need.tf}`);
				}
				const result: SingleFlightResult = { readings };
				return new Response(JSON.stringify(result), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		}),
	};
	return { namespace, calls };
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("rows — basketRows", () => {
	it("expands the basket into per-row cache keys", () => {
		const rows = basketRows("boundary", new URLSearchParams("currency=BTC,ETH&tf=1h,4h"), MODEL);
		assert.equal(rows.length, 4);
		for (const r of rows) {
			assert.equal(r.cacheKey, `boundary:${r.currency}:${r.tf}:${r.bucket}`);
			// boundary bucket = a future UTC next-close epoch second.
			assert.ok(Number(r.bucket) * 1000 > Date.now());
		}
	});

	it("uses a 60s minute-index bucket for updates", () => {
		const rows = basketRows("updates", new URLSearchParams("currency=BTC&tf=1h"), MODEL);
		assert.equal(rows[0].bucket, String(Math.floor(Date.now() / 60_000)));
	});
});

describe("rows — readCache", () => {
	it("splits warm rows from misses", async () => {
		const rows = basketRows("boundary", new URLSearchParams("currency=BTC&tf=1h,4h"), MODEL);
		const warm = rows[0];
		const kv = makeKV({ [warm.cacheKey]: JSON.stringify({ reading: point("warm") }) });
		const env = { PHASE_CACHE: kv } as unknown as Env;
		const { have, need } = await readCache(env, rows);
		assert.equal(have.length, 1);
		assert.equal(have[0].cacheKey, warm.cacheKey);
		assert.equal(need.length, 1);
		assert.equal(need[0].tf, "4h");
	});
});

describe("rows — fetchLeftovers", () => {
	it("groups per currency and never includes a have row", async () => {
		const rows = basketRows("boundary", new URLSearchParams("currency=BTC,ETH&tf=1h,4h"), MODEL);
		// Pre-warm BTC:1h so it is a `have` row, not a `need`.
		const btc1h = rows.find((r) => r.currency === "BTC" && r.tf === "1h")!;
		const kv = makeKV({ [btc1h.cacheKey]: JSON.stringify({ reading: point("warm") }) });
		const { namespace, calls } = makeDONamespace();
		const env = { PHASE_CACHE: kv, CURRENCY_SINGLEFLIGHT: namespace } as unknown as Env;

		const { need } = await readCache(env, rows);
		const fresh = await fetchLeftovers(env, need);

		// One call per currency (BTC, ETH) — never a single combined csv×csv call.
		assert.equal(calls.length, 2);
		const btcCall = calls.find((c) => c.currency === "BTC")!;
		const ethCall = calls.find((c) => c.currency === "ETH")!;
		// BTC's warm 1h row is NOT in the BTC call; only its 4h leftover is.
		assert.deepEqual(
			btcCall.needs.map((n) => n.tf).sort(),
			["4h"],
		);
		assert.deepEqual(
			ethCall.needs.map((n) => n.tf).sort(),
			["1h", "4h"],
		);
		// fresh covers exactly the 3 leftover rows.
		assert.equal(fresh.length, 3);
	});

	it("fails loud when a single-flight DO returns non-2xx", async () => {
		const rows = basketRows("boundary", new URLSearchParams("currency=BTC&tf=1h"), MODEL);
		const namespace = {
			idFromName: (n: string) => n,
			get: () => ({ fetch: async () => new Response("nope", { status: 502 }) }),
		};
		const env = { CURRENCY_SINGLEFLIGHT: namespace } as unknown as Env;
		await assert.rejects(fetchLeftovers(env, rows), /returned 502/);
	});
});

describe("rows — CurrencySingleFlight coalescing (per row)", () => {
	it("issues ONE origin fetch for two concurrent callers of the same rows", async () => {
		let originCalls = 0;
		globalThis.fetch = (async (input: unknown) => {
			originCalls++;
			const url = String(input);
			assert.ok(url.includes("/v1/api/phase/boundary"));
			assert.ok(url.includes("apiKey=house-key"));
			return new Response(
				JSON.stringify({ data: { BTC: { "1h": point("BTC:1h"), "4h": point("BTC:4h") } } }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;

		const env = { ORIGIN_URL: "https://snowsignals.io", HOUSE_API_KEY: "house-key" } as unknown as Env;
		const doInstance = new CurrencySingleFlight({} as DurableObjectState, env);

		const req: SingleFlightRequest = {
			kind: "boundary",
			currency: "BTC",
			needs: [
				{ tf: "1h", cacheKey: "boundary:BTC:1h:1000" },
				{ tf: "4h", cacheKey: "boundary:BTC:4h:1000" },
			],
		};
		const mk = () =>
			doInstance.fetch(
				new Request("https://single-flight/resolve", {
					method: "POST",
					body: JSON.stringify(req),
					headers: { "content-type": "application/json" },
				}),
			);

		const [r1, r2] = await Promise.all([mk(), mk()]);
		const b1 = (await r1.json()) as SingleFlightResult;
		const b2 = (await r2.json()) as SingleFlightResult;

		// Both callers get the readings; only ONE wholesale origin fetch happened (coalesced per row).
		assert.equal(originCalls, 1);
		assert.equal(b1.readings["1h"]?.label, "BTC:1h");
		assert.equal(b2.readings["4h"]?.label, "BTC:4h");
	});

	it("fails loud when HOUSE_API_KEY is unset", async () => {
		const env = { ORIGIN_URL: "https://snowsignals.io" } as unknown as Env;
		const doInstance = new CurrencySingleFlight({} as DurableObjectState, env);
		const res = await doInstance.fetch(
			new Request("https://single-flight/resolve", {
				method: "POST",
				body: JSON.stringify({
					kind: "boundary",
					currency: "BTC",
					needs: [{ tf: "1h", cacheKey: "boundary:BTC:1h:1000" }],
				}),
				headers: { "content-type": "application/json" },
			}),
		);
		assert.equal(res.status, 502);
	});
});

describe("rows — assemble", () => {
	it("filters to exactly the caller's basket and discards extras", () => {
		const requested: Row[] = [
			{ kind: "boundary", currency: "BTC", tf: "1h", bucket: "1000", cacheKey: "boundary:BTC:1h:1000" },
			{ kind: "boundary", currency: "BTC", tf: "4h", bucket: "1000", cacheKey: "boundary:BTC:4h:1000" },
		];
		const have: ResolvedRow[] = [{ ...requested[0], reading: point("have-1h") }];
		const fresh: ResolvedRow[] = [
			{ ...requested[1], reading: point("fresh-4h") },
			// An extra row a shared per-currency batch fetched for a concurrent caller — must be discarded.
			{ kind: "boundary", currency: "BTC", tf: "1d", bucket: "1000", cacheKey: "boundary:BTC:1d:1000", reading: point("extra-1d") },
		];
		const shaped = assemble(requested, have, fresh);
		assert.deepEqual(Object.keys(shaped), ["BTC"]);
		assert.deepEqual(Object.keys(shaped.BTC).sort(), ["1h", "4h"]);
		assert.equal(shaped.BTC["1h"]?.label, "have-1h");
		assert.equal(shaped.BTC["4h"]?.label, "fresh-4h");
	});

	it("fails loud on a requested row with no resolved reading", () => {
		const requested: Row[] = [
			{ kind: "boundary", currency: "BTC", tf: "1h", bucket: "1000", cacheKey: "boundary:BTC:1h:1000" },
		];
		assert.throws(() => assemble(requested, [], []), /no reading resolved/);
	});
});
