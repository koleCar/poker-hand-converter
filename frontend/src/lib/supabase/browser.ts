"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isSupabaseConfigured,
  SUPABASE_ANON_KEY,
  SUPABASE_NOT_CONFIGURED_MESSAGE,
  SUPABASE_URL,
} from "./config";

/**
 * The browser client. One per tab, created on first use.
 *
 * ## What changed, and why every existing session breaks
 *
 * This used to be `createClient()` with `persistSession: true`, which put the
 * session in `localStorage` under `sb-<ref>-auth-token`. `createBrowserClient`
 * from `@supabase/ssr` puts it in **cookies** instead, so the server can read
 * it: an RSC, a Route Handler and a Server Action all see the same session the
 * browser does, which is the entire reason for the move.
 *
 * The cost is that no existing session survives the cutover — the token is in
 * the wrong storage. `components/auth/SessionImport.tsx` is the ~40-line shim
 * that carries one over, once, and then deletes itself.
 *
 * ## `detectSessionInUrl: false`
 *
 * Deliberate, and the other half of the move. The OAuth provider redirects back
 * with `?code=…`; that exchange now happens **server-side** in
 * `app/auth/callback/route.ts`, which is the only way the resulting session can
 * be written as an HTTP-only-ish cookie the server will see on the very next
 * request. Leaving this on would race the route handler for the same code — and
 * an authorization code is single-use, so one of the two would lose.
 *
 * ## `flowType: "pkce"`
 *
 * Unchanged, and still load-bearing: the authorization code never becomes a
 * session without the verifier held in this browser, so a redirect URL captured
 * from history or a referrer header is not a login.
 *
 * ## Memoised
 *
 * `createBrowserClient` is cheap but not free, and — more to the point — each
 * call creates its own `onAuthStateChange` broadcast channel and its own
 * refresh timer. Two clients in one tab means two refreshes racing for the same
 * refresh token, and a refresh token is single-use.
 */
let cached: SupabaseClient | null = null;

export function getBrowserSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) {
    return null;
  }
  if (!cached) {
    cached = createBrowserClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: {
        detectSessionInUrl: false,
        flowType: "pkce",
        autoRefreshToken: true,
        persistSession: true,
      },
    });
  }
  return cached;
}

/** Throws a readable error instead of dereferencing null. */
export function requireBrowserSupabase(): SupabaseClient {
  const client = getBrowserSupabase();
  if (!client) {
    throw new Error(SUPABASE_NOT_CONFIGURED_MESSAGE);
  }
  return client;
}

export { isSupabaseConfigured, SUPABASE_NOT_CONFIGURED_MESSAGE };
