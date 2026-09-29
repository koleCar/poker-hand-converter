import "server-only";

import { cache } from "react";
import type { PhfHand } from "../phf/types";
import { getServerSupabase } from "../supabase/server";

/**
 * Reading a share, server-side, for `/h/[slug]`.
 *
 * ## Why `read_share` and not `resolve_share`
 *
 * `resolve_share` is `volatile`: it increments `views` as a side effect of
 * reading. A page that calls it from `generateMetadata` *and* from its body
 * would count two views per visit, and any caching layer in front would freeze
 * the number at whatever the first render saw. `20261003090000_share_projection`
 * split the pair for exactly this: `read_share` is `stable` and returns the
 * payload, `record_share_view` is `volatile` and does nothing else. The counter
 * now moves from a client beacon fired once per session
 * (`app/h/[slug]/RecordShareView.tsx`).
 *
 * The same split is what makes it safe for metadata and body to share a read at
 * all — and it is why deleting `frontend/api/share-meta.ts` in #26 was possible
 * rather than just desirable.
 *
 * ## Why React `cache()` and not Next's fetch memoisation
 *
 * Next dedupes `fetch()` within a render pass, keyed on URL and options. It
 * does **not** dedupe this: supabase-js issues RPCs as `POST`, and a POST is
 * never memoised — it is assumed to have effects. So `generateMetadata` and the
 * page body would be two round trips to Postgres for the identical row.
 * `cache()` is per-request memoisation at the function level, which is the
 * right granularity here because the argument is one string.
 *
 * ## What comes back
 *
 * An explicit projection, redacted server-side by `phf_redact_private`:
 * `meta.rawText`, `meta.originalFilename`, `meta.warnings` and `meta.parsedAt`
 * are already gone, and the `hands` row's `source_text`, `owner_id`,
 * `hand_key`, `site_hand_id` and `source_filename` were never in it. Nothing
 * here should try to read them, and nothing should try to put them back.
 */

const SLUG_PATTERN = /^[23456789abcdefghjkmnpqrstuvwxyz]{8,16}$/;

export type ShareReadStatus = "ok" | "not-found" | "unconfigured" | "error";

export interface ServerShare {
  slug: string;
  title: string | null;
  /** Whether this link's copy may reveal how the hand ended. Defaults closed. */
  spoilers: boolean;
  views: number;
  createdAt: string | null;
  storedHandId: string | null;
  phf: PhfHand | null;
  standardText: string;
}

export interface ShareReadResult {
  status: ShareReadStatus;
  share: ServerShare | null;
}

export const readShare = cache(async (slug: string): Promise<ShareReadResult> => {
  // The shape check is first and is also enforced inside the function. An
  // unknown slug and a malformed one are deliberately indistinguishable, so a
  // probe learns nothing from either.
  if (!slug || !SLUG_PATTERN.test(slug)) {
    return { status: "not-found", share: null };
  }

  const supabase = await getServerSupabase();
  if (!supabase) {
    return { status: "unconfigured", share: null };
  }

  const { data, error } = await supabase.rpc("read_share", { p_slug: slug });
  if (error) {
    return { status: "error", share: null };
  }
  if (!data) {
    return { status: "not-found", share: null };
  }

  const payload = data as Record<string, unknown>;
  const standardText = (payload.standardText as string | null) ?? "";

  return {
    status: "ok",
    share: {
      slug: String(payload.slug),
      title: (payload.title as string | null) ?? null,
      // Defaults closed. A payload from a database that predates the column, or
      // a deployment where the migration has not landed, must not start leaking
      // the result into unfurls because a key was missing.
      spoilers: payload.spoilers === true,
      views: Number(payload.views ?? 0),
      createdAt: (payload.createdAt as string | null) ?? null,
      storedHandId: (payload.handId as string | null) ?? null,
      phf: (payload.phf as PhfHand | null) ?? null,
      standardText,
    },
  };
});
