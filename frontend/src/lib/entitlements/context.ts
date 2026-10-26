/**
 * The signed-in account's entitlements (Rail R6.2), and their hook.
 *
 * Split from `EntitlementsProvider.tsx` as `lib/profile/context.ts` is: a
 * module that exports a component *and* a hook loses fast refresh.
 */

"use client";

import { createContext, useContext } from "react";
import type { Entitlements, Feature } from "../db/entitlements";

export type EntitlementsStatus =
  /** Signed out, or no database: no plan to show and nothing locked. */
  | "none"
  | "loading"
  | "ready"
  /** The database predates `20270908090000_entitlements.sql`. */
  | "unavailable"
  | "error";

export interface EntitlementsContextValue {
  status: EntitlementsStatus;
  entitlements: Entitlements | null;
  /**
   * True when the database would refuse this feature to the account:
   * enforcement on and the plan without it. False while loading, signed
   * out, or on error - the server refuses on its own, and a lock shown in
   * error would hide a feature the account has.
   */
  locked: (feature: Feature) => boolean;
  /** Re-reads `my_entitlements()`, e.g. after saving hands. */
  refresh: () => Promise<void>;
}

const NOTHING_LOCKED: EntitlementsContextValue = {
  status: "none",
  entitlements: null,
  locked: () => false,
  refresh: async () => {},
};

export const EntitlementsContext = createContext<EntitlementsContextValue | null>(null);

/** Outside the provider (tests, isolated renders): nothing is locked. */
export function useEntitlements(): EntitlementsContextValue {
  return useContext(EntitlementsContext) ?? NOTHING_LOCKED;
}
