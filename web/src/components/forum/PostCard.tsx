/**
 * One post in a feed (forum v2). Server-rendered; the arrows and the cards are
 * islands. The board chip carries the board's colour, a hand post shows its
 * cards, and the row underneath says who, when and how much talk. On a phone
 * the card is a flat full-width item and the arrows move down into an action
 * row beside the comment count (CSS only: the same elements, re-placed).
 */

import Link from "next/link";
import type { CSSProperties } from "react";
import { boardHue, faceHue } from "../../lib/forum/boards";
import type { ForumPost } from "../../lib/forum/types";
import type { Dict } from "../../lib/i18n/types";
import { paths } from "../../lib/routes";
import { formatPostDate } from "./format";
import { HandCards } from "./HandCards";
import { VoteButtons } from "./VoteButtons";
import styles from "./forum.module.css";

export function Face({ username, size = 20 }: { username: string | null; size?: number }) {
  const name = username ?? "?";
  return (
    <span
      className={styles.face}
      style={{ "--face": username ? faceHue(username) : "var(--border-strong)", "--size": `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function PostCard({ post, t: en, index = 0 }: { post: ForumPost; t: Dict; index?: number }) {
  const href = paths.post(post.board.slug, post.publicId, post.slug);
  const style = { "--hue": boardHue(post.board.slug), "--d": `${Math.min(index, 12) * 40}ms` } as CSSProperties;
  return (
    <article className={`${styles.card} ${post.isPinned ? styles.cardPinned : ""}`} style={style}>
      <VoteButtons post={post.publicId} upvotes={post.upvotes} downvotes={post.downvotes} disabled={post.isLocked} />
      <div className={styles.cardBody}>
        <div className={styles.tags}>
          <Link href={paths.board(post.board.slug)} className={styles.boardChip}>
            <span className={styles.navDot} aria-hidden="true" />
            {post.board.name}
          </Link>
          {post.poll ? (
            <span className={`${styles.badge} ${styles.badgePoll}`}>{en.forum.poll.badge(post.poll.votes)}</span>
          ) : post.kind === "hand" ? (
            <span className={`${styles.badge} ${styles.badgeHand}`}>{en.forum.handBadge}</span>
          ) : null}
          {post.isPinned ? <span className={`${styles.badge} ${styles.badgePin}`}>{en.forum.pinned}</span> : null}
          {post.isLocked ? <span className={styles.badge}>{en.forum.locked}</span> : null}
        </div>
        <h2 className={styles.cardTitle}>
          <Link href={href}>{post.title}</Link>
        </h2>
        {post.hand ? (
          <Link href={href} className={styles.handStrip}>
            <HandCards hero={post.hand.heroCards} board={post.hand.boardCards} />
            <span className={styles.handLine}>{[post.hand.stakesLabel, post.hand.heroPosition].filter(Boolean).join(" · ")}</span>
          </Link>
        ) : null}
        <div className={styles.cardFoot}>
          <p className={styles.meta}>
            <Face username={post.author?.username ?? null} />
            {post.author ? (
              <Link href={paths.profile(post.author.username)} className={styles.author}>
                {post.author.username}
              </Link>
            ) : (
              <span>{en.forum.deletedAuthor}</span>
            )}
            <span className={styles.sep} aria-hidden="true" />
            <time dateTime={post.createdAt}>{formatPostDate(post.createdAt, en.chrome.intl)}</time>
          </p>
          <span className={`${styles.sep} ${styles.footSep}`} aria-hidden="true" />
          <Link href={`${href}#comments`} className={styles.replies} aria-label={en.forum.commentCount(post.commentCount)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.4A8.5 8.5 0 1 1 21 12z" />
            </svg>
            <span className={styles.repliesFull}>{en.forum.commentCount(post.commentCount)}</span>
            <span className={styles.repliesNum} aria-hidden="true">
              {post.commentCount}
            </span>
          </Link>
        </div>
      </div>
    </article>
  );
}
