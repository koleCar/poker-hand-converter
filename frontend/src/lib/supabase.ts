import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * True when both Supabase env vars are present at build time.
 *
 * The converter is a pure client-side function, so the app is fully usable
 * without a database: you can still convert files and download the output. Only
 * the stored-hand browser, the failure corpus and share links need this to be
 * true, and the UI is expected to say so plainly rather than fail at the first
 * request.
 */
export const isSupabaseConfigured = Boolean(url && anonKey);

/** Shown by the UI when a database-backed feature is unavailable. */
export const SUPABASE_NOT_CONFIGURED_MESSAGE =
  "Database is not connected. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable " +
  "saving, browsing and sharing hands. Conversion and download work without it.";

/**
 * Null when the env vars are missing, so importing this module never throws and
 * the offline converter keeps working.
 *
 * The key here is the *anon* key and it ships inside a public bundle, so it is
 * public by construction. What it can reach is granted deliberately in the
 * migrations; since `20260922130000_user_accounts_and_ownership.sql` that is
 * almost nothing — the anon role cannot read or write `hands` at all, and
 * `resolve_share` is its one remaining door. See `docs/DATABASE.md`.
 *
 * Auth options, and why each one is not the default:
 *
 *  * `persistSession` — a session that vanished on reload would make the whole
 *    login pointless. It lands in `localStorage` under `sb-<ref>-auth-token`.
 *  * `detectSessionInUrl` — the OAuth provider redirects back to the app with
 *    `?code=…`; this is what exchanges it for a session and then scrubs the
 *    parameter out of the URL with `history.replaceState`.
 *  * `flowType: "pkce"` — the authorization code never becomes a session
 *    without the verifier held in this browser, so a redirect URL captured
 *    from history or a referrer header is not a login.
 */
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
      },
    })
  : null;

/** Throws a readable error instead of dereferencing null. */
export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error(SUPABASE_NOT_CONFIGURED_MESSAGE);
  }
  return supabase;
}
