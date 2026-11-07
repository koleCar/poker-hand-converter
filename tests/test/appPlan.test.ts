/**
 * (R6.4) The desktop app's plan in its window: the lock in place of a Pro
 * feature in English and Croatian for every reason the Rust side gives
 * (`rail_sync::entitlements`, tested there in every state), what each lock
 * offers (sign in, check again, upgrade), Settings' plan badge, the HUD's
 * `locked` phase, the analysis waiting for the plan, sync held by it - and
 * that **nothing is locked while enforcement is off**, today's state.
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
import { ROUTE_FEATURE, isLocked } from "../../app/src/lib/useEntitlements";
import { describeStatus } from "../../app/src/screens/analysis/status";
import { SyncRowView, planBadge } from "../../app/src/screens/settings/Account";

const ALL = { desktopSync: true, hud: true, reportsFull: true, analysis: true, learn: true };
const NONE = { desktopSync: false, hud: false, reportsFull: false, analysis: false, learn: false };
const DAY = 24 * 60 * 60 * 1000;
const AT = Date.UTC(2027, 0, 15, 12, 0, 0);

function status(effective: Partial<EffectivePlan>, extra: Partial<EntitlementsStatus> = {}): EntitlementsStatus {
  return {
    effective: {
      plan: "free",
      reason: "free",
      enforcement: "on",
      features: NONE,
      proUntilMs: null,
      checkedAtMs: null,
      ...effective,
    },
    check: { attemptedAtMs: AT, succeededAtMs: AT, failing: false },
    handsStored: null,
    handCap: null,
    serverReason: null,
    offlineGraceDays: 14,
    upgradeUrl: "https://example.invalid/settings#plan",
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

const FEATURES: PlanFeature[] = ["hud", "analysis", "reportsFull", "desktopSync", "learn"];

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

  it("every Pro feature on Free, signed out, unchecked or past the grace period", () => {
    for (const plan of [FREE, SIGNED_OUT, NOT_CHECKED, EXPIRED]) {
      for (const feature of FEATURES) expect(isLocked(plan, feature)).toBe(true);
    }
    // A feature the server grants Free (plan_limits are data) stays open.
    const learnFree = status({ plan: "free", reason: "free", features: { ...NONE, learn: true } });
    expect(isLocked(learnFree, "learn")).toBe(false);
    expect(isLocked(learnFree, "hud")).toBe(true);
  });

  it("the screens that are Pro: Analysis and Players (Reports locks only its situation tabs)", () => {
    expect(ROUTE_FEATURE).toEqual({ analysis: "analysis", players: "reportsFull" });
    expect(ROUTE_FEATURE.reports).toBeUndefined();
    expect(ROUTE_FEATURE.hands).toBeUndefined();
    expect(ROUTE_FEATURE.live).toBeUndefined();
  });
});

describe("the lock, in both languages", () => {
  for (const [locale, dict] of [
    ["en", en],
    ["hr", hr],
  ] as const) {
    const p = dict.plan;
    it(`says what and why, and offers the way out, ${locale}`, () => {
      for (const feature of FEATURES) {
        const html = lock(locale, feature, FREE);
        expect(html).toContain(p.heading);
        expect(html).toContain(p.features[feature]);
        expect(html).toContain(p.reasons.free);
        expect(html).toContain(p.upgrade);
        expect(html).not.toContain(p.signIn);
        expect(html).not.toContain(p.checkAgain);
      }
      const signedOut = lock(locale, "hud", SIGNED_OUT);
      expect(signedOut).toContain(p.reasons.signedOut);
      expect(signedOut).toContain(`>${p.signIn}<`);
      expect(signedOut).toContain(p.upgrade);
      const unchecked = lock(locale, "analysis", NOT_CHECKED);
      expect(unchecked).toContain(p.reasons.notChecked);
      expect(unchecked).toContain(p.checkAgain);
      const expired = lock(locale, "reportsFull", EXPIRED);
      expect(expired).toContain(p.reasons.graceExpired(14));
      expect(expired).toContain(p.checkAgain);
      expect(expired).not.toContain(`>${p.signIn}<`);
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

  it("sync held by the plan says so and offers the upgrade, in both languages", () => {
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
    }
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
