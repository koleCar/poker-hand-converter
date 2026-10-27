"use client";

/**
 * "3 new comments — show" on an open thread (#39).
 *
 * Realtime **Broadcast** on `post:<public id>`, sent by a trigger on
 * `comments` (see `comments_broadcast()`), not Postgres Changes: a hot table
 * under Postgres Changes has RLS evaluated per subscriber per row, which is the
 * known scaling cliff. The payload is a count and a sequence number — nothing a
 * reload would not show anyway — so the channel can be public.
 *
 * Clicking re-renders the thread from the server rather than splicing comments
 * in: ordering and tombstones are `get_post_comments`' to decide.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useDict } from "../../lib/i18n/client";
import { getBrowserSupabase } from "../../lib/supabase/browser";
import styles from "./forum.module.css";

export function LiveCommentBanner({ post, knownSeq }: { post: string; knownSeq: number }) {
  const en = useDict();
  const router = useRouter();
  const [latest, setLatest] = useState(knownSeq);
  const [base, setBase] = useState(knownSeq);

  // A server re-render hands down a new `knownSeq`: that is "seen".
  const [prevKnown, setPrevKnown] = useState(knownSeq);
  if (prevKnown !== knownSeq) {
    setPrevKnown(knownSeq);
    setBase(knownSeq);
    setLatest((current) => Math.max(current, knownSeq));
  }

  useEffect(() => {
    const supabase = getBrowserSupabase();
    if (!supabase) return;
    const channel = supabase
      .channel(`post:${post}`)
      .on("broadcast", { event: "comment" }, (message) => {
        const seq = Number((message.payload as { seq?: number } | undefined)?.seq ?? 0);
        setLatest((current) => Math.max(current, seq));
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [post]);

  const fresh = latest - base;
  if (fresh <= 0) {
    return null;
  }
  return (
    <button type="button" className={`btn btn--sm ${styles.banner}`} onClick={() => router.refresh()}>
      {en.social.newComments(fresh)}
    </button>
  );
}
