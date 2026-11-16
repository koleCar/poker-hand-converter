import type { Metadata } from "next";
import { PostPreviewScreen } from "./PostPreviewScreen";
import { getDict } from "../../../lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: `${en.chrome.share.forum.preview.metaTitle} | Rail`,
    robots: { index: false, follow: false },
  };
}

/**
 * The post preview, opened in a new tab by "Post to the forum" in the share
 * popover: `?hand=<library row id>` or `?draft=<local draft key>`. Everything
 * here is the author's own and private until they press Post, so the page is
 * all client: it reads the hand with the author's session.
 */
export default async function PostPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const handId = typeof params.hand === "string" ? params.hand : null;
  const draftId = typeof params.draft === "string" ? params.draft : null;
  return <PostPreviewScreen handId={handId} draftId={draftId} />;
}
