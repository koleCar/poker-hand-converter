/**
 * (R6.4) The desktop app's plan in its window: the lock in place of a Pro
 * feature in English and Croatian for every reason the Rust side gives
 * (`rail_sync::entitlements`, tested there in every state), what each lock
 * offers (sign in, check again, upgrade), Settings' plan badge, the HUD's
 * `locked` phase, the analysis waiting for the plan, sync held by it - and
 * that **nothing is locked while enforcement is off**, today's state.
 * (Free tier) The lock's new look (Pro badge, one line, "See Pro"), sync's
 * day cap and full library, the library meter and today's use in Settings,
 * and that Free keeps sync.
 */
import "./support/appWindow";

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RunnerStatus } from "../../app/src/analysis/runner";
import { ProLockView } from "../../app/src/components/ProLock";
import { en } from "../../app/src/i18n/en";
import { hr } from "../../app/src/i18n/hr";
import { DictProvider } from "../../app/src/i18n/index";
import { hudState } from "../../app/src/lib/hudCompliance";
import type { EffectivePlan, EntitlementsStatus, HudStatus, PlanFeature, SyncStatus } from "../../app/src/lib/ipc";
import { ROUTE_FEATURE, ROUTE_LINE, flopsCounted, isLocked } from "../../app/src/lib/useEntitlements";
import { describeStatus } from "../../app/src/screens/analysis/status";
import { SyncRowView, UsageRowsView, planBadge } from "../../app/src/screens/settings/Account";

const ALL = {
  desktopSync: true,
  hud: true,
  reportsFull: true,
  analysis: true,
  learn: true,
  solverUnlimited: true,
  nodelock: true,
};
const NONE = {
  desktopSync: false,
  hud: false,
  reportsFull: false,
  analysis: false,
  learn: false,
  solverUnlimited: false,
  nodelock: false,
};
/** What Free includes (and every Free fallback): sync. */
const FREE_FEATURES = { ...NONE, desktopSync: true };
const DAY = 24 * 60 * 60 * 1000;
const AT = Date.UTC(2027, 0, 15, 12, 0, 0);

function status(effective: Partial<EffectivePlan>, extra: Partial<EntitlementsStatus> = {}): EntitlementsStatus {
  return {
    effective: {
      plan: "free",
      reason: "free",
      enforcement: "on",
      features: FREE_FEATURES,
      proUntilMs: null,
      checkedAtMs: null,
      ...effective,
    },
    check: { attemptedAtMs: AT, succeededAtMs: AT, failing: false },
    handsStored: null,
    handCap: null,
    serverReason: null,
    offlineGraceDays: 14,
    dailyHandCap: null,
    handsToday: null,
    dailyFlopCap: null,
    flopsToday: [],
    dayResetsAtMs: null,
    upgradeUrl: "https://example.invalid/pricing?from=app",
    ...extra,
  };
}

const OPEN_UNKNOWN = status({ plan: "open", reason: "enforcementUnknown", enforcement: "unknown", features: ALL });
const OPEN_OFF = status({ plan: "open", reason: "notEnforced", enforcement: "off", features: ALL });
const PRO = status({ plan: "pro", reason: "pro", features: ALL, proUntilMs: AT + 14 * DAY, checkedAtMs: AT });
const FREE = status({ plan: "free", reason: "free" }, { handsStored: 1234, handCap: 10000 });
const SIGNED_OUT = status({ plan: "free", reason: "signedOut" });
const NOT_CHECKED = status({ plan: "free", reason: "notChecked" });
const EXPIRED = status({ plan: "free", reason: "graceExpired", checkedAtMs: AT - 15 * DAY });

/** The features Free lacks. */
const FEATURES: PlanFeature[] = ["hud", "analysis", "reportsFull", "learn", "solverUnlimited", "nodelock"];

function render(locale: "en" | "hr", element: ReactElement): string {
  return renderToStaticMarkup(createElement(DictProvider, { locale }, element));
}

