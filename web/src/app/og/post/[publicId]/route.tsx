import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE } from "../../../../components/og/OgCard";
import { getDict } from "../../../../lib/i18n/server";
import { getParser } from "../../../../lib/parsers";
import { readPost } from "../../../../lib/server/forum";

/**
 * The social card for a forum thread (#55). Read as `anon`, like the page: a
 * thread a stranger cannot see gets a generic card, not its title. A poll
 * shows its question and never the hand's cards (#51).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ publicId: string }> }) {
  const en = await getDict();
  const { publicId } = await params;
  const result = await readPost(publicId);
  if (result.status !== "ok") {
    return new ImageResponse(<OgCard t={en} eyebrow={en.og.forumEyebrow} title={en.og.threadFallback} facts={[]} />, OG_SIZE);
  }
  const post = result.post;
  const hand = post.poll ? null : post.hand;
  return new ImageResponse(
    <OgCard t={en}
      eyebrow={post.board.name}
      title={post.title}
      badge={post.poll ? en.og.pollTitle : undefined}
      facts={[
        post.author ? en.og.by(post.author.username) : "",
        hand ? [hand.stakesLabel, getParser(hand.site)?.name ?? hand.site].filter(Boolean).join(" ") : "",
        en.og.comments(post.commentCount),
      ]}
      cards={hand?.heroCards ?? []}
    />,
    { ...OG_SIZE, headers: { "cache-control": "public, max-age=600, stale-while-revalidate=86400" } },
  );
}
