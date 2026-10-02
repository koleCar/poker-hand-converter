import type { Metadata } from "next";
import { ReportsScreen } from "./ReportsScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * Reports: your frequencies against the reference (`docs/ANALYSIS-PLAN.md`
 * §0.1 *Reports*, §6.3, phase A3).
 *
 * Private and not indexed, like `/analysis`: every number on it is one
 * account's own decisions behind RLS (`robots.ts` keeps `/analysis` disallowed
 * apart from the public learn and charts pages). The filters live in the
 * query string, read here so the first render is the report the address names.
 */

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.analysisReports.title,
    description: en.meta.analysisReports.description,
    alternates: { canonical: paths.analysisReports() },
    robots: { index: false, follow: false },
  };
}

export default async function AnalysisReportsPage({ searchParams }: PageProps) {
  return <ReportsScreen query={await searchParams} />;
}
