import type { Metadata } from "next";
import { StatsScreen } from "../StatsScreen";
import { getDict } from "../../../../lib/i18n/server";
import { paths } from "../../../../lib/routes";

/**
 * One stat's drill-down in Analytics (docs/ANALYTICS.md Step 8).
 *
 * The same screen as `/analysis/stats`: it reads the stat from the address
 * (`drillOfPath`), so moving between the tabs and a drill-down from inside
 * the screen is a history entry (`history.pushState`), not a new page, and
 * the filter and the tab stay. Typed or reloaded, this route opens the same
 * screen at the drill-down with the default filter.
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

export default function AnalysisStatDrillPage() {
  return <StatsScreen />;
}
