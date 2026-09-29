import type { Metadata } from "next";
import { SavedScreen } from "./SavedScreen";
import { en } from "../../lib/i18n/en";

export const metadata: Metadata = { title: en.social.savedTitle, robots: { index: false, follow: false } };

export default function SavedPage() {
  return <SavedScreen />;
}
