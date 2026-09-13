// Concurrency burner — fire N simultaneous PAID calls at one cold row and see whether the gateway's
// per-currency single-flight collapses them into ONE wholesale debit (net-one). NOT committed.
// Each caller pays its own x402 (real USDC). Run:  N=8 node scripts/concurrency.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";

const N = Number(process.env.N ?? 8);
const URL = process.env.SMOKE_URL ?? "https://pay.snowsignals.io/phase/boundary?currency=SOL&tf=1h";
const key =
  process.env.PAYER_PRIVATE_KEY?.trim() ||
  readFileSync(process.env.X402_CREDS ?? join(homedir(), "Desktop", "x402Creds.txt"), "utf8").match(
    /^\s*PAYER_PRIVATE_KEY\s*=\s*(0x[0-9a-fA-F]{64})/m,
  )[1];

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(key) });
const pay = wrapFetchWithPayment(fetch, client);

console.log(`firing ${N} concurrent paid calls → ${URL}`);
const t0 = Date.now();
const results = await Promise.allSettled(
  Array.from({ length: N }, async (_, i) => {
    const r = await pay(URL);
    const h = r.headers.get("payment-response");
    let tx = null;
    try { tx = decodePaymentResponseHeader(h)?.transaction; } catch {}
    return { i, status: r.status, cache: r.headers.get("x-cache"), tx };
  }),
);

let ok = 0;
const txs = new Set();
for (const p of results) {
  if (p.status === "fulfilled") {
    const v = p.value;
    if (v.status === 200) ok++;
    if (v.tx) txs.add(v.tx);
    console.log(`  #${v.i}  status=${v.status}  x-cache=${v.cache}  tx=${v.tx ? v.tx.slice(0, 14) + "…" : "-"}`);
  } else {
    console.log("  ERR", p.reason?.message);
  }
}
console.log(`\n${ok}/${N} served in ${Date.now() - t0}ms · distinct on-chain settlements = ${txs.size}`);
console.log("→ now read the house tally: SOL boundary wholesale-call count should be 1 (net-one), not N.");
