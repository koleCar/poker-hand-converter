/**
 * Paying for Pro on the web (Rail R6.3 and the pricing round,
 * `web/src/lib/billing/checkout.ts`, `components/plan/PlanPanel.tsx`,
 * `components/plan/PricingScreen.tsx`, `components/plan/BillingReturn.tsx`):
 *
 * - the offer from `GET billing-checkout` read field by field (anything odd
 *   is "not on sale"): month, half_year and year; the list prices when not;
 *   what a longer period saves; prices in both languages;
 * - only Stripe's own pages are ever redirected to;
 * - what the panel offers per subscription state (upgrade, manage, notices);
 * - the panel and the return pages in English and Croatian: Free or Pro,
 *   enforcement on or off, past due, canceled with time left, ended;
 * - the pricing table's rows are the contract's plans table.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  billingView,
  formatPrice,
  isStripeUrl,
  LIST_PRICES,
  NO_OFFER,
  parseBillingOffer,
  savingPercent,
  shownPrices,
  subscriptionRunning,
} from "../../web/src/lib/billing/checkout.js";
import { parseEntitlements } from "../../web/src/lib/db/entitlements.js";
import { PlanDetails } from "../../web/src/components/plan/PlanPanel.js";
import { pricingRows } from "../../web/src/components/plan/PricingScreen.js";
import { BillingCancel, BillingSuccessView } from "../../web/src/components/plan/BillingReturn.js";
import { I18nProvider } from "../../web/src/lib/i18n/client.js";
import { en as EN } from "../../web/src/lib/i18n/en.js";
import { hr as HR } from "../../web/src/lib/i18n/hr.js";

const OFFER_RAW = {
  available: true,
  prices: {
    month: { amount: 2500, currency: "usd", interval: "month", taxInclusive: false },
    half_year: { amount: 11900, currency: "usd", interval: "half_year", taxInclusive: false },
    year: { amount: 19900, currency: "usd", interval: "year", taxInclusive: false },
  },
};
const OFFER = parseBillingOffer(OFFER_RAW);

const features = (on: boolean, cap: number | null) => ({
  library_unlimited: cap === null,
  hand_cap: cap,
  desktop_sync: true,
  hud: on,
  reports_full: on,
  analysis: on,
  learn: on,
  solver_unlimited: on,
  nodelock: on,
});

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

function entitlements(
  subscription: {
    plan: "free" | "pro";
    period: "month" | "half_year" | "year" | null;
    status: string | null;
    currentPeriodEnd: string | null;
  },
  enforced = false,
) {
  const pro = !enforced || subscription.plan === "pro";
  return parseEntitlements({
    plan: pro ? "pro" : "free",
    reason: enforced ? (pro ? "subscription" : "free") : "not_enforced",
    enforced,
    features: features(pro, pro ? null : 10000),
    usage: { handsStored: 1200, handsToday: 0, flopsToday: [], dayResetsAt: null },
    limits: { freeHandCap: 10000, dailyHandCap: enforced && !pro ? 500 : null, dailyFlopCap: enforced && !pro ? 3 : null },
    subscription,
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
const panel = (locale: "en" | "hr", e: ReturnType<typeof entitlements>) =>
  render(locale, createElement(PlanDetails, { entitlements: e }));

describe("the offer", () => {
  it("reads the function's answer, three periods", () => {
    expect(OFFER).toEqual(OFFER_RAW);
    // Six months as Stripe words it: a monthly price every 6 months.
    const stripeWords = parseBillingOffer({
      ...OFFER_RAW,
      prices: { ...OFFER_RAW.prices, half_year: { ...OFFER_RAW.prices.half_year, interval: "month", intervalCount: 6 } },
    });
    expect(stripeWords.prices.half_year?.amount).toBe(11900);
  });

  it("reads anything odd as not on sale", () => {
    expect(parseBillingOffer(null)).toEqual(NO_OFFER);
    expect(parseBillingOffer({ available: true, prices: {} }).available).toBe(false);
    expect(parseBillingOffer({ ...OFFER_RAW, available: false }).available).toBe(false);
    const wrong = parseBillingOffer({
      available: true,
      prices: {
        month: { amount: 6.99, currency: "usd", interval: "month" },
        half_year: { amount: 11900, currency: "usd", interval: "month" },
        year: { amount: 5999, currency: "dollar", interval: "year" },
      },
    });
    expect(wrong).toEqual(NO_OFFER);
    expect(parseBillingOffer({ ...OFFER_RAW, prices: { month: OFFER_RAW.prices.year } }).prices.month).toBeNull();
    expect(parseBillingOffer({ ...OFFER_RAW, earlyDiscountPercent: 30 })).not.toHaveProperty("earlyDiscountPercent");
  });

  it("shows the list prices until Stripe's are known, and what a longer period saves", () => {
    expect(shownPrices(null)).toEqual(LIST_PRICES);
    expect(shownPrices(NO_OFFER)).toEqual(LIST_PRICES);
    expect(shownPrices(OFFER).year.amount).toBe(19900);
    expect(LIST_PRICES.month.amount).toBe(2500);
    expect(LIST_PRICES.half_year.amount).toBe(11900);
    expect(savingPercent(LIST_PRICES, "month")).toBe(0);
    expect(savingPercent(LIST_PRICES, "half_year")).toBe(21);
    expect(savingPercent(LIST_PRICES, "year")).toBe(34);
  });

  it("formats prices per language and currency", () => {
    expect(formatPrice(699, "eur", "en-GB")).toBe("€6.99");
    expect(formatPrice(699, "eur", "hr-HR")).toMatch(/^6,99\s€$/);
    expect(formatPrice(1200, "jpy", "en-GB")).toBe("¥1,200");
    expect(formatPrice(2500, "usd", "en-GB", true)).toBe("$25");
    expect(formatPrice(2500, "usd", "hr-HR", true)).toMatch(/^25\s\$$/);
    expect(formatPrice(19900, "usd", "en-US")).toBe("$199.00");
    expect(formatPrice(19900, "usd", "en-US", true)).toBe("$199");
    expect(formatPrice(1658, "usd", "en-US", true)).toBe("$16.58");
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

describe("the Plan panel", () => {
  it("Free under enforcement: the upgrade is a link to /pricing, nothing is bought here", () => {
    const html = panel("en", entitlements(NONE, true));
    expect(html).toMatch(/<a[^>]*href="\/pricing"[^>]*>Upgrade to Pro<\/a>/);
    expect(html).not.toContain("Before you pay");
    expect(html).not.toContain("Monthly");
    expect(html).not.toContain("Manage subscription");
    expect(html).toContain("0 / 500 hands · 0 / 3 flops");
  });

  it("early access: one line, and the way to the prices", () => {
    const early = panel("en", entitlements(NONE));
    expect(early).not.toContain("Upgrade to Pro");
    expect(early).toContain("Everything is open while Rail is in early access.");
    expect(early).toMatch(/<a[^>]*href="\/pricing"[^>]*>Plans and prices<\/a>/);
    expect(early).not.toContain("discount");
  });

  it("a subscriber: Manage subscription, no upgrade; six months is a period", () => {
    const html = panel("en", entitlements(ACTIVE, true));
    expect(html).toContain("Manage subscription");
    expect(html).toContain("download invoices or cancel");
    expect(html).not.toContain("Upgrade to Pro");
    expect(panel("en", entitlements({ ...ACTIVE, period: "half_year" }, true))).toContain("Billed every 6 months");
    expect(panel("hr", entitlements({ ...ACTIVE, period: "half_year" }, true))).toContain("Naplata svakih 6 mjeseci");
  });

  it("past due: the warning and the way to fix it, never 'renews' on a past date", () => {
    const html = panel("en", entitlements(PAST_DUE, true));
    expect(html).toContain("Your last payment did not go through.");
    expect(html).toContain("Manage subscription");
    expect(html).not.toContain("Upgrade to Pro");
    expect(html).not.toContain("Renews on");
    const grace = parseEntitlements({
      ...JSON.parse(JSON.stringify(entitlements(PAST_DUE, true))),
      reason: "grace",
      graceUntil: "2026-11-02T00:00:00Z",
    });
    const withGrace = panel("en", grace);
    expect(withGrace).toContain("Pro stays on until 2 November 2026; update your payment method");
    expect(withGrace.match(/did not go through/g)?.length).toBe(1);
    const hr = panel("hr", grace);
    expect(hr).toContain("Pro ostaje uključen do 2. studenoga 2026; ažuriraj");
  });

  it("dates in Croatian end with one full stop, not two", () => {
    const html = panel("hr", entitlements({ ...ACTIVE, currentPeriodEnd: "2027-10-26T00:00:00Z" }, true));
    expect(html).toContain("Obnavlja se 26. listopada 2027.");
    expect(html).not.toContain("2027..");
  });

  it("canceled with time left: until when, renew in the portal; ended: Pro again from /pricing", () => {
    const left = panel("en", entitlements(CANCELED_LEFT, true));
    expect(left).toMatch(/Your subscription is canceled\. Pro stays on until \d+ \w+ \d{4}/);
    expect(left).not.toContain("Upgrade to Pro");
    // An ended subscription is Free again (`expired`).
    const ended = panel(
      "en",
      parseEntitlements({ ...JSON.parse(JSON.stringify(entitlements(NONE, true))), subscription: ENDED, reason: "expired" }),
    );
    expect(ended).toMatch(/Your subscription ended on \d+ \w+ \d{4}\./);
    expect(ended).toContain("Upgrade to Pro");
    expect(ended).toContain("Manage subscription");
  });

  it("Pro granted by hand: nothing to buy, nothing to manage", () => {
    const html = panel("en", entitlements(GRANTED, true));
    expect(html).not.toContain("Upgrade to Pro");
    expect(html).not.toContain("Manage subscription");
  });

  it("speaks Croatian", () => {
    const free = panel("hr", entitlements(NONE, true));
    expect(free).toContain("Prijeđi na Pro");
    expect(free).toContain("0 / 500 ruku · 0 / 3 flopova");
    const due = panel("hr", entitlements(PAST_DUE, true));
    expect(due).toContain("Zadnje plaćanje nije prošlo.");
    expect(due).toContain("Upravljaj pretplatom");
    expect(panel("hr", entitlements(CANCELED_LEFT, true))).toContain("Pretplata je otkazana.");
    for (const html of [free, due]) {
      expect(html).not.toContain("Manage subscription");
      expect(html).not.toContain("Upgrade to Pro");
    }
  });
});

describe("the pricing table", () => {
  const count = (n: number) => n.toLocaleString("en-US");
  it("has the contract's rows: no Learn, no early users, Free's numbers", () => {
    const rows = pricingRows(EN.pricing, count);
    const labels = rows.map((r) => ("group" in r ? `# ${r.group}` : r.label));
    expect(labels).toEqual([
      "# Hands",
      "Upload, convert and replay",
      "Hands saved per day",
      "Hand library",
      "Delete hands",
      "Share hands, forum, polls",
      "# Statistics",
      "Results graph and basic statistics",
      "Full reports",
      "Players",
      "# Desktop app",
      "Import and hands on your computer",
      "Sync with the web",
      "Table tiling and RNG",
      "HUD",
      "# Study",
      "Solver",
      "Nodelock",
      "Analysis",
      "Trainer",
      "Review queue",
    ]);
    const cell = (label: string) => rows.find((r) => !("group" in r) && r.label === label) as { free: unknown; pro: unknown };
    expect(cell("Hands saved per day")).toEqual(expect.objectContaining({ free: "500", pro: "Unlimited" }));
    expect(cell("Hand library").free).toBe("10,000 hands");
    expect(cell("Solver").free).toBe("3 flops a day");
    expect(cell("Sync with the web").free).toBe(true);
    expect(cell("HUD").free).toBe(false);
    expect(JSON.stringify(rows)).not.toMatch(/learn|early/i);
    expect(pricingRows(HR.pricing, count)).toHaveLength(rows.length);
  });
});

describe("the pages Stripe returns to", () => {
  it("success: waiting, running, slow - in both languages", () => {
    const waiting = render("en", createElement(BillingSuccessView, { running: false, slow: false }));
    expect(waiting).toContain("Turning on Pro…");
    expect(waiting).toContain("Usually a few seconds.");
    const running = render("en", createElement(BillingSuccessView, { running: true, slow: false }));
    expect(running).toContain("You&#x27;re on Pro");
    expect(running).toContain('href="/analysis"');
    expect(running).toContain('href="/download"');
    expect(running).toContain("Receipt sent to your email.");
    expect(render("en", createElement(BillingSuccessView, { running: false, slow: true }))).toContain(
      "taking longer than usual",
    );
    const hr = render("hr", createElement(BillingSuccessView, { running: true, slow: false }));
    expect(hr).toContain("Sada si na Pro planu");
    expect(hr).toContain("Otvori analizu");
  });

  it("cancel: no payment was made, back to pricing - in both languages", () => {
    const en = render("en", createElement(BillingCancel));
    expect(en).toContain("No payment was made");
    expect(en).toContain('href="/pricing"');
    const hr = render("hr", createElement(BillingCancel));
    expect(hr).toContain("Ništa nije plaćeno");
    expect(hr).toContain("Natrag na cijene");
  });
});
