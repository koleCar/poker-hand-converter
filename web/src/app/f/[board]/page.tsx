import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Feed, parseFeedParams } from "../../../components/forum/Feed";
import { ForumLayout } from "../../../components/forum/ForumLayout";
import { ServerFrame } from "../../../components/shell/ServerFrame";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";
import { readBoardCounts, readBoards, readFeed } from "../../../lib/server/forum";

type Params = Promise<{ board: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: SearchParams }): Promise<Metadata> {
  const en = await getDict();
  const { board } = await params;
  const { page } = parseFeedParams(await searchParams);
  const found = (await readBoards()).find((entry) => entry.slug === board);
  if (!found) return { title: en.meta.notFound.title, robots: { index: false, follow: true } };
  return {
    title: en.forum.metaBoardTitle(found.name),
    description: en.forum.metaBoardDescription(found.name, found.description),
    alternates: {
      canonical: paths.board(found.slug),
      types: { "application/rss+xml": `${paths.board(found.slug)}/feed.xml` },
    },
    robots: { index: page <= 10, follow: true },
  };
}

export default async function BoardPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const en = await getDict();
  const { board } = await params;
  const { sort, filters, after, page } = parseFeedParams(await searchParams);
  const boards = await readBoards();
  const found = boards.find((entry) => entry.slug === board);
  if (!found) notFound();
  const [counts, data, top, waiting] = await Promise.all([
    readBoardCounts(),
    readFeed(found.slug, sort, after, filters.kind, filters.unanswered),
    readFeed(found.slug, "top", null, null, false, 5),
    readFeed(found.slug, "new", null, null, true, 5),
  ]);

  return (
    <ServerFrame tab="forum">
      <ForumLayout
        t={en}
        boards={boards}
        counts={counts}
        current={found.slug}
        nav="board"
        rail={{ top: top?.posts ?? [], waiting: waiting?.posts ?? [] }}
      >
        <Feed t={en} board={found} sort={sort} filters={filters} page={page} data={data} heading={found.name} />
      </ForumLayout>
    </ServerFrame>
  );
}
