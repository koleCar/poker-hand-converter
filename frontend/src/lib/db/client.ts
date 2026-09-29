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

/** Copy for the "this needs an account" state. */
export const SIGN_IN_REQUIRED_MESSAGE =
  "Sign in to save hands to your library. Converting, previewing and downloading work without an account.";

/**
 * Thrown before the request leaves the browser when a write needs a session.
 *
 * The server refuses these anyway — `anon` has no grant on `hands` and the
 * write RPCs raise `42501` — but a caught, typed error the UI can turn into a
 * sign-in prompt is worth far more than a Postgres permission string.
 */
export class SignInRequiredError extends Error {
  constructor(message: string = SIGN_IN_REQUIRED_MESSAGE) {
    super(message);
    this.name = "SignInRequiredError";
  }
}

/**
 * Resolves the caller's user id, or throws.
 *
 * `getSession()` reads the in-memory session after the client has initialised,
 * so this is a local check in practice, not a round trip.
 */
export async function requireUserId(message?: string): Promise<string> {
  const client = requireDb();
  const { data } = await client.auth.getSession();
  const id = data.session?.user?.id;
  if (!id) {
    throw new SignInRequiredError(message);
  }
  return id;
}

/** Non-throwing variant, for read paths that should render empty rather than fail. */
export async function currentUserId(): Promise<string | null> {
  if (!supabase) {
    return null;
  }
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
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
 * An RPC that came back with an error, carrying the code the server sent.
 *
 * The message is unchanged from what `rpc()` has always thrown, so every
 * existing `catch` keeps rendering the same string. The addition is `code`:
 * PostgREST reports `PGRST202` for a function that is not in the schema cache,
 * which is how a client tells "this feature has not been migrated onto your
 * database yet" apart from "this call failed". Without it the only way to
 * recognise the case is to match on English error text, which breaks the first
 * time PostgREST rewords it.
 */
export class DatabaseRpcError extends Error {
  readonly code: string | null;
  readonly fn: string;

  constructor(fn: string, message: string, code: string | null) {
    super(`${fn}: ${message}`);
    this.name = "DatabaseRpcError";
    this.fn = fn;
    this.code = code;
  }
}

/**
 * True when the failure is "the server does not have this function", rather
 * than "the call went wrong".
 *
 * `PGRST202` is PostgREST's "could not find the function in the schema cache".
 * `42883` and `42P01` are Postgres' own undefined-function / undefined-table,
 * which is what a `security invoker` RPC raises when it reaches a table a
 * migration has not created yet.
 */
export function isMissingSchemaError(error: unknown): boolean {
  if (!(error instanceof DatabaseRpcError)) {
    return false;
  }
  return error.code === "PGRST202" || error.code === "42883" || error.code === "42P01";
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
    throw new DatabaseRpcError(fn, error.message, error.code ?? null);
  }
  return data as T;
}
