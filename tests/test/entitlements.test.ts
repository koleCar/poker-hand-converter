/**
 * Plans and entitlements on the web (Rail R6.2,
 * `frontend/src/lib/db/entitlements.ts`, `components/plan/`):
 *
 * - `my_entitlements()`'s JSON read field by field; while enforcement is off
 *   every feature is open whatever the payload says, and nothing is locked;
 * - a lock only when enforcement is on and the plan lacks the feature;
 * - hands left under the cap; the PT402 refusal recognised;
 * - the Plan panel and the lock in both languages: early access says so and
 *   offers no upgrade, a Free account under enforcement sees its usage
 *   against the cap and the (disabled) upgrade, Pro sees its renewal.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DatabaseRpcError } from "../../frontend/src/lib/db/client.js";
import {
  handsLeft,
  isLocked,
  isPlanRequiredError,
  parseEntitlements,
} from "../../frontend/src/lib/db/entitlements.js";
import { PlanDetails } from "../../frontend/src/components/plan/PlanPanel.js";
import { ProLock } from "../../frontend/src/components/plan/ProLock.js";
import { I18nProvider } from "../../frontend/src/lib/i18n/client.js";
import { localizeServerMessage } from "../../frontend/src/lib/i18n/serverErrors.js";

const features = (on: boolean, cap: number | null) => ({
  library_unlimited: cap === null,
  hand_cap: cap,
  desktop_sync: on,
  hud: on,
  reports_full: on,
  analysis: on,
  learn: on,
});

const base = {
  usage: { handsStored: 2500 },
  limits: { freeHandCap: 10000 },
  earlyUser: { is: true, since: "2026-10-01T00:00:00Z", discountPercent: 30 },
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
  usage: { handsStored: 10000 },
  features: features(false, 10000),
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
    expect(e.usage.handsStored).toBe(10000);
    expect(e.earlyUser).toEqual({ is: true, since: "2026-10-01T00:00:00Z", discountPercent: 30 });
    expect(parseEntitlements(PRO).subscription).toEqual(PRO.subscription);
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
    expect(isLocked(parseEntitlements(FREE), "desktop_sync")).toBe(true);
    expect(isLocked(parseEntitlements(PRO), "analysis")).toBe(false);
    expect(isLocked(null, "learn")).toBe(false);
  });

  it("counts the hands left", () => {
    expect(handsLeft(parseEntitlements(OFF))).toBeNull();
    expect(handsLeft(parseEntitlements(PRO))).toBeNull();
    expect(handsLeft(parseEntitlements(FREE))).toBe(0);
    expect(handsLeft(parseEntitlements({ ...FREE, usage: { handsStored: 9000 } }))).toBe(1000);
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
    expect(html).toContain("2,500 hands stored, no limit");
    expect(html).toContain("The Free plan holds 10,000 hands.");
    expect(html).toContain("30% lifetime discount");
    expect(html).not.toContain("Upgrade to Pro");
    expect(html).not.toContain("role=\"meter\"");
  });

  it("shows a Free account its usage against the cap, full, and the upgrade (disabled until R6.3)", () => {
    const html = render("en", createElement(PlanDetails, { entitlements: parseEntitlements(FREE) }));
    expect(html).toContain("Your plan: Free");
    expect(html).toContain("10,000 of 10,000 hands stored");
    expect(html).toContain("role=\"meter\"");
    expect(html).toContain("Your library is full.");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Upgrade to Pro<\/button>/);
    expect(html).not.toContain("early access");
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
  it("names the feature and links to the plan, in both languages", () => {
    const en = render("en", createElement(ProLock, { feature: "analysis" }));
    expect(en).toContain("This is a Pro feature");
    expect(en).toContain("Analysis");
    expect(en).toContain('href="/settings#plan"');
    const hr = render("hr", createElement(ProLock, { feature: "reports_full" }));
    expect(hr).toContain("Ovo je Pro značajka");
    expect(hr).toContain("Potpuni izvještaji");
  });
});
