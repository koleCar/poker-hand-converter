"use client";

/**
 * Loads the signed-in account's entitlements once, for every screen (R6.2).
 *
 * The same shape as `ProfileProvider`: keyed on the user id so another
 * account's plan is never shown, and a database without the migration is a
 * status (`unavailable`), never an error that takes the screen down. What it
 * answers only decides what the UI shows first; the database refuses a Pro
 * function to a Free account on its own (`PT402`).
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "../auth";
import { isDatabaseConfigured, isMissingSchemaError } from "../db/client";
import { fetchMyEntitlements, isLocked, type Entitlements, type Feature } from "../db/entitlements";
import { EntitlementsContext, type EntitlementsContextValue, type EntitlementsStatus } from "./context";

interface Loaded {
  userId: string;
  status: EntitlementsStatus;
  entitlements: Entitlements | null;
}

function failed(userId: string, error: unknown): Loaded {
  return { userId, status: isMissingSchemaError(error) ? "unavailable" : "error", entitlements: null };
}

export function EntitlementsProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const userId = isDatabaseConfigured && auth.isSignedIn ? (auth.user?.id ?? null) : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!userId) {
      return;
    }
    let active = true;
    fetchMyEntitlements().then(
      (entitlements) => {
        if (active) setLoaded({ userId, status: "ready", entitlements });
      },
      (error: unknown) => {
        if (active) setLoaded(failed(userId, error));
      },
    );
    return () => {
      active = false;
    };
  }, [userId]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    await fetchMyEntitlements().then(
      (entitlements) => setLoaded({ userId, status: "ready", entitlements }),
      (error: unknown) => setLoaded(failed(userId, error)),
    );
  }, [userId]);

  // Derived, so a previous account's answer is never rendered.
  const current = loaded && loaded.userId === userId ? loaded : null;
  const status: EntitlementsStatus = !userId ? "none" : current ? current.status : "loading";
  const entitlements = current?.entitlements ?? null;

  const value = useMemo<EntitlementsContextValue>(
    () => ({
      status,
      entitlements,
      locked: (feature: Feature) => isLocked(entitlements, feature),
      refresh,
    }),
    [status, entitlements, refresh],
  );

  return <EntitlementsContext.Provider value={value}>{children}</EntitlementsContext.Provider>;
}
