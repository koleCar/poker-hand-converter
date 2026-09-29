"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { forumErrorMessage } from "../../lib/db/forum";
import { editPostTitle, setPostFlags, setPostStatus } from "../../lib/db/moderation";
import { en } from "../../lib/i18n/en";
import { paths } from "../../lib/routes";
import { useCanModerate } from "./ModContext";
import styles from "./forum.module.css";

/** Remove, lock, pin, retitle — for whoever moderates this post's board. */
export function PostModTools({
  post,
  board,
  title,
  isLocked,
  isPinned,
}: {
  post: string;
  board: string;
  title: string;
  isLocked: boolean;
  isPinned: boolean;
}) {
  const can = useCanModerate();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  if (!can) return null;

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (err) {
      setError(forumErrorMessage(err));
    }
  }

  const reason = () => window.prompt(en.moderation.reasonPrompt) ?? undefined;

  return (
    <div className={styles.modBar} aria-label={en.moderation.tools}>
      <strong>{en.moderation.tools}</strong>
      <button type="button" className="linkish" onClick={() => void run(() => setPostStatus(post, "removed", reason()))}>
        {en.moderation.remove}
      </button>
      <button type="button" className="linkish" onClick={() => void run(() => setPostFlags(post, { locked: !isLocked }, reason()))}>
        {isLocked ? en.moderation.unlock : en.moderation.lock}
      </button>
      <button type="button" className="linkish" onClick={() => void run(() => setPostFlags(post, { pinned: !isPinned }))}>
        {isPinned ? en.moderation.unpin : en.moderation.pin}
      </button>
      {editing ? (
        <span className={styles.row}>
          <input value={draft} maxLength={300} onChange={(event) => setDraft(event.target.value)} />
          <button
            type="button"
            className="btn btn--sm"
            onClick={() =>
              void run(async () => {
                const result = await editPostTitle(post, draft, reason());
                setEditing(false);
                router.replace(paths.post(board, post, result.slug));
              })
            }
          >
            {en.moderation.save}
          </button>
        </span>
      ) : (
        <button type="button" className="linkish" onClick={() => setEditing(true)}>
          {en.moderation.editTitle}
        </button>
      )}
      {error ? <small className="notice notice--error">{error}</small> : null}
    </div>
  );
}
