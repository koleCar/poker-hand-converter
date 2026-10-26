/**
 * "Cancel this account's subscription" - for account deletion (R6.5) and
 * anything else server-side that must stop billing an account
 * (docs/BILLING.md "Cancelling for an account").
 *
 * Every subscription of the account's Stripe customer that is not already
 * over is cancelled **now** (not at the period's end; no proration, no
 * refund - a refund is the owner's call in the Stripe Dashboard). The plan
 * on the profile follows through the webhook (`customer.subscription.deleted`)
 * like any other change; if the account is deleted first, that event finds
 * no customer and is logged.
 *
 * Two ways in:
 *   - import `cancelOwnerSubscriptions` from another Edge Function in this
 *     folder (it needs the same environment: the service role and the Stripe
 *     key);
 *   - call the `billing-cancel` function with the service role key as the
 *     bearer and `{ "owner": "<uuid>" }`.
 *
 * The Stripe customer itself is kept: its invoices are tax records (deleting
 * it is the owner's decision, docs/BILLING.md).
 */

import { type BillingEnv, stripeReady } from "./config.ts";
import { billingAccount } from "./http.ts";
import { stripeRequest } from "./stripe.ts";

export type CancelResult =
  | { ok: true; canceled: number; hadCustomer: boolean }
  | { ok: false; error: "no_profile" | "stripe_not_configured" };

const OVER = new Set(["canceled", "incomplete_expired"]);

export async function cancelOwnerSubscriptions(
  env: BillingEnv,
  owner: string,
  fetchFn: typeof fetch = fetch,
): Promise<CancelResult> {
  const account = await billingAccount(env, fetchFn, owner);
  if (!account) return { ok: false, error: "no_profile" };
  if (!account.customer_id) return { ok: true, canceled: 0, hadCustomer: false };
  if (!stripeReady(env)) return { ok: false, error: "stripe_not_configured" };

  const stripe = { secretKey: env.stripeSecretKey, apiVersion: env.stripeApiVersion, fetchFn };
  let canceled = 0;
  let startingAfter: string | undefined;
  for (let page = 0; page < 10; page++) {
    const list = await stripeRequest<{ data?: { id?: unknown; status?: unknown }[]; has_more?: unknown }>(
      stripe,
      "GET",
      "/v1/subscriptions",
      { customer: account.customer_id, status: "all", limit: 100, starting_after: startingAfter },
    );
    const data = Array.isArray(list.data) ? list.data : [];
    for (const subscription of data) {
      if (typeof subscription.id !== "string" || OVER.has(String(subscription.status))) continue;
      await stripeRequest(stripe, "DELETE", `/v1/subscriptions/${encodeURIComponent(subscription.id)}`);
      canceled++;
    }
    const last = data.at(-1)?.id;
    if (list.has_more !== true || typeof last !== "string") break;
    startingAfter = last;
  }
  return { ok: true, canceled, hadCustomer: true };
}
