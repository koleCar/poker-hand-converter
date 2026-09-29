import type { Metadata } from "next";
import { LibraryScreen } from "./LibraryScreen";
import { en } from "../../lib/i18n/en";
import { paths } from "../../lib/routes";

/**
 * The library — browse, filter and replay saved hands.
 *
 * Used to be `/replay`; `/replay`, `/replayer` and `/hands` all 308 here from
 * `next.config.ts`. The rename is #27's: the screen is a library with a
 * replayer in it, and calling it after the replayer made the *list* — which is
 * what people actually come for — look like a side panel.
 *
 * Not indexed, and not server-rendered with content: everything on it is one
 * account's own rows behind RLS. There is nothing here for a crawler and
 * nothing a shared render could safely cache.
 */
export const metadata: Metadata = {
  title: en.meta.library.title,
  description: en.meta.library.description,
  alternates: { canonical: paths.library() },
  robots: { index: false, follow: true },
};

export default function LibraryPage() {
  return <LibraryScreen />;
}
