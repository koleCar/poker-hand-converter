/**
 * The overview's "three biggest leaks" card (R5.2, `docs/RAIL-PLAN.md`): the
 * leak finder (A6) framed as the three most important leaks, each with
 * example hands.
 *
 * - **Which three** is `rankTopLeaks` (`lib/analysis/topLeaks.ts`): EV lost in
 *   total, the leaks the sample can vouch for (A6's medium or high
 *   confidence) first, a thinner one with two mistakes or more only to fill an
 *   empty place, marked tentative. The leaks are `groupLeaks`' own, so each
 *   links to its row in the full report (`/analysis/leaks?leak=`).
 * - **Per leak**: what it is in words (the report's own title and spot), EV
 *   lost per 100 hands with the range the mistake rate's 95% interval gives,
 *   EV lost in all, how often (mistakes in the spot, with the interval),
 *   confidence, the target (the reference's best move; your actions against
 *   the reference's best move for the hands you held), was / now (the last 30
 *   days of play against the 30 before, A6's words), and up to five example
 *   hands, each opening its analysis at the decision.
 * - **Period**: the last 30 days of play (the default; counted back from the
 *   last day played, as "what changed" counts) or all time. The overview's
 *   own filters (format, seat, pot type) apply to both, and to the examples.
 *
 * The data are the stored leak sums (`analysis_top_leaks`,
 * `analysis_leak_examples`, `20270728090000_leak_summaries.sql`), so a
 * million hands open in well under a second. No AI-written summary: declined
 * for now (ANALYSIS-PLAN A8c).
 */

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { encodePosition } from "@rail/ui/replayer/position";
import { groupLeaks, leakKind } from "../../../lib/analysis/leaks";
import {
  EXAMPLES_FETCH,
  TOP_PERIODS,
  leakSize,
  leakTrend,
  pickExamples,
  rankTopLeaks,
  type LeakTrend,
  type RankedLeak,
  type TopPeriod,
} from "../../../lib/analysis/topLeaks";
import { isMissingSchemaError } from "../../../lib/db/client";
import type { AnalysisFilters } from "../../../lib/db/analysis";
import { fetchLeakExamples, fetchTopLeaks, type LeakExampleRow, type TopLeaksReport } from "../../../lib/db/topLeaks";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import { dateFormat, useIntlLocale } from "../../stats/format";
import { GradeIcon } from "../GradeIcon";
import analysisStyles from "../analysis.module.css";
import reportStyles from "../reports/reports.module.css";
import { ConfidenceTag } from "./ConfidenceTag";
import { TrendTag } from "./WhatChanged";
import { EMPTY_LEAKS_STATE, leaksQuery } from "./leaksState";
import styles from "./topLeaks.module.css";

/** The migration the card needs, named in its not-installed note. An identifier, not prose. */
const TOP_LEAKS_MIGRATION = "supabase/migrations/20270728090000_leak_summaries.sql";

export interface TopLeakView extends RankedLeak {
  trend: LeakTrend;
}

interface Loaded {
  key: string;
  report: TopLeaksReport | null;
  top: TopLeakView[];
}

interface ExamplesAnswer {
  byLeak: Map<string, LeakExampleRow[]> | null;
  error: string | null;
}

interface Examples extends ExamplesAnswer {
  key: string;
}

/** The top three of a report: grouped, ranked, each with its was / now. Pure (exported for the tests). */
export function topOf(report: TopLeaksReport): TopLeakView[] {
  const leaks = groupLeaks(report.sample.rows, { hands: report.sample.hands });
  return rankTopLeaks(leaks).map((entry) => ({ ...entry, trend: leakTrend(entry.leak, report.now.rows, report.was.rows) }));
}

interface TopLeaksProps {
  /** The overview's filters (format, seat, pot type), as JSON. */
  scopeKey: string;
  /** Bumped by the overview after a run or an upload. */
  generation: number;
  /** The overview's own address query, so a hand's Back link returns to it. */
  backQuery: string;
  /** The period to open on (tests; the card's toggle changes it). */
  initialPeriod?: TopPeriod;
}

