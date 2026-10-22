"use client";

/**
 * Live progress across tabs (Rail R4.3), the two React ends of
 * `activityChannel.ts`:
 *
 * - `useOtherUploads(userId)`: the uploads running in the account's *other*
 *   tabs and devices, for the shell's live strip. Expiry is the board's
 *   (`lib/live/activity.ts`); this re-renders when an entry is due to go.
 * - `useUploadPresence(userId, activity)`: the converter publishes its
 *   running upload. Throttled by the publisher; withdrawn when the activity
 *   goes null, the account changes or the page leaves.
 *
 * Neither does anything for a signed-out visitor (`userId` null) or without
 * a database: no socket is opened.
 */

import { useEffect, useRef, useState } from "react";
import {
  createActivityBoard,
  createActivityPublisher,
  type ActivityPublisher,
  type UploadActivity,
} from "../../lib/live/activity";
import { getBrowserSupabase } from "../../lib/supabase/browser";
import { openActivityChannel, type ActivityClientLike, type ActivityLink } from "./activityChannel";

function activityClient(): ActivityClientLike | null {
  return getBrowserSupabase() as unknown as ActivityClientLike | null;
}

export function useOtherUploads(userId: string | null): UploadActivity[] {
  const [uploads, setUploads] = useState<{ user: string; list: UploadActivity[] } | null>(null);

  useEffect(() => {
    const client = activityClient();
    if (!userId || !client) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const board = createActivityBoard();

    const publish = () => {
      if (!active) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      setUploads({ user: userId, list: board.visible() });
      // Re-render when the next entry expires, without waiting for a sync.
      const next = board.nextChange();
      if (next !== null) {
        timer = setTimeout(publish, Math.max(250, next - Date.now() + 50));
      }
    };

    const link = openActivityChannel(client, userId, (state, ownKey) => {
      board.sync(state, ownKey);
      publish();
    });

    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      link.release();
    };
  }, [userId]);

  return uploads && uploads.user === userId ? uploads.list : [];
}

export function useUploadPresence(userId: string | null, activity: UploadActivity | null) {
  const state = useRef<{ user: string; link: ActivityLink; publisher: ActivityPublisher } | null>(null);

  // The link lives as long as there is a user and something to publish.
  const publishing = userId !== null && activity !== null;
  useEffect(() => {
    const client = activityClient();
    if (!publishing || !userId || !client) {
      return;
    }
    const link = openActivityChannel(client, userId);
    const publisher = createActivityPublisher({ send: (next) => link.track(next) });
    state.current = { user: userId, link, publisher };
    return () => {
      state.current = null;
      publisher.dispose();
      link.release();
    };
  }, [publishing, userId]);

  useEffect(() => {
    if (activity && state.current && state.current.user === userId) {
      state.current.publisher.update(activity);
    }
  }, [activity, userId, publishing]);
}
