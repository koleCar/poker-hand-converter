import type { Metadata } from "next";
import { NotFoundScreen } from "./NotFoundScreen";
import { getDict } from "../lib/i18n/server";

/**
 * 404, rendered inside the app shell.
 *
 * Next serves this for anything the file-system router does not match, which
 * replaces the old matcher's `{ name: "not-found" }` branch and the
 * `NotFoundPage` it rendered inside `AppPage`. The copy and the two escape
 * hatches are unchanged.
 */
export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.notFound.title,
    description: en.meta.notFound.description,
    robots: { index: false, follow: true },
  };
}

export default function NotFound() {
  return <NotFoundScreen />;
}
