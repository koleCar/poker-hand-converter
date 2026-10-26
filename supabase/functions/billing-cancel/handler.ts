/**
 * The handler of `billing-cancel` (`index.ts` serves it; docs/RAIL-PLAN.md
 * R6.3, docs/BILLING.md "Cancelling for an account"): the server-side way to
 * stop billing an account, for R6.5's account deletion.
 *
 * Not for browsers: the caller must present the project's **service role
 * key** as the bearer (compared in constant time; no CORS). Body
 * `{ "owner": "<account uuid>" }`. Every live subscription of that account's
 * Stripe customer is cancelled now (`cancelOwnerSubscriptions`).
 *
 * Answers: 200 `{ canceled, hadCustomer }` (an account that never paid:
 * `{ canceled: 0, hadCustomer: false }`); 404 `no_profile`; 503 when the
 * account has a customer but Stripe is not configured, or Stripe or the
 * database could not be reached - the caller should not delete the account
 * then, or it could keep being billed.
 */

import { cancelOwnerSubscriptions } from "../_shared/billing/cancel.ts";
import { type BillingEnv, supabaseReady } from "../_shared/billing/config.ts";
import { bearer, json, readJson, refuse } from "../_shared/billing/http.ts";
import { timingSafeEqual } from "../_shared/billing/stripe.ts";

const FN = "billing-cancel";

export async function handle(request: Request, env: BillingEnv, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (request.method !== "POST") return refuse(FN, 405, "method_not_allowed", undefined, false);
  if (!supabaseReady(env)) return refuse(FN, 503, "unavailable", "function environment incomplete", false);
  const token = bearer(request);
  if (!token || !timingSafeEqual(token, env.serviceRoleKey)) return refuse(FN, 401, "forbidden", undefined, false);

  const body = await readJson(request, 512);
  const owner = (body as { owner?: unknown } | null)?.owner;
  if (typeof owner !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner)) {
    return refuse(FN, 400, "invalid_request", "owner", false);
  }

  try {
    const result = await cancelOwnerSubscriptions(env, owner, fetchFn);
    if (!result.ok) {
      return refuse(FN, result.error === "no_profile" ? 404 : 503, result.error, undefined, false);
    }
    console.log(`${FN}: ${result.canceled} subscription(s) cancelled`);
    return json(200, { canceled: result.canceled, hadCustomer: result.hadCustomer }, false);
  } catch (error) {
    return refuse(FN, 503, "unavailable", error instanceof Error ? error.message : "failed", false);
  }
}
