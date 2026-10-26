/**
 * Stripe, without the SDK (docs/RAIL-PLAN.md R6.3, docs/BILLING.md).
 *
 * The billing functions use five Stripe endpoints and one signature check, so
 * this file talks to Stripe's REST API with `fetch` instead of importing the
 * `stripe` package:
 *
 *  - no third-party code runs next to the secret key, and nothing is fetched
 *    from npm when a function deploys or when CI tests it (the tests run
 *    offline against a fake `fetch`);
 *  - the webhook check is Stripe's documented scheme ("Verify manually" in
 *    Stripe's webhook docs), implemented below with WebCrypto in a few lines
 *    and tested against signed fixtures, tampered bodies, wrong secrets and
 *    old timestamps - and against a header produced by the official
 *    `stripe` SDK (`testdata/sdk_vector.json`, made by
 *    `testdata/make_sdk_vector.ts`);
 *  - every request pins Stripe's API version (`STRIPE_API_VERSION`, default
 *    below), so a change on Stripe's side cannot reshape the answers.
 *
 * Never logs or returns the secret key; errors carry the HTTP status and
 * Stripe's error type and code only.
 */

/** The API version every request asks for (override: `STRIPE_API_VERSION`). */
export const STRIPE_API_VERSION_DEFAULT = "2025-03-31.basil";

export const STRIPE_API_BASE = "https://api.stripe.com";

/** Stripe signs `t.payload`; five minutes is the SDK's default tolerance. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Form encoding (Stripe's request bodies are `a[b][0][c]=v`)
// ---------------------------------------------------------------------------

export type FormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FormValue[]
  | { [key: string]: FormValue };

/** `{ a: { b: [ { c: 1 } ] } }` -> `a[b][0][c]=1`; null and undefined are left out. */
export function encodeForm(params: Record<string, FormValue>): string {
  const out: string[] = [];
  const walk = (key: string, value: FormValue): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${key}[${index}]`, item));
      return;
    }
    if (typeof value === "object") {
      for (const [name, item] of Object.entries(value)) walk(`${key}[${name}]`, item);
      return;
    }
    out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return out.join("&");
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface StripeOptions {
  secretKey: string;
  apiVersion: string;
  fetchFn: typeof fetch;
  baseUrl?: string;
}

/** A Stripe refusal or an unreachable Stripe. Never holds the key or a body. */
export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | null,
    readonly code: string | null,
  ) {
    super(`stripe ${status}${type ? ` ${type}` : ""}${code ? ` ${code}` : ""}`);
    this.name = "StripeError";
  }
}

/** Is the key a Stripe secret (or restricted) key, and of which mode? */
export function keyMode(secretKey: string): "test" | "live" | null {
  const match = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.exec(secretKey);
  return match ? (match[1] as "test" | "live") : null;
}

/** One call. `params` go in the query for GET and DELETE, in the body otherwise. */
export async function stripeRequest<T>(
  options: StripeOptions,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, FormValue> = {},
  idempotencyKey?: string,
): Promise<T> {
  const encoded = encodeForm(params);
  const url = `${options.baseUrl ?? STRIPE_API_BASE}${path}${method !== "POST" && encoded ? `?${encoded}` : ""}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.secretKey}`,
    "Stripe-Version": options.apiVersion,
  };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  let response: Response;
  try {
    response = await options.fetchFn(url, {
      method,
      headers,
      body: method === "POST" ? encoded : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new StripeError(0, "network", null);
  }
  const body = (await response.json().catch(() => null)) as
    | { error?: { type?: unknown; code?: unknown } }
    | null;
  if (!response.ok) {
    const error = body?.error ?? {};
    throw new StripeError(
      response.status,
      typeof error.type === "string" ? error.type : null,
      typeof error.code === "string" ? error.code : null,
    );
  }
  if (body === null) throw new StripeError(response.status, "not_json", null);
  return body as T;
}

// ---------------------------------------------------------------------------
// Webhook signatures
// ---------------------------------------------------------------------------

export type SignatureFailure = "no_header" | "bad_header" | "no_secret" | "mismatch" | "outside_tolerance";

export type SignatureResult = { ok: true; timestamp: number } | { ok: false; reason: SignatureFailure };

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Equal strings in time that does not depend on where they differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** HMAC-SHA256 of `t.payload` with the endpoint's secret (the whole `whsec_...` string), in hex. */
export async function computeSignature(secret: string, timestamp: number, payload: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const prefix = encoder.encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + payload.length);
  message.set(prefix, 0);
  message.set(payload, prefix.length);
  return toHex(await crypto.subtle.sign("HMAC", key, message));
}

/**
 * Stripe's `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>][,v0=...]` over the
 * **raw** request bytes. Any `v1` may match (Stripe sends two while a secret
 * is being rolled); `v0` (test-only, SHA-1 era) is ignored. The timestamp must
 * be within `toleranceSeconds` of now, either way, so a captured request
 * cannot be replayed later.
 */
export async function verifyStripeSignature(
  payload: Uint8Array,
  header: string | null,
  secret: string,
  options: { toleranceSeconds?: number; nowSeconds?: number } = {},
): Promise<SignatureResult> {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!header) return { ok: false, reason: "no_header" };
  if (header.length > 4096) return { ok: false, reason: "bad_header" };

  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (name === "v1" && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: "bad_header" };

  const expected = await computeSignature(secret, timestamp, payload);
  let matched = false;
  for (const signature of signatures) matched = timingSafeEqual(signature, expected) || matched;
  if (!matched) return { ok: false, reason: "mismatch" };

  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: "outside_tolerance" };
  return { ok: true, timestamp };
}

/** A header for a payload, as Stripe would send it (tests and local tools only). */
export async function signPayload(secret: string, payload: string, timestamp: number): Promise<string> {
  return `t=${timestamp},v1=${await computeSignature(secret, timestamp, encoder.encode(payload))}`;
}
