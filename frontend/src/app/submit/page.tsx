import type { Metadata } from "next";
import { SubmitScreen } from "./SubmitScreen";
import { en } from "../../lib/i18n/en";
import { paths } from "../../lib/routes";
import { readBoards } from "../../lib/server/forum";
import { readPublishedHand } from "../../lib/server/published";

export const metadata: Metadata = {
  title: en.forum.submit.metaTitle,
  alternates: { canonical: paths.submit() },
  robots: { index: false, follow: false },
};

/**
 * New post. `?hand=<published id>` arrives from the publish dialog and attaches
 * that hand; `create_post` re-checks that it is the caller's own.
 */
export default async function SubmitPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const handId = typeof params.hand === "string" ? params.hand : null;
  const boardParam = typeof params.board === "string" ? params.board : null;
  const [boards, hand] = await Promise.all([readBoards(), handId ? readPublishedHand(handId) : Promise.resolve(null)]);
  const attached =
    hand && hand.status === "ok"
      ? {
          publicId: hand.hand.publicId,
          label: hand.hand.title ?? [hand.hand.stakesLabel, hand.hand.heroPosition].filter(Boolean).join(" · "),
          title: hand.hand.title,
          phf: hand.hand.phf,
        }
      : null;
  return <SubmitScreen boards={boards} attached={attached} initialBoard={boardParam} />;
}
