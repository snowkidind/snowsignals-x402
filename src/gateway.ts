/**
 * The x402 money path. Ordering is owned explicitly — verify → serve → settle — by driving the v2
 * resource server's `processHTTPRequest` / `processSettlement` rather than the settle-around-handler
 * middleware. Settlement runs ONLY after the data is in hand, so any pre-settle failure leaves the
 * client uncharged.
 *
 * Fail-loud status map:
 *   - bad / over-cap basket (before any payment)                 → 400
 *   - no / invalid payment, or verify says invalid               → 402 (+ derived price, from the server)
 *   - serve failure (house 402, leftover fetch, missing reading) → 503 (do NOT settle)
 *   - facilitator settle error, or settle unsuccessful           → 503 (client not charged, no data)
 * There is no partial-basket serve.
 */
import type { HTTPResponseInstructions } from "@x402/core/http";
import type { Env } from "./env.js";
import type { PhaseKind } from "./types.js";
import { computeRetail, countRows, getPricingModel, type PricingModel } from "./pricing.js";
import { assemble, basketRows, fetchLeftovers, loadCache, readCache } from "./rows.js";
import { recordSettlement } from "./settlement.js";
import { RequestError } from "./errors.js";
import { logError } from "./log.js";
import { toRequestContext, type PaymentServer } from "./x402http.js";

/** Render the resource server's response instructions (402 challenge, verify errors) as a Response. */
function toResponse(instructions: HTTPResponseInstructions): Response {
	const { status, headers, body } = instructions;
	const isJson = body !== undefined && body !== null && typeof body === "object";
	const payload = body === undefined || body === null ? null : isJson ? JSON.stringify(body) : String(body);
	const res = new Response(payload, { status });
	for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
	if (isJson && !res.headers.has("Content-Type")) res.headers.set("Content-Type", "application/json");
	return res;
}

/** Serve one metered phase kind end to end: price → verify → serve pipeline → settle. */
export async function servePaidPhase(
	kind: PhaseKind,
	request: Request,
	env: Env,
	server: PaymentServer,
): Promise<Response> {
	const query = new URL(request.url).searchParams;

	// Price + validate the basket up front so a bad / over-cap request is a clean 400 before any
	// payment work. `retail` is authoritative for the settlement record — it uses the same live model
	// and math the server's dynamic price does, so it equals what the client is charged.
	let model: PricingModel;
	let rows: number;
	let retail: number;
	try {
		model = await getPricingModel(env);
		rows = countRows(query, model);
		retail = computeRetail(rows, model);
	} catch (err) {
		if (err instanceof RequestError) {
			return Response.json({ error: err.message }, { status: err.status });
		}
		logError(`[gateway] pricing failed for ${kind}`, err);
		return Response.json({ error: "pricing unavailable" }, { status: 503 });
	}

	// Verify the payment, or issue the 402 challenge with the derived price. The resource server owns
	// the x402 wire format + version negotiation; we own what happens between verify and settle.
	let processed;
	try {
		processed = await server.processHTTPRequest(toRequestContext(request, kind));
	} catch (err) {
		logError(`[gateway] processHTTPRequest threw for ${kind}`, err);
		return Response.json({ error: "payment processing error" }, { status: 503 });
	}
	if (processed.type === "payment-error") {
		return toResponse(processed.response);
	}
	if (processed.type === "no-payment-required") {
		// A metered route must always require payment; this means a route/config mismatch — fail loud.
		logError(`[gateway] unexpected no-payment-required on metered route /phase/${kind}`);
		return Response.json({ error: "payment required" }, { status: 402 });
	}

	// Payment verified. Serve the basket per row. Any failure here (house 402, leftover fetch, missing
	// reading) ⇒ 503, and settlement is NOT reached — the client is not charged.
	let shaped;
	let cacheHitRows: number;
	try {
		const allRows = basketRows(kind, query, model);
		const { have, need } = await readCache(env, allRows);
		const fresh = await fetchLeftovers(env, need);
		await loadCache(env, fresh);
		shaped = assemble(allRows, have, fresh);
		cacheHitRows = have.length;
	} catch (err) {
		logError(`[gateway] serve pipeline failed for ${kind} (not settling)`, err);
		return Response.json({ error: "phase data temporarily unavailable" }, { status: 503 });
	}

	// Data is in hand — settle now. A settle error / unsuccessful settle ⇒ 503, no data served.
	let settlement;
	try {
		settlement = await server.processSettlement(
			processed.paymentPayload,
			processed.paymentRequirements,
			processed.declaredExtensions,
		);
	} catch (err) {
		logError(`[gateway] processSettlement threw for ${kind}`, err);
		return Response.json({ error: "settlement error" }, { status: 503 });
	}
	if (!settlement.success) {
		logError(`[gateway] settlement unsuccessful: ${settlement.errorReason ?? "unknown"}`);
		return Response.json({ error: "settlement failed" }, { status: 503 });
	}

	await recordSettlement(env, {
		tx_hash: settlement.transaction,
		endpoint: `/phase/${kind}`,
		kind,
		rows,
		amount: retail,
		cache_hit_rows: cacheHitRows,
		ts: Date.now(),
	});

	const response = Response.json({ data: shaped });
	for (const [k, v] of Object.entries(settlement.headers)) response.headers.set(k, v);
	// Cache observability (clients / e2e): how many served rows came warm vs. bought wholesale.
	response.headers.set("X-Rows", String(rows));
	response.headers.set("X-Cache-Hit-Rows", String(cacheHitRows));
	response.headers.set("X-Cache", cacheHitRows === rows ? "hit" : cacheHitRows === 0 ? "miss" : "partial");
	return response;
}
