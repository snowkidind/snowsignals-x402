import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { encodePayment } from "x402/schemes";
import type { PaymentPayload, SettleResponse, VerifyResponse } from "x402/types";
import { servePaidPhase, type Facilitator } from "../src/gateway.js";
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

/** A schema-valid X-PAYMENT header (verify is stubbed, so signature contents are not checked). */
function paymentHeader(): string {
	const payment: PaymentPayload = {
		x402Version: 1,
		scheme: "exact",
		network: "base",
		payload: {
			signature: `0x${"11".repeat(65)}`,
			authorization: {
				from: `0x${"22".repeat(20)}`,
				to: `0x${"33".repeat(20)}`,
				value: "1000",
				validAfter: "0",
				validBefore: "9999999999",
				nonce: `0x${"44".repeat(32)}`,
			},
		},
	} as PaymentPayload;
	return encodePayment(payment);
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

const okVerify = async (): Promise<VerifyResponse> => ({ isValid: true });

describe("gateway — money path ordering", () => {
	it("does NOT settle when the serve pipeline fails (503)", async () => {
		mockPhasesFetch();
		let settleCalls = 0;
		const facilitator: Facilitator = {
			verify: okVerify,
			settle: async () => {
				settleCalls++;
				return { success: true, transaction: "0xdead", network: "base" } as SettleResponse;
			},
		};
		const env = {
			PHASE_CACHE: makeKV(),
			CURRENCY_SINGLEFLIGHT: makeFailingDO(),
			ORIGIN_URL: "https://snowsignals.io",
			NETWORK: "base",
			PAY_TO: "0x000000000000000000000000000000000000dEaD",
		} as unknown as Env;

		const req = new Request("https://pay.snowsignals.io/phase/boundary?currency=BTC&tf=1h", {
			headers: { "X-PAYMENT": paymentHeader() },
		});
		const res = await servePaidPhase("boundary", req, env, facilitator);

		assert.equal(res.status, 503);
		assert.equal(settleCalls, 0); // settle never runs when the serve failed
	});

	it("returns 402 with the derived price when no X-PAYMENT header is present", async () => {
		mockPhasesFetch();
		const facilitator: Facilitator = {
			verify: async () => {
				throw new Error("verify should not be called without a payment header");
			},
			settle: async () => {
				throw new Error("settle should not be called");
			},
		};
		const env = {
			PHASE_CACHE: makeKV(),
			CURRENCY_SINGLEFLIGHT: makeServingDO(),
			ORIGIN_URL: "https://snowsignals.io",
			NETWORK: "base",
			PAY_TO: "0x000000000000000000000000000000000000dEaD",
		} as unknown as Env;

		const req = new Request("https://pay.snowsignals.io/phase/boundary?currency=BTC&tf=all");
		const res = await servePaidPhase("boundary", req, env, facilitator);

		assert.equal(res.status, 402);
		const body = (await res.json()) as { x402Version: number; accepts: { maxAmountRequired: string }[] };
		assert.equal(body.x402Version, 1);
		// BTC × all (6 rows) ⇒ retail = 3 × round(6 × 2314) = 41652 micro-USD == atomic units.
		assert.equal(body.accepts[0].maxAmountRequired, "41652");
	});

	it("settles after a successful serve and records the settlement", async () => {
		mockPhasesFetch();
		let settleCalls = 0;
		const facilitator: Facilitator = {
			verify: okVerify,
			settle: async () => {
				settleCalls++;
				return { success: true, transaction: "0xbeef", network: "base" } as SettleResponse;
			},
		};
		const kv = makeKV();
		const env = {
			PHASE_CACHE: kv,
			CURRENCY_SINGLEFLIGHT: makeServingDO(),
			ORIGIN_URL: "https://snowsignals.io",
			NETWORK: "base",
			PAY_TO: "0x000000000000000000000000000000000000dEaD",
		} as unknown as Env;

		const req = new Request("https://pay.snowsignals.io/phase/boundary?currency=BTC&tf=1h,4h", {
			headers: { "X-PAYMENT": paymentHeader() },
		});
		const res = await servePaidPhase("boundary", req, env, facilitator);

		assert.equal(res.status, 200);
		assert.equal(settleCalls, 1);
		assert.ok(res.headers.get("X-PAYMENT-RESPONSE"));
		const body = (await res.json()) as { data: Record<string, Record<string, PhasePoint>> };
		assert.equal(body.data.BTC["1h"].label, "BTC:1h");
		assert.equal(body.data.BTC["4h"].label, "BTC:4h");
		// Settlement recorded under settle:<tx_hash>, no aggregate counter.
		assert.ok(kv.store.has("settle:0xbeef"));
		const record = JSON.parse(kv.store.get("settle:0xbeef")!);
		assert.equal(record.rows, 2);
		assert.equal(record.amount, 3 * Math.round(2 * 2314 * 1.15));
	});

	it("does NOT settle when verify rejects (402)", async () => {
		mockPhasesFetch();
		let settleCalls = 0;
		const facilitator: Facilitator = {
			verify: async () => ({ isValid: false, invalidReason: "insufficient_funds" }) as VerifyResponse,
			settle: async () => {
				settleCalls++;
				return { success: true, transaction: "0x", network: "base" } as SettleResponse;
			},
		};
		const env = {
			PHASE_CACHE: makeKV(),
			CURRENCY_SINGLEFLIGHT: makeServingDO(),
			ORIGIN_URL: "https://snowsignals.io",
			NETWORK: "base",
			PAY_TO: "0x000000000000000000000000000000000000dEaD",
		} as unknown as Env;

		const req = new Request("https://pay.snowsignals.io/phase/boundary?currency=BTC&tf=1h", {
			headers: { "X-PAYMENT": paymentHeader() },
		});
		const res = await servePaidPhase("boundary", req, env, facilitator);
		assert.equal(res.status, 402);
		assert.equal(settleCalls, 0);
	});
});
