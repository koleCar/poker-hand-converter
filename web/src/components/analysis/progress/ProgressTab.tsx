/**
 * Progress (`/analysis/progress`, `docs/ANALYSIS-PLAN.md` §6.0 *score trend*,
 * §6.3, phase A6): the score and the EV lost per 100 hands over time, with
 * the graded volume behind each point, and the same split by street, seat or
 * pot type as small multiples.
 *
 * The database sums graded decisions per week, month or session
 * (`analysis_trend`); `trendSeries` in `lib/analysis/leaks.ts` turns the sums
 * into means, 95% intervals and per-100 rates. A bucket under
 * `MIN_COMPARE_MOVES` graded moves is drawn hollow: a mean of a dozen moves
 * swings by chance, and the chart says so rather than drawing a crash.
 *
 * Filters are the Reports ones under the same URL keys; the view (bucket,
 * split, metric) is in the address bar too.
 */

"use client";

import { RailLoader } from "@rail/ui/loader/RailLoader";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { MIN_COMPARE_MOVES, trendSeries, type TrendPoint, type TrendSeries } from "../../../lib/analysis/leaks";
import {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  fetchAnalysisCoverage,
  isDatabaseConfigured,
  isMissingSchemaError,
  type AnalysisCoverage,
} from "../../../lib/db";
import type { AnalysisFilters } from "../../../lib/db/analysis";
import {
  TREND_BUCKETS,
  TREND_GROUPS,
  fetchTrend,
  type TrendBucket,
  type TrendGroup,
  type TrendReport,
} from "../../../lib/db/analysisLeaks";
import { useAuth } from "../../../lib/auth";
import { useAnalysisKind } from "../analysisKind";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import { dateFormat, useIntlLocale } from "../../stats/format";
import { AnalysisNav } from "../AnalysisNav";
import { FilterBar } from "../reports/ReportsTab";
import { reportsFilters } from "../reports/reportsState";
import reportStyles from "../reports/reports.module.css";
import { PROGRESS_METRICS, parseProgressState, progressQuery, type ProgressMetric, type ProgressState } from "../leaks/leaksState";
import styles from "../leaks/leaks.module.css";
import an from "../ui/an.module.css";
import { WhatChanged } from "../leaks/WhatChanged";
import { TrendChart, type TrendChartPoint } from "./TrendChart";
import "../../../styles/stats.css";

const PROGRESS_MIGRATION = "supabase/migrations/20270201090000_analysis_leaks.sql";
const DAY = 24 * 60 * 60 * 1000;

type Status = "loading" | "ready" | "not-installed" | "error";

interface Answer {
  key: string;
  status: Status;
  message: string | null;
}

interface ProgressTabProps {
  initialQuery: Record<string, string | string[] | undefined>;
  refreshToken?: number;
}

