/**
 * A feed page: board chips, sort, search, the posts, and crawlable paging.
 *
 * Paging is keyset (`?after=<cursor>`), exposed as real `<a href>` links with a
 * `<link rel="next">`, so a crawler walks it like a person would. Crawlable
 * depth is capped at ten pages — past that the page is `noindex, follow`
 * (decided by the route's metadata from `?page=`).
 */

import Link from "next/link";
import type { Board, FeedPage, FeedSort } from "../../lib/forum/types";
import { en } from "../../lib/i18n/en";
import { paths } from "../../lib/routes";
import { MyVotesProvider } from "./MyVotes";
import { PostCard } from "./PostCard";
import styles from "./forum.module.css";

const SORTS: FeedSort[] = ["hot", "new", "top"];

export function feedHref(board: string | null, sort: FeedSort, after?: string | null, page?: number): string {
  const base = board ? paths.board(board) : paths.home();
  const params = new URLSearchParams();
  if (sort !== "hot") params.set("sort", sort);
  if (after) params.set("after", after);
  if (after && page && page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function Feed({
  board,
  boards,
  sort,
  page,
  data,
  heading,
}: {
  board: Board | null;
  boards: Board[];
  sort: FeedSort;
  page: number;
  data: FeedPage | null;
  heading: string;
}) {
  const slug = board?.slug ?? null;
  const posts = data?.posts ?? [];
  const nextHref = data?.next ? feedHref(slug, sort, data.next, page + 1) : null;

  return (
    <div className="stack">
      {nextHref ? <link rel="next" href={nextHref} /> : null}

      <div className={styles.toolbar}>
        <h1 className={styles.postTitle}>{heading}</h1>
        <div className={styles.row}>
          <form action={paths.search()} method="get" className={styles.searchForm} role="search">
            <input name="q" type="search" placeholder={en.forum.searchPlaceholder} aria-label={en.forum.search} />
          </form>
          <Link href={paths.submit()} className="btn btn--primary btn--sm">
            {en.forum.newPost}
          </Link>
        </div>
      </div>

      {board?.description ? <p className="muted">{board.description}</p> : null}

      <nav className={styles.chips} aria-label={en.forum.allBoards}>
        <Link href={feedHref(null, sort)} className={styles.chipLink} aria-current={slug === null ? "page" : undefined}>
          {en.forum.allBoards}
        </Link>
        {boards.map((entry) => (
          <Link
            key={entry.slug}
            href={feedHref(entry.slug, sort)}
            className={styles.chipLink}
            aria-current={slug === entry.slug ? "page" : undefined}
          >
            {entry.name}
          </Link>
        ))}
      </nav>

      <nav className={styles.chips} aria-label={en.forum.sorts.hot}>
        {SORTS.map((value) => (
          <Link
            key={value}
            href={feedHref(slug, value)}
            className={styles.chipLink}
            aria-current={sort === value ? "page" : undefined}
          >
            {en.forum.sorts[value]}
          </Link>
        ))}
      </nav>

      <MyVotesProvider postIds={posts.map((post) => post.publicId)}>
        <div className={styles.feed}>
          {posts.length ? posts.map((post) => <PostCard key={post.publicId} post={post} />) : <p className="muted">{en.forum.empty}</p>}
        </div>
      </MyVotesProvider>

      <div className={styles.pager}>
        {page > 1 ? (
          <Link href={feedHref(slug, sort)} className="btn btn--ghost btn--sm">
            {en.forum.first}
          </Link>
        ) : null}
        {nextHref ? (
          <Link href={nextHref} className="btn btn--sm" rel="next">
            {en.forum.next}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function parseFeedParams(params: Record<string, string | string[] | undefined>) {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const rawSort = first(params.sort);
  const sort: FeedSort = rawSort === "new" || rawSort === "top" ? rawSort : "hot";
  const after = first(params.after) ?? null;
  const page = Math.max(1, Math.min(10_000, Number.parseInt(first(params.page) ?? "1", 10) || 1));
  return { sort, after: after && after.length < 120 ? after : null, page };
}
