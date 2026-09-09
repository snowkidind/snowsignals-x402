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
import { useFacilitator } from "x402/verify";
import { createCdpAuthHeaders } from "@coinbase/x402";
import type { Env } from "./env.js";
import { servePaidPhase, type Facilitator } from "./gateway.js";

const app = new Hono<{ Bindings: Env }>();

/** The CDP facilitator client (verify + settle), authenticated with the CDP API key secrets. */
function makeFacilitator(env: Env): Facilitator {
	// @coinbase/x402 (via @x402/core) and x402 pin slightly different CreateHeaders types (optional vs
	// required header maps); the runtime shapes match, so bridge the two with a typed cast.
	const config = {
		url: env.FACILITATOR_URL,
		createAuthHeaders: createCdpAuthHeaders(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET),
	} as Parameters<typeof useFacilitator>[0];
	const { verify, settle } = useFacilitator(config);
	return { verify, settle };
}

// Metered routes — priced per row, paid per call over x402.
app.get("/phase/boundary", (c) => servePaidPhase("boundary", c.req.raw, c.env, makeFacilitator(c.env)));
app.get("/phase/updates", (c) => servePaidPhase("updates", c.req.raw, c.env, makeFacilitator(c.env)));

// The per-currency single-flight coordinator, exported so the Durable Object binding resolves.
export { CurrencySingleFlight } from "./singleflight.js";

export default app;
