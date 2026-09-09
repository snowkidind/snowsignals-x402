# snowsignals-x402

A Cloudflare Worker that resells [SnowSignals](https://snowsignals.io) market-phase reads over the
[x402](https://x402.org) payment protocol. An agent pays per call in USDC on Base; the Worker verifies
the payment, serves the phase data, then settles. To the SnowSignals API (liveserv) the Worker is one
ordinary prepaid url-mode customer — the "house account".

## Provenance

Cribbed from
[`cloudflare/templates/x402-proxy-template`](https://github.com/cloudflare/templates/tree/main/x402-proxy-template)
@ commit `fa7b8572e96fa5ac3bc0b5b4ed20193ed75ce90a`. This is a **net-new** project, **not a fork** — the
transparent-proxy skeleton and the x402 wiring were used as a starting point, then reworked: the
JWT-cookie access window was removed (this gateway bills strictly per call), pricing is derived per row
from the live SnowSignals pricing model, and the serve path caches and single-flights per row.

## Public routes

The Worker fronts these routes (on the eventual `pay.snowsignals.io`), each mapping to the liveserv
`/v1/api/...` origin path of the same name:

| Route | Cost | Origin |
|-------|------|--------|
| `GET /phase/boundary?currency=&tf=` | metered (per row) | `/v1/api/phase/boundary` |
| `GET /phase/updates?currency=&tf=` | metered (per row) | `/v1/api/phase/updates` |
| `GET /phases` | free (edge-cached) | `/v1/api/phases` |
| `GET /phase/resolution-stats` | free (edge-cached) | `/v1/api/phase/resolution-stats` |

`currency` and `tf` are comma-lists or `all`. A metered request is priced as `rows = |currencies| ×
|tfs|` at the SnowSignals base rate × the tier multiplier, then × the retail multiplier (see
`src/config.ts`). The pricing model is fetched live from `GET /v1/api/phases` — never hardcoded.

## How it works

```
agent ──pay per call (x402 / USDC on Base)──▶  Worker (Cloudflare edge)
                                                 │  no payment → 402 + derived price
                                                 │  payment → verify (CDP facilitator)
                                                 │  price/serve per ROW (basket = currency×tf rows)
                                                 │    KV hit → serve ; miss → per-currency DO single-flight
                                                 │      → per-currency leftover GET liveserv ?apiKey=<house>
                                                 │  settle AFTER the data is in hand
                                                 ▼   USDC → merchant address (Base)
liveserv (unchanged)  ◀── house account, url-mode, daas:read
```

- **Price per row, from the live model.** `src/pricing.ts` reads the pricing model (cached ~24h in KV,
  refetched from the origin on miss) and computes the retail micro-USD price by request size.
- **Cache per row.** Each `(kind, currency, tf, bucket)` is cached independently (`src/rows.ts`), so a
  warm row is never re-bought.
- **Single-flight per currency.** Leftover rows (cache misses) are grouped per currency and routed
  through a Durable Object (`src/singleflight.ts`), which coalesces concurrent identical rows and issues
  one wholesale origin GET per currency for exactly its needed timeframes.
- **Fail loud on the money path.** A facilitator error, a house-account 402, or a leftover-fetch failure
  maps to a mapped HTTP status and **does not settle** — the client is not charged. Settlement runs only
  after a successful serve.

## Configuration

Config vars live in `wrangler.jsonc` (`ORIGIN_URL`, `FACILITATOR_URL`, `PAY_TO`). Secrets are
set with `wrangler secret put` and are **never committed** — see `.dev.vars.example` for the list
(`HOUSE_API_KEY`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`).

`PAY_TO` in `wrangler.jsonc` is a **documented placeholder** (the dead address) — the real merchant
address is set at go-live.

## Develop

```
npm install
npm run typecheck     # tsc --noEmit
npm test              # unit tests (node:test via tsx)
npx wrangler deploy --dry-run
```

Deploying, provisioning the Cloudflare resources (KV namespace, Durable Object), the house account, and
the on-chain tests are handled at go-live, not here.

## License

Not yet specified.
