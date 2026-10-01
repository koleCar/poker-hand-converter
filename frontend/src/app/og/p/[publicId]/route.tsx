import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE } from "../../../../components/og/OgCard";
import { formatStakes, shortGameName } from "../../../../components/share/preview";
import { en } from "../../../../lib/i18n/en";
import { getParser } from "../../../../lib/parsers";
import { readPublishedHand } from "../../../../lib/server/published";

/**
 * The social card for a published hand (#55): the stakes, the game, the
 * hero's seat and cards — what is known at the deal, and nothing the hand
 * goes on to reveal. A sealed poll's hand gets the question instead.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const result = await readPublishedHand(publicId);
  if (result.status === "poll") {
    return new ImageResponse(
      <OgCard eyebrow={en.og.poll} title={en.og.pollTitle} facts={[en.og.pollFacts]} badge={en.og.poll} />,
      { ...OG_SIZE, headers: CACHE },
    );
  }
  if (result.status !== "ok") {
    return new ImageResponse(<OgCard eyebrow={en.og.handEyebrow} title={en.og.handFallback} facts={[]} />, OG_SIZE);
  }
  const published = result.hand;
  const hand = published.phf;
  const hero = hand.players.find((player) => player.isHero);
  return new ImageResponse(
    <OgCard
      eyebrow={getParser(published.site)?.name ?? published.site}
      title={published.title ?? `${formatStakes(hand)} ${shortGameName(hand.game.label)}`}
      facts={[
        en.og.handed(hand.players.length),
        hero?.position ? en.og.hero(hero.position) : "",
        published.title ? formatStakes(hand) : "",
      ]}
      cards={hero?.holeCards ?? []}
    />,
    { ...OG_SIZE, headers: CACHE },
  );
}

const CACHE = { "cache-control": "public, max-age=3600, stale-while-revalidate=86400" };
