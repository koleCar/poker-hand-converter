/**
 * The account's plan and what it may use — the client half of
 * `supabase/migrations/20270908090000_entitlements.sql` (Rail R6.2).
 *
 * The database is the truth: every Pro function refuses a Free account with
 * SQLSTATE `PT402` (HTTP 402) once the owner turns enforcement on, whatever
 * the UI shows. This module only reads `my_entitlements()` so the UI can say
 * so first (a lock instead of an error), and recognises the refusal.
 *
 * While enforcement is off (until paid plans launch) every account's
 * effective plan is Pro, `enforced` is false, and nothing is locked.
 */

import { DatabaseRpcError, rpc } from "./client";

/** The features a plan grants (`plan_limits.features`, plus the cap). */
export type Feature = "desktop_sync" | "hud" | "reports_full" | "analysis" | "learn" | "solver_unlimited" | "nodelock";

export const FEATURES: readonly Feature[] = [
  "desktop_sync",
  "hud",
  "reports_full",
  "analysis",
  "learn",
  "solver_unlimited",
  "nodelock",
];

/** How often Pro is billed (`billing-checkout`, Stripe's prices). */
export type BillingPeriod = "month" | "half_year" | "year";

export type PlanName = "free" | "pro";

export type PlanReason =
  | "not_enforced"
  | "subscription"
  | "grace"
  | "granted"
  | "canceled_until_period_end"
  | "free"
  | "expired";

export interface Entitlements {
  /** The plan in effect now. */
  plan: PlanName;
  reason: PlanReason;
  /** False until the owner launches paid plans: everything is open. */
  enforced: boolean;
  features: Record<Feature, boolean> & {
    library_unlimited: boolean;
    /** Stored hands the plan holds; null = unlimited. */
    hand_cap: number | null;
  };
  usage: {
    handsStored: number;
    /** Hands saved today (UTC day): web upload and desktop sync together. */
    handsToday: number;
    /** Today's opened flops (canonical keys, `Ks7d2c`). */
    flopsToday: string[];
    /** The next 00:00 UTC, when the daily counts start again. */
    dayResetsAt: string | null;
  };
  /**
   * What the Free plan holds, shown even while enforcement is off; the
   * daily caps are null when the plan has none (Pro).
   */
  limits: { freeHandCap: number | null; dailyHandCap: number | null; dailyFlopCap: number | null };
  /** What the account pays for (R6.3 writes it). */
  subscription: {
    plan: PlanName;
    period: BillingPeriod | null;
    status: "active" | "trialing" | "past_due" | "canceled" | null;
    currentPeriodEnd: string | null;
  };
  /** The plan holds at least until then (null: no end known). */
  validUntil: string | null;
  /** Set while Pro is kept by the payment grace period. */
  graceUntil: string | null;
  offlineGraceDays: number;
  checkedAt: string;
}

type Row = Record<string, unknown>;

const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
/** A flop key as the server writes it: three cards, `Ks7d2c`. */
const FLOP_KEY = /^([2-9TJQKA][shdc]){3}$/;

