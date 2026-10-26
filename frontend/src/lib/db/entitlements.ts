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
export type Feature = "desktop_sync" | "hud" | "reports_full" | "analysis" | "learn";

export const FEATURES: readonly Feature[] = ["desktop_sync", "hud", "reports_full", "analysis", "learn"];

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
  usage: { handsStored: number };
  /** What the Free plan holds, shown even while enforcement is off. */
  limits: { freeHandCap: number | null };
  /** What the account pays for (R6.3 writes it). */
  subscription: {
    plan: PlanName;
    period: "month" | "year" | null;
    status: "active" | "trialing" | "past_due" | "canceled" | null;
    currentPeriodEnd: string | null;
  };
  earlyUser: { is: boolean; since: string | null; discountPercent: number };
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

/** `my_entitlements()`'s JSON, checked field by field (an unknown value is the safe one). */
export function parseEntitlements(raw: unknown): Entitlements {
  const row = obj(raw);
  const features = obj(row.features);
  const subscription = obj(row.subscription);
  const early = obj(row.earlyUser);
  const plan: PlanName = row.plan === "free" ? "free" : "pro";
  const enforced = row.enforced === true;
  const feature = (name: Feature) => (enforced ? features[name] === true : true);
  const period = subscription.period === "month" || subscription.period === "year" ? subscription.period : null;
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
      library_unlimited: enforced ? features.library_unlimited === true : true,
      hand_cap: enforced ? num(features.hand_cap) : null,
    },
    usage: { handsStored: num(obj(row.usage).handsStored) ?? 0 },
    limits: { freeHandCap: num(obj(row.limits).freeHandCap) },
    subscription: {
      plan: subscription.plan === "pro" ? "pro" : "free",
      period,
      status,
      currentPeriodEnd: str(subscription.currentPeriodEnd),
    },
    earlyUser: {
      is: early.is === true,
      since: str(early.since),
      discountPercent: num(early.discountPercent) ?? 0,
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

/** The refusal of a Pro function or of the hand cap (`PT402`, HTTP 402). */
export function isPlanRequiredError(error: unknown): boolean {
  return error instanceof DatabaseRpcError && error.code === "PT402";
}
