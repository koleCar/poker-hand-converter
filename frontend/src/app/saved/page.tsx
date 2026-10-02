import type { Metadata } from "next";
import { SavedScreen } from "./SavedScreen";
import { getDict } from "../../lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return { title: en.social.savedTitle, robots: { index: false, follow: false } };
}

export default function SavedPage() {
  return <SavedScreen />;
}
