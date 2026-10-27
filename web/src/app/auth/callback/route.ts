import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "../../../lib/auth/nextPath";
import { getWritableServerSupabase } from "../../../lib/supabase/server";

/**
 * The one address every sign-in comes back to.
 *
 * Google's redirect, the signup confirmation mail and the password-reset mail
 * all land here with `?code=…`, and this handler exchanges that code for a
 * session. It has to be a Route Handler rather than a page: the exchange writes
 * cookies, and a Server Component cannot.
 *
 * ## `?next=` is validated, not sanitised
 *
 * This is the single most dangerous parameter in the app. It is
 * attacker-controlled, and it decides the `Location` of a response that has
 * just minted a session — which with OAuth is an account-takeover primitive,
 * not a phishing nuisance. `safeNextPath()` answers with a member of a fixed
 * set of literal paths or with `/`; it never echoes its input and never parses
 * a URL. The reasoning, and the list of bypasses that killed every "reject
 * absolute URLs" rule ever written, is on `lib/auth/nextPath.ts`.
 *
 * ## Failure goes home, quietly
 *
 * A code that is expired, already used, or from a different browser (the PKCE
 * verifier lives in *this* browser, by design) is not an error page. The user
 * gets `/?auth=failed`, where the app can offer them the sign-in dialog again.
 * There is nothing actionable in `error.message` for a person, and echoing it
 * into a query string puts auth-server text on a public URL.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNextPath(url.searchParams.get("next"));

  // `url.origin` rather than SITE_URL: the redirect has to stay on the host the
  // browser is actually talking to, or a preview deployment would bounce its
  // freshly-signed-in user over to production, where the cookie does not exist.
  const to = (path: string) => NextResponse.redirect(new URL(path, url.origin));

  if (!code) {
    return to(next);
  }

  const supabase = await getWritableServerSupabase();
  if (!supabase) {
    return to("/?auth=failed");
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return to("/?auth=failed");
  }

  return to(next);
}
