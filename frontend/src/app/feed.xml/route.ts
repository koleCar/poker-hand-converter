import { rssDocument, RSS_HEADERS } from "../../lib/feed/rss";
import { en } from "../../lib/i18n/en";
import { paths } from "../../lib/routes";
import { readFeed } from "../../lib/server/forum";

/** `/feed.xml`: the newest threads on every board (#55). */
export const revalidate = 600;

export async function GET(): Promise<Response> {
  const page = await readFeed(null, "new", null);
  return new Response(
    rssDocument({
      title: en.brand.name,
      description: en.brand.tagline,
      selfPath: "/feed.xml",
      linkPath: paths.home(),
      posts: page?.posts ?? [],
    }),
    { headers: RSS_HEADERS },
  );
}
