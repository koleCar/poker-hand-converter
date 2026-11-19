import type { Metadata } from "next";
import { MultiwayScreen } from "./MultiwayScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * analysis/45: the multiway pots on their own (design `ideas-potkinds` C).
 * Private and not indexed, like the rest of `/analysis`.
 */
export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.analysisMultiway.title,
    description: en.meta.analysisMultiway.description,
    alternates: { canonical: paths.analysisMultiway() },
    robots: { index: false, follow: false },
  };
}

export default function AnalysisMultiwayPage() {
  return <MultiwayScreen />;
}