function lock(locale: "en" | "hr", feature: PlanFeature, plan: EntitlementsStatus): string {
  const noop = () => undefined;
  return render(locale, createElement(ProLockView, { feature, status: plan, onSignIn: noop, onUpgrade: noop, onCheck: noop }));
}

describe("what is locked", () => {
  it("nothing while enforcement is off or unknown, or on Pro (today's behaviour)", () => {
    for (const plan of [OPEN_UNKNOWN, OPEN_OFF, PRO, null, undefined]) {
      for (const feature of FEATURES) expect(isLocked(plan, feature), `${plan?.effective.reason} ${feature}`).toBe(false);
    }
  });

  it("every Pro feature on Free, signed out, unchecked or past the grace period - never sync", () => {
    for (const plan of [FREE, SIGNED_OUT, NOT_CHECKED, EXPIRED]) {
      for (const feature of FEATURES) expect(isLocked(plan, feature)).toBe(true);
      expect(isLocked(plan, "desktopSync"), "sync is free").toBe(false);
      expect(flopsCounted(plan), "the solver's flops are counted").toBe(true);
    }
    for (const plan of [OPEN_UNKNOWN, OPEN_OFF, PRO, null]) expect(flopsCounted(plan)).toBe(false);
    // A feature the server grants Free (plan_limits are data) stays open.
    const learnFree = status({ plan: "free", reason: "free", features: { ...NONE, learn: true } });
    expect(isLocked(learnFree, "learn")).toBe(false);
    expect(isLocked(learnFree, "hud")).toBe(true);
  });

  it("the screens that are Pro: Analysis, the Trainer and Players (Reports locks only its situation tabs)", () => {
    expect(ROUTE_FEATURE).toEqual({ analysis: "analysis", trainer: "analysis", players: "reportsFull" });
    expect(ROUTE_FEATURE.reports).toBeUndefined();
    expect(ROUTE_FEATURE.hands).toBeUndefined();
    expect(ROUTE_FEATURE.live).toBeUndefined();
    expect(ROUTE_FEATURE.solver, "the solver counts flops, it is not locked").toBeUndefined();
    expect(ROUTE_FEATURE.tables, "table tiling and the RNG are never gated").toBeUndefined();
    expect(ROUTE_LINE).toEqual({ trainer: "trainer", players: "players" });
  });
});