export function TopLeaks({ scopeKey, generation, backQuery, initialPeriod = "30d" }: TopLeaksProps) {
  const t = useDict().analysis.topLeaks;
  const [period, setPeriod] = useState<TopPeriod>(initialPeriod);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [examples, setExamples] = useState<Examples | null>(null);
  const [error, setError] = useState<{ key: string; message: string; missing: boolean } | null>(null);
  const requestKey = `${scopeKey}|${period}|${generation}`;

  useEffect(() => {
    let live = true;
    const scope = JSON.parse(scopeKey) as AnalysisFilters;
    (async () => {
      const report = await fetchTopLeaks(scope, period);
      if (!live) return;
      const top = report ? topOf(report) : [];
      setLoaded({ key: requestKey, report, top });
      setError(null);
      if (!report || top.length === 0) {
        setExamples({ key: requestKey, byLeak: new Map(), error: null });
        return;
      }
      try {
        const byLeak = await fetchLeakExamples(scope, {
          leaks: top.map(({ leak }) => ({ id: leak.id, keys: leak.keys })),
          window: period === "30d" ? report.current : null,
          limit: EXAMPLES_FETCH,
        });
        if (live) setExamples({ key: requestKey, byLeak, error: null });
      } catch (reason) {
        if (live) setExamples({ key: requestKey, byLeak: null, error: reason instanceof Error ? reason.message : String(reason) });
      }
    })().catch((reason: unknown) => {
      if (live) {
        setError({
          key: requestKey,
          message: reason instanceof Error ? reason.message : String(reason),
          missing: isMissingSchemaError(reason),
        });
      }
    });
    return () => {
      live = false;
    };
  }, [scopeKey, period, generation, requestKey]);

  const current = loaded?.key === requestKey ? loaded : null;
  const failed = error?.key === requestKey ? error : null;
  const loading = !current && !failed;
  // Keep the last answer on screen while the next one loads.
  const shown = current ?? (failed ? null : loaded);
  const shownExamples = examples && shown && examples.key === shown.key ? examples : null;

  // Nothing graded at all: the overview already says so.
  if (shown && !shown.report && !loading) return null;

  return (
    <section className={`card stats-group ${styles.card}`} aria-labelledby="top-leaks" aria-busy={loading}>
      <div className={styles.head}>
        <h3 id="top-leaks" className={styles.heading}>
          {t.heading}
        </h3>
        <div className={styles.periods} role="group" aria-label={t.period}>
          {TOP_PERIODS.map((value) => (
            <button
              key={value}
              type="button"
              className="btn btn--sm btn--ghost"
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {t.periods[value]}
            </button>
          ))}
        </div>
      </div>

      {failed ? (
        failed.missing ? (
          <p className="muted">
            {t.notInstalledBefore}
            <code>{TOP_LEAKS_MIGRATION}</code>
            {t.notInstalledAfter}
          </p>
        ) : (
          <p className="notice notice--error">{t.failed(failed.message)}</p>
        )
      ) : null}
      {loading && !shown ? (
        <p className="muted" role="status">
          {t.loading}
        </p>
      ) : null}
      {shown?.report ? (
        <TopLeaksBody
          report={shown.report}
          top={shown.top}
          examples={shownExamples}
          scope={JSON.parse(scopeKey) as AnalysisFilters}
          backQuery={backQuery}
        />
      ) : null}
    </section>
  );
}

/** The card's body for one answer (exported for the tests: it renders without a database). */
export function TopLeaksBody({
  report,
  top,
  examples,
  scope,
  backQuery,
}: {
  report: TopLeaksReport;
  top: readonly TopLeakView[];
  examples: ExamplesAnswer | null;
  scope: AnalysisFilters;
  backQuery: string;
}) {
  const t = useDict().analysis.topLeaks;
  const sample = report.sample;
  const window = report.period === "30d" ? report.current : null;
  const allHref = paths.analysisLeaks(
    leaksQuery({
      ...EMPTY_LEAKS_STATE,
      ...(window ? { from: window.from, to: window.to } : {}),
      position: scope.position ?? null,
    }),
  );
  return (
    <>
      <p className={styles.sample}>
        {sample.graded > 0 ? t.sample(sample.graded, sample.hands) : t.noneInPeriod}{" "}
        {window ? <span className="muted">{t.window(window.from, window.to)}</span> : null}
      </p>
      <p className={`muted ${styles.rule}`}>{t.rule}</p>
      {sample.graded > 0 && top.length === 0 ? <p className="muted">{t.none}</p> : null}
      {top.length > 0 ? (
        <ol className={styles.list}>
          {top.map((entry) => (
            <TopLeakItem
              key={entry.leak.id}
              entry={entry}
              examples={examples?.byLeak?.get(entry.leak.id) ?? null}
              examplesError={examples?.error ?? null}
              examplesLoading={!examples}
              leakHref={paths.analysisLeaks(
                leaksQuery({
                  ...EMPTY_LEAKS_STATE,
                  ...(window ? { from: window.from, to: window.to } : {}),
                  position: scope.position ?? null,
                  leak: entry.leak.id,
                }),
              )}
              backQuery={backQuery}
            />
          ))}
        </ol>
      ) : null}
      <p className={styles.links}>
        <Link href={allHref}>{t.allLeaks}</Link>
      </p>
    </>
  );
}

