import type { Metadata } from "next";
import { BombScreen } from "./BombScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * analysis/45: the bomb pots on their own (design `ideas-potkinds` C).
 * Private and not indexed, like the rest of `/analysis`.
 */
export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.analysisBomb.title,
    description: en.meta.analysisBomb.description,
    alternates: { canonical: paths.analysisBomb() },
    robots: { index: false, follow: false },
  };
}

export default function AnalysisBombPage() {
  return <BombScreen />;
}
