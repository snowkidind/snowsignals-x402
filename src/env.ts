/**
 * Environment bindings for the SnowSignals x402 gateway.
 *
 * Extends the wrangler-generated `CloudflareBindings` (vars + KV + Durable Object, from
 * wrangler.jsonc) with the secrets that are set via `wrangler secret put` at deploy time
 * ([[98-x402-gateway-go-live]]) — never committed. A missing REQUIRED secret must fail loud at the
 * point of use (Ground rule 4 / CLAUDE.md "no credential fallbacks"); there is no default.
 */

export interface Env extends CloudflareBindings {
	/**
	 * The SnowSignals house account's url-mode API key (daas:read). The single-flight Durable Object
	 * uses it to buy leftover rows wholesale from the origin. Set via `wrangler secret put` in
	 * [[98]]; absent here (build segment). Required at serve time — fail loud if unset.
	 */
	HOUSE_API_KEY: string;
	/** CDP (Coinbase Developer Platform) API key id — authenticates verify/settle to the CDP facilitator. Secret ([[98]]). */
	CDP_API_KEY_ID: string;
	/** CDP API key secret — the other half of the facilitator auth header. Secret ([[98]]). */
	CDP_API_KEY_SECRET: string;
}
