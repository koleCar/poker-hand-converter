import { NextResponse, type NextRequest } from "next/server";
import { drain, pendingOf, type DrainResult, type RpcClient } from "../../../lib/derive/drain";
import { typescriptParser } from "../../../lib/db/storedHand";
import { getWritableServerSupabase } from "../../../lib/supabase/server";

/**
 * Works out the caller's queued hands (docs/POOL.md P1): one time-boxed slice
 * of their own `derive_queue`, next to the database.
 *
 * The upload calls it right after the hands are stored (`deriveNow`), so a
 * fresh upload is processed without any page asking; the scheduled worker
 * (`/api/derive/cron`) drains everything else. This path works on its own.
 *
 * ## As the user, never as the service role
 *
 * The client is `getWritableServerSupabase()`: the anon key plus the caller's
 * cookie. `derive_claim` gives a signed-in caller their own rows only and
 * `derive_save` writes only those, through the same writers (and budgets) the
 * browser used; the worst a forged request can do is work out the forger's
 * own hands. See `lib/supabase/server.ts`.
 *
 * Answers `{processed, saved, failed, pending, done}`; the client calls again
 * while `done` is false and the pending count goes down.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Stop claiming new pages after this long; the client calls again. */
const TIME_BUDGET_MS = 8_000;

export interface DeriveSlice extends Omit<DrainResult, "empty"> {
  /** The caller's hands still in the queue after this slice. */
  pending: number;
  /** Nothing claimable was left. */
  done: boolean;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // A cookie-authenticated POST is a CSRF surface: same origin only.
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Cross-origin request refused." }, { status: 403 });
  }

  const supabase = await getWritableServerSupabase();
  if (!supabase) {
    return NextResponse.json({ error: "This deployment has no database." }, { status: 503 });
  }
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "Sign in to process your hands." }, { status: 401 });
  }

  const client = supabase as unknown as RpcClient;
  try {
    const result = await drain(client, { parse: typescriptParser, budgetMs: TIME_BUDGET_MS });
    const pending = await pendingOf(client);
    const slice: DeriveSlice = {
      processed: result.processed,
      saved: result.saved,
      failed: result.failed,
      pending,
      done: result.empty,
    };
    return NextResponse.json(slice, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    // PostgREST errors are plain objects with a `message`; never forward
    // anything else (a stack, a URL with a key in it) to the client.
    const message =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "Processing your hands failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
