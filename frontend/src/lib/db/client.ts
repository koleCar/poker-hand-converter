/**
 * Thin access layer over the Supabase client.
 *
 * Nothing else in `lib/db` imports `@supabase/supabase-js` directly, so the
 * "database is not configured" branch lives in exactly one place.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isSupabaseConfigured,
  requireSupabase,
  SUPABASE_NOT_CONFIGURED_MESSAGE,
  supabase,
} from "../supabase";

/**
 * True when the build has Supabase credentials.
 *
 * Read this before offering any database feature. Every function in this module
 * throws `DatabaseNotConfiguredError` rather than silently doing nothing, so a
 * UI that forgets to check gets a loud, readable failure instead of an empty
 * list it cannot explain.
 */
export const isDatabaseConfigured = isSupabaseConfigured;

/** Copy for the "DB features are off" state. */
export const DATABASE_NOT_CONFIGURED_MESSAGE = SUPABASE_NOT_CONFIGURED_MESSAGE;

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super(SUPABASE_NOT_CONFIGURED_MESSAGE);
    this.name = "DatabaseNotConfiguredError";
  }
}

/** The raw client, or null when the app is running as an offline converter. */
export const db: SupabaseClient | null = supabase;

export function requireDb(): SupabaseClient {
  if (!supabase) {
    throw new DatabaseNotConfiguredError();
  }
  return requireSupabase();
}

/**
 * Calls a Postgres function and unwraps the result.
 *
 * Every write path in this schema is an RPC rather than a PostgREST table call:
 * the anon role has no UPDATE or DELETE anywhere, and the counters that do have
 * to move (failure occurrences, share views) live inside `security definer`
 * functions. See `docs/DATABASE.md`.
 */
export async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const client = requireDb();
  const { data, error } = await client.rpc(fn, args ?? {});
  if (error) {
    throw new Error(`${fn}: ${error.message}`);
  }
  return data as T;
}
