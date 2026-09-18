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
 * public by construction. Every privilege it has is granted deliberately in
 * `supabase/migrations/20260916190000_phf_baseline.sql`; see `docs/DATABASE.md`
 * for the threat model.
 */
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: { persistSession: false },
    })
  : null;

/** Throws a readable error instead of dereferencing null. */
export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error(SUPABASE_NOT_CONFIGURED_MESSAGE);
  }
  return supabase;
}
