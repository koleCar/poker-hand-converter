/**
 * HTTP pieces the billing functions share: CORS, JSON answers, the bearer
 * token, the caller's identity (GoTrue) and the service role's RPC calls.
 *
 * CORS is `*` for the functions the web calls: they are authorised by a
 * bearer token the page reads from its own storage, never by a cookie, so
 * another origin gains nothing by being allowed to send one.
 *
 * Logs carry the function, an outcome and status codes - never a token, an
 * email, a user id, a request body or a Stripe payload.
 */

import type { BillingEnv } from "./config.ts";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "600",
};

export function json(status: number, body: Record<string, unknown>, cors = true): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(cors ? CORS_HEADERS : {}),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/** A refusal with a code the page maps to a sentence, logged without detail about the caller. */
export function refuse(fn: string, status: number, error: string, detail?: string, cors = true): Response {
  console.log(`${fn}: refused ${error}${detail ? ` (${detail})` : ""}`);
  return json(status, { error }, cors);
}

export function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(header);
  return match ? match[1] : null;
}

export interface Caller {
  id: string;
  email: string;
}

export type CallerResult = { ok: true; caller: Caller } | {
  ok: false;
  status: number;
  error: "not_signed_in" | "account_not_supported" | "email_unconfirmed" | "unavailable";
  detail: string;
};

/**
 * Who is calling: GoTrue verifies the token (signature, expiry, a live
 * session). An anonymous account, or one without a confirmed email, cannot
 * be a Stripe customer (the receipt and the invoice go to that address).
 */
export async function verifyCaller(env: BillingEnv, jwt: string, fetchFn: typeof fetch): Promise<CallerResult> {
  let user: { id?: unknown; email?: unknown; email_confirmed_at?: unknown; is_anonymous?: unknown };
  try {
    const response = await fetchFn(`${env.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: env.anonKey, Authorization: `Bearer ${jwt}` },
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: 401, error: "not_signed_in", detail: `user ${response.status}` };
    }
    if (!response.ok) return { ok: false, status: 503, error: "unavailable", detail: `user ${response.status}` };
    user = await response.json();
  } catch {
    return { ok: false, status: 503, error: "unavailable", detail: "user lookup failed" };
  }
  if (typeof user.id !== "string" || !/^[0-9a-f-]{36}$/.test(user.id)) {
    return { ok: false, status: 401, error: "not_signed_in", detail: "no user id" };
  }
  if (user.is_anonymous === true || typeof user.email !== "string" || user.email.length === 0) {
    return { ok: false, status: 403, error: "account_not_supported", detail: "no email" };
  }
  if (typeof user.email_confirmed_at !== "string" || user.email_confirmed_at.length === 0) {
    return { ok: false, status: 403, error: "email_unconfirmed", detail: "unconfirmed" };
  }
  return { ok: true, caller: { id: user.id, email: user.email } };
}

/** A database refusal: HTTP status and SQLSTATE only. */
export class DbError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`db ${status}${code ? ` ${code}` : ""}`);
    this.name = "DbError";
  }
}

/** A service-role RPC (the `billing_*` functions are executable by the service role only). */
export async function serviceRpc<T>(
  env: BillingEnv,
  fetchFn: typeof fetch,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: env.serviceRoleKey,
        Authorization: `Bearer ${env.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
  } catch {
    throw new DbError(0, null);
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { code?: unknown };
    throw new DbError(response.status, typeof error.code === "string" ? error.code : null);
  }
  const text = await response.text();
  return (text.length === 0 ? null : JSON.parse(text)) as T;
}

/** Reads a small JSON body; null when it is too big or not JSON. */
export async function readJson(request: Request, maxBytes: number): Promise<unknown | null> {
  const text = await request.text();
  if (text.length > maxBytes) return null;
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The account's billing row (`billing_account`), or null when it has no profile. */
export interface BillingAccount {
  customer_id: string | null;
  subscription_id: string | null;
  plan: string;
  plan_status: string | null;
  current_period_end: string | null;
  early_user: boolean;
}

export async function billingAccount(
  env: BillingEnv,
  fetchFn: typeof fetch,
  owner: string,
): Promise<BillingAccount | null> {
  const rows = await serviceRpc<BillingAccount[]>(env, fetchFn, "billing_account", { p_owner: owner });
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** Spends one of the account's sessions; false when over the budget. */
export async function claimSession(
  env: BillingEnv,
  fetchFn: typeof fetch,
  owner: string,
  kind: "checkout" | "portal",
): Promise<boolean> {
  try {
    await serviceRpc(env, fetchFn, "billing_claim", { p_owner: owner, p_kind: kind });
    return true;
  } catch (error) {
    if (error instanceof DbError && error.code === "53400") return false;
    throw error;
  }
}

/**
 * A subscription the account still has: live, or canceled with paid time
 * left (renewing it is the portal's job, not a second checkout).
 */
export function hasSubscription(account: BillingAccount, now = Date.now()): boolean {
  if (account.plan !== "pro" || !account.subscription_id) return false;
  if (account.plan_status === "active" || account.plan_status === "trialing" || account.plan_status === "past_due") {
    return true;
  }
  if (account.plan_status === "canceled" && account.current_period_end) {
    return Date.parse(account.current_period_end) > now;
  }
  return false;
}

/** `en` or `hr` from the page; Stripe's own detection otherwise. */
export function stripeLocale(value: unknown): "en" | "hr" | "auto" {
  return value === "en" || value === "hr" ? value : "auto";
}
