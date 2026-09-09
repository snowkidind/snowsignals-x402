/**
 * CDP facilitator JWT auth, signed with the runtime's native WebCrypto (Ed25519 / EdDSA).
 *
 * This replaces @coinbase/cdp-sdk's `createCdpFacilitatorClient`, whose JWT path pulls in jose +
 * uncrypto — modules the Worker bundle fails to initialize in order, leaving their crypto bindings
 * undefined at runtime. Signing directly against `crypto.subtle` (which workerd supports for Ed25519)
 * keeps the money-path auth on first-party, runtime-native code.
 *
 * The produced headers match the per-facilitator-path shape `@x402/core`'s HTTPFacilitatorClient
 * expects: `{ verify, settle, supported }`, each a Bearer JWT scoped to that method + path. The JWT
 * mirrors the CDP format: EdDSA, header `{ alg, kid, typ, nonce }`, claims
 * `{ sub, iss: "cdp", uris: ["<METHOD> <host><path>"], iat, nbf, exp }`, ~120s validity.
 */
import type { Env } from "./env.js";

const JWT_TTL_SECONDS = 120;

/** Base64url-encode raw bytes (no padding). */
function b64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64url-encode a JSON value. */
function b64urlJson(value: unknown): string {
	return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Decode a standard base64 string (the CDP secret) to bytes. */
function fromBase64(base64: string): Uint8Array {
	return Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
}

/** Sign one CDP JWT (EdDSA) authorizing `METHOD host+path`. */
async function signCdpJwt(
	keyId: string,
	keySecret: string,
	method: string,
	host: string,
	path: string,
): Promise<string> {
	// CDP Ed25519 secret is base64 of 64 bytes: 32-byte seed followed by the 32-byte public key.
	const raw = fromBase64(keySecret);
	if (raw.length !== 64) {
		throw new Error("CDP_API_KEY_SECRET must be a base64 Ed25519 key (64 bytes: seed + public key)");
	}
	const jwk: JsonWebKey = {
		kty: "OKP",
		crv: "Ed25519",
		d: b64url(raw.subarray(0, 32)),
		x: b64url(raw.subarray(32)),
	};
	const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);

	const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: "EdDSA", kid: keyId, typ: "JWT", nonce };
	const claims = {
		sub: keyId,
		iss: "cdp",
		uris: [`${method} ${host}${path}`],
		iat: now,
		nbf: now,
		exp: now + JWT_TTL_SECONDS,
	};
	const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
	const signature = new Uint8Array(
		await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(signingInput)),
	);
	return `${signingInput}.${b64url(signature)}`;
}

/**
 * Build the per-path CDP auth-header factory for `@x402/core`'s HTTPFacilitatorClient. Each call
 * mints fresh short-lived JWTs for the verify / settle / supported endpoints derived from
 * `FACILITATOR_URL`.
 */
export function createCdpAuthHeaders(
	env: Env,
): () => Promise<{ verify: Record<string, string>; settle: Record<string, string>; supported: Record<string, string> }> {
	const url = new URL(env.FACILITATOR_URL);
	const host = url.host;
	const base = url.pathname.replace(/\/$/, "");
	const bearer = async (method: string, path: string) => ({
		Authorization: `Bearer ${await signCdpJwt(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET, method, host, path)}`,
	});
	return async () => ({
		verify: await bearer("POST", `${base}/verify`),
		settle: await bearer("POST", `${base}/settle`),
		supported: await bearer("GET", `${base}/supported`),
	});
}
