/**
 * The thread, server-rendered in `get_post_comments` order — depth-first by
 * path, top-level comments by the chosen sort. Indentation is the depth; there
 * is no client-side tree building to disagree with the server's.
 *
 * Tombstones render in place so replies stay under the thing they answered.
 */

import Link from "next/link";
import { anchorLabel } from "../../lib/forum/anchor";
import type { ForumComment } from "../../lib/forum/types";
import type { Dict } from "../../lib/i18n/types";
import type { PhfHand } from "../../lib/phf/types";
import { paths } from "../../lib/routes";
import { CommentActions } from "./CommentActions";
import { formatPostDate } from "./format";
import { AnchorChip } from "./PostDiscussion";
import { PostText } from "./PostText";
import { Revisions } from "./Revisions";
import { VoteButtons } from "./VoteButtons";
import styles from "./forum.module.css";

export function CommentThread({
  post,
  comments,
  hand,
  locked,
  permalink,
  t: en,
}: {
  post: string;
  comments: ForumComment[];
  hand: PhfHand | null;
  locked: boolean;
  permalink: (seq: number) => string;
  /** The strings, from the caller: this renders from a server page and from `PollThread`. */
  t: Dict;
}) {
  return (
    <ol className={styles.thread}>
      {comments.map((comment) => {
        const gone = comment.deleted || comment.removed || comment.body === null;
        const label = anchorLabel(hand, comment.anchor, en.forum.anchorAfter);
        return (
          <li
            key={comment.seq}
            id={`c-${comment.seq}`}
            className={styles.comment}
            style={{ marginLeft: `${Math.min(comment.depth - 1, 9) * 16}px` }}
          >
            {gone ? (
              <p className={styles.tombstone}>{comment.removed ? en.forum.comments.removed : en.forum.comments.deleted}</p>
            ) : (
              <>
                <p className={styles.meta}>
                  {comment.author ? (
                    <Link href={paths.profile(comment.author.username)}>{comment.author.username}</Link>
                  ) : (
                    en.forum.deletedAuthor
                  )}
                  <span aria-hidden="true">·</span>
                  <Link href={permalink(comment.seq)}>
                    <time dateTime={comment.createdAt}>{formatPostDate(comment.createdAt, en.chrome.intl)}</time>
                  </Link>
                  {comment.editedAt ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <Revisions post={post} seq={comment.seq} />
                    </>
                  ) : null}
                  {label && comment.anchor ? (
                    <AnchorChip actionIndex={comment.anchor.actionIndex} street={comment.anchor.street} label={label} />
                  ) : null}
                </p>
                <PostText body={comment.body} />
                <div className={styles.commentFoot}>
                  <VoteButtons
                    post={post}
                    seq={comment.seq}
                    upvotes={comment.upvotes}
                    downvotes={comment.downvotes}
                    disabled={locked}
                    compact
                  />
                  <CommentActions
                    post={post}
                    seq={comment.seq}
                    author={comment.author?.username ?? null}
                    canReply={comment.depth < 10}
                    locked={locked}
                  />
                </div>
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}