export function ProgressTab({ initialQuery, refreshToken = 0 }: ProgressTabProps) {
  const t = useDict().analysis.progress;
  const leaksT = useDict().analysis.leaks;
  const auth = useAuth();
  const [state, setState] = useState<ProgressState>(() => parseProgressState(initialQuery));
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [data, setData] = useState<{ coverage: AnalysisCoverage | null; trend: TrendReport | null } | null>(null);
  const [attempt, setAttempt] = useState(0);

  // One kind of game, never both (`analysisKind.ts`): nothing is read until it is known.
  const kinds = useAnalysisKind(state.kind, isDatabaseConfigured && auth.isSignedIn, refreshToken);
  const shownState = useMemo(() => ({ ...state, kind: kinds.kind }), [state, kinds.kind]);
  const kindReady = kinds.kind !== null;
  const filters = useMemo(() => reportsFilters(shownState), [shownState]);
  const filterKey = JSON.stringify(filters);

  const updateState = useCallback((patch: Partial<ProgressState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", paths.analysisProgress(progressQuery(next)));
      }
      return next;
    });
  }, []);

  const requestKey = `${filterKey}|${state.bucket}|${state.group}|${refreshToken}|${attempt}`;
  useEffect(() => {
    if (!isDatabaseConfigured || !auth.isSignedIn || !kindReady) return;
    let live = true;
    Promise.all([fetchAnalysisCoverage(), fetchTrend(JSON.parse(filterKey) as AnalysisFilters, state.bucket, state.group)])
      .then(([coverage, trend]) => {
        if (!live) return;
        setData({ coverage, trend });
        setAnswer({ key: requestKey, status: "ready", message: null });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setAnswer({
          key: requestKey,
          status: isMissingSchemaError(error) ? "not-installed" : "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      live = false;
    };
  }, [auth.isSignedIn, kindReady, filterKey, state.bucket, state.group, requestKey]);

  const loading = answer?.key !== requestKey;
  const status = answer?.status ?? "loading";
  const coverage = data?.coverage ?? null;
  const trend = data?.trend ?? null;
  const series = useMemo(() => (trend ? trendSeries(trend.rows, trend.group) : []), [trend]);

  if (!isDatabaseConfigured) {
    return (
      <div className="stats">
        <Header />
        <p className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</p>
      </div>
    );
  }

  if (!auth.isSignedIn) {
    return <SignedOut />;
  }

  if (status === "not-installed" && !loading) {
    return (
      <div className="stats">
        <Header />
        <div className="card stats-empty">
          <h3>{leaksT.notInstalledHeading}</h3>
          <p className="muted">
            {leaksT.notInstalledBefore}
            <code>{PROGRESS_MIGRATION}</code>
            {leaksT.notInstalledAfter}
          </p>
        </div>
      </div>
    );
  }

  if (status === "error" && !loading) {
    return (
      <div className="stats">
        <Header />
        <p className="notice notice--error">{answer?.message}</p>
        <TryAgain onClick={() => setAttempt((value) => value + 1)} />
      </div>
    );
  }

  if (!coverage || !trend) {
    return (
      <div className="stats">
        <Header />
        <RailLoader label={t.loading} showLabel centered />
      </div>
    );
  }

  if (coverage.atVersion === 0 || trend.facets.sites.length === 0) {
    return (
      <div className="stats">
        <Header />
        <div className="card stats-empty">
          <h3>{t.emptyHeading}</h3>
          <p className="muted">{t.emptyBody}</p>
          <Link href={paths.analysis()} className="btn btn--primary">
            {t.goToAnalysis}
          </Link>
        </div>
      </div>
    );
  }

  const graded = series.reduce((sum, entry) => sum + entry.graded, 0);

  return (
    <div className="stats">
      <Header tools={<FilterBar state={shownState} kinds={kinds} facets={trend.facets} onChange={updateState} />} />
      <Controls state={state} onChange={updateState} />
      {state.bucket === "session" ? <p className={reportStyles.muted}>{t.sessionNote(trend.gapMinutes)}</p> : null}

      {loading ? (
        <p className={reportStyles.busy}>
          <RailLoader size="inline" label={t.loading} showLabel />
        </p>
      ) : null}

      {graded === 0 ? <p className="card muted">{t.noneInScope}</p> : null}
      {graded > 0 && trend.group === "all" ? <Overall series={series[0]} bucket={trend.bucket} busy={loading} /> : null}
      {graded > 0 && trend.group !== "all" ? (
        <Multiples series={series} bucket={trend.bucket} group={trend.group} metric={state.metric} busy={loading} />
      ) : null}
      {kinds.kind ? <WhatChanged scopeKey={JSON.stringify({ gameKind: kinds.kind })} generation={refreshToken} /> : null}
    </div>
  );
}

function SignedOut() {
  const t = useDict().analysis.tab;
  const auth = useAuth();
  return (
    <div className="stats">
      <Header />
      <div className="card stats-empty">
        <h3>{t.signInHeading}</h3>
        <p className="muted">{t.signInBody}</p>
        <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
          {t.signIn}
        </button>
      </div>
    </div>
  );
}

function TryAgain({ onClick }: { onClick: () => void }) {
  const t = useDict().analysis.tab;
  return (
    <button type="button" className="btn" onClick={onClick}>
      {t.tryAgain}
    </button>
  );
}

function Header({ tools }: { tools?: ReactNode }) {
  return <AnalysisNav current="progress">{tools}</AnalysisNav>;
}

function Controls({ state, onChange }: { state: ProgressState; onChange: (patch: Partial<ProgressState>) => void }) {
  const t = useDict().analysis.progress.controls;
  return (
    <div className={an.sub} role="group" aria-label={t.bucket}>
      {state.group !== "all" ? (
        <div className={an.seg} role="group" aria-label={t.metric}>
          {PROGRESS_METRICS.map((metric) => (
            <button key={metric} type="button" aria-pressed={state.metric === metric} onClick={() => onChange({ metric })}>
              {t.metrics[metric]}
            </button>
          ))}
        </div>
      ) : null}
      <span className={an.grow} />
      <span className={`${an.xs} ${an.dim}`}>{t.bucket}</span>
      <div className={an.seg} role="group" aria-label={t.bucket}>
        {TREND_BUCKETS.map((bucket) => (
          <button key={bucket} type="button" aria-pressed={state.bucket === bucket} onClick={() => onChange({ bucket })}>
            {t.buckets[bucket]}
          </button>
        ))}
      </div>
      <span className={`${an.xs} ${an.dim}`}>{t.group}</span>
      <div className={an.seg} role="group" aria-label={t.group}>
        {TREND_GROUPS.map((group) => (
          <button key={group} type="button" aria-pressed={state.group === group} onClick={() => onChange({ group })}>
            {t.groups[group]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Tick labels and ranges for a bucket kind, in the reader's locale. */
function useBucketWords(bucket: TrendBucket) {
  const t = useDict().analysis.progress;
  const locale = useIntlLocale();
  return useMemo(() => {
    const day = dateFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
    const month = dateFormat(locale, { month: "short", year: "numeric", timeZone: "UTC" });
    const monthLong = dateFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" });
    const time = dateFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    const full = dateFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    return (point: TrendPoint): { label: string; range: string } => {
      const start = new Date(point.start);
      if (bucket === "month") return { label: month.format(start), range: monthLong.format(start) };
      if (bucket === "week") {
        return { label: day.format(start), range: t.dateRange(point.start, new Date(Date.parse(point.end) - DAY).toISOString()) };
      }
      // A session: its first and last hand, in UTC like every date filter here.
      const end = new Date(point.end);
      const sameDay = point.start.slice(0, 10) === point.end.slice(0, 10);
      return {
        label: day.format(start),
        range: sameDay
          ? `${full.format(start)}, ${time.format(start)}–${time.format(end)}`
          : `${full.format(start)} ${time.format(start)} – ${full.format(end)} ${time.format(end)}`,
      };
    };
  }, [bucket, locale, t]);
}

function chartPoints(series: TrendSeries, metric: ProgressMetric, words: (point: TrendPoint) => { label: string; range: string }): TrendChartPoint[] {
  return series.points.map((point) => {
    const { label, range } = words(point);
    const value = metric === "score" ? point.score : metric === "ev" ? point.evPer100 : point.offRate === null ? null : point.offRate * 100;
    const margin = metric === "score" ? point.scoreMargin : null;
    return {
      key: point.start,
      label,
      range,
      value,
      low: value !== null && margin !== null ? Math.max(0, value - margin) : null,
      high: value !== null && margin !== null ? Math.min(100, value + margin) : null,
      volume: point.graded,
      hands: point.hands,
      thin: point.graded < MIN_COMPARE_MOVES,
    };
  });
}

function Overall({ series, bucket, busy }: { series: TrendSeries | undefined; bucket: TrendBucket; busy: boolean }) {
  const t = useDict().analysis.progress;
  const words = useBucketWords(bucket);
  if (!series || series.points.length < 2) {
    return <p className="notice notice--info">{t.notEnough}</p>;
  }
  return (
    <section className="card stats-group rail-dims" aria-busy={busy}>
      <TrendChart
        name={t.charts.score}
        hint={t.charts.scoreHint}
        points={chartPoints(series, "score", words)}
        format={t.score}
        formatTick={t.tick}
        bounds={[0, 100]}
      />
      <TrendChart
        name={t.charts.ev}
        hint={t.charts.evHint}
        points={chartPoints(series, "ev", words)}
        format={t.bb}
        formatTick={t.tick}
        fromZero
      />
      <p className={reportStyles.muted}>{t.charts.thin(MIN_COMPARE_MOVES)}</p>
    </section>
  );
}

function Multiples({
  series,
  bucket,
  group,
  metric,
  busy,
}: {
  series: TrendSeries[];
  bucket: TrendBucket;
  group: TrendGroup;
  metric: ProgressMetric;
  busy: boolean;
}) {
  const en = useDict();
  const t = en.analysis.progress;
  const words = useBucketWords(bucket);
  const shown = series.filter((entry) => entry.graded >= MIN_COMPARE_MOVES && entry.points.length >= 2);
  const left = series.length - shown.length;
  const keyName = (key: string) =>
    key === ""
      ? t.unknown
      : group === "street"
        ? (en.analysis.leaks.streets[key] ?? key)
        : group === "pot_type"
          ? (en.stats.breakdown.potTypes[key] ?? key)
          : key;
  const format = metric === "score" ? t.score : metric === "ev" ? t.bb : (value: number) => t.pct(value / 100);
  const hint = metric === "score" ? t.charts.scoreHint : metric === "ev" ? t.charts.evHint : t.charts.offHint;
  return (
    <section className="card stats-group rail-dims" aria-busy={busy}>
      <p className={reportStyles.muted}>
        {t.smallMultiplesNote} {hint}.
      </p>
      {shown.length === 0 ? <p className="notice notice--info">{t.notEnough}</p> : null}
      <div key={`${group}|${metric}`} className={`${styles.multiples} rail-stagger`}>
        {shown.map((entry) => (
          <TrendChart
            key={entry.key}
            name={`${keyName(entry.key)} · ${t.moves(entry.graded)}`}
            points={chartPoints(entry, metric, words)}
            format={format}
            formatTick={t.tick}
            bounds={metric === "ev" ? undefined : [0, 100]}
            fromZero={metric !== "score"}
            compact
          />
        ))}
      </div>
      {left > 0 ? <p className={reportStyles.muted}>{t.left(left)}</p> : null}
      <p className={reportStyles.muted}>{t.charts.thin(MIN_COMPARE_MOVES)}</p>
    </section>
  );
}
