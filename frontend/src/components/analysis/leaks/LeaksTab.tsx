/**
 * Leaks (`/analysis/leaks`, `docs/ANALYSIS-PLAN.md` §6.0 *Leaks*, phase A6):
 * the spots that cost the most EV against the reference, ranked, each opening
 * to what the reference does there and the hands behind it.
 *
 * The database sums graded decisions per finest spot (`analysis_leaks`);
 * `lib/analysis/leaks.ts` groups them into leaks, merges thin spots up a
 * level, ranks them and grades their confidence. This screen only draws:
 *
 * - the Reports filter bar (dates, room, stake, seat — the same URL keys),
 *   plus a street and a ranking, and the open leak, all in the address bar;
 * - one row per leak: what went wrong where, EV lost (total and per 100
 *   hands), how often the spot came up and how often it went wrong, EV per
 *   mistake, and a confidence word with a glyph (never colour alone);
 * - opened: a plain-language sentence, your actions against the reference's
 *   best move with the hands you held, the numbers, the merge note, Learn
 *   links, the hands (`analysis_leak_hands`), and "Drill this".
 *
 * **"Drill this"** (phase A7) opens the trainer's drills on the leak's spot
 * keys: the Mistakes and Blunders behind it, as "what would you do?". Each
 * row says how many of them are due today (`drill_due_by_spot`; a Mistake
 * not drilled yet counts as due, since the trainer's first sync makes it so).
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  LEAK_SORTS,
  LEAK_STREETS,
  groupLeaks,
  leakConcepts,
  leakKind,
  sortLeaks,
  type Leak,
  type LeakSort,
} from "../../../lib/analysis/leaks";
import { lineSeats } from "../../../lib/analysis/leaks";
import { walkLine } from "../../../lib/analysis/reports";
import {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  fetchAnalysisCoverage,
  isDatabaseConfigured,
  isMissingSchemaError,
  type AnalysisCoverage,
} from "../../../lib/db";
import type { AnalysisFilters } from "../../../lib/db/analysis";
import { fetchLeakHands, fetchLeaks, type LeakHandRow, type LeaksReport } from "../../../lib/db/analysisLeaks";
import { fetchDrillsBySpot } from "../../../lib/db/training";
import { useAuth } from "../../../lib/auth";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import { CardRow } from "../../replayer/PlayingCard";
import { dateFormat, useIntlLocale } from "../../stats/format";
import { AnalysisNav } from "../AnalysisNav";
import { GradeIcon } from "../GradeIcon";
import { LearnLinks } from "../LearnLinks";
import { lineSteps } from "../chartSpots";
import { FilterBar } from "../reports/ReportsTab";
import { reportsFilters } from "../reports/reportsState";
import analysisStyles from "../analysis.module.css";
import reportStyles from "../reports/reports.module.css";
import { drillQuery } from "../train/trainState";
import { leaksQuery, parseLeaksState, type LeaksState } from "./leaksState";
import styles from "./leaks.module.css";
import "../../../styles/stats.css";

/** The migration the screen needs, named in the not-installed notice. An identifier, not prose. */
const LEAKS_MIGRATION = "supabase/migrations/20270201090000_analysis_leaks.sql";
const PREVIEW = 10;
const HANDS_PAGE = 8;
const HOW_ID = "leaks-how";
const CONFIDENCE_GLYPH = { low: "●○○", medium: "●●○", high: "●●●" } as const;

type Status = "loading" | "ready" | "not-installed" | "error";

interface Answer {
  key: string;
  status: Status;
  message: string | null;
}

interface LeaksTabProps {
  initialQuery: Record<string, string | string[] | undefined>;
  refreshToken?: number;
}

