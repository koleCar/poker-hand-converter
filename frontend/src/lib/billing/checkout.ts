/**
 * Paying for Pro (Rail R6.3): the web half of the Edge Functions
 * `billing-checkout` and `billing-portal` (`supabase/functions/`,
 * docs/BILLING.md).
 *
 * Nothing secret is here or anywhere in the web app: the page asks the
 * functions, as the signed-in user, for the prices Stripe has (`GET
 * billing-checkout`), for a Checkout Session (`POST billing-checkout`) or a
 * Customer Portal session (`POST billing-portal`), and sends the browser to
 * the URL that comes back - only ever a Stripe address. What the account
 * pays for reaches the database through Stripe's webhook, never through the
 * page; the page re-reads `my_entitlements()` to show it.
 *
 * Until the owner configures Stripe (or deploys the functions), the offer is
 * `available: false` and the Plan panel says paid plans open soon.
 *
 * Before Checkout the page asks for two consents (EU consumer law: Pro
 * starts at once, R6.3 addendum): the terms, and the request that Pro start
 * immediately with the acknowledgement about the right of withdrawal. Both
 * boxes start unticked and both are required; the function refuses without
 * them and records them before it opens the session.
 */

import type { Entitlements } from "../db/entitlements";
import { getBrowserSupabase } from "../supabase/browser";

export type Period = "month" | "year";

export interface BillingPrice {
  /** In the currency's minor unit (cents), as Stripe has it. */
  amount: number;
  /** ISO 4217, lower case as Stripe writes it. */
  currency: string;
  interval: Period;
  /** The price includes VAT (Stripe `tax_behavior: inclusive`). */
  taxInclusive: boolean;
}

export interface BillingOffer {
  available: boolean;
  prices: { month: BillingPrice | null; year: BillingPrice | null };
  /** The early users' coupon as Stripe has it; null when none is configured. */
  earlyDiscountPercent: number | null;
}

export const NO_OFFER: BillingOffer = { available: false, prices: { month: null, year: null }, earlyDiscountPercent: null };

/** Refusals the functions answer with, plus `failed` for anything else. */
export type BillingError =
  | "not_signed_in"
  | "invalid_request"
  | "email_unconfirmed"
  | "account_not_supported"
  | "rate_limited"
  | "unavailable"
  | "already_subscribed"
  | "no_customer"
  | "consent_required"
  | "consent_outdated"
  | "failed";

const KNOWN = new Set<BillingError>([
  "not_signed_in",
  "invalid_request",
  "email_unconfirmed",
  "account_not_supported",
  "rate_limited",
  "unavailable",
  "already_subscribed",
  "no_customer",
  "consent_required",
  "consent_outdated",
]);

/**
 * The wording of the two checkboxes (`plan.*.ts`, `billing.consent`) the
 * function records with the consent. Bump it with any change to that
 * wording, and add the new version to `CONSENT_TEXTS` in
 * `supabase/functions/_shared/billing/consent.ts` (deployed first) - Vitest
 * `checkoutConsent` holds the two together.
 */
export const CHECKOUT_CONSENT_VERSION = "2026-10-26";

/** The two boxes of the upgrade step. */
export interface CheckoutConsent {
  terms: boolean;
  immediatePerformance: boolean;
}

export const NO_CONSENT: CheckoutConsent = { terms: false, immediatePerformance: false };

/** Both ticked: only then does the page offer Checkout. */
export function consentComplete(consent: CheckoutConsent): boolean {
  return consent.terms === true && consent.immediatePerformance === true;
}

/** The checkboxes' words as one plain text per box (what the server's hash is of). */
export function consentStatements(words: {
  termsBefore: string;
  termsLink: string;
  immediate: string;
}): [string, string] {
  return [`${words.termsBefore}${words.termsLink}`, words.immediate];
}

type Row = Record<string, unknown>;
const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

function parsePrice(raw: unknown, period: Period): BillingPrice | null {
  const row = obj(raw);
  if (
    typeof row.amount !== "number" ||
    !Number.isInteger(row.amount) ||
    row.amount < 0 ||
    typeof row.currency !== "string" ||
    !/^[a-z]{3}$/i.test(row.currency) ||
    row.interval !== period
  ) {
    return null;
  }
  return { amount: row.amount, currency: row.currency, interval: period, taxInclusive: row.taxInclusive === true };
}

/** The function's `GET` answer, checked field by field; anything odd is "not on sale". */
export function parseBillingOffer(raw: unknown): BillingOffer {
  const row = obj(raw);
  const prices = obj(row.prices);
  const month = parsePrice(prices.month, "month");
  const year = parsePrice(prices.year, "year");
  const percent = row.earlyDiscountPercent;
  return {
    available: row.available === true && (month !== null || year !== null),
    prices: { month, year },
    earlyDiscountPercent: typeof percent === "number" && percent > 0 && percent <= 100 ? percent : null,
  };
}

