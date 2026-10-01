import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { cache } from "react";
import type { Database } from "../db/database.types";
import { isSupabaseConfigured, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

/**
 * Supabase, as the signed-in user, on the server.
 *
 * ## The rule this file exists to enforce: no service-role key
 *
 * There is no service-role client here and there must not be one. Every Server
 * Action and every RSC talks to Supabase **as the user**, holding the same anon
 * key a stranger with devtools has, plus their session cookie. The database is
 * the authority: `hands` is scoped by `owner_id = auth.uid()`, `update` and
 * `delete` are refused everywhere, and the counters that must move live inside
 * `security definer` functions that can touch nothing else.
 *
 * That means a Server Action is a *typed wrapper around an RPC*, never a
 * privilege escalation. The moment one of them holds a service-role key, every
 * RLS policy in `supabase/migrations/` stops being a security boundary and
 * becomes a suggestion, and the only thing standing between two users' hands is
 * whichever `where` clause somebody remembered to write. The one later
 * exception on the roadmap is the digest cron, which is not part of this app.
 *
 * Corollary, and it is the mistake that `create_share` already made once: a
 * Server Action never trusts an argument that identifies the actor. Identity
 * comes from `getUser()` here and ultimately from `auth.uid()` inside the
 * function.
 *
 * ## `getUser()`, never `getSession()`
 *
 * `getSession()` reads the cookie and decodes it **without verifying the JWT
 * signature**. In the browser that is fine — the cookie came from storage this
 * origin owns, and lying to yourself buys nothing. On the server the cookie is
 * attacker-controlled input: anyone can send one. `getUser()` round-trips to
 * the auth server, which verifies the signature and the expiry.
 *
 * `lib/db/client.ts` still uses `getSession()` in `currentUserId()` /
 * `requireUserId()`. That is correct where it runs, which is the browser, and
 * it must not be reused here. That is what {@link getServerUser} is for.
 *
 * ## Two variants, because cookie writes are not allowed everywhere
 *
 * An RSC renders after the response headers are conceptually settled, so
 * `cookies().set()` throws there. The refresh that would have written one has
 * already happened in `middleware.ts`, which runs before the render and *can*
 * write — so the read-only client swallows the write instead of crashing the
 * page. Route Handlers and Server Actions run before their own response is
 * built and get the writable variant.
 */

/**
 * Read-only client for Server Components.
 *
 * `cache()` so that a page calling this in `generateMetadata` and again in the
 * body gets one client, one cookie read, and one `getUser()` round trip.
 */
export const getServerSupabase = cache(async (): Promise<SupabaseClient<Database> | null> => {
  if (!isSupabaseConfigured) {
    return null;
  }
  const store = await cookies();
  return createServerClient<Database>(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll() {
        // Deliberately empty. A Server Component cannot set a cookie, and the
        // refresh this would have persisted was already written by the
        // middleware on the way in. Throwing here would turn a token refresh
        // into a 500 on a page that rendered perfectly well.
      },
    },
  });
});

/**
 * Writable client for Route Handlers and Server Actions.
 *
 * Not cached: a Route Handler builds exactly one response and the cookie writes
 * have to land on it, so sharing an instance across requests would be wrong in
 * the one direction that matters.
 */
export async function getWritableServerSupabase(): Promise<SupabaseClient<Database> | null> {
  if (!isSupabaseConfigured) {
    return null;
  }
  const store = await cookies();
  return createServerClient<Database>(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          store.set(name, value, options);
        }
      },
    },
  });
}

/**
 * The verified caller, or null.
 *
 * **This is the only supported way to learn who is asking, server-side.** It
 * verifies the JWT signature; `getSession()` does not.
 *
 * `cache()` so the root layout, a page and a Server Action in the same request
 * share one round trip rather than three.
 */
export const getServerUser = cache(async (): Promise<User | null> => {
  const client = await getServerSupabase();
  if (!client) {
    return null;
  }
  const { data, error } = await client.auth.getUser();
  if (error) {
    // An expired or forged cookie is "signed out", not an error page.
    return null;
  }
  return data.user ?? null;
});

/**
 * The same, but from a Route Handler / Server Action, where the client is
 * writable and a refresh triggered by this call can actually be persisted.
 */
export async function requireServerUser(): Promise<User> {
  const client = await getWritableServerSupabase();
  if (!client) {
    throw new Error("Accounts need a database, and this deployment has none configured.");
  }
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    throw new Error("Sign in to do that.");
  }
  return data.user;
}

/**
 * Supabase as **nobody**, on the server — no cookies, no session.
 *
 * For reads whose answer must be the same for every visitor: the forum feed, a
 * post, its comments, search. Rendering them as the signed-in user would bake
 * that user's view into the HTML — their own shadowbanned post visible, say —
 * and a page that differs per visitor can never be cached or shared. So these
 * reads go out as `anon`, exactly as a crawler sees them, and per-user state
 * (my votes, "is this mine") is fetched by client islands after hydration.
 *
 * Not `cache()`d across requests — there is nothing per-request in it, but a
 * fresh client per request keeps the fetch dedupe semantics simple.
 */
export const getAnonServerSupabase = cache((): SupabaseClient<Database> | null => {
  if (!isSupabaseConfigured) {
    return null;
  }
  return createClient<Database>(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
});
