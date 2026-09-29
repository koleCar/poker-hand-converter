import type { Metadata } from "next";
import { NotificationsScreen } from "./NotificationsScreen";
import { en } from "../../lib/i18n/en";

export const metadata: Metadata = { title: en.social.notificationsTitle, robots: { index: false, follow: false } };

export default function NotificationsPage() {
  return <NotificationsScreen />;
}
