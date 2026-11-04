import { NextResponse, type NextRequest } from "next/server";
import { parseEntitlements, type Entitlements } from "../../../lib/db/entitlements";
import { appDownloadUrl, downloadAccess, isAppPlatform } from "../../../lib/download";
import { paths } from "../../../lib/routes";
import { getWritableServerSupabase } from "../../../lib/supabase/server";

/**
 * `/download/mac` and `/download/windows`: the installer, for a Pro account.
 *
 * The page's buttons link here rather than to the installer, so the plan is
 * checked on the server, as the user (the anon key and the caller's cookie,
 * `my_entitlements()`), before anyone is sent to the file. Allowed: a 302 to
 * the newest installer. Anything else - signed out, a plan without the
 * desktop app, a plan that could not be read - goes back to `/download`,
 * which says why and what to do.
 *
 * Never cached: the answer is this account's, now.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  if (!isAppPlatform(platform)) {
    return new NextResponse(null, { status: 404 });
  }

  const client = await getWritableServerSupabase();
  const user = client ? (await client.auth.getUser()).data.user : null;
  let entitlements: Entitlements | null = null;
  if (client && user) {
    const { data, error } = await client.rpc("my_entitlements");
    entitlements = error ? null : parseEntitlements(data);
  }

  const access = downloadAccess(user !== null, entitlements);
  const target = access === "allowed" ? appDownloadUrl(platform) : new URL(paths.download(), request.url).toString();
  const response = NextResponse.redirect(target, access === "allowed" ? 302 : 303);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
