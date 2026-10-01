import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Feed, parseFeedParams } from "../../../components/forum/Feed";
import { ServerFrame } from "../../../components/shell/ServerFrame";
import { en } from "../../../lib/i18n/en";
import { paths } from "../../../lib/routes";
import { readBoards, readFeed } from "../../../lib/server/forum";

type Params = Promise<{ board: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: SearchParams }): Promise<Metadata> {
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
  const { board } = await params;
  const { sort, after, page } = parseFeedParams(await searchParams);
  const boards = await readBoards();
  const found = boards.find((entry) => entry.slug === board);
  if (!found) notFound();
  const data = await readFeed(found.slug, sort, after);

  return (
    <ServerFrame tab="forum">
      <Feed board={found} boards={boards} sort={sort} page={page} data={data} heading={found.name} />
    </ServerFrame>
  );
}
