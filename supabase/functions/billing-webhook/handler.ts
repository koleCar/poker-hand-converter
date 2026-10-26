/**
 * The handler of `billing-webhook` (`index.ts` serves it; docs/RAIL-PLAN.md
 * R6.3, docs/BILLING.md): Stripe's events -> the plan on the profile.
 *
 * Called by Stripe only, so no JWT (`verify_jwt = false`): the request is
 * trusted because of its `Stripe-Signature`, checked over the raw bytes with
 * the endpoint's secret (`STRIPE_WEBHOOK_SECRET`) before anything else is
 * read. Then:
 *
 *  1. an event of the other mode (a live event with a test key, or the
 *     reverse) is acknowledged and dropped;
 *  2. of the six handled types (`HANDLED_EVENTS`), only the subscription's
 *     **id** is taken from the event - the subscription itself is read back
 *     from Stripe with the secret key, so neither the order nor the content
 *     of a delivery decides the state (Stripe sends events out of order and
 *     more than once);
 *  3. it is mapped to the plan (`planFromSubscription`) and applied with
 *     `billing_apply_subscription(...)` (service role), which in one
 *     transaction skips a duplicate event id, logs an unknown customer, skips
 *     an event older than the account's newest, and calls R6.2's
 *     `billing_set_plan(...)`.
 *
 * Answers: 200 for everything handled or deliberately ignored (an unknown
 * customer included, so Stripe stops retrying); 400 for a bad signature or
 * body; 5xx when Stripe or the database could not be reached, so Stripe
 * retries (for up to three days).
 *
 * Logs: the event's id, type and the outcome - never the payload, an email,
 * an address, a card detail or a secret.
 */

import { type BillingEnv, stripeReady } from "../_shared/billing/config.ts";
import { DbError, json, serviceRpc } from "../_shared/billing/http.ts";
import { HANDLED_EVENTS, idOf, planFromSubscription, subscriptionOfEvent } from "../_shared/billing/subscription.ts";
import { keyMode, StripeError, stripeRequest, verifyStripeSignature } from "../_shared/billing/stripe.ts";

/** Stripe's events are a few kilobytes; a megabyte is far beyond any of the six types. */
export const MAX_BODY_BYTES = 1024 * 1024;

const FN = "billing-webhook";

export interface WebhookOptions {
  fetchFn?: typeof fetch;
  nowSeconds?: number;
}

function answer(status: number, body: Record<string, unknown>): Response {
  return json(status, body, false);
}

function refused(status: number, error: string, detail?: string): Response {
  console.log(`${FN}: refused ${error}${detail ? ` (${detail})` : ""}`);
  return answer(status, { error });
}

function done(id: string, type: string, outcome: string): Response {
  console.log(`${FN}: ${id} ${type} -> ${outcome}`);
  return answer(200, { received: true, outcome });
}

export async function handle(request: Request, env: BillingEnv, options: WebhookOptions = {}): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  if (request.method !== "POST") return refused(405, "method_not_allowed");
  if (!env.stripeWebhookSecret) return refused(503, "unavailable", "STRIPE_WEBHOOK_SECRET not set");

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return refused(413, "too_large");
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > MAX_BODY_BYTES) return refused(413, "too_large");

  const verified = await verifyStripeSignature(raw, request.headers.get("stripe-signature"), env.stripeWebhookSecret, {
    nowSeconds: options.nowSeconds,
  });
  if (!verified.ok) return refused(400, "bad_signature", verified.reason);

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return refused(400, "invalid_event", "not JSON");
  }
  const id = event?.id;
  const type = event?.type;
  const created = event?.created;
  if (
    event?.object !== "event" || typeof id !== "string" || !/^evt_[A-Za-z0-9_]{1,250}$/.test(id) ||
    typeof type !== "string" || type.length > 100 || typeof created !== "number" || !Number.isInteger(created)
  ) {
    return refused(400, "invalid_event", "not an event");
  }

  if (!HANDLED_EVENTS.has(type)) return done(id, type, "ignored");

  const mode = keyMode(env.stripeSecretKey);
  if (!stripeReady(env) || mode === null) return refused(503, "unavailable", "STRIPE_SECRET_KEY not set");
  if (typeof event.livemode === "boolean" && event.livemode !== (mode === "live")) {
    return done(id, type, "other_mode");
  }

  const target = subscriptionOfEvent(type, (event.data as { object?: unknown } | undefined)?.object);
  if (!target) return done(id, type, "ignored");

  // The state is Stripe's, read now - not what the delivery says.
  let subscription: Record<string, unknown>;
  try {
    subscription = await stripeRequest<Record<string, unknown>>(
      { secretKey: env.stripeSecretKey, apiVersion: env.stripeApiVersion, fetchFn },
      "GET",
      `/v1/subscriptions/${encodeURIComponent(target.subscription)}`,
    );
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return done(id, type, "no_such_subscription");
    return refused(502, "stripe_unavailable", error instanceof StripeError ? error.message : "stripe failed");
  }
  const customer = idOf(subscription.customer);
  if (!customer || idOf(subscription.id) !== target.subscription) {
    return refused(502, "stripe_unavailable", "subscription without its customer");
  }

  const plan = planFromSubscription(subscription);
  let outcome: unknown;
  try {
    outcome = await serviceRpc<string>(env, fetchFn, "billing_apply_subscription", {
      p_event_id: id,
      p_event_type: type,
      p_event_created: new Date(created * 1000).toISOString(),
      p_customer_id: customer,
      p_subscription_id: target.subscription,
      p_plan: plan.plan,
      p_period: plan.period,
      p_status: plan.status,
      p_current_period_end: plan.currentPeriodEnd,
    });
  } catch (error) {
    return refused(500, "database_unavailable", error instanceof DbError ? error.message : "db failed");
  }
  return done(id, type, typeof outcome === "string" ? outcome : "applied");
}
