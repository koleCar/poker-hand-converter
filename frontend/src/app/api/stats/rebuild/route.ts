import { NextResponse, type NextRequest } from "next/server";
import { handStatsRows, type HandStatsInsert } from "../../../../lib/db/statsRows";
import type { PhfHand } from "../../../../lib/phf/types";
import { STATS_VERSION } from "../../../../lib/stats";
import { getWritableServerSupabase } from "../../../../lib/supabase/server";

/**
 * Derives statistics for the caller's hands that have none at the current
 * `stats_version`, next to the database rather than in the browser (#44).
 *
 * ## Why a route and not the tab
 *
 * A rebuild reads every stored `phf` document, ~20 KB a hand. Over a phone
 * connection that is the difference between a feature and a progress bar
 * nobody waits for. Here the documents travel from Supabase to a function in
 * the same region and never reach the client; what the client sees is a count.
 *
 * ## As the user, never as the service role
 *
 * The client here is `getWritableServerSupabase()`: the anon key plus the
 * caller's cookie, i.e. exactly the credential their browser already has. Both
 * reads (`hands_needing_stats`) and the write (`save_hand_stats`) are
 * `security invoker`, so RLS is the ownership check on every row, and the worst
 * a forged request can do is rebuild the forger's own statistics. Moving the
 * work server-side buys bandwidth and no privilege — see the header of
 * `lib/supabase/server.ts` for why that line does not move.
 *
 * ## One slice per request
 *
 * Each call works for at most {@link TIME_BUDGET_MS} and answers with a keyset
 * cursor; the client calls again until `done`. That keeps every invocation far
 * inside a serverless time limit, makes progress visible, and means a tab
 * closed half way loses one slice rather than the run — the next run starts
 * from whatever is still missing, because "missing" is computed, not tracked.
 *
 * When a run reaches the end it also prunes rows from older `stats_version`s
 * (`prune_hand_stats`), so a version bump is one button rather than two.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Stop starting new pages after this long; the client will call again. */
const TIME_BUDGET_MS = 8_000;
/** Hands per read. `hands_needing_stats` caps at 200. */
const PAGE_SIZE = 100;
/** `save_hand_stats` takes at most 1000 rows; stay under it. */
const MAX_ROWS_PER_WRITE = 900;
/** Upper bound on prune calls in one request (each removes up to 20 000 rows). */
const MAX_PRUNE_CALLS = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RebuildSlice {
  statsVersion: string;
  /** Hands read and derived in this slice. */
  processed: number;
  /** Rows written. */
  inserted: number;
  /** Hands whose document could not be derived (a converter bug, not the user's). */
  failed: number;
  /** Pass back as `after` to continue; null when `done`. */
  after: string | null;
  done: boolean;
  /** Obsolete rows removed, on the final slice. */
  pruned: number;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // A cookie-authenticated POST is a CSRF surface. The harm here is small (it
  // can only do the caller's own idempotent rebuild), but the check is one line
  // and the default for every state-changing route should be "same origin".
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
    return NextResponse.json({ error: "Sign in to rebuild statistics." }, { status: 401 });
  }

  let body: { after?: unknown; includeVillains?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An empty body is a fresh run.
  }
  let after = typeof body.after === "string" && UUID_RE.test(body.after) ? body.after : null;
  const includeVillains = body.includeVillains === true;

  const started = Date.now();
  const slice: RebuildSlice = {
    statsVersion: STATS_VERSION,
    processed: 0,
    inserted: 0,
    failed: 0,
    after,
    done: false,
    pruned: 0,
  };

  try {
    while (Date.now() - started < TIME_BUDGET_MS) {
      const { data, error } = await supabase.rpc("hands_needing_stats", {
        p_version: STATS_VERSION,
        // Omitted rather than null: the generated types model a defaulted
        // argument as optional, and the server default is the same null.
        p_after: after ?? undefined,
        p_limit: PAGE_SIZE,
        // With opponent statistics on, a hand that has hero rows but no
        // villain rows still needs work: that is what switching it on means.
        p_villains: includeVillains,
      });
      if (error) {
        throw error;
      }
      const page = (data ?? []) as unknown as Array<{ id: string; phf: PhfHand }>;

      const rows: HandStatsInsert[] = [];
      for (const { phf } of page) {
        try {
          rows.push(...handStatsRows(phf, { includeVillains }));
        } catch {
          slice.failed += 1;
        }
      }
      for (let i = 0; i < rows.length; i += MAX_ROWS_PER_WRITE) {
        const { data: saved, error: saveError } = await supabase.rpc("save_hand_stats", {
          p_rows: rows.slice(i, i + MAX_ROWS_PER_WRITE),
        });
        if (saveError) {
          throw saveError;
        }
        slice.inserted += (saved as { inserted?: number } | null)?.inserted ?? 0;
      }

      slice.processed += page.length;
      if (page.length > 0) {
        after = page[page.length - 1].id;
      }
      if (page.length < PAGE_SIZE) {
        slice.done = true;
        break;
      }
    }

    if (slice.done) {
      for (let i = 0; i < MAX_PRUNE_CALLS; i += 1) {
        const { data, error } = await supabase.rpc("prune_hand_stats", {
          p_keep_version: STATS_VERSION,
          p_limit: 20_000,
        });
        if (error) {
          throw error;
        }
        const pruned = data as { deleted?: number; more?: boolean } | null;
        slice.pruned += pruned?.deleted ?? 0;
        if (!pruned?.more) {
          break;
        }
      }
    }
  } catch (error) {
    // PostgREST errors are plain objects with a `message`; never forward
    // anything else (a stack, a URL with a key in it) to the client.
    const message =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "The rebuild failed.";
    return NextResponse.json({ error: message, slice }, { status: 500 });
  }

  slice.after = slice.done ? null : after;
  return NextResponse.json(slice, { headers: { "cache-control": "no-store" } });
}
