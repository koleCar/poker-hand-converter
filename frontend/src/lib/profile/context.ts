/**
 * The signed-in account's own profile, and its hook.
 *
 * Split from `ProfileProvider.tsx` for the same reason `lib/auth/context.ts` is:
 * a module that exports a component *and* a hook loses fast refresh.
 */

"use client";

import { createContext, useContext } from "react";
import type { MyProfile } from "../db/profiles";

export type ProfileStatus =
  /** Signed out, or no database: there is no profile to have. */
  | "none"
  | "loading"
  | "ready"
  /** The database predates `20261007090000_forum_identity.sql`. */
  | "unavailable"
  | "error";

export interface ProfileContextValue {
  status: ProfileStatus;
  profile: MyProfile | null;
  /** Re-reads `my_profile()`, e.g. after a username change. */
  refresh: () => Promise<void>;
}

export const ProfileContext = createContext<ProfileContextValue | null>(null);

export function useMyProfile(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) {
    throw new Error("useMyProfile() must be used inside <ProfileProvider>.");
  }
  return value;
}
