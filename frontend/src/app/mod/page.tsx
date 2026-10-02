import type { Metadata } from "next";
import { ModScreen } from "./ModScreen";
import { getDict } from "../../lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return { title: en.moderation.modTitle, robots: { index: false, follow: false } };
}

/** The mod queue. Client-rendered: everything on it is gated per caller by the RPCs. */
export default function ModPage() {
  return <ModScreen />;
}
