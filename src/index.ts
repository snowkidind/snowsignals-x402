/**
 * SnowSignals x402 gateway — Cloudflare Worker entrypoint.
 *
 * Resells SnowSignals phase reads over the x402 payment protocol (USDC on Base). To liveserv this
 * Worker is one ordinary prepaid url-mode customer (the house account). Public surface:
 *   metered  GET /phase/boundary, GET /phase/updates   (pay-per-call, priced per row)
 *   free     GET /phases, GET /phase/resolution-stats   (edge-cached passthrough)
 *
 * This gateway bills strictly per call — no JWT-cookie access window (Anti-patterns).
 */
import { Hono } from "hono";
import type { Env } from "./env.js";
import type { PhaseKind } from "./types.js";
import { servePaidPhase } from "./gateway.js";
import { getPaymentServer } from "./x402server.js";
import { serveFreeMetadata } from "./free.js";
import { logError } from "./log.js";

const app = new Hono<{ Bindings: Env }>();

/**
 * Acquire the isolate's payment server (built + initialized once) and serve. A build/init failure —
 * e.g. the facilitator handshake — fails loud as a logged 503, never a bare 500.
 */
async function servePaid(kind: PhaseKind, request: Request, env: Env): Promise<Response> {
	let server;
	try {
		server = await getPaymentServer(env, request);
	} catch (err) {
		logError(`[gateway] payment server init failed for ${kind}`, err);
		return Response.json({ error: "payment processing unavailable" }, { status: 503 });
	}
	return servePaidPhase(kind, request, env, server);
}

// Metered routes — priced per row, paid per call over x402 (verify → serve → settle).
app.get("/phase/boundary", (c) => servePaid("boundary", c.req.raw, c.env));
app.get("/phase/updates", (c) => servePaid("updates", c.req.raw, c.env));

// Free metadata — edge-cached passthrough, no payment.
app.get("/phases", (c) => serveFreeMetadata(c.req.raw, c.env, "/v1/api/phases"));
app.get("/phase/resolution-stats", (c) =>
	serveFreeMetadata(c.req.raw, c.env, "/v1/api/phase/resolution-stats"));

// The per-currency single-flight coordinator, exported so the Durable Object binding resolves.
export { CurrencySingleFlight } from "./singleflight.js";

export default app;
