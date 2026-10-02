import type { Metadata } from "next";
import { EmbedFrame, EmbedGone } from "../../../../components/embed/EmbedFrame";
import { ReplayViewer } from "../../../../components/replayer/ReplayViewer";
import { decodePosition, POSITION_PARAM } from "../../../../components/replayer/position";
import { getDict } from "../../../../lib/i18n/server";
import { parseHand } from "../../../../lib/phf";
import { sharedHandUrl } from "../../../../lib/routes";
import { readShare } from "../../../../lib/server/shares";

/**
 * A share link, embeddable (#52). Same capability as `/h/:slug` — whoever has
 * the slug can see the hand — so embedding it grants nothing the link did not.
 * Never indexed, like the page it mirrors.
 */
interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.embed.title,
    robots: { index: false, follow: false },
  };
}

export default async function EmbedSharedHand({ params, searchParams }: PageProps) {
  const en = await getDict();
  const { slug } = await params;
  const rawT = (await searchParams)[POSITION_PARAM];
  const initialPosition = decodePosition(Array.isArray(rawT) ? rawT[0] : rawT);
  const result = await readShare(slug);
  const text = result.share?.standardText;
  const hand = text ? parseHand(text) : null;
  const href = sharedHandUrl(slug);

  if (!hand) {
    return <EmbedGone t={en} href={href} />;
  }
  return (
    <EmbedFrame t={en} href={href}>
      <ReplayViewer hand={hand} mode="embed" initialPosition={initialPosition} />
    </EmbedFrame>
  );
}
