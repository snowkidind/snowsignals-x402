/**
 * Free metadata passthrough (Stage 6 / D4). `/phases` and `/phase/resolution-stats` proxy the origin
 * payloads of the same name, edge-cached — no house key, no 402, no settle. `/phases` fetches the
 * same origin URL the pricing model reads, so the edge cache dedupes the two (the "reuse the
 * price-model fetch" reuse is the shared URL + edge cache, not shared code).
 *
 * Cached for the metadata horizon (PRICING_TTL_SECONDS). Fail loud on a non-2xx origin — never serve
 * an empty or stale body silently.
 */
import type { Env } from "./env.js";
import { PRICING_TTL_SECONDS } from "./config.js";
import { logError } from "./log.js";

/**
 * Serve `originPath` from the edge cache, fetching + caching on a miss. The cache key is the incoming
 * request URL, so a repeat is served from cache without re-hitting the origin.
 */
export async function serveFreeMetadata(request: Request, env: Env, originPath: string): Promise<Response> {
	const cache = caches.default;
	const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });

	const cached = await cache.match(cacheKey);
	if (cached) {
		return cached;
	}

	const originUrl = `${env.ORIGIN_URL}${originPath}`;
	const originResponse = await fetch(originUrl);
	if (!originResponse.ok) {
		logError(`[free] origin ${originUrl} returned ${originResponse.status}`);
		return Response.json({ error: "metadata temporarily unavailable" }, { status: 502 });
	}

	const body = await originResponse.text();
	const response = new Response(body, {
		status: 200,
		headers: {
			"content-type": originResponse.headers.get("content-type") ?? "application/json",
			"cache-control": `public, max-age=${PRICING_TTL_SECONDS}`,
		},
	});
	// Store a clone; the Cache API consumes the body it is given.
	await cache.put(cacheKey, response.clone());
	return response;
}
