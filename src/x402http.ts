/**
 * x402 HTTP glue that carries no runtime dependency on the x402 SDK (types only) — so the serve
 * path and its tests load without pulling in the facilitator / EVM scheme packages. The concrete
 * server that satisfies `PaymentServer` is built in `x402server.ts`.
 */
import type {
	HTTPAdapter,
	HTTPProcessResult,
	HTTPRequestContext,
	ProcessSettleResultResponse,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { PhaseKind } from "./types.js";

/** The two metered routes → their path (the Bazaar route template, and the serve-path key). */
export const ROUTES: Record<PhaseKind, string> = {
	boundary: "/phase/boundary",
	updates: "/phase/updates",
};

/**
 * The slice of `x402HTTPResourceServer` the gateway drives directly, so ordering stays
 * verify → serve → settle. Declared as an interface so a test can inject a stub without a live
 * facilitator; the real server satisfies it structurally.
 */
export interface PaymentServer {
	processHTTPRequest(context: HTTPRequestContext): Promise<HTTPProcessResult>;
	processSettlement(
		paymentPayload: PaymentPayload,
		requirements: PaymentRequirements,
		declaredExtensions?: Record<string, unknown>,
	): Promise<ProcessSettleResultResponse>;
}

/** Cloudflare `Request` → framework-agnostic x402 HTTP adapter. Header reads are case-insensitive. */
function makeAdapter(request: Request): HTTPAdapter {
	const url = new URL(request.url);
	return {
		getHeader: (name) => request.headers.get(name) ?? undefined,
		getMethod: () => request.method,
		getPath: () => url.pathname,
		getUrl: () => request.url,
		getAcceptHeader: () => request.headers.get("accept") ?? "",
		getUserAgent: () => request.headers.get("user-agent") ?? "",
		getQueryParams: () => Object.fromEntries(url.searchParams),
		getQueryParam: (name) => url.searchParams.get(name) ?? undefined,
	};
}

/** The x402 request context for a metered route, matched to its registered path. */
export function toRequestContext(request: Request, kind: PhaseKind): HTTPRequestContext {
	return {
		adapter: makeAdapter(request),
		path: ROUTES[kind],
		method: request.method,
		routePattern: `${request.method} ${ROUTES[kind]}`,
	};
}
