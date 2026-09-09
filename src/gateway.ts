/**
 * The x402 money path (Stage 5). Ordering is owned explicitly — verify → serve → settle — using
 * `verify`/`settle` from `useFacilitator` (x402/verify), NOT the template's paymentMiddleware (which
 * settles around the handler). Settlement runs ONLY after the data is in hand, so any pre-settle
 * failure leaves the client uncharged.
 *
 * Fail-loud status map (5.2):
 *   - no / invalid payment, or verify says invalid               → 402 (+ derived price)
 *   - serve failure (house 402, leftover fetch, missing reading) → 503 (do NOT settle)
 *   - facilitator settle error, or settle unsuccessful           → 503 (client not charged, no data)
 * There is no partial-basket serve.
 */
import { getDefaultAsset } from "x402/shared";
import { decodePayment } from "x402/schemes";
import { settleResponseHeader } from "x402/types";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "x402/types";
import type { Env } from "./env.js";
import type { PhaseKind } from "./types.js";
import { computeRetail, countRows, getPricingModel, type PricingModel } from "./pricing.js";
import { assemble, basketRows, fetchLeftovers, loadCache, readCache } from "./rows.js";
import { recordSettlement } from "./settlement.js";
import { RequestError } from "./errors.js";
import { logError } from "./log.js";

/** The subset of the facilitator we own the ordering of. Injectable so it can be stubbed in tests. */
export interface Facilitator {
	verify: (payload: PaymentPayload, requirements: PaymentRequirements) => Promise<VerifyResponse>;
	settle: (payload: PaymentPayload, requirements: PaymentRequirements) => Promise<SettleResponse>;
}

// x402 protocol version echoed in the 402 body and expected in the payment payload.
const X402_VERSION = 1;
// x402 payment authorization validity window we advertise to the client.
const MAX_TIMEOUT_SECONDS = 60;

/** Build the 402 response body the x402 client expects: the derived price under `accepts`. */
function payment402(requirements: PaymentRequirements, error: string): Response {
	return Response.json({ x402Version: X402_VERSION, error, accepts: [requirements] }, { status: 402 });
}

/**
 * Payment requirements for this request: retail micro-USD mapped 1:1 to USDC atomic units (6
 * decimals ⇒ 1 micro-USD == 1 atomic unit), asset + EIP-712 domain from the network's default USDC
 * (base ⇒ 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).
 */
function buildRequirements(
	env: Env,
	requestUrl: string,
	kind: PhaseKind,
	rows: number,
	retail: number,
): PaymentRequirements {
	const asset = getDefaultAsset(env.NETWORK);
	return {
		scheme: "exact",
		network: env.NETWORK,
		maxAmountRequired: String(retail),
		resource: requestUrl as `${string}://${string}`,
		description: `SnowSignals phase ${kind} — ${rows} row(s)`,
		mimeType: "application/json",
		payTo: env.PAY_TO,
		maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
		asset: asset.address,
		extra: { name: asset.eip712.name, version: asset.eip712.version },
	};
}

/** Serve one metered phase kind end to end: price → verify → serve pipeline → settle. */
export async function servePaidPhase(
	kind: PhaseKind,
	request: Request,
	env: Env,
	facilitator: Facilitator,
): Promise<Response> {
	const query = new URL(request.url).searchParams;

	// Price the request from the live model. A bad / over-cap basket is a 400 (before any payment).
	let model: PricingModel;
	let rows: number;
	let requirements: PaymentRequirements;
	try {
		model = await getPricingModel(env);
		rows = countRows(query, model);
		const retail = computeRetail(rows, model);
		requirements = buildRequirements(env, request.url, kind, rows, retail);
	} catch (err) {
		if (err instanceof RequestError) {
			return Response.json({ error: err.message }, { status: err.status });
		}
		logError(`[gateway] pricing failed for ${kind}`, err);
		return Response.json({ error: "pricing unavailable" }, { status: 503 });
	}

	// Require + verify payment. No payment / invalid payment / verify-invalid ⇒ 402 with the price.
	const paymentHeader = request.headers.get("X-PAYMENT");
	if (!paymentHeader) {
		return payment402(requirements, "X-PAYMENT header is required");
	}
	let payment: PaymentPayload;
	try {
		payment = decodePayment(paymentHeader);
	} catch (err) {
		logError("[gateway] X-PAYMENT decode failed", err);
		return payment402(requirements, "invalid X-PAYMENT header");
	}
	let verification: VerifyResponse;
	try {
		verification = await facilitator.verify(payment, requirements);
	} catch (err) {
		logError("[gateway] facilitator verify threw", err);
		return payment402(requirements, "payment verification error");
	}
	if (!verification.isValid) {
		return payment402(requirements, verification.invalidReason ?? "payment verification failed");
	}

	// Serve the basket per row. Any failure here (house 402, leftover fetch, missing reading) ⇒ 503,
	// and settlement is NOT reached — the client is not charged.
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
	let settlement: SettleResponse;
	try {
		settlement = await facilitator.settle(payment, requirements);
	} catch (err) {
		logError("[gateway] facilitator settle threw", err);
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
		amount: Number(requirements.maxAmountRequired),
		cache_hit_rows: cacheHitRows,
		ts: Date.now(),
	});

	const response = Response.json({ data: shaped });
	response.headers.set("X-PAYMENT-RESPONSE", settleResponseHeader(settlement));
	return response;
}
