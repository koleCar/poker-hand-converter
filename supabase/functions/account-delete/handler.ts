/**
 * The handler of `account-delete` (`index.ts` serves it): deletes the account
 * whose JWT calls it (docs/RAIL-PLAN.md R6.5, GDPR Art. 17). Called by the
 * web's Settings -> Delete account with the user's own access token and
 * `{ confirm }` (the username, typed).
 *
 *  1. Refuses a call without a bearer token and verifies the token with
 *     GoTrue (`GET /auth/v1/user`).
 *  2. Starts the deletion **as the user**: `begin_account_deletion(confirm)`
 *     checks the typed username and that the session signed in within the
 *     last 15 minutes (the JWT's `amr`), spends a per-account budget, and
 *     records the request - or returns the one in progress, which is resumed
 *     without either check.
 *  3. Then, with the service role, each step not done yet, in order, each
 *     marked done in `account_deletions` as it finishes:
 *       billing  the subscriptions canceled through R6.3's
 *                `cancelOwnerSubscriptions` (`billing.ts`; fails closed),
 *       storage  every object under `<id>/` in the inventory's buckets,
 *                through the Storage API (the database cascade does not
 *                remove stored files),
 *       content  `erase_account_content` (the forum and the traces in
 *                others' rows: see the migration),
 *       hands    `erase_account_hands`, a batch per call, until none is left.
 *  4. Deletes the auth user (`DELETE /auth/v1/admin/users/<id>`; a 404 means
 *     a previous call already did) - every remaining row cascades - and
 *     marks the request completed.
 *
 * Idempotent and resumable: a step that fails records its error and the call
 * answers 503; the next call starts again at that step. A call that runs out
 * of its time budget (a large library) answers 202 `in_progress` and the page
 * calls again. After step 4 the token no longer names a user, so a further
 * call is refused as signed out - the page treats the 200 as the end.
 *
 * The service role key is the runtime's own `SUPABASE_SERVICE_ROLE_KEY`; no
 * client and no file in the repository holds it. Logs carry step names and
 * upstream status codes only: no token, email, user id or body.
 */

import { billingFrom, BillingUnavailable, cancelForDeletion, type Canceller, stripeCanceller } from "./billing.ts";

export interface Env {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  /** Cancels the account's subscriptions (R6.3's `cancelOwnerSubscriptions`; a fake in the tests). */
  cancelBilling: Canceller;
  /** How long one call may work before it answers 202 and is called again. */
  timeBudgetMs: number;
  /** Hands deleted per `erase_account_hands` call. */
  handsBatch: number;
}

/** The page sends `{ "confirm": "<username>" }`; anything far larger is not the page. */
export const MAX_BODY_BYTES = 1024;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
};

/** Error codes the page maps to sentences (`lib/i18n/ns/account.*.ts`). */
export type DeleteErrorCode =
  | "method_not_allowed"
  | "not_signed_in"
  | "invalid_request"
  | "reauth_required"
  | "confirmation_mismatch"
  | "rate_limited"
  | "billing_unavailable"
  | "unavailable";

export type Step = "billing" | "storage" | "content" | "hands";
export const STEPS: readonly Step[] = ["billing", "storage", "content", "hands"];

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function fail(status: number, error: DeleteErrorCode, detail?: string): Response {
  console.log(`account-delete: refused ${error}${detail ? ` (${detail})` : ""}`);
  return json(status, { error });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(header);
  return match ? match[1] : null;
}

/** A failed upstream call: which step, and the status for the log. */
class StepFailed extends Error {
  constructor(readonly step: Step | "completed", detail: string) {
    super(detail);
  }
}

interface DeletionState {
  steps: Partial<Record<Step, string | null>>;
  completedAt: string | null;
  billing: unknown;
}

