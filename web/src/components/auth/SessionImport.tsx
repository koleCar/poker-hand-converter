"use client";

/**
 * Carries a pre-cutover session out of `localStorage` and into cookies. Once.
 *
 * ## DELETE ON OR AFTER 2026-11-28
 *
 * Sixty days from the cutover (2026-09-29). By then every session this can find
 * has expired on its own: a Supabase refresh token is good for 30 days of
 * inactivity on this project, so a token last touched before the cutover is
 * dead well inside the window, and anyone still active has long since been
 * migrated by this component on their first visit. Deleting it is: remove this
 * file, remove the one `<SessionImport />` from `app/layout.tsx`. Nothing else
 * references it.
 *
 * ## Why it has to exist
 *
 * #25 moved the session from `localStorage["sb-<ref>-auth-token"]`, where
 * `createClient({ persistSession: true })` put it, to cookies, where
 * `createBrowserClient` from `@supabase/ssr` puts it so the server can read it.
 * Nothing migrates between the two. Without this shim, **every signed-in user
 * is silently signed out by the deploy** — not logged out with a message, just
 * back to a sign-in dialog on a library they thought they had, which reads as
 * data loss even though no row moved.
 *
 * `setSession()` is the whole trick: hand it the refresh token out of the old
 * blob and the new client writes a fresh, correctly-shaped cookie session. It
 * is also the reason this is worth doing rather than just letting people sign
 * in again — a Google user has no password to fall back on.
 *
 * ## Failure is the normal case
 *
 * Almost every visitor has no old key, and that path must cost nothing and say
 * nothing. A malformed blob, a revoked refresh token, a browser with storage
 * blocked: all of them mean "no session to import", which is indistinguishable
 * from "signed out" and is exactly the state the app already renders. So
 * everything here is wrapped and silent, and the old key is removed either way
 * — a blob that failed once will fail every time, and leaving it there means
 * re-running this on every page load for two months.
 */

import { useEffect } from "react";
import { getBrowserSupabase } from "../../lib/supabase/browser";
import { SUPABASE_URL } from "../../lib/supabase/config";

/** `https://riybwcfnclphacnfawiq.supabase.co` → `sb-riybwcfnclphacnfawiq-auth-token`. */
function legacyKey(): string | null {
  const ref = SUPABASE_URL?.match(/^https?:\/\/([^.]+)\./)?.[1];
  return ref ? `sb-${ref}-auth-token` : null;
}

/**
 * supabase-js has written this value two ways: raw JSON, and `base64-<payload>`
 * since v2.40-ish. Both are in the wild in real browsers right now.
 */
function decode(raw: string): { refresh_token?: string; access_token?: string } | null {
  try {
    const json = raw.startsWith("base64-") ? atob(raw.slice("base64-".length)) : raw;
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export function SessionImport() {
  useEffect(() => {
    const key = legacyKey();
    const supabase = getBrowserSupabase();
    if (!key || !supabase) {
      return;
    }

    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
      // Removed before the async work, not after: `setSession()` triggers an
      // `onAuthStateChange` that re-renders the tree, and a second mount racing
      // the first on the same single-use refresh token would burn it.
      if (raw !== null) {
        localStorage.removeItem(key);
      }
    } catch {
      return; // Storage blocked. Nothing to import, nothing to clean up.
    }
    if (!raw) {
      return;
    }

    const stored = decode(raw);
    if (!stored?.refresh_token || !stored?.access_token) {
      return;
    }

    void supabase.auth
      .setSession({
        access_token: stored.access_token,
        refresh_token: stored.refresh_token,
      })
      .catch(() => {
        // Expired or revoked. They are signed out, which is what the UI already
        // shows; there is nothing useful to say about a token they never saw.
      });
  }, []);

  return null;
}
