"use client";

/**
 * The unread badge in the app bar (#39).
 *
 * Supabase Realtime, Postgres Changes on `notifications` filtered to the
 * caller's own id. That works — and stays private — because the table's only
 * policy is select-own: Realtime applies RLS to the change feed, so a
 * subscription to somebody else's id receives nothing.
 *
 * The count is re-read on focus as well, so a missed event (a sleeping laptop,
 * a dropped socket) costs a stale number for as long as the tab was in the
 * background, not forever.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { unreadNotificationCount } from "../../lib/db/social";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { getBrowserSupabase } from "../../lib/supabase/browser";

export function NotificationsBell() {
  const en = useDict();
  const auth = useAuth();
  const userId = auth.isSignedIn ? (auth.user?.id ?? null) : null;
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!userId) {
      return;
    }
    let active = true;
    const refresh = () =>
      unreadNotificationCount().then(
        (count) => {
          if (active) setUnread(count);
        },
        () => {
          // A database without the social migration: no badge.
        },
      );
    void refresh();

    const supabase = getBrowserSupabase();
    let channel: ReturnType<NonNullable<typeof supabase>["channel"]> | null = null;
    // The socket has to carry the *user's* token before the join. A session
    // restored from the cookie does not hand it to Realtime on its own, and a
    // channel joined as `anon` is filtered by the select-own policy down to
    // nothing — it subscribes fine and never fires, which is the worst way to
    // fail. So: token first, then the channel.
    void supabase?.auth.getSession().then(({ data }) => {
      if (!active || !supabase) return;
      if (data.session?.access_token) {
        void supabase.realtime.setAuth(data.session.access_token);
      }
      channel = supabase
        .channel(`notifications:${userId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
          () => {
            if (active) setUnread((count) => count + 1);
          },
        )
        .subscribe();
    });

    const onFocus = () => void refresh();
    const onRead = () => void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener("rail:notifications-read", onRead);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("rail:notifications-read", onRead);
      if (channel) void supabase?.removeChannel(channel);
    };
  }, [userId]);

  if (!userId) {
    return null;
  }

  return (
    <Link href={paths.notifications()} className="bell" aria-label={en.social.bell(unread)} title={en.social.bell(unread)}>
      <span aria-hidden="true">🔔</span>
      {unread > 0 ? <span className="bell__count">{unread > 99 ? "99+" : unread}</span> : null}
    </Link>
  );
}
