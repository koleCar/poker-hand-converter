import type { Metadata } from "next";
import { LeaksScreen } from "./LeaksScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * Leaks: the spots that cost the most EV (`docs/ANALYSIS-PLAN.md` §6.0
 * *Leaks*, phase A6).
 *
 * Private and not indexed, like `/analysis`: every number on it is one
 * account's own decisions behind RLS (`robots.ts` keeps `/analysis` disallowed
 * apart from the public learn and charts pages). The filters, the ranking and
 * the open leak live in the query string, read here so the first render is
 * the list the address names.
 */

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.analysisLeaks.title,
    description: en.meta.analysisLeaks.description,
    alternates: { canonical: paths.analysisLeaks() },
    robots: { index: false, follow: false },
  };
}

export default async function AnalysisLeaksPage({ searchParams }: PageProps) {
  return <LeaksScreen query={await searchParams} />;
}