describe("the lock, in both languages", () => {
  for (const [locale, dict] of [
    ["en", en],
    ["hr", hr],
  ] as const) {
    const p = dict.plan;
    it(`a Pro badge, one line and See Pro; why and the way out only when it is more than Free, ${locale}`, () => {
      for (const feature of FEATURES) {
        const html = lock(locale, feature, FREE);
        expect(html).toContain(`>${p.pro}<`);
        expect(html).toContain(p.features[feature]);
        expect(html).toContain(`>${p.upgrade}<`);
        expect(html).not.toContain(p.reasons.free);
        expect(html).not.toContain(`>${p.signIn}<`);
        expect(html).not.toContain(p.checkAgain);
        expect(html).toContain('aria-hidden="true"');
      }
      const signedOut = lock(locale, "hud", SIGNED_OUT);
      expect(signedOut).toContain(p.reasons.signedOut);
      expect(signedOut).toContain(`>${p.signIn}<`);
      expect(signedOut).toContain(`>${p.upgrade}<`);
      const unchecked = lock(locale, "analysis", NOT_CHECKED);
      expect(unchecked).toContain(p.reasons.notChecked);
      expect(unchecked).toContain(p.checkAgain);
      const expired = lock(locale, "reportsFull", EXPIRED);
      expect(expired).toContain(p.reasons.graceExpired(14));
      expect(expired).toContain(p.checkAgain);
      expect(expired).not.toContain(`>${p.signIn}<`);
      // A screen with its own line.
      const noop = () => undefined;
      const trainer = render(
        locale,
        createElement(ProLockView, {
          feature: "analysis",
          status: FREE,
          onSignIn: noop,
          onUpgrade: noop,
          onCheck: noop,
          line: p.screens.trainer,
        }),
      );
      expect(trainer).toContain(p.screens.trainer);
      expect(trainer).not.toContain(p.features.analysis);
    });

    it(`Settings' plan badge: coloured by what can be used now, with its one action, ${locale}`, () => {
      const when = (ms: number) => new Date(ms).toISOString();
      const b = p.badge;
      const badge = (plan: EntitlementsStatus) => planBadge(plan, b, when);
      expect(badge(OPEN_OFF)).toEqual({ tone: "blue", icon: "check", label: b.open, action: null });
      expect(badge(OPEN_UNKNOWN)).toEqual({ tone: "blue", icon: "check", label: b.open, action: null });
      // Pro always holds offline until a date; it says so only while the check fails.
      expect(badge(PRO)).toEqual({ tone: "gold", icon: "star", label: b.pro, action: null });
      const proOffline = { ...PRO, check: { ...PRO.check, failing: true } };
      expect(badge(proOffline)).toEqual({
        tone: "yellow",
        icon: "cloudOff",
        label: b.proOffline(when(AT + 14 * DAY)),
        action: "checkAgain",
      });
      expect(badge(FREE)).toEqual({ tone: "grey", icon: "minus", label: b.free, action: "upgrade" });
      expect(badge(EXPIRED)).toEqual({ tone: "red", icon: "lock", label: b.reconnect, action: "checkAgain" });
      expect(badge(SIGNED_OUT)).toEqual({ tone: "dashed", icon: null, label: b.none, action: "signIn" });
      expect(badge(NOT_CHECKED)).toEqual({ tone: "dashed", icon: null, label: b.none, action: "checkAgain" });
      const unknown = status({ plan: "free", reason: "enforcementUnknown" });
      expect(badge(unknown)).toEqual({ tone: "dashed", icon: null, label: b.none, action: null });
    });
  }
});

