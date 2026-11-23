import type { Metadata } from "next";
import { StatsScreen } from "../StatsScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * One stat's drill-down on the Analytics screen (docs/ANALYTICS.md Step 8).
 *
 * The same screen as `/stats`: it reads the stat from the address
 * (`drillOfPath`), so moving between the tabs and a drill-down from inside
 * the screen is a history entry (`history.pushState`), not a new page, and
 * the filter and the tab stay. Typed or reloaded, this route opens the same
 * screen at the drill-down with the default filter.
 */
export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.stats.title,
    description: en.meta.stats.description,
    alternates: { canonical: paths.stats() },
    robots: { index: false, follow: true },
  };
}

export default function StatDrillPage() {
  return <StatsScreen />;
}
