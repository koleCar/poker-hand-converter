import type { Metadata } from "next";
import { DeleteAccountScreen } from "./DeleteAccountScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * Deleting the account, on its own page (2026-11-16): Settings ends in one
 * danger-zone row that links here. Client-rendered like `/settings`: it is one
 * account's own state.
 */
export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.yourData.delete.metaTitle,
    alternates: { canonical: paths.deleteAccount() },
    robots: { index: false, follow: false },
  };
}

export default function DeleteAccountPage() {
  return <DeleteAccountScreen />;
}
