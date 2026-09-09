import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { serveFreeMetadata } from "../src/free.js";
import type { Env } from "../src/env.js";

const realFetch = globalThis.fetch;
const realCaches = (globalThis as { caches?: unknown }).caches;
afterEach(() => {
	globalThis.fetch = realFetch;
	(globalThis as { caches?: unknown }).caches = realCaches;
});

/** Minimal in-memory Cache API (default cache), keyed by request URL. */
function installMockCache() {
	const store = new Map<string, Response>();
	(globalThis as { caches?: unknown }).caches = {
		default: {
			match: async (req: Request) => {
				const hit = store.get(req.url);
				return hit ? hit.clone() : undefined;
			},
			put: async (req: Request, res: Response) => {
				store.set(req.url, res.clone());
			},
		},
	};
	return store;
}

describe("free — edge-cached metadata passthrough", () => {
	it("proxies the origin payload unauthenticated, then serves a repeat from cache", async () => {
		installMockCache();
		let originCalls = 0;
		globalThis.fetch = (async (input: unknown) => {
			originCalls++;
			assert.equal(String(input), "https://snowsignals.io/v1/api/phases");
			return new Response(JSON.stringify({ phases: ["establishing_bull"], tfs: ["1h"] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		const env = { ORIGIN_URL: "https://snowsignals.io" } as unknown as Env;
		const req = new Request("https://pay.snowsignals.io/phases");

		const first = await serveFreeMetadata(req, env, "/v1/api/phases");
		assert.equal(first.status, 200);
		const firstBody = (await first.json()) as { phases: string[] };
		assert.deepEqual(firstBody.phases, ["establishing_bull"]);
		assert.equal(originCalls, 1);

		// Repeat: served from the edge cache, origin NOT re-fetched.
		const second = await serveFreeMetadata(req, env, "/v1/api/phases");
		assert.equal(second.status, 200);
		assert.equal(originCalls, 1);
	});

	it("fails loud (502) when the origin returns non-2xx", async () => {
		installMockCache();
		globalThis.fetch = (async () => new Response("down", { status: 500 })) as typeof fetch;
		const env = { ORIGIN_URL: "https://snowsignals.io" } as unknown as Env;
		const res = await serveFreeMetadata(
			new Request("https://pay.snowsignals.io/phase/resolution-stats"),
			env,
			"/v1/api/phase/resolution-stats",
		);
		assert.equal(res.status, 502);
	});
});