function TopLeakItem({
  entry,
  examples,
  examplesError,
  examplesLoading,
  leakHref,
  backQuery,
}: {
  entry: TopLeakView;
  examples: LeakExampleRow[] | null;
  examplesError: string | null;
  examplesLoading: boolean;
  leakHref: string;
  backQuery: string;
}) {
  const en = useDict().analysis;
  const t = en.topLeaks;
  const { leak, rank, tentative, trend } = entry;
  const title = en.leaks.title(leakKind(leak.attrs.taken, leak.attrs.best), leak.attrs);
  const context = en.leaks.fullContext(leak.attrs, leak.level, leak.partial);
  const name = en.leaks.name(title, context, leak.attrs.street);
  const size = leakSize(leak);
  const headingId = `top-leak-${rank}`;
  return (
    <li className={styles.leak} aria-labelledby={headingId}>
      <h4 id={headingId} className={styles.leakHead}>
        <span className={styles.rank}>{t.rank(rank)}</span>
        <span className={styles.name}>
          <span className={styles.title}>{title}</span>
          <span className={styles.context}>
            {context} · {en.leaks.streets[leak.attrs.street] ?? leak.attrs.street}
          </span>
        </span>
        {tentative ? <span className={styles.tentative}>{t.tentative}</span> : null}
      </h4>

      <div className={styles.figures}>
        <p className={styles.big}>
          <strong>{t.per100(leak.per100)}</strong>
          {size ? <span className="muted"> {t.per100Range(size.per100Interval.low, size.per100Interval.high)}</span> : null}
        </p>
        <p className="muted">{t.total(leak.evLossBb)}</p>
      </div>

      <p className={styles.line}>
        {size ? t.how(leak.mistakes, leak.spotDecisions, size.rate, size.rateInterval.low, size.rateInterval.high) : null}{" "}
        <ConfidenceTag leak={leak} />
      </p>
      {tentative ? <p className="notice notice--warn">{t.tentativeNote}</p> : null}

      <p className={styles.line}>
        <strong>{t.target(leak.attrs.best)}</strong>
      </p>
      <dl className={styles.mixes}>
        <div>
          <dt>{t.you}</dt>
          <dd>{en.leaks.detail.mix(leak.taken)}</dd>
        </div>
        <div>
          <dt>{t.reference}</dt>
          <dd>{en.leaks.detail.mix(leak.best)}</dd>
        </div>
      </dl>

      <p className={styles.line}>
        <span className="muted">{t.trendLabel}: </span>
        {t.trend(trend.now.mistakes, trend.now.spot, trend.was.mistakes, trend.was.spot)} <TrendTag trend={trend.trend} />
      </p>

      <ExampleHands
        leakName={name}
        rows={examples}
        error={examplesError}
        loading={examplesLoading}
        backQuery={backQuery}
      />

      <p className={styles.links}>
        <Link href={leakHref} aria-label={t.openLeakLabel(name)}>
          {t.openLeak}
        </Link>
      </p>
    </li>
  );
}

function ExampleHands({
  leakName,
  rows,
  error,
  loading,
  backQuery,
}: {
  leakName: string;
  rows: LeakExampleRow[] | null;
  error: string | null;
  loading: boolean;
  backQuery: string;
}) {
  const en = useDict().analysis;
  const t = en.topLeaks;
  const locale = useIntlLocale();
  const picked = useMemo(() => (rows ? pickExamples(rows) : []), [rows]);
  const when = (iso: string | null) =>
    iso ? dateFormat(locale, { day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(iso)) : "";
  return (
    <div className={styles.examples}>
      <h5 className={styles.examplesHead}>{t.examples}</h5>
      {error ? <p className="notice notice--error">{t.examplesFailed(error)}</p> : null}
      {loading ? <p className="muted">{t.examplesLoading}</p> : null}
      {!loading && !error && picked.length === 0 ? <p className="muted">{t.examplesNone}</p> : null}
      {picked.length > 0 ? (
        <>
          <p className="muted">{t.examplesNote}</p>
          <ul className={reportStyles.handList}>
            {picked.map((row) => {
              const cards = row.heroCards.join(" ");
              const at = `t=${encodePosition({ kind: "action", actionIndex: row.actionIndex })}`;
              return (
                <li key={`${row.handId}-${row.ord}`} className={reportStyles.handRow}>
                  <Link
                    href={paths.analysisHand(row.handId, backQuery ? `${at}&${backQuery}` : at)}
                    className={reportStyles.handLink}
                    aria-label={t.openHand(cards || row.handClass || row.handId, leakName)}
                  >
                    {row.heroCards.length ? <CardRow cards={row.heroCards} size="xs" /> : null}
                    <span className={reportStyles.handClass}>{row.handClass ?? ""}</span>
                    <span className={reportStyles.muted}>{row.position ?? ""}</span>
                  </Link>
                  <span className={reportStyles.handWhat}>
                    <span>
                      {en.leaks.hands.took(en.leaks.actions[row.taken] ?? row.taken, en.leaks.actions[row.best] ?? row.best)}
                    </span>
                  </span>
                  <span className={reportStyles.handGrade}>
                    {row.grade ? (
                      <span className={`${analysisStyles.gradeTag} ${analysisStyles[row.grade] ?? ""}`}>
                        <GradeIcon grade={row.grade} />
                        {en.grades[row.grade] ?? row.grade}
                      </span>
                    ) : null}
                    {row.evLossBb !== null && row.evLossBb > 0 ? <span className="num">{t.evLoss(row.evLossBb)}</span> : null}
                    <span className={reportStyles.muted}>{when(row.playedAt)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}
