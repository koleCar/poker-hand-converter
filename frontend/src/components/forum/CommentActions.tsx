"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteComment, forumErrorMessage } from "../../lib/db/forum";
import { en } from "../../lib/i18n/en";
import { useMyProfile } from "../../lib/profile/context";
import { CommentComposer } from "./CommentComposer";
import styles from "./forum.module.css";

/** Reply and, on your own comment, delete. Decided client-side, after hydration. */
export function CommentActions({
  post,
  seq,
  author,
  canReply,
  locked,
}: {
  post: string;
  seq: number;
  author: string | null;
  canReply: boolean;
  locked: boolean;
}) {
  const { profile } = useMyProfile();
  const router = useRouter();
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = Boolean(profile && author && profile.username === author);

  async function remove() {
    try {
      await deleteComment(post, seq);
      router.refresh();
    } catch (err) {
      setError(forumErrorMessage(err));
    }
  }

  return (
    <>
      <div className={styles.commentActions}>
        {canReply && !locked ? (
          <button type="button" className="linkish" onClick={() => setReplying((value) => !value)}>
            {en.forum.comments.reply}
          </button>
        ) : null}
        {mine ? (
          <button type="button" className="linkish" onClick={() => void remove()}>
            {en.forum.comments.delete}
          </button>
        ) : null}
        {error ? <small className="notice notice--error">{error}</small> : null}
      </div>
      {replying ? (
        <CommentComposer post={post} parentSeq={seq} autoFocus onDone={() => setReplying(false)} />
      ) : null}
    </>
  );
}
