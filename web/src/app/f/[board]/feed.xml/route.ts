import { rssDocument, RSS_HEADERS } from "../../../../lib/feed/rss";
import { getDict } from "../../../../lib/i18n/server";
import { paths } from "../../../../lib/routes";
import { readBoards, readFeed } from "../../../../lib/server/forum";

/** `/f/:board/feed.xml`: one board's newest threads (#55). */
export const revalidate = 600;

export async function GET(_request: Request, { params }: { params: Promise<{ board: string }> }): Promise<Response> {
  const en = await getDict();
  const { board } = await params;
  const found = (await readBoards()).find((entry) => entry.slug === board);
  if (!found) {
    return new Response("Not found", { status: 404 });
  }
  const page = await readFeed(found.slug, "new", null);
  return new Response(
    rssDocument({
      title: `${found.name} | ${en.brand.name}`,
      description: found.description ?? en.brand.tagline,
      selfPath: `${paths.board(found.slug)}/feed.xml`,
      linkPath: paths.board(found.slug),
      posts: page?.posts ?? [],
    }),
    { headers: RSS_HEADERS },
  );
}
