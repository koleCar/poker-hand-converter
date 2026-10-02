import type { Metadata } from "next";
import { TrainScreen } from "./TrainScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * The trainer (`docs/ANALYSIS-PLAN.md` §7, phase A7): preflop spots, river
 * spots and drills of your own mistakes.
 *
 * Private and not indexed, like `/analysis`: drills are one account's own
 * decisions behind RLS, and `robots.ts` keeps `/analysis` disallowed apart
 * from the public learn and charts pages. The mode and its settings live in
 * the query string, read here so the first render is the trainer the address
 * names (a leak's "Drill this" is a link).
 */

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.analysisTrain.title,
    description: en.meta.analysisTrain.description,
    alternates: { canonical: paths.analysisTrain() },
    robots: { index: false, follow: false },
  };
}

export default async function AnalysisTrainPage({ searchParams }: PageProps) {
  return <TrainScreen query={await searchParams} />;
}
