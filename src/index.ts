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

const app = new Hono<{ Bindings: Env }>();

// Metered + free routes are wired in later stages (money path, then free metadata passthrough).

export default app;
