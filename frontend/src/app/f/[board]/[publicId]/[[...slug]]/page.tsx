import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { CommentComposer } from "../../../../../components/forum/CommentComposer";
import { CommentThread } from "../../../../../components/forum/CommentThread";
import { LiveCommentBanner } from "../../../../../components/forum/LiveCommentBanner";
import { PostStateControls } from "../../../../../components/forum/PostStateControls";
import { formatPostDate } from "../../../../../components/forum/format";
import { MyVotesProvider } from "../../../../../components/forum/MyVotes";
import { PostActions } from "../../../../../components/forum/PostActions";
import { PostDiscussion } from "../../../../../components/forum/PostDiscussion";
import { PostText } from "../../../../../components/forum/PostText";
import { VoteButtons } from "../../../../../components/forum/VoteButtons";
import { HandSummary } from "../../../../../components/hand/HandSummary";
import { decodePosition, POSITION_PARAM } from "../../../../../components/replayer/position";
import { ServerFrame } from "../../../../../components/shell/ServerFrame";
import { discussionJsonLd, jsonLdScript } from "../../../../../lib/forum/jsonLd";
import { excerpt } from "../../../../../lib/forum/text";
import type { ForumPost } from "../../../../../lib/forum/types";
import { en } from "../../../../../lib/i18n/en";
import { getParser } from "../../../../../lib/parsers";
import { canonicalUrl, paths } from "../../../../../lib/routes";
import { readComments, readPost } from "../../../../../lib/server/forum";
import styles from "../../../../../components/forum/forum.module.css";

/**
 * A thread. `/f/<board>/<public_id>/<slug>`.
 *
 * ## The URL
 *
 * The id is the key; the board and the slug are decoration. Either one wrong
 * or stale — a title was edited, a post moved boards, somebody typed it — and
 * the page 308s to the canonical address, keeping `?t=`, so every link ever
 * shared keeps working and there is exactly one URL for `rel=canonical`.
 *
 * ## What makes it rank (#36)
 *
 * For a hand post, the first thing in the document is `HandSummary`: seats,
 * blinds, hero's cards, the action street by street, the result — real text
 * about real cards, rendered from the published (scrubbed) document. The
 * replayer is an island below it. Plus `DiscussionForumPosting` JSON-LD with
 * the comments nested, which is what Google's forum rich result reads.
 *
 * ## What is not in the HTML
 *
 * Anything about the visitor. The page is rendered as `anon`; which arrows are
 * yours, and whether the edit link is yours, are islands.
 */

type Params = Promise<{ board: string; publicId: string; slug?: string[] }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function postUrl(post: ForumPost): string {
  return canonicalUrl(paths.post(post.board.slug, post.publicId, post.slug));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { publicId } = await params;
  const result = await readPost(publicId);
  if (result.status !== "ok") {
    return { title: en.meta.notFound.title, robots: { index: false, follow: true } };
  }
  const post = result.post;
  const description =
    excerpt(post.body, 160) ||
    [post.hand?.stakesLabel, post.hand?.heroPosition, post.hand?.heroCards.join(" ")].filter(Boolean).join(" · ") ||
    en.forum.metaHomeDescription;
  const title = `${post.title} | ${post.board.name} | Rail`;
  return {
    title,
    description,
    alternates: { canonical: postUrl(post) },
    robots: { index: true, follow: true },
    openGraph: {
      type: "article",
      siteName: en.brand.name,
      title,
      description,
      url: postUrl(post),
      images: [{ url: "/og-default.png", width: 1200, height: 630 }],
    },
    twitter: { card: "summary_large_image", title, description, images: ["/og-default.png"] },
  };
}

