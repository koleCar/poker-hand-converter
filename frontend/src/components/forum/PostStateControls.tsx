"use client";

/**
 * Save, and follow / mute, on a post. Per-user state, so an island: the post
 * HTML is the same for everybody (see the post page header).
 */

import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { forumErrorMessage } from "../../lib/db/forum";
import { myPostState, savePost, setThreadSubscription, type SubscriptionLevel } from "../../lib/db/social";
import { en } from "../../lib/i18n/en";
import styles from "./forum.module.css";

export function PostStateControls({ post }: { post: string }) {
  const auth = useAuth();
  const [saved, setSaved] = useState(false);
  const [level, setLevel] = useState<SubscriptionLevel>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.isSignedIn) return;
    let active = true;
    myPostState(post).then(
      (state) => {
        if (active && state) {
          setSaved(state.saved);
          setLevel(state.subscription);
        }
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [auth.isSignedIn, post]);

  if (!auth.isSignedIn) {
    return null;
  }

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(forumErrorMessage(err));
    }
  }

  return (
    <div className={styles.row}>
      <button
        type="button"
        className={`btn btn--sm ${saved ? "is-active" : ""}`.trim()}
        aria-pressed={saved}
        onClick={() => void run(async () => setSaved(await savePost(post, !saved)))}
      >
        {saved ? en.social.saved : en.social.save}
      </button>
      {level === "muted" ? (
        <button type="button" className="btn btn--sm" onClick={() => void run(async () => setLevel(await setThreadSubscription(post, null)))}>
          {en.social.unmute}
        </button>
      ) : (
        <>
          <button
            type="button"
            className={`btn btn--sm ${level === "watching" ? "is-active" : ""}`.trim()}
            aria-pressed={level === "watching"}
            onClick={() =>
              void run(async () => setLevel(await setThreadSubscription(post, level === "watching" ? null : "watching")))
            }
          >
            {level === "watching" ? en.social.watching : en.social.watch}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void run(async () => setLevel(await setThreadSubscription(post, "muted")))}>
            {en.social.mute}
          </button>
        </>
      )}
      {error ? <small className="notice notice--error">{error}</small> : null}
    </div>
  );
}
