import type { Metadata } from "next";
import { PricingScreen } from "../../components/plan/PricingScreen";
import { getDict } from "../../lib/i18n/server";
import { paths } from "../../lib/routes";

/**
 * `/pricing`: Free against Pro, the three billing periods and the upgrade
 * (the pricing round's PR-B-Table). Public and indexable; the desktop app
 * opens it with `?from=app`, Settings and the locks with no query, and
 * `?period=` opens it on a period. A top-level segment, so `pricing` is a
 * reserved username (`20271119170000_pricing_route.sql`).
 */

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.pricing.metaTitle,
    description: en.pricing.metaDescription,
    alternates: { canonical: paths.pricing() },
    openGraph: { title: en.pricing.metaTitle, description: en.pricing.metaDescription, url: paths.pricing() },
  };
}

export default async function PricingPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const period = Array.isArray(query.period) ? query.period[0] : query.period;
  return <PricingScreen period={period ?? null} />;
}
