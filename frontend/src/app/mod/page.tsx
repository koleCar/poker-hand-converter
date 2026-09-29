import type { Metadata } from "next";
import { ModScreen } from "./ModScreen";
import { en } from "../../lib/i18n/en";

export const metadata: Metadata = { title: en.moderation.modTitle, robots: { index: false, follow: false } };

/** The mod queue. Client-rendered: everything on it is gated per caller by the RPCs. */
export default function ModPage() {
  return <ModScreen />;
}
