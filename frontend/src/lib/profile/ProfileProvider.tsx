"use client";

/**
 * Loads the signed-in account's profile once, for every screen.
 *
 * Its own provider rather than more state on `AuthProvider`: the session is
 * GoTrue's and arrives from a cookie, the profile is ours and arrives from an
 * RPC, and they fail differently. A database without the identity migration
 * yet must leave sign-in working and just not show a username — so a profile
 * that cannot load is a status here, never an error that takes the session
 * down with it.
 *
 * Keyed on the user id, not on `isSignedIn`, so switching accounts in another
 * tab cannot leave the previous account's name in the bar.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "../auth";
import { fetchMyProfile, type MyProfile } from "../db/profiles";
import { isMissingSchemaError } from "../db/client";
import { ProfileContext, type ProfileContextValue, type ProfileStatus } from "./context";

interface Loaded {
  userId: string;
  status: ProfileStatus;
  profile: MyProfile | null;
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const userId = auth.isSignedIn ? (auth.user?.id ?? null) : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  // A promise, not state: the callbacks below are what set state, which keeps
  // the effect a subscription to an external answer rather than a setter.
  const load = useCallback(
    (id: string) =>
      fetchMyProfile().then(
        (profile) => setLoaded({ userId: id, status: profile ? "ready" : "error", profile }),
        (error: unknown) =>
          setLoaded({
            userId: id,
            status: isMissingSchemaError(error) ? "unavailable" : "error",
            profile: null,
          }),
      ),
    [],
  );

  useEffect(() => {
    if (!userId) {
      return;
    }
    let active = true;
    fetchMyProfile().then(
      (profile) => {
        if (active) setLoaded({ userId, status: profile ? "ready" : "error", profile });
      },
      (error: unknown) => {
        if (active) {
          setLoaded({
            userId,
            status: isMissingSchemaError(error) ? "unavailable" : "error",
            profile: null,
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [userId]);

  const refresh = useCallback(async () => {
    if (userId) {
      await load(userId);
    }
  }, [userId, load]);

  // Derived, so a stale answer for a previous account is never rendered: until
  // the current account's profile arrives, the status is "loading".
  const current = loaded && loaded.userId === userId ? loaded : null;
  const status: ProfileStatus = !userId ? "none" : current ? current.status : "loading";

  const value = useMemo<ProfileContextValue>(
    () => ({ status, profile: current?.profile ?? null, refresh }),
    [status, current, refresh],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}
