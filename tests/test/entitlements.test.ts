/**
 * Plans and entitlements on the web (Rail R6.2,
 * `web/src/lib/db/entitlements.ts`, `components/plan/`):
 *
 * - `my_entitlements()`'s JSON read field by field; while enforcement is off
 *   every feature is open whatever the payload says, and nothing is locked;
 * - a lock only when enforcement is on and the plan lacks the feature;
 * - hands left under the cap; the PT402 refusal recognised;
 * - the Free plan's daily caps and the room a save has (the pricing round);
 * - the Plan panel and the lock in both languages: early access says so, a
 *   Free account under enforcement sees its usage against the cap and today's
 *   hands and flops, Pro sees its renewal; the lock is a teaser to /pricing.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DatabaseRpcError } from "../../web/src/lib/db/client.js";
import {
  dailyFlopCap,
  handsLeft,
  handsLeftToday,
  isLocked,
  isPlanRequiredError,
  parseEntitlements,
  saveRoom,
} from "../../web/src/lib/db/entitlements.js";
import { PlanDetails } from "../../web/src/components/plan/PlanPanel.js";
import { ProLock } from "../../web/src/components/plan/ProLock.js";
import { I18nProvider } from "../../web/src/lib/i18n/client.js";
import { localizeServerMessage } from "../../web/src/lib/i18n/serverErrors.js";

const features = (on: boolean, cap: number | null) => ({
  library_unlimited: cap === null,
  hand_cap: cap,
  desktop_sync: on,
  hud: on,
  reports_full: on,
  analysis: on,
  learn: on,
  solver_unlimited: on,
  nodelock: on,
});

const base = {
  usage: { handsStored: 2500, handsToday: 0, flopsToday: [], dayResetsAt: "2026-10-27T00:00:00Z" },
  limits: { freeHandCap: 10000, dailyHandCap: null, dailyFlopCap: null },
  offlineGraceDays: 14,
  graceUntil: null,
  validUntil: null,
  checkedAt: "2026-10-26T10:00:00Z",
};

const OFF = {
  ...base,
  plan: "pro",
  reason: "not_enforced",
  enforced: false,
  features: features(true, null),
  subscription: { plan: "free", period: null, status: null, currentPeriodEnd: null },
};
const FREE = {
  ...base,
  plan: "free",
  reason: "free",
  enforced: true,
  usage: { handsStored: 10000, handsToday: 120, flopsToday: ["Ks7d2c", "nonsense"], dayResetsAt: "2026-10-27T00:00:00Z" },
  limits: { freeHandCap: 10000, dailyHandCap: 500, dailyFlopCap: 3 },
  features: { ...features(false, 10000), desktop_sync: true },
  subscription: { plan: "free", period: null, status: null, currentPeriodEnd: null },
};
const PRO = {
  ...base,
  plan: "pro",
  reason: "subscription",
  enforced: true,
  features: features(true, null),
  subscription: { plan: "pro", period: "year", status: "active", currentPeriodEnd: "2027-10-26T00:00:00Z" },
  validUntil: "2027-11-02T00:00:00Z",
};

describe("parseEntitlements", () => {
  it("reads every field of an answer", () => {
    const e = parseEntitlements(FREE);
    expect(e.plan).toBe("free");
    expect(e.enforced).toBe(true);
    expect(e.features.analysis).toBe(false);
    expect(e.features.hand_cap).toBe(10000);
    expect(e.usage).toEqual({ handsStored: 10000, handsToday: 120, flopsToday: ["Ks7d2c"], dayResetsAt: "2026-10-27T00:00:00Z" });
    expect(e.limits).toEqual({ freeHandCap: 10000, dailyHandCap: 500, dailyFlopCap: 3 });
    expect(e.features.solver_unlimited).toBe(false);
    expect(e.features.nodelock).toBe(false);
    expect(e.features.desktop_sync).toBe(true);
    expect(parseEntitlements(PRO).subscription).toEqual(PRO.subscription);
    const half = { ...PRO.subscription, period: "half_year" };
    expect(parseEntitlements({ ...PRO, subscription: half }).subscription.period).toBe("half_year");
  });

  it("opens everything while enforcement is off, whatever the payload says", () => {
    const e = parseEntitlements({ ...OFF, features: features(false, 10000) });
    expect(e.enforced).toBe(false);
    expect(Object.values(e.features).filter((v) => v === false)).toEqual([]);
    expect(e.features.hand_cap).toBeNull();
  });

  it("reads a broken answer as the safe one", () => {
    const e = parseEntitlements(null);
    expect(e.enforced).toBe(false);
    expect(e.plan).toBe("pro");
    expect(isLocked(e, "analysis")).toBe(false);
  });
});

describe("locks and the cap", () => {
  it("locks only under enforcement, only what the plan lacks", () => {
    expect(isLocked(parseEntitlements(OFF), "analysis")).toBe(false);
    expect(isLocked(parseEntitlements(FREE), "analysis")).toBe(true);
    expect(isLocked(parseEntitlements(FREE), "desktop_sync")).toBe(false);
    expect(isLocked(parseEntitlements(FREE), "nodelock")).toBe(true);
    expect(isLocked(parseEntitlements(PRO), "analysis")).toBe(false);
    expect(isLocked(null, "learn")).toBe(false);
  });

  it("counts the hands left", () => {
    expect(handsLeft(parseEntitlements(OFF))).toBeNull();
    expect(handsLeft(parseEntitlements(PRO))).toBeNull();
    expect(handsLeft(parseEntitlements(FREE))).toBe(0);
    expect(handsLeft(parseEntitlements({ ...FREE, usage: { handsStored: 9000 } }))).toBe(1000);
  });

  it("counts today's room and the flops a day, on Free under enforcement only", () => {
    const free = parseEntitlements({ ...FREE, usage: { ...FREE.usage, handsStored: 9000 } });
    expect(handsLeftToday(free)).toBe(380);
    expect(saveRoom(free)).toEqual({ room: 380, by: "daily" });
    expect(saveRoom(parseEntitlements({ ...FREE, usage: { ...FREE.usage, handsStored: 9900 } }))).toEqual({ room: 100, by: "library" });
    expect(dailyFlopCap(free)).toBe(3);
    for (const other of [OFF, PRO]) {
      expect(handsLeftToday(parseEntitlements(other))).toBeNull();
      expect(saveRoom(parseEntitlements(other))).toBeNull();
      expect(dailyFlopCap(parseEntitlements(other))).toBeNull();
    }
  });

  it("recognises the database's refusal (PT402, HTTP 402)", () => {
    expect(isPlanRequiredError(new DatabaseRpcError("report_situations", "This is a Pro feature.", "PT402"))).toBe(true);
    expect(isPlanRequiredError(new DatabaseRpcError("report_open", "x", "42501"))).toBe(false);
    expect(isPlanRequiredError(new Error("PT402"))).toBe(false);
  });

  it("has the refusals in Croatian", () => {
    for (const sentence of [
      "This is a Pro feature. Upgrade to Pro to use it.",
      "Your library is full on the Free plan. Upgrade to Pro to keep saving hands.",
      "Syncing hands from the desktop app is a Pro feature. Upgrade to Pro to sync.",
    ]) {
      expect(localizeServerMessage(sentence, "hr")).not.toBe(sentence);
      expect(localizeServerMessage(sentence, "en")).toBe(sentence);
    }
  });
});

const render = (locale: "en" | "hr", node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale }, node));

describe("the Plan panel", () => {
  it("says early access while enforcement is off, and offers no upgrade", () => {
    const html = render("en", createElement(PlanDetails, { entitlements: parseEntitlements(OFF) }));
    expect(html).toContain("early access");
    expect(html).toContain("2,500 hands");
    expect(html).not.toContain("discount");
    expect(html).not.toContain("Upgrade to Pro");
    expect(html).toContain('href="/pricing"');
    expect(html).not.toContain("role=\"meter\"");
    expect(html).not.toContain("Today");
  });

  it("shows a Free account its usage against the cap, full, today's use, and the way to /pricing", () => {
    const html = render("en", createElement(PlanDetails, { entitlements: parseEntitlements(FREE) }));
    expect(html).toContain("Your plan: Free");
    expect(html).toContain("10,000 / 10,000 hands");
    expect(html).toContain("role=\"meter\"");
    expect(html).toContain("Your library is full");
    expect(html).toContain("120 / 500 hands · 1 / 3 flops");
    expect(html).toMatch(/<a[^>]*href="\/pricing"[^>]*>Upgrade to Pro<\/a>/);
    expect(html).not.toContain("early access");
  });

  it("turns the library meter yellow over 90 %", () => {
    const near = render("en", createElement(PlanDetails, { entitlements: parseEntitlements({ ...FREE, usage: { ...FREE.usage, handsStored: 9500 } }) }));
    const under = render("en", createElement(PlanDetails, { entitlements: parseEntitlements({ ...FREE, usage: { ...FREE.usage, handsStored: 5000 } }) }));
    expect(near).toMatch(/meterNear/);
    expect(under).not.toMatch(/meterNear/);
  });

  it("shows Pro its billing and renewal", () => {
    const html = render("en", createElement(PlanDetails, { entitlements: parseEntitlements(PRO) }));
    expect(html).toContain("Your plan: Pro");
    expect(html).toContain("Active · Billed yearly · Renews on 26 October 2027.");
    expect(html).not.toContain("Upgrade to Pro");
  });

  it("speaks Croatian", () => {
    const html = render("hr", createElement(PlanDetails, { entitlements: parseEntitlements(FREE) }));
    expect(html).toContain("Tvoj plan: Free");
    expect(html).toContain("Prijeđi na Pro");
    expect(html).not.toContain("Upgrade to Pro");
  });
});

describe("the lock", () => {
  it("is a teaser: the Pro badge, one line and See Pro to /pricing, in both languages", () => {
    const en = render("en", createElement(ProLock, { feature: "analysis" }));
    expect(en).toContain("Find your leaks from your own hands");
    expect(en).toContain(">Pro<");
    expect(en).toMatch(/<a[^>]*href="\/pricing"[^>]*>See Pro<\/a>/);
    expect(en).toContain('aria-hidden="true"');
    const hr = render("hr", createElement(ProLock, { feature: "reports_full" }));
    expect(hr).toContain("Pogledaj Pro");
    expect(hr).toContain("Svaka situacija");
  });
});
