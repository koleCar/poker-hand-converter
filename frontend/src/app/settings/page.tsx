import type { Metadata } from "next";
import { SettingsScreen } from "./SettingsScreen";
import { en } from "../../lib/i18n/en";
import { paths } from "../../lib/routes";

/**
 * Account settings: the username, and whether the account may post.
 *
 * Client-rendered like `/library` and `/stats`: everything on it is one
 * account's own state, read through `my_profile()`, and there is nothing a
 * crawler or a shared render could use.
 */
export const metadata: Metadata = {
  title: en.settings.metaTitle,
  description: en.settings.metaDescription,
  alternates: { canonical: paths.settings() },
  robots: { index: false, follow: false },
};

export default function SettingsPage() {
  return <SettingsScreen />;
}
