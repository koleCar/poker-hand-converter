/**
 * (R6.4) The plan as the app last worked it out (`entitlements_status`):
 * loaded at once, again whenever the app says it changed
 * (`entitlements-changed`, `account-changed`), and every minute for the
 * times it shows.
 *
 * `locked(feature)` is true only when the app would hold the feature back:
 * enforcement on and the effective plan without it. While loading, outside
 * the app, or with enforcement off (today) nothing is locked.
 */
import { useCallback, useEffect, useState } from "react";

import {
  errorText,
  inApp,
  ipc,
  onAccountChanged,
  onEntitlementsChanged,
  type EntitlementsStatus,
  type PlanFeature,
} from "./ipc";
import type { Route } from "./router";

const REFRESH_MS = 60_000;

/**
 * The screens that are a Pro feature: shown as a lock while the plan holds
 * them back (`App.tsx`). Reports keeps its basic statistics and locks only
 * its situation tabs (`Reports.tsx`); the HUD screen says so itself.
 */
export const ROUTE_FEATURE: Partial<Record<Route, PlanFeature>> = {
  analysis: "analysis",
  players: "reportsFull",
};

/** True when `status` holds `feature` back. */
export function isLocked(status: EntitlementsStatus | null | undefined, feature: PlanFeature): boolean {
  return status !== null && status !== undefined && status.effective.plan === "free" && !status.effective.features[feature];
}

export interface UseEntitlements {
  /** `null` while loading or outside the app. */
  status: EntitlementsStatus | null;
  error: string | null;
  locked: (feature: PlanFeature) => boolean;
  /** "Check again": the app asks the server now (the answer arrives as an event). */
  checkNow: () => void;
  /** "Upgrade": the web's Plan panel in the browser. */
  upgrade: () => void;
  /** "Sign in": the account's sign-in in the browser. */
  signIn: () => void;
  checking: boolean;
}

export function useEntitlements(): UseEntitlements {
  const [status, setStatus] = useState<EntitlementsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const reload = useCallback(() => {
    ipc
      .entitlementsStatus()
      .then((next) => {
        setStatus(next);
        setError(null);
        setChecking(false);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    if (!inApp) {
      return;
    }
    reload();
    const stopPlan = onEntitlementsChanged(reload);
    const stopAccount = onAccountChanged(reload);
    const timer = window.setInterval(reload, REFRESH_MS);
    return () => {
      stopPlan();
      stopAccount();
      window.clearInterval(timer);
    };
  }, [reload]);

  const checkNow = useCallback(() => {
    setChecking(true);
    ipc
      .entitlementsCheckNow()
      .then(() => window.setTimeout(reload, 15_000))
      .catch((e: unknown) => {
        setChecking(false);
        setError(errorText(e));
      });
  }, [reload]);

  const upgrade = useCallback(() => {
    ipc.entitlementsOpenUpgrade().catch((e: unknown) => setError(errorText(e)));
  }, []);

  const signIn = useCallback(() => {
    ipc.accountSignIn().catch((e: unknown) => setError(errorText(e)));
  }, []);

  const locked = useCallback((feature: PlanFeature) => isLocked(status, feature), [status]);

  return { status, error, locked, checkNow, upgrade, signIn, checking };
}
