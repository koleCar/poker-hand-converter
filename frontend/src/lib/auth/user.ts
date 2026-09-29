import type { User } from "@supabase/supabase-js";

/**
 * The slice of a Supabase user the app actually renders, and the one function
 * that produces it.
 *
 * Split out of `session.ts` because this is the one piece of the auth layer
 * that has to run on **both** sides: the root layout resolves a `User` with
 * `getServerUser()` and hands `AuthUser` down as `initialUser`, while the
 * browser derives the same shape from `onAuthStateChange`. `session.ts` imports
 * the browser client, which carries a `"use client"` boundary — a Server
 * Component that wanted `toAuthUser` from there would be reaching across it for
 * a pure function, which works today and stops working the first time somebody
 * adds a side effect to that module.
 *
 * Pure, and type-only on `@supabase/supabase-js`: nothing here runs a query,
 * reads a cookie or knows which side it is on.
 */
export interface AuthUser {
  id: string;
  email: string | null;
  /** `full_name` / `name` from an OAuth provider, else the local part of the email. */
  displayName: string;
  avatarUrl: string | null;
}

export function toAuthUser(user: User | null | undefined): AuthUser | null {
  if (!user) {
    return null;
  }
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    typeof meta.full_name === "string"
      ? meta.full_name
      : typeof meta.name === "string"
        ? meta.name
        : "";
  const email = user.email ?? null;
  return {
    id: user.id,
    email,
    displayName: name.trim() || email?.split("@")[0] || "Signed in",
    avatarUrl: typeof meta.avatar_url === "string" ? meta.avatar_url : null,
  };
}
