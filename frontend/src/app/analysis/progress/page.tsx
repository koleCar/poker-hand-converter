import type { Metadata } from "next";
import { ProgressScreen } from "./ProgressScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * Progress: score and EV lost over time (`docs/ANALYSIS-PLAN.md` §6.0 *score
 * trend*, §6.3, phase A6).
 *
 * Private and not indexed, like `/analysis`. The filters and the view
 * (bucket, split, metric) live in the query string, read here so the first
 * render is the chart the address names.
 */

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.analysisProgress.title,
    description: en.meta.analysisProgress.description,
    alternates: { canonical: paths.analysisProgress() },
    robots: { index: false, follow: false },
  };
}

export default async function AnalysisProgressPage({ searchParams }: PageProps) {
  return <ProgressScreen query={await searchParams} />;
}
