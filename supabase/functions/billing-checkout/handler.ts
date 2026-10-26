/**
 * The handler of `billing-checkout` (`index.ts` serves it; docs/RAIL-PLAN.md
 * R6.3, docs/BILLING.md).
 *
 * `GET`  - what the Plan panel shows before anyone pays: whether checkout is
 *          open, each period's price (amount, currency, whether VAT is
 *          included) as Stripe has it, and the early-user discount's percent.
 *          No secret and nothing about the account; cached for ten minutes.
 * `POST` `{ period: "month" | "year", locale?: "en" | "hr" }` - a Stripe
 *          Checkout Session for Pro, and its URL:
 *
 *  1. the caller is verified with GoTrue (its own bearer token; an anonymous
 *     or unconfirmed account cannot buy);
 *  2. one of the account's 20 sessions an hour (`billing_claim`);
 *  3. an account that already has a subscription is sent to the portal
 *     instead (409 `already_subscribed`) - no second subscription;
 *  4. the Stripe customer is reused, or created (idempotency key per account
 *     and email) and linked (`billing_set_customer`, first writer wins);
 *  5. the session: mode subscription, the period's price from configuration,
 *     **Stripe Tax** (`automatic_tax`, the billing address required, tax ids
 *     collected for businesses, both saved on the customer), the early-user
 *     coupon when the account is an early user (else none),
 *     `client_reference_id` and the subscription's metadata = the account id
 *     (from the verified token, never from the body).
 *
 * With the Stripe configuration unset, `GET` says `available: false` and
 * `POST` answers 503 `unavailable`: the page says paid plans open soon.
 */

import {
  type BillingEnv,
  checkoutReady,
  earlyDiscount,
  type Period,
  priceFor,
  supabaseReady,
} from "../_shared/billing/config.ts";
import {
  bearer,
  billingAccount,
  claimSession,
  CORS_HEADERS,
  DbError,
  hasSubscription,
  json,
  readJson,
  refuse,
  serviceRpc,
  stripeLocale,
  verifyCaller,
} from "../_shared/billing/http.ts";
import { type StripeOptions, stripeRequest } from "../_shared/billing/stripe.ts";

const FN = "billing-checkout";
export const MAX_BODY_BYTES = 1024;
const CONFIG_TTL_MS = 10 * 60 * 1000;

export interface PriceInfo {
  amount: number;
  currency: string;
  interval: Period;
  taxInclusive: boolean;
}

export interface BillingConfig {
  available: boolean;
  prices: { month: PriceInfo | null; year: PriceInfo | null };
  earlyDiscountPercent: number | null;
}

const UNAVAILABLE: BillingConfig = {
  available: false,
  prices: { month: null, year: null },
  earlyDiscountPercent: null,
};

let cached: { at: number; key: string; value: BillingConfig } | null = null;

/** For tests: forget the cached prices. */
export function resetConfigCache(): void {
  cached = null;
}

function stripeOptions(env: BillingEnv, fetchFn: typeof fetch): StripeOptions {
  return { secretKey: env.stripeSecretKey, apiVersion: env.stripeApiVersion, fetchFn };
}

async function readPrice(env: BillingEnv, fetchFn: typeof fetch, period: Period): Promise<PriceInfo | null> {
  const id = priceFor(env, period);
  if (!id) return null;
  const price = await stripeRequest<Record<string, unknown>>(stripeOptions(env, fetchFn), "GET", `/v1/prices/${id}`);
  const recurring = (price.recurring ?? {}) as { interval?: unknown };
  if (
    price.active !== true || typeof price.unit_amount !== "number" || typeof price.currency !== "string" ||
    recurring.interval !== period
  ) {
    console.log(`${FN}: the ${period} price is not an active ${period}ly price with an amount`);
    return null;
  }
  return {
    amount: price.unit_amount,
    currency: price.currency,
    interval: period,
    taxInclusive: price.tax_behavior === "inclusive",
  };
}

async function readDiscountPercent(env: BillingEnv, fetchFn: typeof fetch): Promise<number | null> {
  const discount = earlyDiscount(env);
  if (!discount) return null;
  let coupon: Record<string, unknown>;
  if ("coupon" in discount) {
    coupon = await stripeRequest(stripeOptions(env, fetchFn), "GET", `/v1/coupons/${discount.coupon}`);
  } else {
    const promotion = await stripeRequest<Record<string, unknown>>(
      stripeOptions(env, fetchFn),
      "GET",
      `/v1/promotion_codes/${discount.promotion_code}`,
    );
    coupon = (promotion.coupon ?? {}) as Record<string, unknown>;
  }
  return typeof coupon.percent_off === "number" ? coupon.percent_off : null;
}

