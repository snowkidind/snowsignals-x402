/**
 * SnowSignals x402 gateway — Cloudflare Worker entrypoint.
 *
 * Resells SnowSignals phase reads over the x402 payment protocol (USDC on Base). To liveserv this
 * Worker is one ordinary prepaid url-mode customer (the house account). Public surface:
 *   metered  GET /phase/boundary, GET /phase/updates   (pay-per-call, priced per row)
 *   free     GET /phases, GET /phase/resolution-stats   (edge-cached passthrough)
 *
 * The cookie/JWT access-window from the upstream template is intentionally gone: this gateway bills
 * strictly per call (Anti-patterns — "keep the template's JWT-cookie access window").
 *
 * Cribbed from cloudflare/templates/x402-proxy-template @ fa7b8572e96fa5ac3bc0b5b4ed20193ed75ce90a;
 * net-new, not a fork.
 */
import { Hono } from "hono";
import type { Env } from "./env.js";
import { servePaidPhase } from "./gateway.js";
import { getPaymentServer } from "./x402server.js";
import { serveFreeMetadata } from "./free.js";

const app = new Hono<{ Bindings: Env }>();

// Metered routes — priced per row, paid per call over x402 (verify → serve → settle).
app.get("/phase/boundary", async (c) =>
	servePaidPhase("boundary", c.req.raw, c.env, await getPaymentServer(c.env, c.req.raw)));
app.get("/phase/updates", async (c) =>
	servePaidPhase("updates", c.req.raw, c.env, await getPaymentServer(c.env, c.req.raw)));

// Free metadata — edge-cached passthrough, no payment.
app.get("/phases", (c) => serveFreeMetadata(c.req.raw, c.env, "/v1/api/phases"));
app.get("/phase/resolution-stats", (c) =>
	serveFreeMetadata(c.req.raw, c.env, "/v1/api/phase/resolution-stats"));

// The per-currency single-flight coordinator, exported so the Durable Object binding resolves.
export { CurrencySingleFlight } from "./singleflight.js";

export default app;
