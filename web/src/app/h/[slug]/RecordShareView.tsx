"use client";

import { useEffect } from "react";
import { getBrowserSupabase } from "../../../lib/supabase/browser";

/**
 * Counts one view of a share, at most once per session per slug.
 *
 * ## Why this is a client beacon and not part of the read
 *
 * It used to be a side effect of `resolve_share`, which meant every read moved
 * the counter — and the readers included Slack, Discord, iMessage and every
 * other unfurl prefetch. A single paste into a busy channel registered dozens
 * of "views" from software. The number measured "times pasted", not "times
 * read".
 *
 * Moving it here fixes that by construction: a crawler does not run this. The
 * page itself calls only `read_share`, which is `stable` and has no counter, so
 * `generateMetadata` and the body can both read without either of them
 * counting.
 *
 * ## The sessionStorage guard
 *
 * A reload is not a second reader, and the replayer writes `?t=` into the URL
 * as you step through the hand — under a `views++` per navigation that would
 * make a thorough reader look like sixty. One key per slug, per tab session.
 *
 * ## Silent on every failure
 *
 * The server rate-limits to 600/hour per slug and swallows its own refusals for
 * the same reason this does: the counter is decoration on a page whose job is
 * to show a hand. A failed increment is invisible; a thrown error would turn a
 * readable share into a broken one.
 */
export function RecordShareView({ slug }: { slug: string }) {
  useEffect(() => {
    const key = `rail.shareViewed.${slug}`;
    try {
      if (sessionStorage.getItem(key)) {
        return;
      }
      sessionStorage.setItem(key, "1");
    } catch {
      // Storage blocked. Counting once per load is better than not at all, and
      // this is the only path that can over-count.
    }

    const supabase = getBrowserSupabase();
    if (!supabase) {
      return;
    }
    void supabase.rpc("record_share_view", { p_slug: slug }).then(
      () => {},
      () => {},
    );
  }, [slug]);

  return null;
}