function stateFrom(value: unknown): DeletionState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const steps = (v.steps && typeof v.steps === "object" ? v.steps : {}) as Record<string, unknown>;
  const done: Partial<Record<Step, string | null>> = {};
  for (const step of STEPS) {
    done[step] = typeof steps[step] === "string" ? (steps[step] as string) : null;
  }
  return {
    steps: done,
    completedAt: typeof v.completedAt === "string" ? v.completedAt : null,
    billing: v.billing,
  };
}

export async function handle(
  request: Request,
  env: Env,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return fail(405, "method_not_allowed");
  }
  const started = now();
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
  let confirm: string | null = null;
  if (text.trim().length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, "invalid_request", "not JSON");
    }
    if (!body || typeof body !== "object") {
      return fail(400, "invalid_request", "not an object");
    }
    const value = (body as Record<string, unknown>).confirm;
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 200)) {
      return fail(400, "invalid_request", "bad confirm");
    }
    confirm = typeof value === "string" ? value : null;
  }

  // 1. Who is asking.
  const asUser = { apikey: env.anonKey, Authorization: `Bearer ${jwt}` };
  let userId: string;
  try {
    const response = await fetchFn(`${env.supabaseUrl}/auth/v1/user`, { headers: asUser });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      await response.body?.cancel();
      return fail(401, "not_signed_in", `user ${response.status}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      return fail(503, "unavailable", `user ${response.status}`);
    }
    const user = (await response.json()) as { id?: unknown };
    if (typeof user.id !== "string" || user.id.length !== 36) {
      return fail(401, "not_signed_in", "no user id");
    }
    userId = user.id;
  } catch {
    return fail(503, "unavailable", "user lookup failed");
  }

  // 2. Start or resume, as the user.
  try {
    const response = await fetchFn(`${env.supabaseUrl}/rest/v1/rpc/begin_account_deletion`, {
      method: "POST",
      headers: { ...asUser, "Content-Type": "application/json" },
      body: JSON.stringify({ p_confirm: confirm }),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { code?: unknown; hint?: unknown };
      if (error.code === "53400") return fail(429, "rate_limited");
      if (error.code === "28000" || error.hint === "reauth_required") return fail(403, "reauth_required");
      if (error.hint === "confirmation_mismatch") return fail(400, "confirmation_mismatch");
      if (error.code === "42501") return fail(401, "not_signed_in", "begin refused");
      return fail(503, "unavailable", `begin ${response.status}`);
    }
    await response.body?.cancel();
  } catch {
    return fail(503, "unavailable", "begin failed");
  }

  // 3. The steps, with the service role.
  const asService = {
    apikey: env.serviceRoleKey,
    Authorization: `Bearer ${env.serviceRoleKey}`,
    "Content-Type": "application/json",
  };
  const rpc = async (name: string, args: Record<string, unknown>, step: Step | "completed"): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchFn(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: asService,
        body: JSON.stringify(args),
      });
    } catch {
      throw new StepFailed(step, `${name} did not answer`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new StepFailed(step, `${name} ${response.status}`);
    }
    return await response.json().catch(() => null);
  };
  const mark = (step: Step | "completed", error?: string) =>
    rpc("account_deletion_mark", { p_user: userId, p_step: step, p_error: error ?? null }, step);

  let state: DeletionState | null;
  try {
    state = stateFrom(await rpc("account_deletion_state", { p_user: userId }, "billing"));
  } catch (error) {
    return fail(503, "unavailable", (error as Error).message);
  }
  if (!state) {
    return fail(503, "unavailable", "no deletion recorded");
  }

  let current: Step | "completed" = "billing";
  try {
    // billing
    current = "billing";
    if (!state.steps.billing) {
      const outcome = await cancelForDeletion(env.cancelBilling, userId, billingFrom(state.billing), fetchFn);
      if (outcome === "stripe_not_configured") {
        console.log("account-delete: a customer on the profile but Stripe is not configured: nothing can bill it");
      }
      await mark("billing");
    }

    // storage
    current = "storage";
    if (!state.steps.storage) {
      for (let round = 0;; round++) {
        if (round > 10_000) throw new StepFailed("storage", "too many rounds");
        const objects = (await rpc("account_storage_objects", { p_user: userId, p_limit: 1000 }, "storage")) as
          | { bucket_id?: unknown; name?: unknown }[]
          | null;
        const list = Array.isArray(objects) ? objects : [];
        if (list.length === 0) break;
        const byBucket = new Map<string, string[]>();
        for (const object of list) {
          if (typeof object.bucket_id !== "string" || typeof object.name !== "string") continue;
          if (!object.name.startsWith(`${userId}/`)) throw new StepFailed("storage", "an object outside the folder");
          byBucket.set(object.bucket_id, [...(byBucket.get(object.bucket_id) ?? []), object.name]);
        }
        for (const [bucket, prefixes] of byBucket) {
          let response: Response;
          try {
            response = await fetchFn(`${env.supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`, {
              method: "DELETE",
              headers: asService,
              body: JSON.stringify({ prefixes }),
            });
          } catch {
            throw new StepFailed("storage", "storage did not answer");
          }
          await response.body?.cancel();
          if (!response.ok) throw new StepFailed("storage", `storage ${response.status}`);
        }
        if (now() - started > env.timeBudgetMs) {
          return json(202, { status: "in_progress", step: "storage" });
        }
      }
      await mark("storage");
    }

    // content
    current = "content";
    if (!state.steps.content) {
      await rpc("erase_account_content", { p_user: userId }, "content");
    }

    // hands
    current = "hands";
    if (!state.steps.hands) {
      let progressed = false;
      for (;;) {
        let deleted: unknown;
        try {
          deleted = await rpc("erase_account_hands", { p_user: userId, p_limit: env.handsBatch }, "hands");
        } catch (error) {
          // A slow batch (cold disk, a busy database) after some progress is
          // no failure: the page calls again, and the server carries on.
          if (progressed) return json(202, { status: "in_progress", step: "hands" });
          throw error;
        }
        if (typeof deleted !== "number") throw new StepFailed("hands", "no count");
        if (deleted === 0) break;
        if (deleted > 0) progressed = true;
        // -1: another call holds the hands that are left; this one waits.
        if (deleted < 0) await new Promise((resolve) => setTimeout(resolve, 1000));
        if (now() - started > env.timeBudgetMs) {
          return json(202, { status: "in_progress", step: "hands" });
        }
      }
    }

    // 4. The auth user, and the record.
    current = "completed";
    let response: Response;
    try {
      response = await fetchFn(`${env.supabaseUrl}/auth/v1/admin/users/${userId}`, {
        method: "DELETE",
        headers: asService,
        body: JSON.stringify({ should_soft_delete: false }),
      });
    } catch {
      throw new StepFailed("completed", "auth did not answer");
    }
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) {
      throw new StepFailed("completed", `auth ${response.status}`);
    }
    await mark("completed");
  } catch (error) {
    const step = error instanceof StepFailed ? error.step : current;
    const detail = error instanceof Error ? error.message : String(error);
    // The failure is noted for the next call (and for us); the user sees a code.
    await mark(step, detail).catch(() => undefined);
    if (error instanceof BillingUnavailable) {
      return fail(503, "billing_unavailable", detail);
    }
    return fail(503, "unavailable", `${step}: ${detail}`);
  }

  console.log("account-delete: deleted");
  return json(200, { status: "deleted" });
}

/** The environment Supabase sets inside every function, and ours. */
export function envFromDeno(): Env {
  const number = (name: string, fallback: number) => {
    const value = Number(Deno.env.get(name) ?? "");
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    supabaseUrl: (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, ""),
    anonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    cancelBilling: stripeCanceller,
    timeBudgetMs: number("ACCOUNT_DELETE_TIME_BUDGET_MS", 60_000),
    handsBatch: number("ACCOUNT_DELETE_HANDS_BATCH", 200),
  };
}