/** `my_entitlements()`'s JSON, checked field by field (an unknown value is the safe one). */
export function parseEntitlements(raw: unknown): Entitlements {
  const row = obj(raw);
  const features = obj(row.features);
  const subscription = obj(row.subscription);
  const plan: PlanName = row.plan === "free" ? "free" : "pro";
  const enforced = row.enforced === true;
  const feature = (name: Feature) => (enforced ? features[name] === true : true);
  const period =
    subscription.period === "month" || subscription.period === "half_year" || subscription.period === "year"
      ? subscription.period
      : null;
  const usage = obj(row.usage);
  const limits = obj(row.limits);
  const status =
    subscription.status === "active" ||
    subscription.status === "trialing" ||
    subscription.status === "past_due" ||
    subscription.status === "canceled"
      ? subscription.status
      : null;
  return {
    plan,
    reason: (str(row.reason) ?? (enforced ? plan : "not_enforced")) as PlanReason,
    enforced,
    features: {
      desktop_sync: feature("desktop_sync"),
      hud: feature("hud"),
      reports_full: feature("reports_full"),
      analysis: feature("analysis"),
      learn: feature("learn"),
      solver_unlimited: feature("solver_unlimited"),
      nodelock: feature("nodelock"),
      library_unlimited: enforced ? features.library_unlimited === true : true,
      hand_cap: enforced ? num(features.hand_cap) : null,
    },
    usage: {
      handsStored: num(usage.handsStored) ?? 0,
      handsToday: num(usage.handsToday) ?? 0,
      flopsToday: Array.isArray(usage.flopsToday)
        ? usage.flopsToday.filter((f): f is string => typeof f === "string" && FLOP_KEY.test(f))
        : [],
      dayResetsAt: str(usage.dayResetsAt),
    },
    limits: {
      freeHandCap: num(limits.freeHandCap),
      dailyHandCap: num(limits.dailyHandCap),
      dailyFlopCap: num(limits.dailyFlopCap),
    },
    subscription: {
      plan: subscription.plan === "pro" ? "pro" : "free",
      period,
      status,
      currentPeriodEnd: str(subscription.currentPeriodEnd),
    },
    validUntil: str(row.validUntil),
    graceUntil: str(row.graceUntil),
    offlineGraceDays: num(row.offlineGraceDays) ?? 0,
    checkedAt: str(row.checkedAt) ?? new Date().toISOString(),
  };
}

/** The caller's entitlements (signed in only). */
export async function fetchMyEntitlements(): Promise<Entitlements> {
  return parseEntitlements(await rpc<unknown>("my_entitlements"));
}

/** True when a feature is shut for this account: enforcement on and the plan without it. */
export function isLocked(entitlements: Entitlements | null, feature: Feature): boolean {
  return entitlements !== null && entitlements.enforced && !entitlements.features[feature];
}

/** Hands the account may still store, or null for no limit. */
export function handsLeft(entitlements: Entitlements | null): number | null {
  if (!entitlements || !entitlements.enforced || entitlements.features.hand_cap === null) {
    return null;
  }
  return Math.max(0, entitlements.features.hand_cap - entitlements.usage.handsStored);
}

/** True for a Free account under enforcement: what the Free-tier display is for. */
export function isFreeEnforced(entitlements: Entitlements | null): boolean {
  return entitlements !== null && entitlements.enforced && entitlements.plan === "free";
}

/** The plan's hands-per-day cap under enforcement, or null (Pro, or enforcement off). */
export function dailyHandCap(entitlements: Entitlements | null): number | null {
  return isFreeEnforced(entitlements) ? (entitlements?.limits.dailyHandCap ?? null) : null;
}

/** Hands the account may still save today, or null for no limit. */
export function handsLeftToday(entitlements: Entitlements | null): number | null {
  const cap = dailyHandCap(entitlements);
  return cap === null || !entitlements ? null : Math.max(0, cap - entitlements.usage.handsToday);
}

/**
 * Hands one save may still add: the smaller of what fits in the library and
 * what fits today, or null for no limit. The server stays the gate (PT402);
 * this only keeps a save from asking for more than fits.
 */
export function saveRoom(entitlements: Entitlements | null): { room: number; by: "library" | "daily" } | null {
  const library = handsLeft(entitlements);
  const today = handsLeftToday(entitlements);
  if (library === null && today === null) return null;
  if (today !== null && (library === null || today < library)) return { room: today, by: "daily" };
  return { room: library ?? 0, by: "library" };
}

/** The plan's flops-per-day cap under enforcement, or null (no limit). */
export function dailyFlopCap(entitlements: Entitlements | null): number | null {
  if (!isFreeEnforced(entitlements) || !entitlements || entitlements.features.solver_unlimited) return null;
  return entitlements.limits.dailyFlopCap;
}

/** The refusal of a Pro function or of the hand cap (`PT402`, HTTP 402). */
export function isPlanRequiredError(error: unknown): boolean {
  return error instanceof DatabaseRpcError && error.code === "PT402";
}