describe("the HUD, the analysis and sync, held by the plan", () => {
  it("the HUD's `locked` phase", () => {
    expect(hudState({ phase: "locked" } as HudStatus)).toBe("locked");
    expect(hudState({ phase: "running" } as HudStatus)).toBe("running");
    expect(hudState({ phase: "not-installed" } as HudStatus)).toBe("off");
  });

  it("the analysis waits for the plan, in both languages", () => {
    const waiting: RunnerStatus = {
      phase: "waiting",
      reason: "plan",
      paused: false,
      counts: null,
      analysed: 0,
      failed: 0,
      handsPerSecond: null,
      library: true,
      lastError: null,
      version: "analysis/35",
    };
    expect(describeStatus(waiting, en.analysis.status)[0]?.text).toBe(en.analysis.status.waiting.plan);
    expect(describeStatus(waiting, hr.analysis.status)[0]?.text).toBe(hr.analysis.status.waiting.plan);
  });

  it("sync held by the plan says so and offers See Pro, in both languages", () => {
    const sync: SyncStatus = {
      phase: { state: "planRequired", feature: "desktop_sync" },
      paused: false,
      outbox: 3,
      live: 0,
      retrying: 0,
      sent: 0,
      total: 3,
      rejected: [],
      pulled: 0,
      pullSkipped: 0,
      lastSyncAt: null,
      handsPerSecond: null,
      bytesPerSecond: null,
      cap: null,
      capNow: null,
      tablesOpen: false,
    };
    for (const [locale, dict] of [
      ["en", en],
      ["hr", hr],
    ] as const) {
      const html = render(locale, createElement(SyncRowView, { sync, error: null, busy: false, run: async () => undefined }));
      expect(html).toContain(dict.sync.short.planRequired);
      expect(html).toContain(dict.plan.upgrade);
      // (Free tier) The day's cap: one quiet line with the reset's time, and See Pro.
      const resetsAtMs = Date.UTC(2027, 0, 16, 0, 0, 0);
      const daily = render(
        locale,
        createElement(SyncRowView, {
          sync: { ...sync, phase: { state: "dailyCap", cap: 500, resetsAtMs } },
          error: null,
          busy: false,
          run: async () => undefined,
        }),
      );
      // The line up to the time (its format is the app's clock).
      expect(daily).toContain(dict.sync.short.dailyCap(500, "\u0000").split("\u0000")[0]);
      expect(daily).toContain(`>${dict.plan.upgrade}<`);
      // The web library is full.
      const full = render(
        locale,
        createElement(SyncRowView, {
          sync: { ...sync, phase: { state: "libraryFull", cap: 10000 } },
          error: null,
          busy: false,
          run: async () => undefined,
        }),
      );
      expect(full).toContain(dict.sync.short.libraryFull(10000));
      expect(full).toContain(`>${dict.plan.upgrade}<`);
    }
    expect(en.sync.short.dailyCap(500, "01:00")).toBe("500 hands synced today — the rest syncs after 01:00, or now with Pro");
    expect(en.sync.short.libraryFull(10000)).toBe("Your web library is full (10,000)");
  });

  it("Settings on Free: the library meter (yellow over 90 %) and today's use; nothing on Pro or while open", () => {
    const usage = (plan: EntitlementsStatus) => render("en", createElement(UsageRowsView, { status: plan }));
    const s = en.plan.settings;
    const free = status(
      { plan: "free", reason: "free" },
      {
        handsStored: 9412,
        handCap: 10000,
        dailyHandCap: 500,
        handsToday: 120,
        dailyFlopCap: 3,
        flopsToday: ["Ks7d2c", "QhJh4s"],
        dayResetsAtMs: AT + DAY / 2,
      },
    );
    const html = usage(free);
    expect(html).toContain(s.libraryCount(9412, 10000));
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="9412"');
    expect(html).toMatch(/meterFull/);
    expect(html).toContain(s.handsToday(120, 500));
    expect(html).toContain(s.flopsToday(2, 3));
    expect(usage({ ...free, handsStored: 4000 })).not.toMatch(/meterFull/);
    for (const plan of [PRO, OPEN_OFF, OPEN_UNKNOWN]) expect(usage(plan)).toBe("");
  });

  it("Settings' sync row: one status, one action, the bar while syncing, the refusals as a pill", () => {
    const base: SyncStatus = {
      phase: { state: "syncing" },
      paused: false,
      outbox: 2800,
      live: 0,
      retrying: 0,
      sent: 1200,
      total: 4000,
      rejected: [],
      pulled: 0,
      pullSkipped: 0,
      lastSyncAt: null,
      handsPerSecond: null,
      bytesPerSecond: null,
      cap: null,
      capNow: null,
      tablesOpen: false,
    };
    const row = (sync: SyncStatus) =>
      render("en", createElement(SyncRowView, { sync, error: null, busy: false, run: async () => undefined }));
    const s = en.sync.short;
    const syncing = row(base);
    expect(syncing).toContain(s.syncing(1200, 4000));
    expect(syncing).toContain('role="progressbar"');
    expect(syncing).toContain('aria-valuenow="30"');
    expect(syncing).toContain(`>${s.pause}<`);
    const refused = row({ ...base, phase: { state: "upToDate" }, rejected: [{ reason: "shape", count: 3 }] });
    expect(refused).toContain(s.refused(3));
    expect(refused).toContain(`>${en.sync.tryAgain}<`);
    expect(refused).not.toContain(`>${s.pause}<`);
    expect(refused).not.toContain('role="progressbar"');
    const mismatch = row({
      ...base,
      phase: { state: "accountMismatch", ownerEmail: "a@example.invalid", email: "b@example.invalid", localHands: 9 },
    });
    expect(mismatch).toContain(s.mismatch("a@example.invalid"));
    expect(mismatch).toContain(`>${s.upload}<`);
    expect(mismatch).toContain(`>${s.keepApart}<`);
    expect(row({ ...base, phase: { state: "paused" }, paused: true })).toContain(`>${s.resume}<`);
  });
});
