"use client";

/**
 * Up / down arrows and the count between them.
 *
 * The count shown is `upvotes - downvotes` — what people did — while ranking
 * uses the weighted `score`. So a fresh account's vote visibly moves the number
 * and changes nothing that ranks (see `vote_weight()`), and nobody is told
 * their vote "did not register".
 */

import { useState } from "react";
import { useAuth } from "../../lib/auth";
import { forumErrorMessage, voteComment, votePost, type VoteCounts } from "../../lib/db/forum";
import { en } from "../../lib/i18n/en";
import { useMyVotes } from "./MyVotes";
import styles from "./forum.module.css";

interface VoteButtonsProps {
  post: string;
  /** Present for a comment. */
  seq?: number;
  upvotes: number;
  downvotes: number;
  disabled?: boolean;
  compact?: boolean;
}

export function VoteButtons({ post, seq, upvotes, downvotes, disabled = false, compact = false }: VoteButtonsProps) {
  const auth = useAuth();
  const mine = useMyVotes();
  const serverMine = (seq === undefined ? mine.posts[post] : mine.comments[String(seq)]) ?? 0;
  const [override, setOverride] = useState<{ counts: Pick<VoteCounts, "upvotes" | "downvotes">; myVote: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const myVote = override?.myVote ?? serverMine;
  const shown = (override?.counts.upvotes ?? upvotes) - (override?.counts.downvotes ?? downvotes);

  async function cast(direction: 1 | -1) {
    if (!auth.isSignedIn) {
      auth.requestSignIn(en.forum.comments.signIn);
      return;
    }
    const next = (myVote === direction ? 0 : direction) as -1 | 0 | 1;
    setBusy(true);
    setError(null);
    try {
      const result = seq === undefined ? await votePost(post, next) : await voteComment(post, seq, next);
      setOverride({ counts: result, myVote: next });
    } catch (err) {
      setError(forumErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${styles.votes} ${compact ? styles.votesCompact : ""}`}>
      <button
        type="button"
        className={`${styles.arrow} ${myVote === 1 ? styles.arrowUp : ""}`}
        aria-label={en.forum.upvote}
        aria-pressed={myVote === 1}
        disabled={busy || disabled}
        onClick={() => void cast(1)}
      >
        ▲
      </button>
      <span className={styles.count} title={error ?? undefined}>
        {shown}
      </span>
      <button
        type="button"
        className={`${styles.arrow} ${myVote === -1 ? styles.arrowDown : ""}`}
        aria-label={en.forum.downvote}
        aria-pressed={myVote === -1}
        disabled={busy || disabled}
        onClick={() => void cast(-1)}
      >
        ▼
      </button>
    </div>
  );
}
