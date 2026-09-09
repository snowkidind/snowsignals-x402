/**
 * Pricing — size-derived from the live SnowSignals pricing model, never hardcoded (D1/D8).
 *
 * The model is fetched from the origin's free `GET /v1/api/phases` `pricing` block (+ the enabled
 * `currencies`/`tfs` sets) and cached ~24h in KV; on a miss/expiry it is refetched. A fetch error
 * fails loud — there is no hardcoded price fallback (Anti-patterns).
 *
 * Retail price by request size: `wholesale = round(rows × base_rate_micro_usd × mult(rows))`,
 * `retail = wholesale × RETAIL_MULTIPLIER`. `rows = |currencies| × |tfs|`.
 */
import type { Env } from "./env.js";
import { PRICING_TTL_SECONDS, RETAIL_MULTIPLIER } from "./config.js";
import { RequestError } from "./errors.js";

/** One multiplier tier from the published model: rows ≤ max_rows ⇒ factor (max_rows null = ∞). */
export interface MultiplierTier {
	max_rows: number | null;
	factor: number;
}

/** The pricing inputs the gateway needs, distilled from the origin `/v1/api/phases` payload. */
export interface PricingModel {
	base_rate_micro_usd: number;
	multiplier_tiers: MultiplierTier[];
	/** Enabled currency set (the origin's live candleserv-served set). */
	currencies: string[];
	/** Enabled timeframe set. */
	tfs: string[];
}

const PRICE_MODEL_KEY = "price-model";

/**
 * Return the pricing model, from KV if warm else fetched from the origin and cached. Fails loud on
 * a missing KV binding or a bad/absent origin payload (no hardcoded fallback).
 */
export async function getPricingModel(env: Env): Promise<PricingModel> {
	if (!env.PHASE_CACHE) {
		throw new Error("PHASE_CACHE KV binding is not configured");
	}
	const cached = (await env.PHASE_CACHE.get(PRICE_MODEL_KEY, "json")) as PricingModel | null;
	if (cached) {
		return cached;
	}

	const url = `${env.ORIGIN_URL}/v1/api/phases`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`pricing model fetch ${url} returned ${res.status}`);
	}
	const body = (await res.json()) as {
		pricing?: { base_rate_micro_usd?: number; multiplier_tiers?: MultiplierTier[] };
		currencies?: string[];
		tfs?: string[];
	};
	const pricing = body.pricing;
	if (
		!pricing ||
		typeof pricing.base_rate_micro_usd !== "number" ||
		!Array.isArray(pricing.multiplier_tiers) ||
		!Array.isArray(body.currencies) ||
		!Array.isArray(body.tfs)
	) {
		throw new Error(`pricing model payload from ${url} is malformed`);
	}

	const model: PricingModel = {
		base_rate_micro_usd: pricing.base_rate_micro_usd,
		multiplier_tiers: pricing.multiplier_tiers,
		currencies: body.currencies,
		tfs: body.tfs,
	};
	await env.PHASE_CACHE.put(PRICE_MODEL_KEY, JSON.stringify(model), {
		expirationTtl: PRICING_TTL_SECONDS,
	});
	return model;
}

/** The multiplier for a given row count — first tier whose max_rows covers `rows` (null = ∞). */
export function multiplierFor(rows: number, tiers: MultiplierTier[]): number {
	for (const tier of tiers) {
		if (tier.max_rows === null || rows <= tier.max_rows) {
			return tier.factor;
		}
	}
	// The published model always ends with a max_rows:null catch-all; a miss means a bad model.
	throw new Error(`no multiplier tier matched ${rows} rows`);
}

/** Retail micro-USD for `rows`: round(rows × base × mult(rows)) × RETAIL_MULTIPLIER. */
export function computeRetail(rows: number, model: PricingModel): number {
	const factor = multiplierFor(rows, model.multiplier_tiers);
	const wholesale = Math.round(rows * model.base_rate_micro_usd * factor);
	return wholesale * RETAIL_MULTIPLIER;
}

/** "all"/empty ⇒ the full enabled set; else a trimmed comma list (dups preserved — they bill). */
function parseList(param: string | null, all: string[]): string[] {
	if (param == null || param === "" || param === "all") {
		return [...all];
	}
	return param
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Parse + validate `currency`/`tf` against the model's enabled sets (mirrors liveserv parseList).
 * Throws RequestError(400) on an empty or unknown-member list. Does NOT enforce the cap — countRows
 * owns that so the price is computed on a rejected-if-too-large basket.
 */
export function parseBasket(
	query: URLSearchParams,
	model: PricingModel,
): { currencies: string[]; tfs: string[] } {
	const currencies = parseList(query.get("currency"), model.currencies);
	const tfs = parseList(query.get("tf"), model.tfs);
	if (currencies.length === 0 || currencies.some((c) => !model.currencies.includes(c))) {
		throw new RequestError(400, "invalid currency (must be a served currency)");
	}
	if (tfs.length === 0 || tfs.some((t) => !model.tfs.includes(t))) {
		throw new RequestError(400, "invalid tf (must be a served timeframe or 'all')");
	}
	return { currencies, tfs };
}

/**
 * The billable row count for the request: `|currencies| × |tfs|`. The cap is the full enabled basket
 * (`|enabled currencies| × |enabled tfs|`); a larger request (e.g. duplicated members) is rejected
 * with 400.
 */
export function countRows(query: URLSearchParams, model: PricingModel): number {
	const { currencies, tfs } = parseBasket(query, model);
	const rows = currencies.length * tfs.length;
	const cap = model.currencies.length * model.tfs.length;
	if (rows > cap) {
		throw new RequestError(400, `basket too large: ${rows} rows exceeds cap ${cap}`);
	}
	return rows;
}
