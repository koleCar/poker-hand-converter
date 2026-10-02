import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AnalysisHandScreen } from "./AnalysisHandScreen";
import { getDict } from "../../../../lib/i18n/server";

/**
 * One hand's analysis: the replayer with the Analysis sheet (§6.1).
 *
 * The id is the `hands.id` uuid. Anything else is a 404 before a request is
 * made; a well-formed id that is not the reader's is answered by RLS on the
 * client, as "not in your library". Never indexed: it is one account's hand.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  params: Promise<{ handId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.analysisHand.title,
    description: en.meta.analysisHand.description,
    robots: { index: false, follow: false },
  };
}

export default async function AnalysisHandPage({ params, searchParams }: PageProps) {
  const { handId } = await params;
  if (!UUID_RE.test(handId)) {
    notFound();
  }
  return <AnalysisHandScreen handId={handId.toLowerCase()} query={await searchParams} />;
}
