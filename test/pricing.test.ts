import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	computeRetail,
	countRows,
	getPricingModel,
	multiplierFor,
	parseBasket,
	type PricingModel,
} from "../src/pricing.js";
import { RequestError } from "../src/errors.js";
import type { Env } from "../src/env.js";

// The live /v1/api/phases pricing block (captured 2026-09-09). The plan allows the Stage 3 fetch to
// hit the live free endpoint; we mock it with the real values so the test is deterministic offline
// and still asserts the true "3 × liveserv wholesale" number.
const PHASES_PAYLOAD = {
	pricing: {
		base_rate_micro_usd: 2314,
		multiplier_tiers: [
			{ max_rows: 1, factor: 1.25 },
			{ max_rows: 5, factor: 1.15 },
			{ max_rows: null, factor: 1 },
		],
		formula: "debit_micro_usd = round(rows × base_rate_micro_usd × multiplier(rows))",
	},
	currencies: ["BTC", "ETH", "GRAM", "SOL", "TRX"],
	tfs: ["15m", "1h", "2h", "4h", "1d", "1w"],
};

const MODEL: PricingModel = {
	base_rate_micro_usd: 2314,
	multiplier_tiers: PHASES_PAYLOAD.pricing.multiplier_tiers,
	currencies: PHASES_PAYLOAD.currencies,
	tfs: PHASES_PAYLOAD.tfs,
};

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

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("pricing — countRows / computeRetail", () => {
	it("prices BTC×all at 3× the liveserv wholesale", () => {
		const rows = countRows(new URLSearchParams("currency=BTC&tf=all"), MODEL);
		assert.equal(rows, 6); // 1 currency × 6 tfs
		// wholesale = round(6 × 2314 × 1.0) = 13884 (6 rows > 5 ⇒ multiplier 1.0)
		const wholesale = 13884;
		const retail = computeRetail(rows, MODEL);
		assert.equal(retail, 3 * wholesale);
		assert.equal(retail, 41652);
	});

	it("applies the small-basket multiplier tiers", () => {
		// 1 row ⇒ factor 1.25: round(1 × 2314 × 1.25) = 2893; retail = 8679
		assert.equal(multiplierFor(1, MODEL.multiplier_tiers), 1.25);
		assert.equal(computeRetail(1, MODEL), 3 * 2893);
		// 5 rows ⇒ factor 1.15: round(5 × 2314 × 1.15) = round(13305.4999…) = 13305; retail = 39915.
		// (Matches liveserv computeDebit exactly — same JS Math.round of the same float product.)
		assert.equal(multiplierFor(5, MODEL.multiplier_tiers), 1.15);
		assert.equal(computeRetail(5, MODEL), 3 * 13305);
		// 6 rows ⇒ factor 1.0
		assert.equal(multiplierFor(6, MODEL.multiplier_tiers), 1.0);
	});

	it("rejects an over-cap basket with 400", () => {
		// 6 duplicated BTC × 6 tfs = 36 rows > cap (5 × 6 = 30)
		const q = new URLSearchParams("currency=BTC,BTC,BTC,BTC,BTC,BTC&tf=all");
		assert.throws(
			() => countRows(q, MODEL),
			(err: unknown) => err instanceof RequestError && err.status === 400,
		);
	});

	it("rejects an unknown currency/tf with 400", () => {
		assert.throws(
			() => parseBasket(new URLSearchParams("currency=DOGE&tf=1h"), MODEL),
			(err: unknown) => err instanceof RequestError && err.status === 400,
		);
		assert.throws(
			() => parseBasket(new URLSearchParams("currency=BTC&tf=3m"), MODEL),
			(err: unknown) => err instanceof RequestError && err.status === 400,
		);
	});
});

describe("pricing — getPricingModel", () => {
	it("fetches from origin on a KV miss and caches the model", async () => {
		let calls = 0;
		globalThis.fetch = (async (input: unknown) => {
			calls++;
			assert.equal(String(input), "https://snowsignals.io/v1/api/phases");
			return new Response(JSON.stringify(PHASES_PAYLOAD), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		const kv = makeKV();
		const env = { PHASE_CACHE: kv, ORIGIN_URL: "https://snowsignals.io" } as unknown as Env;

		const model = await getPricingModel(env);
		assert.equal(model.base_rate_micro_usd, 2314);
		assert.deepEqual(model.tfs, PHASES_PAYLOAD.tfs);
		assert.equal(calls, 1);
		assert.ok(kv.store.has("price-model"));

		// Second call is served from KV — no second fetch.
		const again = await getPricingModel(env);
		assert.equal(again.base_rate_micro_usd, 2314);
		assert.equal(calls, 1);
	});

	it("fails loud when the origin returns non-2xx", async () => {
		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof fetch;
		const env = { PHASE_CACHE: makeKV(), ORIGIN_URL: "https://snowsignals.io" } as unknown as Env;
		await assert.rejects(getPricingModel(env), /returned 500/);
	});
});
