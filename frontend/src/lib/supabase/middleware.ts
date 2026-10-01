import { createServerClient } from "@supabase/ssr";
import type { Database } from "../db/database.types";
import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseConfigured, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

/**
 * Refreshes the session cookie on every request that renders something.
 *
 * ## Why this is not optional
 *
 * A Supabase access token lives about an hour. In the old localStorage world
 * the browser client refreshed it on a timer, which worked because the only
 * consumer was the same browser client. With cookie sessions the *server* is a
 * consumer too, and a Server Component cannot write a cookie — so if nothing
 * refreshed the token before the render, every returning user whose hour had
 * elapsed would render as signed out, correctly and uselessly.
 *
 * Middleware is the one place in the request that runs before the render and
 * can still set headers. So the refresh happens here, and `lib/supabase/server`
 * deliberately swallows cookie writes because this already did them.
 *
 * ## The copy dance is load-bearing
 *
 * `setAll` has to write to **both** the request (so the render that follows in
 * this same pass sees the fresh token) and the response (so the browser keeps
 * it). Rebuilding `response` from the mutated request is what keeps the two in
 * step. Getting this wrong produces the classic symptom: signed in, then signed
 * out on the next navigation, then signed in again.
 *
 * ## `getUser()`, not `getSession()`
 *
 * Same rule as everywhere else server-side. It is also what actually triggers
 * the refresh — `getSession()` would happily hand back the expired token it
 * just read out of the cookie and refresh nothing.
 *
 * Nothing here authorises anything. Middleware is not a security boundary in
 * this app: the database is. This only moves a token along.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  if (!isSupabaseConfigured) {
    return response;
  }

  const supabase = createServerClient<Database>(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Do not remove, and do not put code between this and the `createServerClient`
  // call above: this is the call that refreshes an expiring token, and the
  // cookie writes it triggers are what `setAll` is here to capture.
  await supabase.auth.getUser();

  return response;
}