export function LeaksTab({ initialQuery, refreshToken = 0 }: LeaksTabProps) {
  const t = useDict().analysis.leaks;
  const auth = useAuth();
  const [state, setState] = useState<LeaksState>(() => parseLeaksState(initialQuery));
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [data, setData] = useState<{ coverage: AnalysisCoverage | null; report: LeaksReport | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [howOpen, setHowOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [drills, setDrills] = useState<Map<string, { items: number; due: number }> | null>(null);
  // Only a leak named by the address on arrival is scrolled to; one opened here stays put.
  const arrivedOn = useRef(state.leak);

  const filters = useMemo(() => reportsFilters(state), [state]);
  const filterKey = JSON.stringify(filters);

  const updateState = useCallback((patch: Partial<LeaksState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", paths.analysisLeaks(leaksQuery(next)));
      }
      return next;
    });
  }, []);

  const requestKey = `${filterKey}|${refreshToken}|${attempt}`;
  useEffect(() => {
    if (!isDatabaseConfigured || !auth.isSignedIn) return;
    let live = true;
    Promise.all([fetchAnalysisCoverage(), fetchLeaks(JSON.parse(filterKey) as AnalysisFilters)])
      .then(([coverage, report]) => {
        if (!live) return;
        setData({ coverage, report });
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
  }, [auth.isSignedIn, filterKey, requestKey]);

  // Drills per spot: the trainer's counts, for "Drill this". Quiet when the
  // drills are not installed (the trainer's migration) or anything fails.
  useEffect(() => {
    if (!isDatabaseConfigured || !auth.isSignedIn) return;
    let live = true;
    fetchDrillsBySpot()
      .then((map) => {
        if (live) setDrills(map);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [auth.isSignedIn, refreshToken]);

  const loading = answer?.key !== requestKey;
  const status = answer?.status ?? "loading";
  const coverage = data?.coverage ?? null;
  const report = data?.report ?? null;

  const leaks = useMemo(() => (report ? groupLeaks(report.rows, { hands: report.hands }) : []), [report]);
  const shown = useMemo(
    () => sortLeaks(state.street ? leaks.filter((leak) => leak.attrs.street === state.street) : leaks, state.sort),
    [leaks, state.street, state.sort],
  );
  const openIndex = state.leak ? shown.findIndex((leak) => leak.id === state.leak) : -1;
  const visible = all || openIndex >= PREVIEW ? shown : shown.slice(0, PREVIEW);
  const totalEv = shown.reduce((sum, leak) => sum + leak.evLossBb, 0);

  // A link to one leak (the overview's card makes them) lands on it, once.
  useEffect(() => {
    if (!arrivedOn.current || openIndex < 0 || typeof document === "undefined") return;
    if (shown[openIndex].id !== arrivedOn.current) return;
    arrivedOn.current = null;
    document.getElementById(`leak-${shown[openIndex].id}`)?.scrollIntoView({ block: "start" });
  }, [openIndex, shown]);

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
          <h3>{t.notInstalledHeading}</h3>
          <p className="muted">
            {t.notInstalledBefore}
            <code>{LEAKS_MIGRATION}</code>
            {t.notInstalledAfter}
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

  if (!coverage || !report) {
    return (
      <div className="stats">
        <Header />
        <p className="muted" role="status">
          {t.loading}
        </p>
      </div>
    );
  }

  if (coverage.atVersion === 0 || report.facets.sites.length === 0) {
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

  return (
    <div className="stats">
      <Header sample={t.sample(report.graded, report.hands)} />
      <div className={`notice notice--info ${reportStyles.intro}`}>
        <span>{t.intro}</span>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          aria-expanded={howOpen}
          aria-controls={HOW_ID}
          onClick={() => setHowOpen((open) => !open)}
        >
          {t.how.toggle}
        </button>
      </div>
      <HowItWorks open={howOpen} />

      <FilterBar state={state} facets={report.facets} onChange={(patch) => updateState({ ...patch, leak: null })} />
      <Controls state={state} onChange={updateState} />

      {loading ? (
        <p className={reportStyles.busy} role="status">
          {t.loading}
        </p>
      ) : null}

      {report.graded === 0 ? <p className="card muted">{t.noneInScope}</p> : null}
      {report.graded > 0 && shown.length === 0 ? <p className="card muted">{t.noLeaks}</p> : null}

      {shown.length > 0 ? (
        <section className="card stats-group" aria-labelledby="leaks-list">
          <h3 id="leaks-list" className={reportStyles.cardTitle}>
            {t.heading}
          </h3>
          <p className={reportStyles.muted}>
            {t.total(totalEv, report.hands > 0 ? (totalEv / report.hands) * 100 : 0, shown.length)}
          </p>
          <ol className={styles.leaks}>
            {visible.map((leak) => (
              <LeakItem
                key={leak.id}
                leak={leak}
                rank={shown.indexOf(leak) + 1}
                open={state.leak === leak.id}
                filters={filters}
                drills={drills}
                onToggle={() => updateState({ leak: state.leak === leak.id ? null : leak.id })}
              />
            ))}
          </ol>
          {shown.length > PREVIEW ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAll((value) => !value)}>
              {all ? t.showFewer : t.showAll(shown.length)}
            </button>
          ) : null}
        </section>
      ) : null}
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

function Header({ sample }: { sample?: string }) {
  const t = useDict().analysis.leaks;
  return (
    <>
      <header className="stats__head">
        <h2>{t.heading}</h2>
        {sample ? <span className="stats__sample">{sample}</span> : null}
      </header>
      <AnalysisNav current="leaks" />
    </>
  );
}

function HowItWorks({ open }: { open: boolean }) {
  const t = useDict().analysis.leaks.how;
  return (
    <section id={HOW_ID} className={`card ${reportStyles.how}`} hidden={!open} aria-label={t.title}>
      <h3 className={reportStyles.howTitle}>{t.title}</h3>
      <p>{t.spot}</p>
      <p>{t.frequency}</p>
      <p>{t.merge}</p>
      <p>{t.confidence}</p>
      <p className={reportStyles.muted}>{t.reference}</p>
    </section>
  );
}

function Controls({ state, onChange }: { state: LeaksState; onChange: (patch: Partial<LeaksState>) => void }) {
  const t = useDict().analysis.leaks;
  return (
    <div className={reportStyles.filters} role="group" aria-label={t.heading}>
      <label className="field">
        <span className="field__label">{t.controls.street}</span>
        <select value={state.street ?? ""} onChange={(event) => onChange({ street: event.target.value || null, leak: null })}>
          <option value="">{t.controls.anyStreet}</option>
          {LEAK_STREETS.map((street) => (
            <option key={street} value={street}>
              {t.streets[street]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field__label">{t.controls.sort}</span>
        <select value={state.sort} onChange={(event) => onChange({ sort: event.target.value as LeakSort })}>
          {LEAK_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {t.controls.sorts[sort]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** Title, context and street of a leak, in the reader's language. */
function useLeakWords() {
  const t = useDict().analysis.leaks;
  return useCallback(
    (leak: Leak) => {
      const title = t.title(leakKind(leak.attrs.taken, leak.attrs.best), leak.attrs);
      const context = t.fullContext(leak.attrs, leak.level, leak.partial);
      return { title, context, street: t.streets[leak.attrs.street] ?? leak.attrs.street, name: t.name(title, context, leak.attrs.street) };
    },
    [t],
  );
}

function ConfidenceTag({ leak }: { leak: Leak }) {
  const t = useDict().analysis.leaks;
  return (
    <span className={`${styles.confidence} ${styles[leak.confidence]}`}>
      <span aria-hidden="true" className={styles.confidenceGlyph}>
        {CONFIDENCE_GLYPH[leak.confidence]}
      </span>
      {t.confidence[leak.confidence]}
    </span>
  );
}

/** A leak's drills: how many there are and how many are due today, summed over its spots. */
function drillCount(leak: Leak, drills: Map<string, { items: number; due: number }> | null) {
  if (!drills) return null;
  let items = 0;
  let due = 0;
  for (const key of leak.keys) {
    const row = drills.get(key);
    if (row) {
      items += row.items;
      due += row.due;
    }
  }
  return { items, due };
}

function LeakItem({
  leak,
  rank,
  open,
  filters,
  drills,
  onToggle,
}: {
  leak: Leak;
  rank: number;
  open: boolean;
  filters: AnalysisFilters;
  drills: Map<string, { items: number; due: number }> | null;
  onToggle: () => void;
}) {
  const t = useDict().analysis.leaks;
  const train = useDict().analysis.train.leak;
  const words = useLeakWords()(leak);
  const panelId = useId();
  const count = drillCount(leak, drills);
  return (
    <li id={`leak-${leak.id}`} className={styles.leak} data-open={open || undefined}>
      <h4 className={styles.leakHeading}>
        <button type="button" className={styles.leakToggle} aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
          <span aria-hidden="true" className={reportStyles.chevron}>
            {open ? "▾" : "▸"}
          </span>
          <span className={styles.rank}>{t.rank(rank)}</span>
          <span className={styles.leakName}>
            <span className={styles.leakTitle}>{words.title}</span>
            <span className={styles.leakContext}>
              {words.context} · {words.street}
            </span>
          </span>
          <span className={styles.leakEv}>{t.evLost(leak.evLossBb)}</span>
        </button>
      </h4>
      <p className={styles.leakStats}>
        <span>{t.per100(leak.per100)}</span>
        <span>{t.spotTimes(leak.mistakes, leak.spotDecisions)}</span>
        <span>{t.perMistake(leak.perMistake)}</span>
        <ConfidenceTag leak={leak} />
        {count && count.due > 0 ? <span className={styles.drillBadge}>{train.badge(count.due)}</span> : null}
      </p>
      <div id={panelId} hidden={!open} className={styles.leakPanel}>
        {open ? <LeakDetail leak={leak} filters={filters} drills={count} /> : null}
      </div>
    </li>
  );
}

function LeakDetail({
  leak,
  filters,
  drills,
}: {
  leak: Leak;
  filters: AnalysisFilters;
  drills: { items: number; due: number } | null;
}) {
  const t = useDict().analysis.leaks;
  const train = useDict().analysis.train.leak;
  const drillId = useId();
  return (
    <div className={reportStyles.detail}>
      <p className={styles.describe}>
        {t.detail.describe(t.context(leak.attrs), t.streetsIn[leak.attrs.street] ?? leak.attrs.street, leak.mistakes, leak.spotDecisions, leak.evLossBb)}
      </p>
      {leak.level > 0 ? (
        <p className={reportStyles.muted}>
          {t.detail.merged(leak.situationKeys.length)} {leak.partial ? t.detail.partial : null}
        </p>
      ) : null}
      {leak.confidence === "low" ? <p className="notice notice--warn">{t.detail.lowNote}</p> : null}

      <div className={styles.mixes}>
        <div>
          <h5 className={styles.mixHead}>{t.detail.youDid}</h5>
          <p>{t.detail.mix(leak.taken)}</p>
        </div>
        <div>
          <h5 className={styles.mixHead}>{t.detail.referenceDoes}</h5>
          <p>{t.detail.mix(leak.best)}</p>
        </div>
      </div>
      <p className={reportStyles.muted}>
        {t.detail.best(leak.attrs.best)} {t.detail.mixNote}
      </p>

      <dl className={styles.numbers}>
        <div>
          <dt>{t.columns.evLost}</dt>
          <dd>
            {t.bb(leak.evLossBb)} <span className={reportStyles.interval}>{t.detail.per100(leak.per100)}</span>
          </dd>
        </div>
        <div>
          <dt>{t.columns.spot}</dt>
          <dd>
            {leak.spotDecisions} <span className={reportStyles.interval}>{t.detail.perSpot(leak.perSpot)}</span>
          </dd>
        </div>
        <div>
          <dt>{t.columns.mistakes}</dt>
          <dd>
            {leak.mistakes}{" "}
            <span className={reportStyles.interval}>
              {t.detail.perMistake(leak.perMistake)} · {t.detail.seriousNote(leak.serious)}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t.columns.confidence}</dt>
          <dd>
            <ConfidenceTag leak={leak} />{" "}
            <span className={reportStyles.interval}>{t.confidenceHint(leak.spotDecisions, leak.mistakes)}</span>
          </dd>
        </div>
      </dl>

      <LearnLinks concepts={leakConcepts(leak.attrs)} />

      <div className={styles.drill}>
        <Link href={paths.analysisTrain(drillQuery(leak.keys))} className="btn btn--sm" aria-describedby={drills ? drillId : undefined}>
          {t.detail.drill}
        </Link>
        {drills ? (
          <span id={drillId} className={reportStyles.muted}>
            {train.due(drills.due, drills.items)}
          </span>
        ) : null}
      </div>

      <LeakHands leak={leak} filters={filters} />
    </div>
  );
}

function LeakHands({ leak, filters }: { leak: Leak; filters: AnalysisFilters }) {
  const en = useDict().analysis;
  const t = en.leaks;
  const locale = useIntlLocale();
  const keys = leak.keys.join(",");
  const filterKey = JSON.stringify(filters);
  const [pages, setPages] = useState(1);
  const [data, setData] = useState<{ key: string; total: number; rows: LeakHandRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestKey = `${keys}|${filterKey}|${pages}`;
  const loading = data?.key !== requestKey && !error;

  useEffect(() => {
    let live = true;
    fetchLeakHands(JSON.parse(filterKey) as AnalysisFilters, { keys: keys.split(","), limit: HANDS_PAGE * pages })
      .then((page) => {
        if (live) setData({ key: requestKey, total: page.total, rows: page.rows });
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
    };
  }, [keys, filterKey, pages, requestKey]);

  const when = (iso: string | null) =>
    iso ? dateFormat(locale, { day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(iso)) : "";
  // Merged leaks span several spots: each hand says which one it was.
  const spotOf = (row: LeakHandRow) => {
    if (row.street === "preflop" && (row.line !== "" || row.scenario === "unopened")) {
      // The line's own table: a 9-max set's line walks on 9-max seats (A2c).
      const seats = lineSeats(row.line, row.position ?? "");
      return en.charts.spotLabel(
        walkLine(row.line, seats).next ?? row.position ?? "",
        lineSteps(row.line, seats).map((step) => ({ position: step.position, verb: en.charts.verbs[step.verb] ?? step.verb })),
      );
    }
    return `${en.breakdown.scenario(row.scenario)}${row.position ? ` (${row.position})` : ""}`;
  };

  return (
    <div className={reportStyles.hands}>
      <h5 className={reportStyles.subhead}>{t.hands.heading}</h5>
      <p className={reportStyles.muted}>{t.hands.note}</p>
      {error ? <p className="notice notice--error">{t.hands.failed(error)}</p> : null}
      {loading && !data ? <p className={reportStyles.muted}>{t.hands.loading}</p> : null}
      {data && data.rows.length === 0 ? <p className={reportStyles.muted}>{t.hands.empty}</p> : null}
      {data && data.rows.length > 0 ? (
        <ul className={reportStyles.handList} aria-busy={loading}>
          {data.rows.map((row) => {
            const cards = row.heroCards.join(" ");
            return (
              <li key={`${row.handId}-${row.ord}`} className={reportStyles.handRow}>
                <Link
                  href={paths.analysisHand(row.handId)}
                  className={reportStyles.handLink}
                  aria-label={t.hands.open(cards || row.handClass || row.handId)}
                >
                  {row.heroCards.length ? <CardRow cards={row.heroCards} size="xs" /> : null}
                  <span className={reportStyles.handClass}>{row.handClass ?? ""}</span>
                  <span className={reportStyles.muted}>{row.position ?? ""}</span>
                </Link>
                <span className={reportStyles.handWhat}>
                  {leak.level > 0 ? <span className={reportStyles.handSpot}>{spotOf(row)}</span> : null}
                  <span>{t.hands.took(t.actions[row.taken] ?? row.taken, t.actions[row.best] ?? row.best)}</span>
                </span>
                <span className={reportStyles.handGrade}>
                  {row.grade ? (
                    <span className={`${analysisStyles.gradeTag} ${analysisStyles[row.grade] ?? ""}`}>
                      <GradeIcon grade={row.grade} />
                      {en.grades[row.grade] ?? row.grade}
                    </span>
                  ) : null}
                  {row.evLossBb !== null && row.evLossBb > 0 ? <span className="num">{t.hands.evLoss(row.evLossBb)}</span> : null}
                  <span className={reportStyles.muted}>{when(row.playedAt)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {data && data.total > data.rows.length ? (
        <button type="button" className="btn btn--ghost btn--sm" disabled={loading} onClick={() => setPages((value) => value + 1)}>
          {t.hands.more}
        </button>
      ) : null}
      {data && data.total > 0 ? <p className={reportStyles.muted}>{t.hands.total(data.total)}</p> : null}
    </div>
  );
}