/** The public half: prices as Stripe has them. */
export async function billingConfig(env: BillingEnv, fetchFn: typeof fetch, now = Date.now()): Promise<BillingConfig> {
  if (!checkoutReady(env)) return UNAVAILABLE;
  const key = `${env.priceMonth}|${env.priceYear}|${env.earlyUserCoupon}`;
  if (cached && cached.key === key && now - cached.at < CONFIG_TTL_MS) return cached.value;
  const [month, year, earlyDiscountPercent] = await Promise.all([
    readPrice(env, fetchFn, "month"),
    readPrice(env, fetchFn, "year"),
    readDiscountPercent(env, fetchFn).catch(() => null),
  ]);
  const value: BillingConfig = {
    available: month !== null || year !== null,
    prices: { month, year },
    earlyDiscountPercent,
  };
  cached = { at: now, key, value };
  return value;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handle(request: Request, env: BillingEnv, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "GET" && request.method !== "POST") return refuse(FN, 405, "method_not_allowed");

  const jwt = bearer(request);
  if (!jwt) return refuse(FN, 401, "not_signed_in", "no bearer token");
  if (!supabaseReady(env)) return refuse(FN, 503, "unavailable", "function environment incomplete");

  let body: { period?: unknown; locale?: unknown } = {};
  if (request.method === "POST") {
    const parsed = await readJson(request, MAX_BODY_BYTES);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return refuse(FN, 400, "invalid_request", "not a JSON object");
    }
    body = parsed as typeof body;
    if (body.period !== "month" && body.period !== "year") {
      return refuse(FN, 400, "invalid_request", "period");
    }
  }

  const who = await verifyCaller(env, jwt, fetchFn);
  if (!who.ok) return refuse(FN, who.status, who.error, who.detail);

  if (request.method === "GET") {
    try {
      return json(200, { ...(await billingConfig(env, fetchFn)) });
    } catch {
      console.log(`${FN}: prices could not be read from Stripe`);
      return json(200, { ...UNAVAILABLE });
    }
  }

  const period = body.period as Period;
  const price = priceFor(env, period);
  if (!checkoutReady(env) || !price) return refuse(FN, 503, "unavailable", "checkout not configured");
  const owner = who.caller.id;

  try {
    if (!(await claimSession(env, fetchFn, owner, "checkout"))) return refuse(FN, 429, "rate_limited");
    const account = await billingAccount(env, fetchFn, owner);
    if (!account) return refuse(FN, 403, "account_not_supported", "no profile");
    if (hasSubscription(account)) return refuse(FN, 409, "already_subscribed");

    const stripe = stripeOptions(env, fetchFn);
    let customer = account.customer_id;
    if (!customer) {
      // Two clicks at once get the same customer from Stripe (the key), and
      // the account keeps the first one linked whatever happens.
      const created = await stripeRequest<{ id?: unknown }>(
        stripe,
        "POST",
        "/v1/customers",
        { email: who.caller.email, metadata: { owner_id: owner } },
        `rail-customer-${owner}-${(await sha256Hex(who.caller.email)).slice(0, 16)}`,
      );
      if (typeof created.id !== "string") return refuse(FN, 502, "unavailable", "customer without an id");
      customer = await serviceRpc<string>(env, fetchFn, "billing_set_customer", {
        p_owner: owner,
        p_customer_id: created.id,
      });
    }

    const discount = account.early_user ? earlyDiscount(env) : null;
    const session = await stripeRequest<{ url?: unknown }>(stripe, "POST", "/v1/checkout/sessions", {
      mode: "subscription",
      customer,
      client_reference_id: owner,
      line_items: [{ price, quantity: 1 }],
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
      discounts: discount ? [discount] : undefined,
      subscription_data: { metadata: { owner_id: owner } },
      metadata: { owner_id: owner },
      locale: stripeLocale(body.locale),
      success_url: env.successUrl,
      cancel_url: env.cancelUrl,
    });
    if (typeof session.url !== "string" || !session.url.startsWith("https://")) {
      return refuse(FN, 502, "unavailable", "session without a URL");
    }
    console.log(`${FN}: session created (${period}${discount ? ", early-user discount" : ""})`);
    return json(200, { url: session.url });
  } catch (error) {
    if (error instanceof DbError) return refuse(FN, 503, "unavailable", error.message);
    return refuse(FN, 502, "unavailable", error instanceof Error ? error.message : "failed");
  }
}
