// End-to-end tests against a LIVE SnowSignals x402 gateway (x402 v2, USDC on Base).
//
// Env-driven so anyone can point it at their own deployment with their own funded wallet:
//   GATEWAY_URL         base URL of the gateway            (default https://pay.snowsignals.io)
//   NETWORK             x402 CAIP-2 network                (default eip155:8453 = Base mainnet)
//   PAYER_PRIVATE_KEY   0x… key of a Base wallet holding a little USDC. REQUIRED for the paid tests;
//                       without it, only the free / 402 / 400 tests run (the paid ones skip).
//
// The paid tests make REAL cent-scale USDC payments on-chain (roughly 5 calls, ~$0.05 total).
// Run:  npm run test:e2e     (Node >=22)
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";

const GATEWAY = (process.env.GATEWAY_URL ?? "https://pay.snowsignals.io").replace(/\/+$/, "");
const NETWORK = process.env.NETWORK ?? "eip155:8453";
const KEY = process.env.PAYER_PRIVATE_KEY;
const paid = KEY ? test : test.skip;

// The gateway's own pricing rule, mirrored so we can assert the quote for any deployment's live rate:
// wholesale = round(rows × base × mult(rows)); retail = wholesale × 3.
function mult(tiers, n) {
  for (const t of tiers) if (t.max_rows === null || n <= t.max_rows) return t.factor;
  return 1;
}
function retail(model, n) {
  return Math.round(n * model.base_rate_micro_usd * mult(model.multiplier_tiers, n)) * 3;
}

let _model, _pay;
async function model() {
  if (!_model) {
    const r = await fetch(`${GATEWAY}/phases`);
    assert.equal(r.status, 200, "/phases should be 200");
    _model = (await r.json()).pricing;
  }
  return _model;
}
async function pay() {
  if (!_pay) {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(KEY) });
    _pay = wrapFetchWithPayment(fetch, client);
  }
  return _pay;
}

// ─── free / no-money ─────────────────────────────────────────────────────────────────────────
test("free: /phases returns currencies, timeframes, and the pricing model", async () => {
  const r = await fetch(`${GATEWAY}/phases`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.currencies) && d.currencies.length, "currencies present");
  assert.ok(Array.isArray(d.tfs) && d.tfs.length, "timeframes present");
  assert.ok(d.pricing?.base_rate_micro_usd > 0, "pricing.base_rate_micro_usd present");
  assert.ok(Array.isArray(d.pricing?.multiplier_tiers), "pricing.multiplier_tiers present");
});

test("free: /phase/resolution-stats returns 200", async () => {
  const r = await fetch(`${GATEWAY}/phase/resolution-stats`);
  assert.equal(r.status, 200);
});

test("402: an unpaid metered call quotes the correct price + payTo", async () => {
  const m = await model();
  const r = await fetch(`${GATEWAY}/phase/boundary?currency=BTC&tf=1h`);
  assert.equal(r.status, 402);
  // x402 v2 carries the challenge in the PAYMENT-REQUIRED header (base64), not the body.
  const challenge = r.headers.get("payment-required");
  assert.ok(challenge, "PAYMENT-REQUIRED header present");
  const req = decodePaymentRequiredHeader(challenge).accepts?.[0];
  assert.ok(req, "accepts[0] present");
  assert.equal(req.network, NETWORK);
  assert.equal(Number(req.amount), retail(m, 1), "quote = 3× wholesale for 1 row");
  assert.match(req.payTo, /^0x[0-9a-fA-F]{40}$/, "payTo is an address");
});

test("400: an unknown currency is rejected before any payment", async () => {
  const r = await fetch(`${GATEWAY}/phase/boundary?currency=NOTACOIN&tf=1h`);
  assert.equal(r.status, 400);
});

test("400: an unknown timeframe is rejected before any payment", async () => {
  const r = await fetch(`${GATEWAY}/phase/boundary?currency=BTC&tf=9y`);
  assert.equal(r.status, 400);
});

// ─── paid (real USDC on Base; skipped without PAYER_PRIVATE_KEY) ───────────────────────────────
before(() => {
  if (!KEY) console.log("PAYER_PRIVATE_KEY not set — skipping paid tests.");
});

paid("paid: a single row is served and the payment settles on-chain", async () => {
  const r = await (await pay())(`${GATEWAY}/phase/boundary?currency=BTC&tf=1h`);
  assert.equal(r.status, 200);
  const reading = (await r.json()).data?.BTC?.["1h"];
  assert.ok(reading?.phase, "a phase reading came back");
  assert.ok(r.headers.get("payment-response"), "settlement header present");
});

paid("cache: repeating the same row serves from cache (no wholesale re-buy)", async () => {
  const url = `${GATEWAY}/phase/boundary?currency=BTC&tf=1h`;
  await (await pay())(url); // warm
  const r = await (await pay())(url); // repeat
  assert.equal(r.status, 200);
  // X-Cache reflects KV hits. KV is eventually consistent, so on a rare propagation lag this may read
  // 'miss' — re-run if so. Within a candle, a warmed boundary row should be a hit.
  assert.equal(r.headers.get("x-cache"), "hit", "second identical call is a cache hit");
});

paid("basket: a multi-currency, multi-timeframe request returns exactly those rows", async () => {
  const r = await (await pay())(`${GATEWAY}/phase/boundary?currency=BTC,ETH&tf=1h,4h`);
  assert.equal(r.status, 200);
  const data = (await r.json()).data;
  assert.deepEqual(Object.keys(data).sort(), ["BTC", "ETH"]);
  for (const c of ["BTC", "ETH"]) assert.deepEqual(Object.keys(data[c]).sort(), ["1h", "4h"]);
});

paid("filtering: a single-row request returns only that row, nothing extra", async () => {
  const r = await (await pay())(`${GATEWAY}/phase/boundary?currency=BTC&tf=2h`);
  assert.equal(r.status, 200);
  const data = (await r.json()).data;
  assert.deepEqual(Object.keys(data), ["BTC"]);
  assert.deepEqual(Object.keys(data.BTC), ["2h"]);
});

paid("updates: the live-read kind also serves + settles", async () => {
  const r = await (await pay())(`${GATEWAY}/phase/updates?currency=BTC&tf=1h`);
  assert.equal(r.status, 200);
  assert.ok((await r.json()).data?.BTC?.["1h"] !== undefined, "updates row present");
});
