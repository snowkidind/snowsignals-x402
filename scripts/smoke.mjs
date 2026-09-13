// Throwaway x402 money-path smoke client for the SnowSignals gateway. NOT committed.
// Reads the payer key from ~/Desktop/x402Creds.txt (a line:  PAYER_PRIVATE_KEY=0x<64 hex>).
// This makes a REAL cent-scale USDC payment on Base. Run from the repo, Node >=22:
//     node scripts/smoke.mjs
// Optional overrides:  SMOKE_URL=... X402_CREDS=/path/to/creds  node scripts/smoke.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";

const URL =
  process.env.SMOKE_URL ??
  "https://snowsignals-x402.snowsignals.workers.dev/phase/boundary?currency=BTC&tf=1h";
// Payer key: PAYER_PRIVATE_KEY env wins; otherwise read it from a creds file (X402_CREDS or the
// default on the Desktop).
function loadPayerKey() {
  const env = process.env.PAYER_PRIVATE_KEY?.trim();
  if (env) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(env)) {
      console.error("PAYER_PRIVATE_KEY is set but is not a 0x<64 hex> key");
      process.exit(1);
    }
    return env;
  }
  const creds = process.env.X402_CREDS ?? join(homedir(), "Desktop", "x402Creds.txt");
  let txt;
  try {
    txt = readFileSync(creds, "utf8");
  } catch {
    console.error(
      `No payer key: set PAYER_PRIVATE_KEY=0x<64 hex>, or point X402_CREDS at a file with that line (looked for ${creds}).`,
    );
    process.exit(1);
  }
  const m = txt.match(/^\s*PAYER_PRIVATE_KEY\s*=\s*(0x[0-9a-fA-F]{64})\s*$/m);
  if (!m) {
    console.error(`No 'PAYER_PRIVATE_KEY=0x<64 hex>' line found in ${creds}`);
    process.exit(1);
  }
  return m[1];
}

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(loadPayerKey()) });
const payFetch = wrapFetchWithPayment(fetch, client);

console.log(`→ 402→sign→pay→retry:  ${URL}`);
const res = await payFetch(URL);
console.log(`status:  ${res.status}`);
console.log(`body:    ${await res.text()}`);

const settle = res.headers.get("payment-response");
if (settle) {
  try {
    console.log("settlement:", JSON.stringify(decodePaymentResponseHeader(settle)));
  } catch {
    console.log("payment-response (raw):", settle);
  }
} else {
  console.log("(no payment-response header — check the Worker logs)");
}
