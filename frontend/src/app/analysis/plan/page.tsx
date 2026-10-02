import type { Metadata } from "next";
import { PlanScreen } from "./PlanScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * The study plan (`docs/ANALYSIS-PLAN.md` §7, phase A8b): this week's focus
 * from the leak finder, and its checklist.
 *
 * Private and not indexed, like `/analysis`: the plan is one account's own
 * leaks and hands behind RLS, and `robots.ts` keeps `/analysis` disallowed
 * apart from the public learn and charts pages.
 */

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.analysisPlan.title,
    description: en.meta.analysisPlan.description,
    alternates: { canonical: paths.analysisPlan() },
    robots: { index: false, follow: false },
  };
}

export default function AnalysisPlanPage() {
  return <PlanScreen />;
}
