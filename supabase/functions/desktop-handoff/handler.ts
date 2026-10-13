/**
 * The handler of `desktop-handoff` (`index.ts` serves it): hands a signed-in web user's identity to the Rail
 * desktop app on the same computer (docs/RAIL-PLAN.md R1.7, amendment A6).
 *
 * Called by `/auth/desktop` on the web, after the user clicked "Sign in to
 * Rail", with the user's own access token and `{ v: 1, pub, state }` from
 * the app's request. It:
 *
 *  1. refuses a call without a bearer token, and verifies the token with
 *     GoTrue (`GET /auth/v1/user`: signature, expiry, a live session) - the
 *     gateway's `verify_jwt` is a second check, not the only one;
 *  2. refuses an account the app could not sign in as itself: no email, an
 *     anonymous user, or an unconfirmed email (a magic link confirms the
 *     address it is sent to, so minting one for an unconfirmed address would
 *     confirm it without a mailbox ever being read);
 *  3. counts the call against a per-account budget
 *     (`claim_desktop_sign_in()`, called **as the user**, so the bucket is
 *     keyed by `auth.uid()` inside Postgres, not by anything sent here);
 *  4. mints a one-time magic-link token for that same account with the
 *     service role (`POST /auth/v1/admin/generate_link`; nothing is
 *     emailed), checks it was minted for the same user id, and
 *  5. returns it encrypted to the app's key (`handoff.ts`). The plaintext
 *     token never leaves this function; the browser only ever holds
 *     ciphertext that only the app's in-memory key opens.
 *
 * The service role key is the runtime's own `SUPABASE_SERVICE_ROLE_KEY`,
 * set by Supabase inside the function and nowhere else - no client and no
 * file in the repository holds it.
 *
 * Logs carry outcomes and upstream status codes only: no token, no email,
 * no user id, no request body.
 *
 * CORS is `*`: the call is authorised by a bearer token the page reads from
 * its own storage, never by an ambient cookie, so another origin gains
 * nothing by being allowed to send it.
 */

import { parseRequest, seal } from "./handoff.ts";

export interface Env {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

/** The page sends ~110 bytes; anything far larger is not the page. */
export const MAX_BODY_BYTES = 2048;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
};

/** Error codes the page maps to sentences (`lib/i18n/ns/desktop.*.ts`). */
export type HandoffErrorCode =
  | "method_not_allowed"
  | "not_signed_in"
  | "invalid_request"
  | "email_unconfirmed"
  | "account_not_supported"
  | "rate_limited"
  | "unavailable";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function fail(status: number, error: HandoffErrorCode, detail?: string): Response {
  console.log(`desktop-handoff: refused ${error}${detail ? ` (${detail})` : ""}`);
  return json(status, { error });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(header);
  return match ? match[1] : null;
}

interface GoTrueUser {
  id?: unknown;
  email?: unknown;
  email_confirmed_at?: unknown;
  is_anonymous?: unknown;
}

export async function handle(request: Request, env: Env, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return fail(405, "method_not_allowed");
  }
  const jwt = bearer(request);
  if (!jwt) {
    return fail(401, "not_signed_in", "no bearer token");
  }
  if (!env.supabaseUrl || !env.anonKey || !env.serviceRoleKey) {
    return fail(503, "unavailable", "function environment incomplete");
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return fail(400, "invalid_request", "body too large");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "invalid_request", "not JSON");
  }
  const parsed = parseRequest(body);
  if (!parsed) {
    return fail(400, "invalid_request", "bad parameters");
  }

  // 1. Who is asking: GoTrue verifies the token (and that its session lives).
  const asUser = { apikey: env.anonKey, Authorization: `Bearer ${jwt}` };
  let user: GoTrueUser;
  try {
    const response = await fetchFn(`${env.supabaseUrl}/auth/v1/user`, { headers: asUser });
    if (response.status === 401 || response.status === 403) {
      return fail(401, "not_signed_in", `user ${response.status}`);
    }
    if (!response.ok) {
      return fail(503, "unavailable", `user ${response.status}`);
    }
    user = (await response.json()) as GoTrueUser;
  } catch {
    return fail(503, "unavailable", "user lookup failed");
  }
  if (typeof user.id !== "string" || user.id.length !== 36) {
    return fail(401, "not_signed_in", "no user id");
  }

  // 2. Accounts the app cannot become.
  if (user.is_anonymous === true || typeof user.email !== "string" || user.email.length === 0) {
    return fail(403, "account_not_supported");
  }
  if (typeof user.email_confirmed_at !== "string" || user.email_confirmed_at.length === 0) {
    return fail(403, "email_unconfirmed");
  }

  // 3. The per-account budget, as the user (auth.uid() keys the bucket).
  try {
    const response = await fetchFn(`${env.supabaseUrl}/rest/v1/rpc/claim_desktop_sign_in`, {
      method: "POST",
      headers: { ...asUser, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { code?: unknown };
      if (error.code === "53400") {
        return fail(429, "rate_limited");
      }
      return fail(503, "unavailable", `budget ${response.status}`);
    }
  } catch {
    return fail(503, "unavailable", "budget check failed");
  }

  // 4. A one-time token for the same account. Nothing is emailed.
  let minted: { id?: unknown; hashed_token?: unknown; verification_type?: unknown };
  try {
    const response = await fetchFn(`${env.supabaseUrl}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: {
        apikey: env.serviceRoleKey,
        Authorization: `Bearer ${env.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "magiclink", email: user.email }),
    });
    if (!response.ok) {
      return fail(503, "unavailable", `generate_link ${response.status}`);
    }
    minted = await response.json();
  } catch {
    return fail(503, "unavailable", "generate_link failed");
  }
  // The address could have moved to another account between the two calls;
  // the token must be for the account that clicked.
  if (minted.id !== user.id || typeof minted.hashed_token !== "string" || minted.hashed_token.length === 0) {
    return fail(503, "unavailable", "minted for another account or without a token");
  }

  // 5. Only ciphertext leaves.
  const payload = await seal(parsed.appPublic, parsed.state, {
    v: 1,
    type: "magiclink",
    tokenHash: minted.hashed_token,
    userId: user.id,
    email: user.email,
  });
  console.log("desktop-handoff: issued");
  return json(200, { v: 1, payload });
}

/** The environment Supabase sets inside every function. */
export function envFromDeno(): Env {
  return {
    supabaseUrl: (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, ""),
    anonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  };
}
