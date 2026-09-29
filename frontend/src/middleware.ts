import type { NextRequest } from "next/server";
import { updateSession } from "./lib/supabase/middleware";

/**
 * One job: keep the session cookie fresh. See `lib/supabase/middleware.ts`.
 *
 * The matcher excludes everything that is not a render — static chunks, images,
 * fonts, the favicon — because a token refresh is an HTTP round trip to the
 * auth server and paying for one per font file would be absurd. `/h/:slug` is
 * deliberately *included*: a signed-in owner opening their own share link
 * should still be signed in when they get there.
 */
export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *   _next/static, _next/image   build output
     *   favicon.svg, og-default.png, fonts/   public assets
     *   anything with a file extension        also public assets
     */
    "/((?!_next/static|_next/image|favicon\\.svg|og-default\\.png|fonts/|.*\\.[^/]+$).*)",
  ],
};
