import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { drain, type RpcClient } from "../../../../lib/derive/drain";
import { typescriptParser } from "../../../../lib/db/storedHand";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../../../../lib/supabase/config";

/**
 * The scheduled worker (docs/POOL.md P1): drains every owner's queued hands -
 * desktop syncs, re-counts, version bumps - most urgent and oldest first,
 * capped per run.
 *
 * ## Never the service role
 *
 * It talks to PostgREST with the anon key and `DERIVE_WORKER_JWT`: a JWT for
 * the dedicated derive role (`rail_derive`, or the fallback `derive_caller`
 * accepts), which may execute `derive_claim`, `derive_save` and `derive_fail`
 * and reads no table itself. Those functions write through the same writers
 * as the user's own drain, as the hand's owner.
 *
 * ## Inert until the owner turns it on
 *
 * Without `DERIVE_WORKER_JWT` the route does nothing (200, `inert`). It
 * answers only a request bearing `CRON_SECRET` (Vercel's cron sends it as
 * `Authorization: Bearer <secret>`); without one set it refuses everybody.
 * Minting the key and scheduling the route are the rollout's (P7).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Stop claiming new pages after this long (the function may run 60 s). */
const TIME_BUDGET_MS = 45_000;
/** Hands per run at most. */
const MAX_HANDS = 5_000;

function authorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }
  const jwt = process.env.DERIVE_WORKER_JWT;
  if (!jwt) {
    return NextResponse.json({ inert: true }, { headers: { "cache-control": "no-store" } });
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return NextResponse.json({ error: "This deployment has no database." }, { status: 503 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  try {
    const result = await drain(supabase as unknown as RpcClient, {
      parse: typescriptParser,
      budgetMs: TIME_BUDGET_MS,
      maxHands: MAX_HANDS,
      pageSize: 100,
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "The worker failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
