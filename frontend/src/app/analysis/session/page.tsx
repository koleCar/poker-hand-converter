import type { Metadata } from "next";
import { SessionScreen } from "./SessionScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * Session review (R5.1, `docs/RAIL-PLAN.md` Phase 5): after a session, the
 * hands worth a look.
 *
 * Private and not indexed, like the rest of `/analysis`: every number on it
 * is one account's own hands behind RLS (`robots.ts` keeps `/analysis`
 * disallowed apart from the public learn and charts pages). The session and
 * the filter live in the query string, read here so the first render asks
 * for the session the address names.
 */

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.analysisSession.title,
    description: en.meta.analysisSession.description,
    alternates: { canonical: paths.analysisSession() },
    robots: { index: false, follow: false },
  };
}

export default async function AnalysisSessionPage({ searchParams }: PageProps) {
  return <SessionScreen query={await searchParams} />;
}
