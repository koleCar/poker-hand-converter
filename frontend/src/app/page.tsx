import type { Metadata } from "next";
import { Feed, parseFeedParams } from "../components/forum/Feed";
import { ServerFrame } from "../components/shell/ServerFrame";
import { en } from "../lib/i18n/en";
import { paths } from "../lib/routes";
import { readBoards, readFeed } from "../lib/server/forum";

/**
 * `/` — the forum, every board.
 *
 * This was a placeholder saying the feed was on its way (#27 moved the
 * converter to `/convert` so that this page could become exactly this).
 *
 * Server-rendered as `anon`: the HTML is the same for every visitor, and the
 * one per-user thing on it — which arrows are yours — is an island.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const { page } = parseFeedParams(await searchParams);
  return {
    title: en.forum.metaHomeTitle,
    description: en.forum.metaHomeDescription,
    alternates: { canonical: paths.home(), types: { "application/rss+xml": "/feed.xml" } },
    // Crawlable paging stops at ten pages; past that, follow but do not index.
    robots: { index: page <= 10, follow: true },
  };
}

export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const { sort, after, page } = parseFeedParams(params);
  const [boards, data] = await Promise.all([readBoards(), readFeed(null, sort, after)]);

  return (
    <ServerFrame tab="forum">
      {params.auth === "failed" ? <p className="notice notice--warn">{en.auth.callbackFailed}</p> : null}
      <Feed board={null} boards={boards} sort={sort} page={page} data={data} heading={en.forum.allBoards} />
    </ServerFrame>
  );
}