export default async function PostPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { board, publicId, slug } = await params;
  const query = await searchParams;
  const result = await readPost(publicId);

  if (result.status === "not-found") {
    notFound();
  }
  if (result.status !== "ok") {
    const copy =
      result.status === "deleted"
        ? en.forum.post.deleted
        : result.status === "removed"
          ? en.forum.post.removed
          : en.forum.post.unavailable;
    return (
      <ServerFrame tab="forum">
        <section className="card stack">
          <h1 className={styles.postTitle}>{copy.heading}</h1>
          <p className="muted">{copy.body}</p>
          <div>
            <Link href={paths.home()} className="btn">
              {en.published.homeCta}
            </Link>
          </div>
        </section>
      </ServerFrame>
    );
  }

  const post = result.post;
  const canonicalPath = paths.post(post.board.slug, post.publicId, post.slug);
  const t = first(query[POSITION_PARAM]);
  if (board !== post.board.slug || (slug?.[0] ?? "") !== post.slug || (slug?.length ?? 0) > 1) {
    permanentRedirect(t ? `${canonicalPath}?${POSITION_PARAM}=${encodeURIComponent(t)}` : canonicalPath);
  }

  const sortParam = first(query.sort);
  const commentSort = sortParam === "new" || sortParam === "top" ? sortParam : "best";
  const comments = await readComments(post.publicId, commentSort);
  const hand = post.handPhf ?? null;
  const siteName = post.hand ? getParser(post.hand.site)?.name ?? post.hand.site : null;
  const permalink = (seq: number) => paths.comment(post.board.slug, post.publicId, post.slug, seq);

  const ld = discussionJsonLd({
    post,
    comments,
    url: postUrl(post),
    profileUrl: (username) => canonicalUrl(paths.profile(username)),
    boardUrl: canonicalUrl(paths.board(post.board.slug)),
    homeUrl: canonicalUrl(paths.home()),
    text: excerpt(post.body, 5000) || post.title,
  });

  return (
    <ServerFrame tab="forum">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
      <MyVotesProvider postIds={[post.publicId]} commentsOf={post.publicId}>
        <article className={styles.post}>
          <p className={styles.meta}>
            <Link href={paths.board(post.board.slug)}>{en.forum.post.backToBoard(post.board.name)}</Link>
          </p>
          <header className={styles.postHead}>
            <VoteButtons post={post.publicId} upvotes={post.upvotes} downvotes={post.downvotes} disabled={post.isLocked} />
            <div className="stack">
              <h1 className={styles.postTitle}>{post.title}</h1>
              <p className={styles.meta}>
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
                {post.editedAt ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{en.forum.edited}</span>
                  </>
                ) : null}
                {siteName ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{siteName}</span>
                  </>
                ) : null}
              </p>
              <PostStateControls post={post.publicId} />
              <PostActions
                publicId={post.publicId}
                board={post.board.slug}
                author={post.author?.username ?? null}
                title={post.title}
                body={post.body}
              />
            </div>
          </header>

          <PostText body={post.body} />

          {hand ? (
            <section className="card">
              <HandSummary hand={hand} />
            </section>
          ) : null}

          <PostDiscussion hand={hand} site={siteName} initialPosition={decodePosition(t)}>
            <section id="comments" className="stack">
              <div className={styles.toolbar}>
                <h2 className={styles.cardTitle}>{en.forum.comments.heading(post.commentCount)}</h2>
                <nav className={styles.chips}>
                  {(["best", "new", "top"] as const).map((value) => (
                    <Link
                      key={value}
                      href={value === "best" ? `${canonicalPath}#comments` : `${canonicalPath}?sort=${value}#comments`}
                      className={styles.chipLink}
                      aria-current={commentSort === value ? "page" : undefined}
                      rel="nofollow"
                    >
                      {en.forum.comments.sort[value]}
                    </Link>
                  ))}
                </nav>
              </div>
              <LiveCommentBanner
                post={post.publicId}
                knownSeq={comments.reduce((max, comment) => Math.max(max, comment.seq), 0)}
              />
              <CommentComposer post={post.publicId} locked={post.isLocked} />
              <CommentThread post={post.publicId} comments={comments} hand={hand} locked={post.isLocked} permalink={permalink} />
            </section>
          </PostDiscussion>
        </article>
      </MyVotesProvider>
    </ServerFrame>
  );
}
