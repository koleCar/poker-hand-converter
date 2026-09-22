/**
 * Supabase Auth, wrapped so the UI never sees a raw `AuthError`.
 *
 * Everything here returns plain data or throws an `Error` whose `message` is
 * already the sentence to show the user. Auth is the one place in the app where
 * the error text *is* the feature: "Email or password is not right" and
 * "An account with that email already exists" send a person down completely
 * different paths, and `invalid_credentials` sends them down neither.
 */

import type { Session, User } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "../supabase";

/** The slice of a Supabase user the app actually renders. */
export interface AuthUser {
  id: string;
  email: string | null;
  /** `full_name` / `name` from an OAuth provider, else the local part of the email. */
  displayName: string;
  avatarUrl: string | null;
}

export type SignUpOutcome =
  /** Auto-confirm is on (it is, on this project): the account is usable now. */
  | { kind: "signed-in" }
  /** Email confirmation is required; nothing happens until they click the link. */
  | { kind: "confirm-email"; email: string };

/**
 * Whether to offer the Google button.
 *
 * Defaults to on. The provider still has to be enabled in the Supabase
 * dashboard with a real client id and secret — until it is, pressing the button
 * produces the explanatory message in `describe()` below rather than a dead
 * end. Set `VITE_AUTH_GOOGLE="off"` to hide it entirely.
 */
export const isGoogleAuthOffered =
  isSupabaseConfigured && (import.meta.env.VITE_AUTH_GOOGLE as string | undefined) !== "off";

export const AUTH_UNAVAILABLE_MESSAGE =
  "Accounts need a database, and this build has none configured.";

function client() {
  if (!supabase) {
    throw new Error(AUTH_UNAVAILABLE_MESSAGE);
  }
  return supabase;
}

export function toAuthUser(user: User | null | undefined): AuthUser | null {
  if (!user) {
    return null;
  }
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name = typeof meta.full_name === "string" ? meta.full_name : typeof meta.name === "string" ? meta.name : "";
  const email = user.email ?? null;
  return {
    id: user.id,
    email,
    displayName: name.trim() || email?.split("@")[0] || "Signed in",
    avatarUrl: typeof meta.avatar_url === "string" ? meta.avatar_url : null,
  };
}

const GOOGLE_DISABLED_MESSAGE =
  "Google sign-in is not switched on for this project yet. Enable it under " +
  "Authentication → Providers in the Supabase dashboard, then try again. " +
  "Email and password work now.";

/** The shape both `AuthError` and `AuthApiError` satisfy. */
interface AuthFailure {
  code?: string;
  message: string;
  status?: number;
}

/**
 * Turns an auth failure into a sentence.
 *
 * Matches on `code` first and the message only as a fallback: the codes are
 * stable API surface, the messages are not.
 */
function describe(error: AuthFailure): string {
  switch (error.code) {
    case "invalid_credentials":
      return "That email and password do not match an account.";
    case "email_not_confirmed":
      return "Confirm your email address first — check your inbox for the link.";
    case "user_already_exists":
    case "email_exists":
      return "An account with that email already exists. Sign in instead.";
    case "weak_password":
      return "That password is too weak. Use at least six characters.";
    case "over_email_send_rate_limit":
      return "Too many emails were sent to that address. Wait a few minutes and try again.";
    case "over_request_rate_limit":
      return "Too many attempts. Wait a minute and try again.";
    case "signup_disabled":
      return "New accounts are disabled on this project.";
    case "validation_failed":
      return "That does not look like a valid email address.";
    case "provider_disabled":
      return GOOGLE_DISABLED_MESSAGE;
  }
  if (/unsupported provider|provider is not enabled/i.test(error.message)) {
    return GOOGLE_DISABLED_MESSAGE;
  }
  return error.message;
}

function fail(error: AuthFailure | null): void {
  if (error) {
    throw new Error(describe(error));
  }
}

export async function getSession(): Promise<Session | null> {
  if (!supabase) {
    return null;
  }
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await client().auth.signInWithPassword({ email: email.trim(), password });
  fail(error);
}

export async function signUpWithPassword(email: string, password: string): Promise<SignUpOutcome> {
  const trimmed = email.trim();
  const { data, error } = await client().auth.signUp({
    email: trimmed,
    password,
    options: { emailRedirectTo: redirectUrl() },
  });
  fail(error);
  // `session` is present when the project auto-confirms signups, absent when it
  // sends a confirmation mail. Both are normal; only the copy differs.
  return data.session ? { kind: "signed-in" } : { kind: "confirm-email", email: trimmed };
}

/**
 * Starts the Google redirect. This function does not return in the success
 * case — the browser navigates away — so callers must not put anything
 * important after the await.
 */
export async function signInWithGoogle(): Promise<void> {
  const { error } = await client().auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: redirectUrl() },
  });
  fail(error);
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await client().auth.resetPasswordForEmail(email.trim(), {
    redirectTo: redirectUrl(),
  });
  fail(error);
}

export async function signOut(): Promise<void> {
  const { error } = await client().auth.signOut();
  fail(error);
}

/**
 * Where a provider or an email link sends the browser back to.
 *
 * The current page, minus any query and hash: coming back to `/replay` after
 * signing in from `/replay` is the least surprising thing that can happen, and
 * dropping the query avoids re-triggering whatever state the user was in. Every
 * value this can produce has to be in the project's redirect allow list.
 */
function redirectUrl(): string {
  if (typeof window === "undefined") {
    return "https://poker-hand-converter.vercel.app";
  }
  return `${window.location.origin}${window.location.pathname}`;
}
