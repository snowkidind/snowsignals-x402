import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { HTTPProcessResult, ProcessSettleResultResponse } from "@x402/core/http";
import { servePaidPhase } from "../src/gateway.js";
import type { PaymentServer } from "../src/x402http.js";
import type { Env } from "../src/env.js";
import type { PhasePoint, SingleFlightResult } from "../src/types.js";

const PHASES_PAYLOAD = {
	pricing: {
		base_rate_micro_usd: 2314,
		multiplier_tiers: [
			{ max_rows: 1, factor: 1.25 },
			{ max_rows: 5, factor: 1.15 },
			{ max_rows: null, factor: 1 },
		],
	},
	currencies: ["BTC", "ETH", "GRAM", "SOL", "TRX"],
	tfs: ["15m", "1h", "2h", "4h", "1d", "1w"],
};

function point(tag: string): PhasePoint {
	return { ts: "2026-09-09T00:00:00Z", phase: "establishing_bull", label: tag };
}

function makeKV() {
	const store = new Map<string, string>();
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

/** DO namespace whose stub answers a reading per requested tf (happy path). */
function makeServingDO() {
	return {
		idFromName: (n: string) => n,
		get: () => ({
			fetch: async (_url: string, init?: { body?: string }) => {
				const body = JSON.parse(String(init?.body)) as { currency: string; needs: { tf: string }[] };
				const readings: Record<string, PhasePoint | null> = {};
				for (const n of body.needs) {
					readings[n.tf] = point(`${body.currency}:${n.tf}`);
				}
				const result: SingleFlightResult = { readings };
				return new Response(JSON.stringify(result), { status: 200 });
			},
		}),
	};
}

/** DO namespace whose stub always fails (simulates a house 402 / origin failure). */
function makeFailingDO() {
	return {
		idFromName: (n: string) => n,
		get: () => ({ fetch: async () => new Response("nope", { status: 502 }) }),
	};
}

/**
 * A stub of the two-method payment server the gateway drives. `process` decides what
 * processHTTPRequest returns; `settle` decides processSettlement; `settleCalls` records whether
 * settlement was reached (the money-path ordering assertion).
 */
function makeServer(opts: {
	process: "verified" | "error-402";
	settle?: "success" | "fail";
}): PaymentServer & { settleCalls: number } {
	const server = {
		settleCalls: 0,
		async processHTTPRequest(): Promise<HTTPProcessResult> {
			if (opts.process === "error-402") {
				return {
					type: "payment-error",
					response: {
						status: 402,
						headers: { "Content-Type": "application/json" },
						body: { x402Version: 2, error: "Payment required" },
					},
				};
			}
			return {
				type: "payment-verified",
				paymentPayload: {} as never,
				paymentRequirements: {} as never,
				cancellationDispatcher: {} as never,
			} as HTTPProcessResult;
		},
		async processSettlement(): Promise<ProcessSettleResultResponse> {
			server.settleCalls++;
			if (opts.settle === "fail") {
				return {
					success: false,
					errorReason: "insufficient_funds",
					headers: {},
					response: { status: 503, headers: {}, body: {} },
				} as ProcessSettleResultResponse;
			}
			return {
				success: true,
				transaction: "0xbeef",
				network: "eip155:8453",
				headers: { "PAYMENT-RESPONSE": "settled" },
				requirements: {},
			} as unknown as ProcessSettleResultResponse;
		},
	};
	return server;
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function mockPhasesFetch() {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(PHASES_PAYLOAD), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
}

function baseEnv(over: Record<string, unknown> = {}): Env {
	return {
		PHASE_CACHE: makeKV(),
		CURRENCY_SINGLEFLIGHT: makeServingDO(),
		ORIGIN_URL: "https://snowsignals.io",
		...over,
	} as unknown as Env;
}

describe("gateway — money path ordering", () => {
	it("returns 400 for a bad basket, before any payment processing", async () => {
		mockPhasesFetch();
		const server = makeServer({ process: "verified", settle: "success" });
		const req = new Request("https://pay.snowsignals.io/phase/boundary?currency=NOPE&tf=1h");
		const res = await servePaidPhase("boundary", req, baseEnv(), server);

		assert.equal(res.status, 400);
		assert.equal(server.settleCalls, 0);
	});

	it("returns the server's 402 challenge when payment is missing / invalid, and does not serve", async () => {
		mockPhasesFetch();
		const server = makeServer({ process: "error-402", settle: "success" });
		const req = new Request("https://pay.snowsignals.io/phase/boundary?currency=BTC&tf=all");
		const res = await servePaidPhase("boundary", req, baseEnv(), server);

		assert.equal(res.status, 402);
		assert.equal(server.settleCalls, 0);
		const body = (await res.json()) as { x402Version: number };
		assert.equal(body.x402Version, 2);
	});

	it("does NOT settle when the serve pipeline fails (503)", async () => {
		mockPhasesFetch();
		const server = makeServer({ process: "verified", settle: "success" });
		const env = baseEnv({ CURRENCY_SINGLEFLIGHT: makeFailingDO() });
		const req = new Request("https://pay.snowsignals.io/phase/boundary?currency=BTC&tf=1h");
		const res = await servePaidPhase("boundary", req, env, server);

		assert.equal(res.status, 503);
		assert.equal(server.settleCalls, 0); // settle never runs when the serve failed
	});

	it("returns 503 (no data) when settlement is unsuccessful", async () => {
		mockPhasesFetch();
		const server = makeServer({ process: "verified", settle: "fail" });
		const req = new Request("https://pay.snowsignals.io/phase/boundary?currency=BTC&tf=1h");
		const res = await servePaidPhase("boundary", req, baseEnv(), server);

		assert.equal(res.status, 503);
		assert.equal(server.settleCalls, 1);
	});

	it("settles after a successful serve and records the settlement", async () => {
		mockPhasesFetch();
		const server = makeServer({ process: "verified", settle: "success" });
		const kv = makeKV();
		const env = baseEnv({ PHASE_CACHE: kv });
		const req = new Request("https://pay.snowsignals.io/phase/boundary?currency=BTC&tf=1h,4h");
		const res = await servePaidPhase("boundary", req, env, server);

		assert.equal(res.status, 200);
		assert.equal(server.settleCalls, 1);
		assert.ok(res.headers.get("PAYMENT-RESPONSE"));
		const body = (await res.json()) as { data: Record<string, Record<string, PhasePoint>> };
		assert.equal(body.data.BTC["1h"].label, "BTC:1h");
		assert.equal(body.data.BTC["4h"].label, "BTC:4h");
		// Settlement recorded under settle:<tx_hash>, no aggregate counter.
		assert.ok(kv.store.has("settle:0xbeef"));
		const record = JSON.parse(kv.store.get("settle:0xbeef")!);
		assert.equal(record.rows, 2);
		// retail = RETAIL_MULTIPLIER × round(rows × base × mult(rows)); 2 rows ⇒ 3 × round(2×2314×1.15).
		assert.equal(record.amount, 3 * Math.round(2 * 2314 * 1.15));
	});
});
