import type { Metadata } from "next";
import { Feed, parseFeedParams } from "../../components/forum/Feed";
import { ForumLayout } from "../../components/forum/ForumLayout";
import { ServerFrame } from "../../components/shell/ServerFrame";
import { getDict } from "../../lib/i18n/server";
import { paths } from "../../lib/routes";
import { readBoardCounts, readBoards, readFeed } from "../../lib/server/forum";
import { Dismissible } from "@rail/ui/notice/Dismissible";

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
  const en = await getDict();
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
  const en = await getDict();
  const params = await searchParams;
  const { sort, filters, after, page } = parseFeedParams(params);
  const [boards, counts, data, top, waiting] = await Promise.all([
    readBoards(),
    readBoardCounts(),
    readFeed(null, sort, after, filters.kind, filters.unanswered),
    readFeed(null, "top", null, null, false, 5),
    readFeed(null, "new", null, null, true, 5),
  ]);

  return (
    <ServerFrame tab="forum">
      {params.auth === "failed" ? <Dismissible className="notice notice--warn">{en.auth.callbackFailed}</Dismissible> : null}
      <ForumLayout
        t={en}
        boards={boards}
        counts={counts}
        current={null}
        nav={filters.unanswered ? "unanswered" : "everything"}
        rail={{ top: top?.posts ?? [], waiting: waiting?.posts ?? [] }}
      >
        <Feed t={en} board={null} sort={sort} filters={filters} page={page} data={data} heading={en.forum.allBoards} />
      </ForumLayout>
    </ServerFrame>
  );
}
