/**
 * Profiles and usernames — the client half of
 * `supabase/migrations/20261007090000_forum_identity.sql`.
 *
 * `profiles` has no client grants at all, not even SELECT on your own row
 * (a self-select policy would hand an account its own shadowban flag). So the
 * owner reads through `my_profile()` and writes through `set_username()`, and
 * everybody else reads `profiles_public` — server-side, in
 * `lib/server/profiles.ts`.
 */

import { rpc } from "./client";

export type ProfileRole = "member" | "moderator" | "admin";

export interface MyProfile {
  id: string;
  username: string;
  /** Still on the `user_xxxxxxxx` name handed out at signup. */
  provisional: boolean;
  usernameChangedAt: string | null;
  /** When the 30-day limit lifts. Null while the name is provisional. */
  nextUsernameChangeAt: string | null;
  role: ProfileRole;
  karma: number;
  /** `YYYY-MM-DD`, UTC. */
  joinedOn: string;
  bannedUntil: string | null;
  banReason: string | null;
  /**
   * Null when the account may post; otherwise the sentence the server will
   * raise if it tries. The UI shows it verbatim rather than re-deriving the
   * rules, so the form and the server cannot disagree.
   */
  postingBlockReason: string | null;
}

export interface UsernameChange {
  username: string;
  changedAt: string | null;
  nextChangeAt: string | null;
}

/** The caller's profile, or null when signed out. */
export async function fetchMyProfile(): Promise<MyProfile | null> {
  return rpc<MyProfile | null>("my_profile");
}

/**
 * Changes the caller's username.
 *
 * Every refusal — shape, reserved, taken, "once every 30 days" — comes back as
 * an error whose message is already the sentence to show. `rpc()` prefixes it
 * with the function name for logs; {@link usernameErrorMessage} strips that.
 */
export async function setUsername(username: string): Promise<UsernameChange> {
  return rpc<UsernameChange>("set_username", { p_username: username.trim() });
}

/** The user-facing part of a `set_username` failure. */
export function usernameErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^set_username:\s*/, "");
}

/**
 * The shape rule, mirrored from `profiles_username_shape` so the form can say
 * "too short" without a round trip. **The server is the authority** — it also
 * checks reservations, blocked terms and uniqueness, none of which belong in a
 * bundle — so this only ever answers the questions that are properties of the
 * string alone.
 */
export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_]{2,23}$/;
