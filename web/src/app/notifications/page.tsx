import type { Metadata } from "next";
import { NotificationsScreen } from "./NotificationsScreen";
import { getDict } from "../../lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return { title: en.social.notificationsTitle, robots: { index: false, follow: false } };
}

export default function NotificationsPage() {
  return <NotificationsScreen />;
}
