import type { Metadata } from "next";
import { EmbedFrame, EmbedGone } from "../../../../components/embed/EmbedFrame";
import { ReplayViewer } from "../../../../components/replayer/ReplayViewer";
import { decodePosition, POSITION_PARAM } from "../../../../components/replayer/position";
import { getDict } from "../../../../lib/i18n/server";
import { getParser } from "../../../../lib/parsers";
import { canonicalUrl, paths } from "../../../../lib/routes";
import { readPublishedHand } from "../../../../lib/server/published";

/**
 * A published hand, embeddable (#52). `/p/:id` is the page; this is the same
 * hand as nothing but a replayer, for an `<iframe>` on 2+2, a blog, a Notion
 * page. The framing permission is set for `/embed/*` only, in `next.config.ts`.
 *
 * `noindex`: the canonical copy is `/p/:id`, and a search result that opens a
 * bare replayer with no context is a worse result than the page.
 */
interface PageProps {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const en = await getDict();
  const { publicId } = await params;
  return {
    title: en.embed.title,
    robots: { index: false, follow: true },
    alternates: { canonical: canonicalUrl(paths.publishedHand(publicId)) },
  };
}

export default async function EmbedPublishedHand({ params, searchParams }: PageProps) {
  const en = await getDict();
  const { publicId } = await params;
  const rawT = (await searchParams)[POSITION_PARAM];
  const initialPosition = decodePosition(Array.isArray(rawT) ? rawT[0] : rawT);
  const result = await readPublishedHand(publicId);
  const href = canonicalUrl(paths.publishedHand(publicId));

  // A poll's hand is sealed (#51): an embed would be a way round the vote.
  if (result.status !== "ok") {
    return <EmbedGone t={en} href={href} />;
  }
  const hand = result.hand.phf;
  return (
    <EmbedFrame t={en} href={href}>
      <ReplayViewer
        hand={hand}
        site={getParser(hand.meta.siteId)?.name ?? null}
        mode="embed"
        initialPosition={initialPosition}
      />
    </EmbedFrame>
  );
}