/** Only Stripe's own pages: never send the browser anywhere a response names. */
export function isStripeUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "stripe.com" || url.hostname.endsWith(".stripe.com"));
  } catch {
    return false;
  }
}

/** A price in the reader's language: `6,99 €`, `€6.99`. */
export function formatPrice(amount: number, currency: string, intl: string): string {
  const code = currency.toUpperCase();
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return `${(amount / 100).toFixed(2)} ${code}`;
  }
  return new Intl.NumberFormat(intl, { style: "currency", currency: code }).format(amount / 10 ** digits);
}

/** What a percentage off leaves, rounded to the minor unit as Stripe does. */
export function discounted(amount: number, percent: number): number {
  return Math.round((amount * (100 - percent)) / 100);
}

/**
 * What the Plan panel offers for one account:
 *
 *   upgrade  no subscription that still runs (never paid, ended, or bought
 *            nothing yet) - Pro granted by hand is not offered a purchase
 *   manage   a Stripe subscription exists (any status): the portal changes
 *            the card, the period, cancels, renews and has the invoices
 *   notice   past due (pay or update the card), canceled with time left
 *            (renew in the portal), ended
 */
export interface BillingView {
  upgrade: boolean;
  manage: boolean;
  notice: "past_due" | "canceled_until" | "ended" | null;
}

export function billingView(e: Entitlements, now = Date.now()): BillingView {
  const sub = e.subscription;
  const end = sub.currentPeriodEnd ? Date.parse(sub.currentPeriodEnd) : Number.NaN;
  const paidOn = sub.plan === "pro" && (sub.status === "active" || sub.status === "trialing" || sub.status === "past_due");
  const canceledWithTime = sub.plan === "pro" && sub.status === "canceled" && end > now;
  const granted = sub.plan === "pro" && sub.status === null;
  return {
    upgrade: !paidOn && !canceledWithTime && !granted,
    manage: sub.status !== null,
    notice:
      sub.plan === "pro" && sub.status === "past_due"
        ? "past_due"
        : canceledWithTime
          ? "canceled_until"
          : sub.plan === "pro" && sub.status === "canceled"
            ? "ended"
            : null,
  };
}

/** The webhook has recorded a running subscription (what the success page waits for). */
export function subscriptionRunning(e: Entitlements | null): boolean {
  return (
    e !== null &&
    e.subscription.plan === "pro" &&
    (e.subscription.status === "active" || e.subscription.status === "trialing")
  );
}

async function errorOf(error: unknown): Promise<BillingError> {
  // A FunctionsHttpError carries the Response; its body names the refusal.
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    if (context.status === 404) return "unavailable";
    try {
      const body = (await context.json()) as { error?: unknown };
      if (typeof body.error === "string" && KNOWN.has(body.error as BillingError)) {
        return body.error as BillingError;
      }
    } catch {
      // Not JSON.
    }
  }
  return "failed";
}

/** What is on sale, as Stripe has it. Any failure (not deployed, not configured) is "not on sale". */
export async function fetchBillingOffer(): Promise<BillingOffer> {
  const client = getBrowserSupabase();
  if (!client) return NO_OFFER;
  try {
    const { data, error } = await client.functions.invoke<unknown>("billing-checkout", { method: "GET" });
    return error ? NO_OFFER : parseBillingOffer(data);
  } catch {
    return NO_OFFER;
  }
}

type Redirect = { ok: true; url: string } | { ok: false; error: BillingError };

async function invokeForUrl(name: string, body: Record<string, unknown>): Promise<Redirect> {
  const client = getBrowserSupabase();
  if (!client) return { ok: false, error: "unavailable" };
  try {
    const { data, error } = await client.functions.invoke<{ url?: unknown }>(name, { body });
    if (!error && data && isStripeUrl(data.url)) return { ok: true, url: data.url };
    return { ok: false, error: error ? await errorOf(error) : "failed" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/**
 * A Checkout Session for Pro billed per `period`; the page then goes to the
 * URL. Refused here, before any call, unless both boxes are ticked.
 */
export async function startCheckout(period: Period, locale: "en" | "hr", consent: CheckoutConsent): Promise<Redirect> {
  if (!consentComplete(consent)) return { ok: false, error: "consent_required" };
  return invokeForUrl("billing-checkout", {
    period,
    locale,
    consent: { terms: true, immediatePerformance: true, version: CHECKOUT_CONSENT_VERSION },
  });
}

/** A Customer Portal session for the caller's own customer. */
export function openBillingPortal(locale: "en" | "hr"): Promise<Redirect> {
  return invokeForUrl("billing-portal", { locale });
}
