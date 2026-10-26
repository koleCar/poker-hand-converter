/**
 * Paying for Pro on the web (Rail R6.3, `frontend/src/lib/billing/checkout.ts`,
 * `components/plan/PlanPanel.tsx`, `components/plan/BillingReturn.tsx`):
 *
 * - the offer from `GET billing-checkout` read field by field (anything odd
 *   is "not on sale"), prices in both languages, the early-user price;
 * - only Stripe's own pages are ever redirected to;
 * - what the panel offers per subscription state (upgrade, manage, notices);
 * - the panel and the return pages in English and Croatian: on sale or not,
 *   enforcement on or off, past due, canceled with time left, ended.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  billingView,
  discounted,
  formatPrice,
  isStripeUrl,
  NO_OFFER,
  parseBillingOffer,
  subscriptionRunning,
} from "../../frontend/src/lib/billing/checkout.js";
import { parseEntitlements } from "../../frontend/src/lib/db/entitlements.js";
import { PlanDetails } from "../../frontend/src/components/plan/PlanPanel.js";
import { BillingCancel, BillingSuccessView } from "../../frontend/src/components/plan/BillingReturn.js";
import { I18nProvider } from "../../frontend/src/lib/i18n/client.js";

const OFFER_RAW = {
  available: true,
  prices: {
    month: { amount: 699, currency: "eur", interval: "month", taxInclusive: true },
    year: { amount: 5999, currency: "eur", interval: "year", taxInclusive: true },
  },
  earlyDiscountPercent: 30,
};
const OFFER = parseBillingOffer(OFFER_RAW);

const features = (on: boolean, cap: number | null) => ({
  library_unlimited: cap === null,
  hand_cap: cap,
  desktop_sync: on,
  hud: on,
  reports_full: on,
  analysis: on,
  learn: on,
});

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

function entitlements(
  subscription: { plan: "free" | "pro"; period: "month" | "year" | null; status: string | null; currentPeriodEnd: string | null },
  enforced = false,
  early = true,
) {
  const pro = !enforced || subscription.plan === "pro";
  return parseEntitlements({
    plan: pro ? "pro" : "free",
    reason: enforced ? (pro ? "subscription" : "free") : "not_enforced",
    enforced,
    features: features(pro, pro ? null : 10000),
    usage: { handsStored: 1200 },
    limits: { freeHandCap: 10000 },
    subscription,
    earlyUser: { is: early, since: "2026-10-01T00:00:00Z", discountPercent: 30 },
    validUntil: null,
    graceUntil: null,
    offlineGraceDays: 14,
    checkedAt: "2026-10-26T10:00:00Z",
  });
}

const NONE = { plan: "free" as const, period: null, status: null, currentPeriodEnd: null };
const ACTIVE = { plan: "pro" as const, period: "month" as const, status: "active", currentPeriodEnd: iso(20) };
const PAST_DUE = { plan: "pro" as const, period: "month" as const, status: "past_due", currentPeriodEnd: iso(-2) };
const CANCELED_LEFT = { plan: "pro" as const, period: "year" as const, status: "canceled", currentPeriodEnd: iso(40) };
const ENDED = { plan: "pro" as const, period: "month" as const, status: "canceled", currentPeriodEnd: iso(-3) };
const GRANTED = { plan: "pro" as const, period: null, status: null, currentPeriodEnd: null };

const render = (locale: "en" | "hr", node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale }, node));
const panel = (locale: "en" | "hr", e: ReturnType<typeof entitlements>, offer: typeof OFFER | null) =>
  render(locale, createElement(PlanDetails, { entitlements: e, offer }));

describe("the offer", () => {
  it("reads the function's answer", () => {
    expect(OFFER).toEqual(OFFER_RAW);
  });

  it("reads anything odd as not on sale", () => {
    expect(parseBillingOffer(null)).toEqual(NO_OFFER);
    expect(parseBillingOffer({ available: true, prices: {} }).available).toBe(false);
    expect(parseBillingOffer({ ...OFFER_RAW, available: false }).available).toBe(false);
    const wrong = parseBillingOffer({
      available: true,
      prices: {
        month: { amount: 6.99, currency: "eur", interval: "month" },
        year: { amount: 5999, currency: "euro", interval: "year" },
      },
    });
    expect(wrong).toEqual(NO_OFFER);
    expect(parseBillingOffer({ ...OFFER_RAW, prices: { month: OFFER_RAW.prices.year } }).prices.month).toBeNull();
    expect(parseBillingOffer({ ...OFFER_RAW, earlyDiscountPercent: 0 }).earlyDiscountPercent).toBeNull();
    expect(parseBillingOffer({ ...OFFER_RAW, earlyDiscountPercent: 130 }).earlyDiscountPercent).toBeNull();
  });

  it("formats prices per language and currency, and the early-user price", () => {
    expect(formatPrice(699, "eur", "en-GB")).toBe("€6.99");
    expect(formatPrice(699, "eur", "hr-HR")).toMatch(/^6,99\s€$/);
    expect(formatPrice(1200, "jpy", "en-GB")).toBe("JP¥1,200");
    expect(discounted(699, 30)).toBe(489);
    expect(discounted(5999, 30)).toBe(4199);
  });

  it("only ever sends the browser to Stripe", () => {
    expect(isStripeUrl("https://checkout.stripe.com/c/pay/cs_test_1")).toBe(true);
    expect(isStripeUrl("https://billing.stripe.com/p/session/x")).toBe(true);
    expect(isStripeUrl("http://checkout.stripe.com/c/pay")).toBe(false);
    expect(isStripeUrl("https://checkout.stripe.com.evil.test/")).toBe(false);
    expect(isStripeUrl("https://evil.test/?https://checkout.stripe.com")).toBe(false);
    expect(isStripeUrl("javascript:alert(1)")).toBe(false);
    expect(isStripeUrl(42)).toBe(false);
  });
});

describe("what the panel offers", () => {
  it("per subscription state", () => {
    expect(billingView(entitlements(NONE))).toEqual({ upgrade: true, manage: false, notice: null });
    expect(billingView(entitlements(ACTIVE))).toEqual({ upgrade: false, manage: true, notice: null });
    expect(billingView(entitlements(PAST_DUE))).toEqual({ upgrade: false, manage: true, notice: "past_due" });
    expect(billingView(entitlements(CANCELED_LEFT))).toEqual({ upgrade: false, manage: true, notice: "canceled_until" });
    expect(billingView(entitlements(ENDED))).toEqual({ upgrade: true, manage: true, notice: "ended" });
    expect(billingView(entitlements(GRANTED))).toEqual({ upgrade: false, manage: false, notice: null });
  });

  it("knows when the webhook has recorded a running subscription", () => {
    expect(subscriptionRunning(entitlements(ACTIVE))).toBe(true);
    expect(subscriptionRunning(entitlements({ ...ACTIVE, status: "trialing" }))).toBe(true);
    expect(subscriptionRunning(entitlements(NONE))).toBe(false);
    expect(subscriptionRunning(entitlements(PAST_DUE))).toBe(false);
    expect(subscriptionRunning(null)).toBe(false);
  });
});

describe("the Plan panel with checkout", () => {
  it("on sale in early access: monthly and yearly with prices, the early-user price, VAT, buying allowed", () => {
    const html = panel("en", entitlements(NONE), OFFER);
    expect(html).toContain("You can already subscribe to Pro.");
    expect(html).toContain("Monthly");
    expect(html).toContain("€6.99 / month");
    expect(html).toContain("€59.99 / year");
    expect(html).toContain("€4.89 / month with your 30% early-user discount");
    expect(html).toContain("Prices include VAT.");
    expect(html).toContain("Subscribing now starts Pro billing today.");
    expect(html).toMatch(/<button type="button" class="btn btn--primary">Upgrade to Pro<\/button>/);
    expect(html).not.toContain("Paid plans open soon.");
    expect(html).not.toContain("Manage subscription");
  });

  it("no early-user price for a later account; VAT added for an exclusive price", () => {
    const exclusive = parseBillingOffer({
      ...OFFER_RAW,
      prices: { month: { ...OFFER_RAW.prices.month, taxInclusive: false }, year: null },
    });
    const html = panel("en", entitlements(NONE, true, false), exclusive);
    expect(html).not.toContain("early-user discount");
    expect(html).toContain("VAT is added at checkout");
    expect(html).not.toContain("/ year");
    expect(html).not.toContain("Subscribing now starts Pro billing today.");
  });

  it("not on sale: as before - disabled and 'open soon' only under enforcement, nothing in early access", () => {
    expect(panel("en", entitlements(NONE, true), NO_OFFER)).toMatch(/<button[^>]*disabled[^>]*>Upgrade to Pro<\/button>/);
    expect(panel("en", entitlements(NONE, true), null)).toContain("Paid plans open soon.");
    const early = panel("en", entitlements(NONE), null);
    expect(early).not.toContain("Upgrade to Pro");
    expect(early).toContain("Paid plans are not on sale yet.");
  });

  it("a subscriber: Manage subscription, no upgrade", () => {
    const html = panel("en", entitlements(ACTIVE, true), OFFER);
    expect(html).toContain("Manage subscription");
    expect(html).toContain("download invoices or cancel");
    expect(html).not.toContain("Upgrade to Pro");
  });

  it("past due: the warning and the way to fix it, never 'renews' on a past date", () => {
    const html = panel("en", entitlements(PAST_DUE, true), OFFER);
    expect(html).toContain("Your last payment did not go through.");
    expect(html).toContain("Manage subscription");
    expect(html).not.toContain("Upgrade to Pro");
    expect(html).not.toContain("Renews on");
    const grace = parseEntitlements({
      ...JSON.parse(JSON.stringify(entitlements(PAST_DUE, true))),
      reason: "grace",
      graceUntil: "2026-11-02T00:00:00Z",
    });
    const withGrace = panel("en", grace, OFFER);
    expect(withGrace).toContain("Pro stays on until 2 November 2026; update your payment method");
    expect(withGrace.match(/did not go through/g)?.length).toBe(1);
    const hr = panel("hr", grace, OFFER);
    expect(hr).toContain("Pro ostaje uključen do 2. studenoga 2026; ažuriraj");
  });

  it("dates in Croatian end with one full stop, not two", () => {
    const html = panel("hr", entitlements({ ...ACTIVE, currentPeriodEnd: "2027-10-26T00:00:00Z" }, true), OFFER);
    expect(html).toContain("Obnavlja se 26. listopada 2027.");
    expect(html).not.toContain("2027..");
  });

  it("canceled with time left: until when, renew in the portal; ended: a new subscription", () => {
    const left = panel("en", entitlements(CANCELED_LEFT, true), OFFER);
    expect(left).toMatch(/Your subscription is canceled\. Pro stays on until \d+ \w+ \d{4}/);
    expect(left).not.toContain("Upgrade to Pro");
    const ended = panel("en", entitlements(ENDED, true), OFFER);
    expect(ended).toMatch(/Your subscription ended on \d+ \w+ \d{4}\./);
    expect(ended).toContain("Upgrade to Pro");
    expect(ended).toContain("Manage subscription");
  });

  it("Pro granted by hand: nothing to buy, nothing to manage", () => {
    const html = panel("en", entitlements(GRANTED, true), OFFER);
    expect(html).not.toContain("Upgrade to Pro");
    expect(html).not.toContain("Manage subscription");
  });

  it("speaks Croatian", () => {
    const sale = panel("hr", entitlements(NONE), OFFER);
    expect(sale).toContain("Na Pro se već možeš pretplatiti.");
    expect(sale).toContain("Mjesečno");
    expect(sale).toContain("Godišnje");
    expect(sale).toMatch(/6,99\s€ \/ mjesec/);
    expect(sale).toContain("uz tvoj popust ranog korisnika od 30%");
    expect(sale).toContain("Cijene uključuju PDV.");
    expect(sale).toContain("Prijeđi na Pro");
    const due = panel("hr", entitlements(PAST_DUE, true), OFFER);
    expect(due).toContain("Zadnje plaćanje nije prošlo.");
    expect(due).toContain("Upravljaj pretplatom");
    expect(panel("hr", entitlements(CANCELED_LEFT, true), OFFER)).toContain("Pretplata je otkazana.");
    for (const html of [sale, due]) {
      expect(html).not.toContain("Manage subscription");
      expect(html).not.toContain("Upgrade to Pro");
    }
  });
});

describe("the pages Stripe returns to", () => {
  it("success: waiting, running, slow - in both languages", () => {
    const waiting = render("en", createElement(BillingSuccessView, { running: false, slow: false }));
    expect(waiting).toContain("Thank you");
    expect(waiting).toContain("Waiting for the confirmation");
    expect(waiting).toContain('href="/settings#plan"');
    expect(render("en", createElement(BillingSuccessView, { running: true, slow: false }))).toContain(
      "Pro is on for your account.",
    );
    expect(render("en", createElement(BillingSuccessView, { running: false, slow: true }))).toContain(
      "taking longer than usual",
    );
    const hr = render("hr", createElement(BillingSuccessView, { running: true, slow: false }));
    expect(hr).toContain("Hvala");
    expect(hr).toContain("Pro je uključen za tvoj račun.");
  });

  it("cancel: nothing was charged - in both languages", () => {
    expect(render("en", createElement(BillingCancel))).toContain("Nothing was charged.");
    const hr = render("hr", createElement(BillingCancel));
    expect(hr).toContain("Plaćanje otkazano");
    expect(hr).toContain("Ništa nije naplaćeno.");
  });
});
