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
 *   STRIPE_PRICE_PRO_HALF_YEAR price_... of Pro, billed every 6 months
 *                              (recurring interval month, interval_count 6)
 *   STRIPE_PRICE_PRO_YEAR      price_... of Pro, billed yearly
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
  priceHalfYear: string;
  priceYear: string;
  portalConfiguration: string;
  successUrl: string;
  cancelUrl: string;
  portalReturnUrl: string;
}

export type Period = "month" | "half_year" | "year";

/** Every period, in the order the Plan panel shows them. */
export const PERIODS: readonly Period[] = ["month", "half_year", "year"];

export function isPeriod(value: unknown): value is Period {
  return value === "month" || value === "half_year" || value === "year";
}

/** A period as Stripe's recurring price says it: `interval` x `interval_count`. */
export const PERIOD_RECURRING: Record<Period, { interval: "month" | "year"; count: number }> = {
  month: { interval: "month", count: 1 },
  half_year: { interval: "month", count: 6 },
  year: { interval: "year", count: 1 },
};

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
    priceHalfYear: get("STRIPE_PRICE_PRO_HALF_YEAR"),
    priceYear: get("STRIPE_PRICE_PRO_YEAR"),
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
  const id = period === "month" ? env.priceMonth : period === "half_year" ? env.priceHalfYear : env.priceYear;
  return priceOk(id) ? id : null;
}

/** Checkout can open: a key, at least one price, both return addresses. */
export function checkoutReady(env: BillingEnv): boolean {
  return stripeReady(env) &&
    PERIODS.some((period) => priceFor(env, period) !== null) &&
    returnUrlOk(env.successUrl) &&
    returnUrlOk(env.cancelUrl);
}

export function portalReady(env: BillingEnv): boolean {
  return stripeReady(env) && returnUrlOk(env.portalReturnUrl);
}
