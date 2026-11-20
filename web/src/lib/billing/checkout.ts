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
 * `available: false`: `/pricing` shows the list prices ({@link LIST_PRICES})
 * and every upgrade opens "Pro is coming", the Pro waitlist (`waitlist.ts`).
 *
 * Before Checkout the page asks for two consents (EU consumer law: Pro
 * starts at once, R6.3 addendum): the terms, and the request that Pro start
 * immediately with the acknowledgement about the right of withdrawal. Both
 * boxes start unticked and both are required; the function refuses without
 * them and records them before it opens the session.
 */

import type { BillingPeriod, Entitlements } from "../db/entitlements";
import { getBrowserSupabase } from "../supabase/browser";

export type Period = BillingPeriod;

/** Every period Pro is sold by, in the order the pricing page offers them. */
export const PERIODS: readonly Period[] = ["month", "half_year", "year"];

/** Months in a period: the pricing page's "per month". */
export const PERIOD_MONTHS: Record<Period, number> = { month: 1, half_year: 6, year: 12 };

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
  prices: Record<Period, BillingPrice | null>;
}

export const NO_OFFER: BillingOffer = { available: false, prices: { month: null, half_year: null, year: null } };

/**
 * The owner's list prices (USD, set in Stripe): what `/pricing` shows while
 * Stripe's own answer is not there (signed out, or checkout not open yet).
 */
export const LIST_PRICES: Record<Period, BillingPrice> = {
  month: { amount: 2500, currency: "usd", interval: "month", taxInclusive: false },
  half_year: { amount: 11900, currency: "usd", interval: "half_year", taxInclusive: false },
  year: { amount: 19900, currency: "usd", interval: "year", taxInclusive: false },
};

/** Each period's price: Stripe's when on sale, else the list price. */
export function shownPrices(offer: BillingOffer | null): Record<Period, BillingPrice> {
  const on = offer?.available ? offer.prices : null;
  return {
    month: on?.month ?? LIST_PRICES.month,
    half_year: on?.half_year ?? LIST_PRICES.half_year,
    year: on?.year ?? LIST_PRICES.year,
  };
}

/** How much a longer period saves against paying monthly, in whole percent (0 for none). */
export function savingPercent(prices: Record<Period, BillingPrice>, period: Period): number {
  const monthly = prices.month.amount;
  const price = prices[period];
  if (period === "month" || monthly <= 0 || price.currency !== prices.month.currency) return 0;
  const full = monthly * PERIOD_MONTHS[period];
  return Math.max(0, Math.round(((full - price.amount) / full) * 100));
}

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

/**
 * The interval Stripe names for a period: six months is a monthly price
 * with `interval_count` 6, which the function may pass on either way.
 */
function intervalFits(row: Row, period: Period): boolean {
  if (row.interval === period) return true;
  return period === "half_year" && row.interval === "month" && row.intervalCount === 6;
}

function parsePrice(raw: unknown, period: Period): BillingPrice | null {
  const row = obj(raw);
  if (
    typeof row.amount !== "number" ||
    !Number.isInteger(row.amount) ||
    row.amount < 0 ||
    typeof row.currency !== "string" ||
    !/^[a-z]{3}$/i.test(row.currency) ||
    !intervalFits(row, period)
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
  const halfYear = parsePrice(prices.half_year, "half_year");
  const year = parsePrice(prices.year, "year");
  return {
    available: row.available === true && (month !== null || halfYear !== null || year !== null),
    prices: { month, half_year: halfYear, year },
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

/**
 * A price in the reader's language: `6,99 €`, `€6.99`, `$199.00`. `whole` drops the
 * cents when there are none (`$199`, the pricing table's style).
 */
export function formatPrice(amount: number, currency: string, intl: string, whole = false): string {
  const code = currency.toUpperCase();
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return `${(amount / 100).toFixed(2)} ${code}`;
  }
  const value = amount / 10 ** digits;
  const round = whole && Number.isInteger(value);
  // `narrowSymbol`: `$199`, not `US$199` in British English (the prices are USD).
  return new Intl.NumberFormat(intl, {
    style: "currency",
    currency: code,
    currencyDisplay: "narrowSymbol",
    ...(round ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
  }).format(value);
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
