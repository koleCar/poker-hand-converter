/**
 * A feed page (forum v2): the board header, one sort-and-filter bar, the posts
 * and crawlable paging. The board list lives in `ForumLayout`'s sidebar.
 *
 * Paging is keyset (`?after=<cursor>`), exposed as real `<a href>` links with a
 * `<link rel="next">`, so a crawler walks it like a person would. Crawlable
 * depth is capped at ten pages — past that the page is `noindex, follow`
 * (decided by the route's metadata from `?page=`). Filters are plain query
 * parameters too (`?kind=hand&unanswered=1`), so a filtered feed is a link.
 */

import Link from "next/link";
import type { CSSProperties } from "react";
import { boardHue } from "../../lib/forum/boards";
import type { Board, FeedFilters, FeedKind, FeedPage, FeedSort } from "../../lib/forum/types";
import type { Dict } from "../../lib/i18n/types";
import { paths } from "../../lib/routes";
import { BoardsButton } from "./BoardsSheet";
import { MyVotesProvider } from "./MyVotes";
import { PostCard } from "./PostCard";
import { NavPending, PendingDims, PendingLoader, PendingScope } from "../shell/NavProgress";
import styles from "./forum.module.css";

const SORTS: FeedSort[] = ["hot", "new", "top"];
const KINDS: Array<FeedKind | null> = [null, "hand", "poll", "text"];
const NO_FILTERS: FeedFilters = { kind: null, unanswered: false };

export function feedHref(
  board: string | null,
  sort: FeedSort,
  after?: string | null,
  page?: number,
  filters: FeedFilters = NO_FILTERS,
): string {
  const base = board ? paths.board(board) : paths.home();
  const params = new URLSearchParams();
  if (sort !== "hot") params.set("sort", sort);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.unanswered) params.set("unanswered", "1");
  if (after) params.set("after", after);
  if (after && page && page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function Feed({
  board,
  sort,
  filters,
  page,
  data,
  heading,
  t: en,
}: {
  board: Board | null;
  sort: FeedSort;
  filters: FeedFilters;
  page: number;
  data: FeedPage | null;
  heading: string;
  t: Dict;
}) {
  const slug = board?.slug ?? null;
  const posts = data?.posts ?? [];
  const nextHref = data?.next ? feedHref(slug, sort, data.next, page + 1, filters) : null;
  const filtered = filters.kind !== null || filters.unanswered;

  return (
    <div className={styles.feedPage}>
      {nextHref ? <link rel="next" href={nextHref} /> : null}
      <h1 className={styles.visuallyHidden}>{heading}</h1>

      {board ? (
        <header className={styles.boardHead} style={{ "--hue": boardHue(board.slug) } as CSSProperties}>
          <span className={styles.navDot} aria-hidden="true" />
          <span className={styles.boardName}>{board.name}</span>
          {board.description ? <span className={styles.boardDesc}>{board.description}</span> : null}
        </header>
      ) : null}

      {/* A sort, a filter or a page is a navigation: the list dims while it is on its way. */}
      <PendingScope>
        <div className={styles.filterBar} role="toolbar" aria-label={en.forum.filters.label}>
          <BoardsButton
            label={board?.name ?? en.forum.allBoards}
            menuLabel={en.forum.nav.menu}
            hue={board ? boardHue(board.slug) : undefined}
          />
          <nav className={styles.seg} aria-label={en.forum.sorts.hot}>
            {SORTS.map((value) => (
              <Link key={value} href={feedHref(slug, value, null, 1, filters)} aria-current={sort === value ? "page" : undefined}>
                {en.forum.sorts[value]}
                <NavPending mark={false} />
              </Link>
            ))}
          </nav>
          <span className={styles.barRule} aria-hidden="true" />
          <nav className={styles.kinds} aria-label={en.forum.filters.label}>
            {KINDS.map((kind) => (
              <Link
                key={kind ?? "all"}
                href={feedHref(slug, sort, null, 1, { ...filters, kind })}
                className={styles.filterChip}
                aria-current={filters.kind === kind ? "page" : undefined}
              >
                {en.forum.filters.kinds[kind ?? "all"]}
                <NavPending mark={false} />
              </Link>
            ))}
            <Link
              href={feedHref(slug, sort, null, 1, { ...filters, unanswered: !filters.unanswered })}
              className={styles.filterChip}
              aria-current={filters.unanswered ? "page" : undefined}
            >
              {en.forum.filters.unanswered}
              <NavPending mark={false} />
            </Link>
          </nav>
          <span className={styles.barSpacer} />
          {filtered ? (
            <Link href={feedHref(slug, sort, null, 1, NO_FILTERS)} className={styles.clearLink}>
              {en.forum.filters.clear}
            </Link>
          ) : null}
          <PendingLoader label={en.loading.route.feed} />
        </div>

        <MyVotesProvider postIds={posts.map((post) => post.publicId)}>
          <PendingDims className={styles.feed}>
            {posts.length ? (
              posts.map((post, index) => <PostCard key={post.publicId} post={post} t={en} index={index} />)
            ) : (
              <div className={styles.emptyPanel}>
                <p>{filtered ? en.forum.filters.empty : en.forum.empty}</p>
                {filtered ? (
                  <Link href={feedHref(slug, sort, null, 1, NO_FILTERS)} className="btn btn--sm">
                    {en.forum.filters.clear}
                  </Link>
                ) : null}
              </div>
            )}
          </PendingDims>
        </MyVotesProvider>

        <div className={styles.pager}>
          {page > 1 ? (
            <Link href={feedHref(slug, sort, null, 1, filters)} className="btn btn--ghost btn--sm">
              {en.forum.first}
              <NavPending mark={false} />
            </Link>
          ) : null}
          {nextHref ? (
            <Link href={nextHref} className="btn btn--sm" rel="next">
              {en.forum.next}
              <NavPending mark={false} />
            </Link>
          ) : null}
        </div>
      </PendingScope>

      {/* Phone only: the sidebar's "New post" lives in the sheet, so the feed keeps one in reach of a thumb. */}
      <Link href={paths.submit()} className={styles.fab} aria-label={en.forum.newPost}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </Link>
    </div>
  );
}

export function parseFeedParams(params: Record<string, string | string[] | undefined>) {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const rawSort = first(params.sort);
  const sort: FeedSort = rawSort === "new" || rawSort === "top" ? rawSort : "hot";
  const rawKind = first(params.kind);
  const kind: FeedKind | null = rawKind === "hand" || rawKind === "poll" || rawKind === "text" ? rawKind : null;
  const unanswered = first(params.unanswered) === "1";
  const after = first(params.after) ?? null;
  const page = Math.max(1, Math.min(10_000, Number.parseInt(first(params.page) ?? "1", 10) || 1));
  const filters: FeedFilters = { kind, unanswered };
  return { sort, filters, after: after && after.length < 120 ? after : null, page };
}
