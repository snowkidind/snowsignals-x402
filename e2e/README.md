# End-to-end tests

These run against a **live** SnowSignals x402 gateway and, for the paid tests, make **real
cent-scale USDC payments on Base**. They're the confidence check that the deployed Worker actually
prices, serves, caches, and settles — not just that the unit tests pass.

## What it checks

- **Free routes** — `/phases` returns the pricing model + enabled currencies/timeframes;
  `/phase/resolution-stats` responds.
- **402 challenge** — an unpaid metered call quotes the right price (3× the live wholesale rate) and a
  valid `payTo`.
- **Input errors** — unknown currency / timeframe are rejected with `400` before any payment.
- **Paid, single row** — the payment settles on-chain and the phase reading comes back.
- **Cache** — repeating the same row is served from cache (`X-Cache: hit`), i.e. no wholesale re-buy.
- **Basket** — a multi-currency, multi-timeframe request returns exactly the requested rows, and a
  single-row request returns only that row (no leakage from a shared per-currency fetch).
- **Live read** — the `updates` kind serves and settles too.

## Running it

Node ≥ 22. From the repo root:

```
npm install            # first time (pulls x402-fetch + viem)
npm run test:e2e
```

### Config (environment)

| Var | Default | Notes |
|-----|---------|-------|
| `GATEWAY_URL` | `https://pay.snowsignals.io` | Point it at your own deployment. |
| `NETWORK` | `base` | x402 network. |
| `PAYER_PRIVATE_KEY` | — | `0x…` key of a Base wallet holding a little USDC. **Required for the paid tests**; omit it and only the free / 402 / 400 tests run. |

Bring your own funds and key — nothing wallet-specific is committed here. A Base wallet with ~$1 of
USDC is plenty; the paid suite spends roughly **$0.05** across ~5 calls. Your wallet needs USDC, not gas
(the x402 facilitator covers gas).

```
GATEWAY_URL=https://pay.snowsignals.io \
PAYER_PRIVATE_KEY=0xYOUR_TEST_KEY \
npm run test:e2e
```

Keep `PAYER_PRIVATE_KEY` out of your shell history and out of git — pass it inline, or export it from a
file you don't commit.

## Notes

- **Cache hit flakiness:** `X-Cache` reflects KV hits, and Workers KV is eventually consistent, so on a
  rare write-propagation lag the cache test can read `miss`. Re-run if so.
- **Concurrency / net-one wholesale debit:** the "N concurrent callers → one wholesale debit" property is
  coordinated server-side (a Durable Object) and isn't directly observable from a client — the cache test
  above proves the sequential case. Verifying the concurrent case needs the house account's own usage log.
