"use client";

/**
 * Live arrival on the web (Rail R1.10): the account's own `hand_arrivals` row,
 * through Supabase Realtime.
 *
 * The row is bumped once per insert statement on `hands` (a desktop
 * `ingest_hands` call of up to 500 hands, or a web `save_hands` call), so a
 * change here means "your library grew"; it never carries a hand. Postgres
 * Changes, filtered `owner_id=eq.<uid>` - the same mechanism as the unread
 * badge (`NotificationsBell`) - and private for the same reason: the table's
 * only policy is select-own, and Realtime applies it to every INSERT and
 * UPDATE change, so another account's row never reaches this socket whatever
 * the filter says. `hands` itself is not published (see the migration
 * `20270512090000_hand_arrivals.sql`).
 *
 * When the signals become a refetch is `lib/live/arrivals.ts`'s job:
 * debounced, backed off while a backfill streams, held while the tab is
 * hidden. This hook only wires it up:
 *
 * - the socket carries the user's token before the join (a channel joined
 *   as `anon` subscribes and then receives nothing - see the bell);
 * - a reconnect after an error, a timeout or a close is a resync: events in
 *   the gap are lost, so the page refetches once;
 * - unmount, sign-out or another account removes the channel and drops
 *   whatever was pending.
 *
 * Not used on `/convert`: the converter's promise is that it makes no server
 * requests, and a socket is one.
 */

import { useEffect, useRef } from "react";
import { arrivalSignalFromRow, createArrivalBatcher, type ArrivalBatch } from "../../lib/live/arrivals";
import { getBrowserSupabase } from "../../lib/supabase/browser";

export function useHandArrivals(userId: string | null, onArrival: (batch: ArrivalBatch) => void) {
  // The latest callback without resubscribing when its identity changes.
  const callback = useRef(onArrival);
  useEffect(() => {
    callback.current = onArrival;
  }, [onArrival]);

  useEffect(() => {
    const supabase = getBrowserSupabase();
    if (!userId || !supabase) {
      return;
    }
    let active = true;
    const batcher = createArrivalBatcher({
      hidden: document.visibilityState === "hidden",
      onFlush: (batch) => {
        if (active) callback.current(batch);
      },
    });
    const onVisibility = () => batcher.setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);

    let channel: ReturnType<typeof supabase.channel> | null = null;
    let joined = false;
    let broken = false;

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session?.access_token) {
        void supabase.realtime.setAuth(data.session.access_token);
      }
      const filter = `owner_id=eq.${userId}`;
      const onChange = (payload: { new: unknown }) => batcher.push(arrivalSignalFromRow(payload.new));
      channel = supabase
        .channel(`hand-arrivals:${userId}`)
        // INSERT for the account's first arrival, UPDATE for every one after.
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "hand_arrivals", filter }, onChange)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "hand_arrivals", filter }, onChange)
        .subscribe((status) => {
          if (!active) return;
          if (status === "SUBSCRIBED") {
            if (joined && broken) {
              batcher.push({ hands: null, origin: null });
            }
            joined = true;
            broken = false;
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            broken = true;
          }
        });
    });

    return () => {
      active = false;
      batcher.dispose();
      document.removeEventListener("visibilitychange", onVisibility);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [userId]);
}
