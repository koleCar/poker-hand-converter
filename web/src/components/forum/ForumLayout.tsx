/**
 * Forum v2's frame: the board sidebar on the left, the page in the middle and,
 * on a wide screen, a rail of top and unanswered posts on the right.
 *
 * Server-rendered like the rest of the forum. On a phone the sidebar folds
 * into a "Boards and filters" disclosure above the page, and the rail goes.
 */

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { boardHue } from "../../lib/forum/boards";
import type { Board, FeedFilters, ForumPost } from "../../lib/forum/types";
import type { Dict } from "../../lib/i18n/types";
import { paths } from "../../lib/routes";
import { NavPending } from "../shell/NavProgress";
import { feedHref } from "./Feed";
import styles from "./forum.module.css";

export type ForumNav = "everything" | "unanswered" | "saved" | "board" | "post";

interface ForumLayoutProps {
  t: Dict;
  boards: Board[];
  counts: Record<string, number>;
  /** The board being read, or the board of the post being read. */
  current: string | null;
  nav: ForumNav;
  rail?: { top: ForumPost[]; waiting: ForumPost[] } | null;
  children: ReactNode;
}

function hueStyle(slug: string): CSSProperties {
  return { "--hue": boardHue(slug) } as CSSProperties;
}

const NO_FILTERS: FeedFilters = { kind: null, unanswered: false };

function SideNav({ t: en, boards, counts, current, nav }: Omit<ForumLayoutProps, "rail" | "children">) {
  return (
    <>
      <form action={paths.search()} method="get" className={styles.sideSearch} role="search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input name="q" type="search" placeholder={en.forum.searchPlaceholder} aria-label={en.forum.search} />
      </form>
      <Link href={paths.submit()} className={`btn btn--primary ${styles.sideNew}`}>
        {en.forum.newPost}
      </Link>

      <nav className={styles.nav} aria-label={en.forum.nav.label}>
        <Link href={paths.home()} className={styles.navLink} aria-current={nav === "everything" ? "page" : undefined}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 3l2.4 5.6L20 9.3l-4.4 3.9 1.3 5.8L12 16l-4.9 3 1.3-5.8L4 9.3l5.6-.7z" />
          </svg>
          {en.forum.nav.everything}
          <NavPending mark={false} />
        </Link>
        <Link
          href={feedHref(null, "new", null, 1, { kind: null, unanswered: true })}
          className={styles.navLink}
          aria-current={nav === "unanswered" ? "page" : undefined}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.4A8.5 8.5 0 1 1 21 12z" />
          </svg>
          {en.forum.nav.unanswered}
          <NavPending mark={false} />
        </Link>
        <Link href={paths.saved()} className={styles.navLink} aria-current={nav === "saved" ? "page" : undefined}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 3.5h12v17l-6-4-6 4z" />
          </svg>
          {en.forum.nav.saved}
        </Link>
      </nav>

      <nav className={styles.nav} aria-label={en.forum.nav.boards}>
        <span className={styles.navSection}>{en.forum.nav.boards}</span>
        {boards.map((board) => (
          <Link
            key={board.slug}
            href={feedHref(board.slug, "hot", null, 1, NO_FILTERS)}
            className={styles.navLink}
            style={hueStyle(board.slug)}
            aria-current={current === board.slug && (nav === "board" || nav === "post") ? "page" : undefined}
            title={board.description ?? undefined}
          >
            <span className={styles.navDot} aria-hidden="true" />
            {board.name}
            <span className={styles.navCount}>{counts[board.slug] ?? ""}</span>
            <NavPending mark={false} />
          </Link>
        ))}
      </nav>
    </>
  );
}

function RailList({ title, posts, empty, points }: { title: string; posts: ForumPost[]; empty: string; points: (score: number) => string }) {
  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>{title}</h2>
      {posts.length ? (
        <ol className={styles.railList}>
          {posts.map((post) => (
            <li key={post.publicId}>
              <Link href={paths.post(post.board.slug, post.publicId, post.slug)} className={styles.railItem} style={hueStyle(post.board.slug)}>
                <span className={styles.navDot} aria-hidden="true" />
                <span className={styles.railText}>
                  <span className={styles.railTitle}>{post.title}</span>
                  <span className={styles.railMeta}>
                    {post.board.name} · {points(post.upvotes - post.downvotes)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.railMeta}>{empty}</p>
      )}
    </section>
  );
}

export function ForumLayout({ t: en, boards, counts, current, nav, rail, children }: ForumLayoutProps) {
  const side = { t: en, boards, counts, current, nav };
  return (
    <div className={styles.shell}>
      <aside className={styles.side} aria-label={en.forum.nav.label}>
        <SideNav {...side} />
      </aside>
      <details className={styles.sideMenu}>
        <summary>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h10" />
          </svg>
          {en.forum.nav.menu}
        </summary>
        <div className={styles.sideMenuBody}>
          <SideNav {...side} />
        </div>
      </details>
      <div className={styles.main}>{children}</div>
      {rail ? (
        <aside className={styles.rail} aria-label={en.forum.rail.top}>
          <RailList title={en.forum.rail.top} posts={rail.top} empty={en.forum.rail.none} points={en.forum.points} />
          <RailList title={en.forum.rail.waiting} posts={rail.waiting} empty={en.forum.rail.none} points={en.forum.points} />
        </aside>
      ) : null}
    </div>
  );
}
