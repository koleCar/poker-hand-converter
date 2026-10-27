import type { Metadata } from "next";
import { AnalysisScreen } from "./AnalysisScreen";
import { getDict } from "../../lib/i18n/server";
import { paths } from "../../lib/routes";

/**
 * The Analysis tab (`docs/ANALYSIS-PLAN.md` §6.0).
 *
 * Like `/stats`, deliberately not behind the library's empty-redirect gate: a
 * typed or bookmarked `/analysis` renders and explains itself — sign in, no
 * hands yet, not analysed yet, not set up on this database.
 *
 * Private and not indexed: everything on it is one account's own rows behind
 * RLS. The list's filters live in the query string, which is read here and
 * handed to the client so the first render is the list the address names.
 */

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.analysis.title,
    description: en.meta.analysis.description,
    alternates: { canonical: paths.analysis() },
    robots: { index: false, follow: false },
  };
}

export default async function AnalysisPage({ searchParams }: PageProps) {
  return <AnalysisScreen query={await searchParams} />;
}
