import type { Metadata } from "next";
import { MyChartsScreen } from "./MyChartsScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * Your own preflop charts (R5.3, `docs/RAIL-PLAN.md` Phase 5): build or
 * import chart sets and compare them with the hands you played.
 *
 * Private and not indexed, like the rest of `/analysis` but the public learn
 * and charts pages (`robots.ts`): a user's charts are their own data behind
 * RLS. The open set, view, situation and period live in the query string.
 */

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.analysisMyCharts.title,
    description: en.meta.analysisMyCharts.description,
    alternates: { canonical: paths.analysisMyCharts() },
    robots: { index: false, follow: false },
  };
}

export default async function AnalysisMyChartsPage({ searchParams }: PageProps) {
  return <MyChartsScreen query={await searchParams} />;
}
