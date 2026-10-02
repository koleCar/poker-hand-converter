import type { Metadata } from "next";
import { AnalysisNav } from "../../../components/analysis/AnalysisNav";
import { ChartBrowser } from "../../../components/analysis/ChartBrowser";
import { ServerFrame } from "../../../components/shell/ServerFrame";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";
import styles from "../../../components/learn/learn.module.css";

/**
 * The preflop chart browser (phase A2b, `docs/ANALYSIS-PLAN.md` §6.1 *Study*).
 *
 * **Public and indexable**, like `/analysis/learn`: the charts are our own
 * data (`lib/charts`, computed by our solver) and the page reads no account,
 * no hand and no row, so a signed-out reader and a crawler see what a
 * signed-in player sees. `robots.ts` allows it inside the disallowed
 * `/analysis`, `sitemap.ts` lists it, and the canonical URL drops the query
 * (`?line=` picks a spot, `?hand=` highlights a class — views of one page).
 */

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const LINE_RE = /^(-|[fkcra]{1,24})$/;
const HAND_RE = /^([AKQJT2-9])([AKQJT2-9])([so])?$/;

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.charts.title,
    description: en.meta.charts.description,
    alternates: { canonical: paths.analysisCharts() },
    openGraph: {
      title: en.meta.charts.title,
      description: en.meta.charts.description,
      url: paths.analysisCharts(),
    },
  };
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;

export default async function ChartsPage({ searchParams }: PageProps) {
  const [en, query] = await Promise.all([getDict(), searchParams]);
  // Whitelisted: a malformed query is the default chart, never an error.
  const line = first(query.line);
  const hand = first(query.hand);
  const t = en.analysis.charts;
  return (
    <ServerFrame tab="analysis">
      <div className={styles.page}>
        <header className={styles.pageHead}>
          <h1 className={styles.title}>{t.heading}</h1>
          <AnalysisNav current="charts" />
          <p className={styles.lead}>{t.intro}</p>
        </header>
        <ChartBrowser
          initialLine={line && LINE_RE.test(line) ? line : null}
          initialHand={hand && HAND_RE.test(hand) ? hand : null}
        />
      </div>
    </ServerFrame>
  );
}
