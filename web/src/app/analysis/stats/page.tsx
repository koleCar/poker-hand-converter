import type { Metadata } from "next";
import { StatsScreen } from "./StatsScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * Analytics (docs/ANALYTICS.md): your stats against their targets, a section
 * of Analysis. Private and not indexed, like the rest of `/analysis`.
 */
export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.analysisStats.title,
    description: en.meta.analysisStats.description,
    alternates: { canonical: paths.analysisStats() },
    robots: { index: false, follow: false },
  };
}

export default function AnalysisStatsPage() {
  return <StatsScreen />;
}
