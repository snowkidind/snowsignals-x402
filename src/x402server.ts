/**
 * Builds the x402 v2 resource server the gateway drives (verify → serve → settle). EVM-only on Base:
 * one `exact` scheme on `eip155:8453`, verify/settle through the CDP facilitator. The gateway keeps
 * ordering itself (it does not use settle-around-handler middleware), so per-row pricing and the
 * per-currency single-flight are preserved and settlement runs only after the data is in hand.
 *
 * The server is built once per isolate (facilitator support is fetched in `initialize()`); the
 * per-request price is derived from the live SnowSignals model, mapped 1:1 micro-USD → USDC atomic.
 */
import { x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import type { DynamicPrice, RouteConfig, RoutesConfig } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createCdpFacilitatorClient, buildBazaarDeclaration, CDP_EXTENSION_BAZAAR } from "@coinbase/cdp-sdk/x402";
import type { Env } from "./env.js";
import { MAX_TIMEOUT_SECONDS, NETWORK, USDC_ASSET } from "./config.js";
import { computeRetail, countRows, getPricingModel } from "./pricing.js";
import { ROUTES, type PaymentServer } from "./x402http.js";
import type { PhaseKind } from "./types.js";

/** Per-request price: rows × live model → retail micro-USD, as USDC atomic units (1:1 micro-USD). */
function dynamicPrice(env: Env): DynamicPrice {
	return async (context) => {
		const query = new URL(context.adapter.getUrl()).searchParams;
		const model = await getPricingModel(env);
		const rows = countRows(query, model);
		return { asset: USDC_ASSET, amount: String(computeRetail(rows, model)) };
	};
}

/**
 * The metered routes: an EVM `exact` option on Base priced per row, receiving USDC at `PAY_TO`. Each
 * carries a Bazaar discovery declaration so the CDP facilitator indexes the route at settle time. The
 * `resource` is the canonical route URL (derived from the deployment's own origin, so a fork lists
 * under its own domain) rather than the per-request URL, keeping one clean catalog entry per route.
 */
function buildRoutes(env: Env, origin: string): RoutesConfig {
	const price = dynamicPrice(env);
	const routes: Record<string, RouteConfig> = {};
	for (const kind of Object.keys(ROUTES) as PhaseKind[]) {
		routes[`GET ${ROUTES[kind]}`] = {
			accepts: {
				scheme: "exact",
				network: NETWORK,
				payTo: env.PAY_TO,
				price,
				maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
			},
			resource: `${origin}${ROUTES[kind]}`,
			description: `SnowSignals phase ${kind} — pay-per-row market-phase reading`,
			mimeType: "application/json",
			serviceName: "SnowSignals",
			extensions: { [CDP_EXTENSION_BAZAAR]: buildBazaarDeclaration("GET", ROUTES[kind]) },
		};
	}
	return routes;
}

let serverPromise: Promise<x402HTTPResourceServer> | undefined;

/**
 * The isolate-wide payment server (built + initialized once). The request supplies the deployment's
 * own origin for the routes' canonical `resource` URLs. Fails loud if CDP keys are unset.
 */
export function getPaymentServer(env: Env, request: Request): Promise<PaymentServer> {
	if (!serverPromise) {
		const origin = new URL(request.url).origin;
		serverPromise = buildServer(env, origin).catch((err) => {
			serverPromise = undefined; // let a later request retry a failed init
			throw err;
		});
	}
	return serverPromise;
}

async function buildServer(env: Env, origin: string): Promise<x402HTTPResourceServer> {
	const facilitator = createCdpFacilitatorClient({
		apiKeyId: env.CDP_API_KEY_ID,
		apiKeySecret: env.CDP_API_KEY_SECRET,
		baseUrl: env.FACILITATOR_URL,
	});
	const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
	const server = new x402HTTPResourceServer(resourceServer, buildRoutes(env, origin));
	await server.initialize();
	return server;
}
