/**
 * Supabase Auth, wrapped so the UI never sees a raw `AuthError`.
 *
 * Everything here returns plain data or throws an `Error` whose `message` is
 * already the sentence to show the user. Auth is the one place in the app where
 * the error text *is* the feature: "Email or password is not right" and
 * "An account with that email already exists" send a person down completely
 * different paths, and `invalid_credentials` sends them down neither.
 */

import type { Session } from "@supabase/supabase-js";
import { isGoogleAuthOffered as googleOffered } from "../supabase/config";
import { getBrowserSupabase } from "../supabase/browser";
import { paths, SITE_URL } from "../routes";
import { safeNextPath } from "./nextPath";

export { toAuthUser, type AuthUser } from "./user";

export type SignUpOutcome =
  /** Auto-confirm is on (it is, on this project): the account is usable now. */
  | { kind: "signed-in" }
  /** Email confirmation is required; nothing happens until they click the link. */
  | { kind: "confirm-email"; email: string };

/**
 * Whether to offer the Google button. Reads `NEXT_PUBLIC_AUTH_GOOGLE`; the
 * reasoning lives on the definition in `lib/supabase/config.ts`.
 */
export const isGoogleAuthOffered = googleOffered;

export const AUTH_UNAVAILABLE_MESSAGE =
  "Accounts need a database, and this build has none configured.";

function client() {
  const instance = getBrowserSupabase();
  if (!instance) {
    throw new Error(AUTH_UNAVAILABLE_MESSAGE);
  }
  return instance;
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
    case "captcha_failed":
      return "The robot check did not go through. Complete it again and retry.";
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
  const instance = getBrowserSupabase();
  if (!instance) {
    return null;
  }
  const { data } = await instance.auth.getSession();
  return data.session;
}

/**
 * `captchaToken` is required by GoTrue once Attack Protection is on, and
 * ignored while it is off. See `components/auth/Turnstile.tsx`.
 */
export async function signInWithPassword(
  email: string,
  password: string,
  captchaToken?: string,
): Promise<void> {
  const { error } = await client().auth.signInWithPassword({
    email: email.trim(),
    password,
    options: captchaToken ? { captchaToken } : undefined,
  });
  fail(error);
}

export async function signUpWithPassword(
  email: string,
  password: string,
  captchaToken?: string,
): Promise<SignUpOutcome> {
  const trimmed = email.trim();
  const { data, error } = await client().auth.signUp({
    email: trimmed,
    password,
    options: { emailRedirectTo: redirectUrl(), ...(captchaToken ? { captchaToken } : {}) },
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

export async function sendPasswordReset(email: string, captchaToken?: string): Promise<void> {
  const { error } = await client().auth.resetPasswordForEmail(email.trim(), {
    redirectTo: redirectUrl(),
    ...(captchaToken ? { captchaToken } : {}),
  });
  fail(error);
}

/**
 * Sends the signup confirmation link again.
 *
 * Confirmation gates the first *post*, not sign-in (see `posting_block_reason`
 * in `20261007090000_forum_identity.sql`), so an account can be signed in and
 * still unconfirmed — and the original email is the thing most likely to have
 * been lost by then.
 */
export async function resendConfirmation(email: string, captchaToken?: string): Promise<void> {
  const { error } = await client().auth.resend({
    type: "signup",
    email: email.trim(),
    options: { emailRedirectTo: redirectUrl(), ...(captchaToken ? { captchaToken } : {}) },
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
 * ## One address instead of any address
 *
 * This used to be `${origin}${pathname}` — the page you were on. That meant the
 * function could produce *any* path on the origin, so the project's Supabase
 * redirect allow-list had to be a wildcard, and the code exchange happened
 * wherever the browser happened to land.
 *
 * Now there is exactly one landing address, `/auth/callback`, and the page you
 * were on travels as `?next=`, validated against a fixed list on arrival (see
 * `nextPath.ts`). Two things follow: the Supabase allow-list can name one exact
 * URL per environment, and the `?code=` exchange happens server-side in a Route
 * Handler, which is the only place that can write the session cookie.
 *
 * `SITE_URL` rather than `window.location.origin`, because this value has to
 * match an entry in the Supabase dashboard's allow-list exactly, and a preview
 * deployment's origin never will.
 *
 * **Before merging: add `<SITE_URL>/auth/callback` to Supabase →
 * Authentication → URL Configuration → Redirect URLs**, for every environment
 * that has to work. Today's list only covers `localhost:5173` / `:4173`, which
 * were the Vite ports; `next dev` serves on 3000.
 */
function redirectUrl(): string {
  const next =
    typeof window === "undefined" ? paths.home() : safeNextPath(window.location.pathname);
  return `${SITE_URL}/auth/callback?next=${encodeURIComponent(next)}`;
}
