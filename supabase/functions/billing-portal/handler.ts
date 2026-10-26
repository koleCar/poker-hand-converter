/**
 * The handler of `billing-portal` (`index.ts` serves it; docs/RAIL-PLAN.md
 * R6.3, docs/BILLING.md): a Stripe Customer Portal session for the caller -
 * change card, switch monthly / yearly, download invoices, cancel or renew.
 *
 * `POST { locale?: "en" | "hr" }` with the user's bearer token:
 *
 *  1. the caller is verified with GoTrue;
 *  2. one of the account's 20 portal sessions an hour (`billing_claim`);
 *  3. the account's own Stripe customer (`billing_account`, service role) -
 *     an account that never checked out has none: 409 `no_customer`;
 *  4. `POST /v1/billing_portal/sessions` with that customer, the configured
 *     return address and portal configuration; the URL comes back.
 *
 * What the portal changes reaches the plan through the webhook, like
 * everything else. With Stripe unset: 503 `unavailable`.
 */

import { type BillingEnv, portalReady, supabaseReady } from "../_shared/billing/config.ts";
import {
  bearer,
  billingAccount,
  claimSession,
  CORS_HEADERS,
  DbError,
  json,
  readJson,
  refuse,
  stripeLocale,
  verifyCaller,
} from "../_shared/billing/http.ts";
import { stripeRequest } from "../_shared/billing/stripe.ts";

const FN = "billing-portal";
export const MAX_BODY_BYTES = 1024;

export async function handle(request: Request, env: BillingEnv, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return refuse(FN, 405, "method_not_allowed");

  const jwt = bearer(request);
  if (!jwt) return refuse(FN, 401, "not_signed_in", "no bearer token");
  if (!supabaseReady(env)) return refuse(FN, 503, "unavailable", "function environment incomplete");

  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return refuse(FN, 400, "invalid_request", "not a JSON object");
  }

  const who = await verifyCaller(env, jwt, fetchFn);
  if (!who.ok) return refuse(FN, who.status, who.error, who.detail);
  if (!portalReady(env)) return refuse(FN, 503, "unavailable", "portal not configured");
  const owner = who.caller.id;

  try {
    if (!(await claimSession(env, fetchFn, owner, "portal"))) return refuse(FN, 429, "rate_limited");
    const account = await billingAccount(env, fetchFn, owner);
    if (!account?.customer_id) return refuse(FN, 409, "no_customer");

    const session = await stripeRequest<{ url?: unknown }>(
      { secretKey: env.stripeSecretKey, apiVersion: env.stripeApiVersion, fetchFn },
      "POST",
      "/v1/billing_portal/sessions",
      {
        customer: account.customer_id,
        return_url: env.portalReturnUrl,
        locale: stripeLocale((body as { locale?: unknown }).locale),
        configuration: /^bpc_[A-Za-z0-9]+$/.test(env.portalConfiguration) ? env.portalConfiguration : undefined,
      },
    );
    if (typeof session.url !== "string" || !session.url.startsWith("https://")) {
      return refuse(FN, 502, "unavailable", "session without a URL");
    }
    console.log(`${FN}: session created`);
    return json(200, { url: session.url });
  } catch (error) {
    if (error instanceof DbError) return refuse(FN, 503, "unavailable", error.message);
    return refuse(FN, 502, "unavailable", error instanceof Error ? error.message : "failed");
  }
}
