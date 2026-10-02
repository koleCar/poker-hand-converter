/**
 * One post in a feed. Server-rendered; only the arrows are an island.
 */

import Link from "next/link";
import type { ForumPost } from "../../lib/forum/types";
import type { Dict } from "../../lib/i18n/types";
import { paths } from "../../lib/routes";
import { formatPostDate } from "./format";
import { VoteButtons } from "./VoteButtons";
import styles from "./forum.module.css";

export function PostCard({ post, t: en }: { post: ForumPost; t: Dict }) {
  const href = paths.post(post.board.slug, post.publicId, post.slug);
  return (
    <article className={styles.card}>
      <VoteButtons post={post.publicId} upvotes={post.upvotes} downvotes={post.downvotes} disabled={post.isLocked} />
      <div className={styles.cardBody}>
        <h2 className={styles.cardTitle}>
          {post.isPinned ? <span className={styles.badge}>{en.forum.pinned}</span> : null}
          {post.poll ? (
            <span className={styles.badge}>{en.forum.poll.badge(post.poll.votes)}</span>
          ) : post.kind === "hand" ? (
            <span className={styles.badge}>{en.forum.handBadge}</span>
          ) : null}
          <Link href={href}>{post.title}</Link>
        </h2>
        {post.hand ? (
          <p className={styles.handLine}>
            {[post.hand.stakesLabel, post.hand.heroPosition, post.hand.heroCards.join(" ")].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        <p className={styles.meta}>
          <Link href={paths.board(post.board.slug)}>{post.board.name}</Link>
          <span aria-hidden="true">·</span>
          <span>
            {en.forum.by}{" "}
            {post.author ? (
              <Link href={paths.profile(post.author.username)}>{post.author.username}</Link>
            ) : (
              en.forum.deletedAuthor
            )}
          </span>
          <span aria-hidden="true">·</span>
          <time dateTime={post.createdAt}>{formatPostDate(post.createdAt)}</time>
          <span aria-hidden="true">·</span>
          <Link href={`${href}#comments`}>{en.forum.commentCount(post.commentCount)}</Link>
          {post.isLocked ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{en.forum.locked}</span>
            </>
          ) : null}
        </p>
      </div>
    </article>
  );
}
