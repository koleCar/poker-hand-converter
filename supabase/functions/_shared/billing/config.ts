/**
 * The billing functions' configuration (docs/RAIL-PLAN.md R6.3). Everything
 * Stripe-specific is a secret the owner sets on the Supabase project
 * (`supabase secrets set ...`, docs/BILLING.md); nothing is in code. With the
 * Stripe values unset the functions answer "unavailable" and the web says
 * paid plans open soon - nothing breaks.
 *
 *   STRIPE_SECRET_KEY          sk_test_... / sk_live_... (or a restricted rk_...)
 *   STRIPE_WEBHOOK_SECRET      whsec_... of the webhook endpoint
 *   STRIPE_PRICE_PRO_MONTH     price_... of Pro, billed monthly
 *   STRIPE_PRICE_PRO_YEAR      price_... of Pro, billed yearly
 *   STRIPE_EARLY_USER_COUPON   optional: the early users' coupon id, or a
 *                              promotion code id (promo_...)
 *   STRIPE_PORTAL_CONFIGURATION optional: bpc_... (else the default portal)
 *   STRIPE_API_VERSION         optional: overrides the pinned API version
 *   BILLING_SUCCESS_URL        where Checkout returns after paying
 *   BILLING_CANCEL_URL         where Checkout returns when abandoned
 *   BILLING_PORTAL_RETURN_URL  where the Customer Portal's "back" goes
 *
 * `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are set
 * by Supabase inside every function.
 */

import { keyMode, STRIPE_API_VERSION_DEFAULT } from "./stripe.ts";

export interface BillingEnv {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripeApiVersion: string;
  priceMonth: string;
  priceYear: string;
  earlyUserCoupon: string;
  portalConfiguration: string;
  successUrl: string;
  cancelUrl: string;
  portalReturnUrl: string;
}

export type Period = "month" | "year";

const get = (name: string): string => (Deno.env.get(name) ?? "").trim();

export function billingEnvFromDeno(): BillingEnv {
  return {
    supabaseUrl: get("SUPABASE_URL").replace(/\/+$/, ""),
    anonKey: get("SUPABASE_ANON_KEY"),
    serviceRoleKey: get("SUPABASE_SERVICE_ROLE_KEY"),
    stripeSecretKey: get("STRIPE_SECRET_KEY"),
    stripeWebhookSecret: get("STRIPE_WEBHOOK_SECRET"),
    stripeApiVersion: get("STRIPE_API_VERSION") || STRIPE_API_VERSION_DEFAULT,
    priceMonth: get("STRIPE_PRICE_PRO_MONTH"),
    priceYear: get("STRIPE_PRICE_PRO_YEAR"),
    earlyUserCoupon: get("STRIPE_EARLY_USER_COUPON"),
    portalConfiguration: get("STRIPE_PORTAL_CONFIGURATION"),
    successUrl: get("BILLING_SUCCESS_URL"),
    cancelUrl: get("BILLING_CANCEL_URL"),
    portalReturnUrl: get("BILLING_PORTAL_RETURN_URL"),
  };
}

/** https anywhere, http only on this computer (the Stripe CLI and a local web). */
export function returnUrlOk(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

export function supabaseReady(env: BillingEnv): boolean {
  return Boolean(env.supabaseUrl && env.anonKey && env.serviceRoleKey);
}

export function stripeReady(env: BillingEnv): boolean {
  return keyMode(env.stripeSecretKey) !== null;
}

const priceOk = (id: string) => /^price_[A-Za-z0-9]{1,250}$/.test(id);

/** The price id of a period, or null when that period is not on sale. */
export function priceFor(env: BillingEnv, period: Period): string | null {
  const id = period === "month" ? env.priceMonth : env.priceYear;
  return priceOk(id) ? id : null;
}

/** Checkout can open: a key, at least one price, both return addresses. */
export function checkoutReady(env: BillingEnv): boolean {
  return stripeReady(env) &&
    (priceFor(env, "month") !== null || priceFor(env, "year") !== null) &&
    returnUrlOk(env.successUrl) &&
    returnUrlOk(env.cancelUrl);
}

export function portalReady(env: BillingEnv): boolean {
  return stripeReady(env) && returnUrlOk(env.portalReturnUrl);
}

/** The early users' discount as Checkout takes it, or null when none is configured. */
export function earlyDiscount(env: BillingEnv): { coupon: string } | { promotion_code: string } | null {
  const id = env.earlyUserCoupon;
  if (!id || id.length > 255 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id.startsWith("promo_") ? { promotion_code: id } : { coupon: id };
}
