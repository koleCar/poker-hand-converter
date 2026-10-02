/**
 * The Analysis tab (`docs/ANALYSIS-PLAN.md` §6.0): grades, coverage, flags,
 * the breakdowns, and the hands list that opens each hand in the replayer.
 *
 * Built on the statistics screen's rule — **say which nothing it is** — with
 * one more nothing to tell apart: "analysed, and nothing was graded". Since
 * A2b preflop decisions are graded against the charts wherever a chart
 * covers the spot; postflop decisions are still facts and flags. The screen
 * says which is which, and a sample with no graded move says so in words
 * rather than drawing an empty distribution that reads as "you played
 * perfectly" — the confident wrong answer §9 warns about.
 *
 * ## Running the analysis
 *
 * It runs in this tab (`runAnalysis`, a Web Worker), so unlike statistics it
 * does not start itself on a large job: a first analysis of a 5,000-hand
 * library downloads tens of megabytes, which is a button press, not a side
 * effect of opening a page. A handful of new hands (`AUTO_RUN_LIMIT`) is caught
 * up quietly, the way statistics catch up after an upload. A version change is
 * announced, with the button, rather than run behind the reader's back.
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  fetchAnalysisBreakdown,
  fetchAnalysisCoverage,
  fetchAnalysisHands,
  fetchAnalysisOverview,
  isDatabaseConfigured,
  isMissingSchemaError,
  runAnalysis,
  type AnalysisBreakdownGroup,
  type AnalysisBreakdownRow,
  type AnalysisCoverage,
  type AnalysisHandRow,
  type AnalysisOverview,
  type AnalysisProgress,
  type AnalysisSort,
} from "../../lib/db";
import { ANALYSIS_SORTS } from "../../lib/db/analysis";
import { ANALYSIS_VERSION, FLAG_CODES, GRADES, type FlagCode } from "../../lib/analysis/types";
import type { GradeCounts } from "../../lib/db/analysis";
import { useAuth } from "../../lib/auth";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { getParser } from "../../lib/phf";
import { CardRow } from "../replayer/PlayingCard";
import { countIn, dateFormat, numberFormat, useIntlLocale } from "../stats/format";
import { FLAG_CONCEPTS } from "../../lib/learn/links";
import { ActionStrip } from "./ActionStrip";
import { AnalysisNav } from "./AnalysisNav";
import { GradeIcon } from "./GradeIcon";
import { WhatChanged } from "./leaks/WhatChanged";
import { DrillsDue } from "./train/DrillsDue";
import { LearnLink } from "./LearnLinks";
import {
  EMPTY_LIST_STATE,
  FORMAT_VALUES,
  GRADE_VALUES,
  POSITION_VALUES,
  POT_VALUES,
  STATUS_VALUES,
  STREET_VALUES,
  listFilters,
  listQuery,
  parseListState,
  scopeFilters,
  type AnalysisListState,
} from "./listState";
import styles from "./analysis.module.css";
import "../../styles/stats.css";

/** The migration the tab needs, named in the not-installed notice. An identifier, not prose. */
const ANALYSIS_MIGRATION = "supabase/migrations/20261228090000_analysis.sql";
/** At most this many new hands are analysed without asking. */
const AUTO_RUN_LIMIT = 300;
const PAGE_SIZE = 25;
/** The hands list's anchor, for "show them" from the overview. An id, not prose. */
const HANDS_ID = "analysis-hands";
const GROUPS = ["street", "position", "pot_type", "preflop_scenario", "scenario"] as const satisfies readonly AnalysisBreakdownGroup[];

type Status = "idle" | "loading" | "ready" | "not-installed" | "error";

type RunState =
  | { status: "idle" }
  | { status: "running"; progress: AnalysisProgress; target: number }
  | { status: "done"; progress: AnalysisProgress }
  | { status: "stopped" }
  | { status: "error"; message: string };

interface AnalysisTabProps {
  /** The page's `searchParams`: the list state the address bar holds. */
  initialQuery: Record<string, string | string[] | undefined>;
  /** Bumped by the shell after an upload lands. */
  refreshToken?: number;
}

export function AnalysisTab({ initialQuery, refreshToken = 0 }: AnalysisTabProps) {
  const t = useDict().analysis;
  const auth = useAuth();
  const [state, setState] = useState<AnalysisListState>(() => parseListState(initialQuery));
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<AnalysisCoverage | null>(null);
  const [overview, setOverview] = useState<AnalysisOverview | null>(null);
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const [generation, setGeneration] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const autoRan = useRef(false);

  const scope = useMemo(() => scopeFilters(state), [state]);
  const scopeKey = JSON.stringify(scope);

  // The address bar follows the list, so Back from a hand lands here again.
  const updateState = useCallback((patch: Partial<AnalysisListState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      const query = listQuery(next);
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", paths.analysis(query));
      }
      return next;
    });
  }, []);

  const load = useCallback(async (): Promise<AnalysisCoverage | null> => {
    setStatus("loading");
    setMessage(null);
    try {
      const nextCoverage = await fetchAnalysisCoverage();
      const nextOverview = await fetchAnalysisOverview(JSON.parse(scopeKey));
      setCoverage(nextCoverage);
      setOverview(nextOverview);
      setGeneration((value) => value + 1);
      setStatus("ready");
      return nextCoverage;
    } catch (error) {
      if (isMissingSchemaError(error)) {
        setStatus("not-installed");
        return null;
      }
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [scopeKey]);

  const startRun = useCallback(
    async (target: number) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setRun({ status: "running", progress: { processed: 0, saved: 0, failed: 0, pruned: 0 }, target });
      try {
        const progress = await runAnalysis(
          (next) => setRun({ status: "running", progress: next, target }),
          controller.signal,
        );
        setRun(controller.signal.aborted ? { status: "stopped" } : { status: "done", progress });
      } catch (error) {
        setRun({ status: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        abort.current = null;
        await load();
      }
    },
    [load],
  );

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (!isDatabaseConfigured || !auth.isSignedIn) {
      return;
    }
    void load().then((loaded) => {
      if (!loaded || autoRan.current) return;
      // New uploads since the last run, on a library that has been analysed
      // before at this version: catch up without asking.
      if (loaded.missing > 0 && loaded.missing <= AUTO_RUN_LIMIT && loaded.atVersion > 0 && loaded.stale === 0) {
        autoRan.current = true;
        void startRun(loaded.missing);
      }
    });
  }, [auth.isSignedIn, load, refreshToken, startRun]);

  if (!isDatabaseConfigured) {
    return (
      <div className="stats">
        <Header />
        <p className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</p>
      </div>
    );
  }

  if (!auth.isSignedIn) {
    return (
      <div className="stats">
        <Header />
        <div className="card stats-empty">
          <h3>{t.tab.signInHeading}</h3>
          <p className="muted">{t.tab.signInBody}</p>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
            {t.tab.signIn}
          </button>
        </div>
      </div>
    );
  }

  if (status === "not-installed") {
    return (
      <div className="stats">
        <Header />
        <div className="card stats-empty">
          <h3>{t.tab.notInstalledHeading}</h3>
          <p className="muted">
            {t.tab.notInstalledBefore}
            <code>{ANALYSIS_MIGRATION}</code>
            {t.tab.notInstalledAfter}
          </p>
          <button type="button" className="btn" onClick={() => void load()}>
            {t.tab.tryAgain}
          </button>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="stats">
        <Header />
        <p className="notice notice--error">{message}</p>
        <button type="button" className="btn" onClick={() => void load()}>
          {t.tab.tryAgain}
        </button>
      </div>
    );
  }

  if (status === "idle" || (status === "loading" && !coverage) || !coverage) {
    return (
      <div className="stats">
        <Header />
        <p className="muted">{t.tab.loading}</p>
      </div>
    );
  }

  const runBar = (
    <RunBar coverage={coverage} run={run} onRun={(target) => void startRun(target)} onStop={() => abort.current?.abort()} />
  );

  if (coverage.hands === 0) {
    return (
      <div className="stats">
        <Header />
        <div className="card stats-empty">
          <h3>{t.tab.noHandsHeading}</h3>
          <p className="muted">{t.tab.noHandsBody}</p>
        </div>
      </div>
    );
  }

  if (coverage.atVersion === 0 && run.status !== "done") {
    return (
      <div className="stats">
        <Header />
        <ReferenceNote />
        <div className="card stats-empty">
          {/* A version bump is not "nothing analysed": say what changed. */}
          <h3>{coverage.stale > 0 ? t.tab.updatedHeading : t.tab.emptyHeading}</h3>
          <p className="muted">{coverage.stale > 0 ? t.tab.updatedBody : t.tab.emptyBody}</p>
          {runBar}
        </div>
      </div>
    );
  }

  return (
    <div className="stats">
      <Header sample={t.tab.sample(coverage.atVersion, ANALYSIS_VERSION)} />
      <ReferenceNote />
      {runBar}

      <ScopeBar state={state} onChange={updateState} />

      {overview ? (
        <Overview
          overview={overview}
          onShowBad={() => {
            updateState({ grade: "bad", sort: "ev_loss", page: 0 });
            if (typeof document !== "undefined") document.getElementById(HANDS_ID)?.scrollIntoView({ block: "start" });
          }}
        />
      ) : null}

      <DrillsDue generation={generation} />

      <WhatChanged scopeKey={scopeKey} generation={generation} />

      <BreakdownPanel scopeKey={scopeKey} generation={generation} />

      <HandsPanel state={state} onChange={updateState} generation={generation} />
    </div>
  );
}

function Header({ sample }: { sample?: string }) {
  const t = useDict().analysis.tab;
  return (
    <>
      <header className="stats__head">
        <h2>{t.heading}</h2>
        {sample ? <span className="stats__sample">{sample}</span> : null}
      </header>
      <AnalysisNav current="overview" />
    </>
  );
}

/** What is graded and what is not, and the charts' caveat, above everything it qualifies. */
function ReferenceNote() {
  const t = useDict().analysis.reference;
  return (
    <div className={`notice notice--info ${styles.reference}`}>
      <strong>{t.title}</strong>
      <span>{t.body}</span>
      <span>{t.model}</span>
      <Link href={paths.analysisCharts()} className={styles.learnInline}>
        {t.browse}
      </Link>
    </div>
  );
}

/* --------------------------------------------------------------- grades - */

const pctOf = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/** Perfect…Blunder as one stacked bar. Decorative: the numbers beside it say the same. */
function GradeBar({ counts }: { counts: GradeCounts }) {
  const total = GRADES.reduce((sum, grade) => sum + counts[grade], 0);
  return (
    <span className={styles.gradeBar} aria-hidden="true">
      {GRADES.map((grade) =>
        counts[grade] > 0 ? (
          <span
            key={grade}
            className={styles[`bar_${grade}`]}
            style={{ inlineSize: `${pctOf(counts[grade], total) * 100}%` }}
          />
        ) : null,
      )}
    </span>
  );
}

function countsOf(rows: Array<{ grade: string; decisions: number }>): GradeCounts {
  const counts: GradeCounts = { perfect: 0, good: 0, inaccurate: 0, mistake: 0, blunder: 0 };
  for (const row of rows) {
    if (row.grade in counts) counts[row.grade as keyof GradeCounts] += row.decisions;
  }
  return counts;
}

/** One row per key: graded moves, the five shares, EV loss and score. */
function GradeTable({
  rows,
  first,
  label,
  compact = false,
}: {
  rows: Array<{ key: string | null; graded: number; grades: GradeCounts; evLossBb: number | null; score: number | null }>;
  first: string;
  label: (key: string | null) => string;
  /** Leave out EV loss and score: the overview's by-street table has the distribution only. */
  compact?: boolean;
}) {
  const t = useDict().analysis;
  const locale = useIntlLocale();
  const count = countIn(locale);
  const fixed = numberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const pct = numberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  return (
    <div className="stats-table-wrap">
      <table className="stats-table">
        <thead>
          <tr>
            <th scope="col">{first}</th>
            <th scope="col" className="num">
              {t.table.graded}
            </th>
            <th scope="col">{t.table.distribution}</th>
            {GRADES.map((grade) => (
              <th key={grade} scope="col" className="num">
                <span className={styles[grade]}>
                  <GradeIcon grade={grade} />
                </span>{" "}
                {t.grades[grade]}
              </th>
            ))}
            {compact ? null : (
              <>
                <th scope="col" className="num">
                  {t.table.evLoss}
                </th>
                <th scope="col" className="num">
                  {t.table.score}
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key ?? "unknown"}>
              <th scope="row">{label(row.key)}</th>
              <td className="num">{count(row.graded)}</td>
              <td className={styles.barCell}>{row.graded > 0 ? <GradeBar counts={row.grades} /> : "—"}</td>
              {GRADES.map((grade) => (
                <td key={grade} className="num">
                  {row.graded > 0 ? pct.format(pctOf(row.grades[grade], row.graded)) : "—"}
                </td>
              ))}
              {compact ? null : (
                <>
                  <td className="num">{row.evLossBb === null || row.graded === 0 ? "—" : t.sheet.bb(row.evLossBb)}</td>
                  <td className="num">{row.score === null ? "—" : fixed.format(row.score)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The headline: score, EV loss per 100 hands, moves graded, and the distribution overall and by street. */
function GradesCard({ overview, onShowBad }: { overview: AnalysisOverview; onShowBad: () => void }) {
  const t = useDict().analysis;
  const locale = useIntlLocale();
  const count = countIn(locale);
  const fixed1 = numberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const counts = countsOf(overview.grades);
  const perHundred = overview.gradedHands > 0 && overview.evLossBb !== null ? (overview.evLossBb / overview.gradedHands) * 100 : null;

  if (overview.graded === 0) {
    return (
      <section className={`card stats-group ${styles.wide}`}>
        <h3 className={styles.cardTitle}>{t.overview.gradesHeading}</h3>
        <p className="muted">{t.overview.noGrades}</p>
      </section>
    );
  }

  const streets = ["preflop", "flop", "turn", "river"]
    .map((street) => {
      const grades = countsOf(overview.gradesByStreet.filter((row) => row.street === street));
      const graded = GRADES.reduce((sum, grade) => sum + grades[grade], 0);
      return { key: street, graded, grades, evLossBb: null, score: null };
    })
    .filter((row) => row.graded > 0);

  return (
    <section className={`card stats-group ${styles.wide}`}>
      <h3 className={styles.cardTitle}>{t.overview.gradesHeading}</h3>
      <dl className={styles.tiles}>
        <div>
          <dt>{t.overview.score}</dt>
          <dd>{overview.score === null ? "—" : fixed1.format(overview.score)}</dd>
          <dd className={styles.tileHint}>{t.overview.scoreHint}</dd>
        </div>
        <div>
          <dt>{t.overview.evLoss100}</dt>
          <dd>{perHundred === null ? "—" : t.overview.bb2(perHundred)}</dd>
          <dd className={styles.tileHint}>{t.overview.evLoss100Hint(overview.gradedHands)}</dd>
        </div>
        <div>
          <dt>{t.overview.moves}</dt>
          <dd>{count(overview.graded)}</dd>
          <dd className={styles.tileHint}>{t.overview.movesHint(overview.decisions)}</dd>
        </div>
      </dl>

      <div
        className={styles.distribution}
        role="img"
        aria-label={t.overview.distribution(
          GRADES.map((grade) => t.overview.share(t.grades[grade], pctOf(counts[grade], overview.graded))),
        )}
      >
        <GradeBar counts={counts} />
        <ul className={styles.gradeLegend} aria-hidden="true">
          {GRADES.map((grade) => (
            <li key={grade} className={styles[grade]}>
              <GradeIcon grade={grade} />
              <span className={styles.legendWord}>{t.overview.share(t.grades[grade], pctOf(counts[grade], overview.graded))}</span>
              <span className={styles.muted}>{count(counts[grade])}</span>
            </li>
          ))}
        </ul>
      </div>

      {overview.badHands > 0 ? (
        <p className={styles.badLine}>
          <span>{t.overview.badHands(overview.badHands)}</span>
          <button type="button" className="btn btn--sm" onClick={onShowBad}>
            {t.overview.showBad}
          </button>
        </p>
      ) : null}

      {streets.length > 0 ? (
        <>
          <h4 className={styles.subhead}>{t.overview.byStreet}</h4>
          <GradeTable rows={streets} first={t.table.street} label={(key) => t.streets[key ?? ""] ?? key ?? ""} compact />
        </>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ run - */

function RunBar({
  coverage,
  run,
  onRun,
  onStop,
}: {
  coverage: AnalysisCoverage;
  run: RunState;
  onRun: (target: number) => void;
  onStop: () => void;
}) {
  const t = useDict().analysis.run;
  const behind = coverage.missing + coverage.stale;

  if (run.status === "running") {
    return (
      <div className={`notice notice--info ${styles.run}`} role="status" aria-live="polite">
        <span>{t.running(run.progress.processed, run.target)}</span>
        <button type="button" className="btn btn--sm" onClick={onStop}>
          {t.stop}
        </button>
        <p className={styles.runNote}>{t.note}</p>
      </div>
    );
  }

  const lines: string[] = [];
  let tone = "notice--info";
  if (run.status === "error") {
    lines.push(t.failed(run.message));
    tone = "notice--error";
  } else if (run.status === "stopped") {
    lines.push(t.stopped);
  } else if (run.status === "done") {
    lines.push(t.finished(run.progress.processed));
    if (run.progress.failed > 0) lines.push(t.unreadable(run.progress.failed));
  }
  if (coverage.stale > 0) {
    lines.push(t.versionChanged(coverage.stale, ANALYSIS_VERSION));
    tone = run.status === "error" ? tone : "notice--warn";
  } else if (coverage.missing > 0 && coverage.atVersion > 0) {
    lines.push(t.missing(coverage.missing, coverage.hands));
  }

  if (lines.length === 0 && behind === 0) {
    return null;
  }
  return (
    <div className={`notice ${tone} ${styles.run}`}>
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
      {behind > 0 ? (
        <button type="button" className="btn btn--sm btn--primary" onClick={() => onRun(behind)}>
          {coverage.stale > 0 ? t.update : coverage.atVersion > 0 ? t.again : t.button}
        </button>
      ) : null}
      {behind > 0 ? <p className={styles.runNote}>{t.note}</p> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- scope - */

/** The filters the whole screen follows: format, position, pot type. */
function ScopeBar({
  state,
  onChange,
}: {
  state: AnalysisListState;
  onChange: (patch: Partial<AnalysisListState>) => void;
}) {
  const en = useDict();
  const t = en.analysis.filters;
  const formats: Partial<Record<string, string>> = { ...en.stats.scope.formats, sng: en.stats.scope.formats["sit-and-go"] };
  return (
    <div className={styles.filters} role="group" aria-label={t.ariaLabel}>
      <label className="field">
        <span className="field__label">{t.format}</span>
        <select
          value={state.gameFormat ?? ""}
          onChange={(event) => onChange({ gameFormat: event.target.value || null, page: 0 })}
        >
          <option value="">{en.stats.scope.allFormats}</option>
          {FORMAT_VALUES.map((format) => (
            <option key={format} value={format}>
              {formats[format] ?? format}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field__label">{t.position}</span>
        <select value={state.position ?? ""} onChange={(event) => onChange({ position: event.target.value || null, page: 0 })}>
          <option value="">{t.anyPosition}</option>
          {POSITION_VALUES.map((position) => (
            <option key={position} value={position}>
              {position}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field__label">{t.potType}</span>
        <select value={state.potType ?? ""} onChange={(event) => onChange({ potType: event.target.value || null, page: 0 })}>
          <option value="">{t.anyPot}</option>
          {POT_VALUES.map((pot) => (
            <option key={pot} value={pot}>
              {en.stats.breakdown.potTypes[pot] ?? pot}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/* ------------------------------------------------------------- overview - */

function Overview({ overview, onShowBad }: { overview: AnalysisOverview; onShowBad: () => void }) {
  const t = useDict().analysis;
  const count = countIn(useIntlLocale());
  const share = (part: number) => (overview.hands > 0 ? `${(part / overview.hands) * 100}%` : "0%");

  return (
    <div className={styles.cards}>
      <GradesCard overview={overview} onShowBad={onShowBad} />

      <section className="card stats-group">
        <h3 className={styles.cardTitle}>{t.overview.coverage}</h3>
        <div className={styles.bar} aria-hidden="true">
          <span className={styles.barFull} style={{ inlineSize: share(overview.status.full) }} />
          <span className={styles.barPartial} style={{ inlineSize: share(overview.status.partial) }} />
          <span className={styles.barNot} style={{ inlineSize: share(overview.status.notAnalysed) }} />
        </div>
        <dl className={styles.coverage}>
          {(["full", "partial", "notAnalysed"] as const).map((key) => (
            <div key={key}>
              <dt>
                {t.overview[key].label}
                <small>{t.overview[key].hint}</small>
              </dt>
              <dd>{count(overview.status[key])}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.muted}>{t.overview.analysedDecisions(overview.analysed, overview.decisions)}</p>
        {overview.reasons.length > 0 ? (
          <>
            <h4 className={styles.subhead}>{t.overview.reasonsHeading}</h4>
            <ul className={styles.reasons}>
              {overview.reasons.map((row) => (
                <li key={row.reason}>
                  <span>{t.reasons[row.reason] ?? row.reason}</span>
                  <span>{count(row.count)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {overview.skipped.length > 0 ? (
          <>
            <h4 className={styles.subhead}>{t.overview.skippedHeading}</h4>
            <ul className={styles.reasons}>
              {overview.skipped.map((row) => (
                <li key={row.reason}>
                  <span>{t.reasons[row.reason] ?? row.reason}</span>
                  <span>{t.overview.decisions(row.count)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="card stats-group">
        <h3 className={styles.cardTitle}>{t.overview.flagsHeading}</h3>
        <p className={styles.muted}>{t.overview.flagsNote}</p>
        {overview.flags.length === 0 ? (
          <p className="muted">{t.overview.noFlags}</p>
        ) : (
          <>
            <p className={styles.muted}>{t.overview.flaggedHands(overview.flaggedHands)}</p>
            <div className="stats-table-wrap">
              <table className="stats-table">
                <thead>
                  <tr>
                    <th scope="col">{t.table.flag}</th>
                    <th scope="col">{t.table.street}</th>
                    <th scope="col" className="num">
                      {t.table.count}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.flags.map((row) => (
                    <tr key={`${row.code}-${row.street}`}>
                      <th scope="row">
                        <span className={`${styles.tag} ${styles[row.severity]}`}>{t.severity[row.severity]}</span>{" "}
                        {t.flags[row.code] ?? row.code}
                        {FLAG_CONCEPTS[row.code as FlagCode]?.[0] ? (
                          <>
                            <br />
                            <LearnLink concept={FLAG_CONCEPTS[row.code as FlagCode][0]} />
                          </>
                        ) : null}
                      </th>
                      <td>{t.streets[row.street] ?? row.street}</td>
                      <td className="num">{count(row.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {overview.approximations.length > 0 ? (
          <>
            <h4 className={styles.subhead}>{t.overview.approximationsHeading}</h4>
            <ul className={styles.reasons}>
              {overview.approximations.map((row) => (
                <li key={row.approximation}>
                  <span>{t.approximations[row.approximation] ?? row.approximation}</span>
                  <span>{t.overview.hands(row.hands)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className={`card stats-group ${styles.wide}`}>
        <h3 className={styles.cardTitle}>{t.overview.streetsHeading}</h3>
        <StreetTable
          rows={overview.streets.map((row) => ({ ...row, key: row.street, hands: 0, inaccurate: 0 }))}
          first={t.table.street}
          label={(key) => t.streets[key ?? ""] ?? key ?? ""}
          showHands={false}
        />
        <p className={styles.muted}>{t.overview.defenceNote}</p>
      </section>
    </div>
  );
}

/** Decisions, flags and defence against MDF, one row per key. Shared by the overview and the breakdown. */
function StreetTable({
  rows,
  first,
  label,
  showHands,
}: {
  rows: Array<Omit<AnalysisBreakdownRow, "graded" | "gradedHands" | "grades" | "evLossBb" | "score">>;
  first: string;
  label: (key: string | null) => string;
  showHands: boolean;
}) {
  const t = useDict().analysis.table;
  const locale = useIntlLocale();
  const count = countIn(locale);
  const pct = numberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  return (
    <div className="stats-table-wrap">
      <table className="stats-table">
        <thead>
          <tr>
            <th scope="col">{first}</th>
            {showHands ? (
              <th scope="col" className="num">
                {t.hands}
              </th>
            ) : null}
            <th scope="col" className="num">
              {t.decisions}
            </th>
            <th scope="col" className="num">
              {t.flagged}
            </th>
            <th scope="col" className="num">
              {t.facingBet}
            </th>
            <th scope="col" className="num">
              {t.defended}
            </th>
            <th scope="col" className="num">
              {t.mdf}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key ?? "unknown"}>
              <th scope="row">{label(row.key)}</th>
              {showHands ? <td className="num">{count(row.hands)}</td> : null}
              <td className="num">{count(row.decisions)}</td>
              <td className="num">{count(row.flagged)}</td>
              <td className="num">{count(row.facingBet)}</td>
              <td className="num">{row.facingBet > 0 ? pct.format(row.defended / row.facingBet) : "—"}</td>
              <td className="num">{row.mdf !== null ? pct.format(row.mdf) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------ breakdown - */

function BreakdownPanel({ scopeKey, generation }: { scopeKey: string; generation: number }) {
  const en = useDict();
  const t = en.analysis.breakdown;
  const [group, setGroup] = useState<AnalysisBreakdownGroup>("street");
  // The rows remember the split they answer, so switching the split never
  // labels the previous split's rows with the new one's names.
  const [data, setData] = useState<{ group: AnalysisBreakdownGroup; rows: AnalysisBreakdownRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchAnalysisBreakdown(JSON.parse(scopeKey), group)
      .then((rows) => {
        if (live) {
          setData({ group, rows });
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
    };
  }, [scopeKey, group, generation]);

  const shown = data?.group ?? group;
  const label = (key: string | null): string => {
    if (key === null) return t.unknown;
    if (shown === "street") return en.analysis.streets[key] ?? key;
    if (shown === "pot_type") return en.stats.breakdown.potTypes[key] ?? key;
    if (shown === "scenario" || shown === "preflop_scenario") return t.scenario(key);
    return key;
  };
  const anyGraded = data?.rows.some((row) => row.graded > 0) ?? false;

  return (
    <section className="card stats-group">
      <div className="card__head stats-breakdown__head">
        <h3>{t.heading}</h3>
        <div className="stats-scope__formats" role="group" aria-label={t.splitBy}>
          {GROUPS.map((id) => (
            <button
              key={id}
              type="button"
              className={`btn btn--sm${group === id ? " btn--primary" : ""}`}
              aria-pressed={group === id}
              onClick={() => setGroup(id)}
            >
              {t.groups[id]}
            </button>
          ))}
        </div>
      </div>
      {error ? <p className="notice notice--error">{error}</p> : null}
      {data && anyGraded ? (
        <>
          <h4 className={styles.subhead}>{t.gradesTitle}</h4>
          <GradeTable rows={data.rows} first={t.groups[shown]} label={label} />
        </>
      ) : null}
      {data ? (
        <>
          <h4 className={styles.subhead}>{t.flagsTitle}</h4>
          <StreetTable rows={data.rows} first={t.groups[shown]} label={label} showHands />
        </>
      ) : null}
    </section>
  );
}

/* ----------------------------------------------------------------- list - */

function HandsPanel({
  state,
  onChange,
  generation,
}: {
  state: AnalysisListState;
  onChange: (patch: Partial<AnalysisListState>) => void;
  generation: number;
}) {
  const en = useDict();
  const t = en.analysis;
  const locale = useIntlLocale();
  const [rows, setRows] = useState<AnalysisHandRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const filterKey = JSON.stringify(listFilters(state));
  const query = listQuery(state);
  // "Loading" is derived — the page on screen answers an older request — so
  // the effect below never has to set state before its fetch resolves.
  const requestKey = `${filterKey}|${state.sort}|${state.page}|${generation}`;
  const [answeredKey, setAnsweredKey] = useState<string | null>(null);
  const loading = answeredKey !== requestKey;

  useEffect(() => {
    let live = true;
    const [filters, sort, page] = [JSON.parse(filterKey), state.sort, state.page];
    fetchAnalysisHands(filters, sort, PAGE_SIZE, page * PAGE_SIZE)
      .then((result) => {
        if (!live) return;
        setRows(result.rows);
        setTotal(result.total);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (live) setAnsweredKey(requestKey);
      });
    return () => {
      live = false;
    };
  }, [filterKey, state.sort, state.page, requestKey]);

  const when = (iso: string | null) =>
    iso ? dateFormat(locale, { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : t.list.noDate;
  const signed = numberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1, signDisplay: "exceptZero" });
  const from = total === 0 ? 0 : state.page * PAGE_SIZE + 1;
  const to = Math.min(total, (state.page + 1) * PAGE_SIZE);
  const anyFilter = state.street || state.flag || state.status || state.grade || state.sort !== "recent";
  const fixed2 = numberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const pctFormat = numberFormat(locale, { style: "percent", maximumFractionDigits: 1 });

  return (
    <section className="card stats-group" id={HANDS_ID}>
      <div className="card__head">
        <h3>{t.list.heading}</h3>
        <p className="muted">{t.list.total(total)}</p>
      </div>

      <div className={styles.filters}>
        <label className="field">
          <span className="field__label">{t.filters.street}</span>
          <select value={state.street ?? ""} onChange={(event) => onChange({ street: event.target.value || null, page: 0 })}>
            <option value="">{t.filters.anyStreet}</option>
            {STREET_VALUES.map((street) => (
              <option key={street} value={street}>
                {t.streets[street]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">{t.filters.flag}</span>
          <select value={state.flag ?? ""} onChange={(event) => onChange({ flag: event.target.value || null, page: 0 })}>
            <option value="">{t.filters.anyFlag}</option>
            <option value="any">{t.filters.flaggedOnly}</option>
            {FLAG_CODES.map((code) => (
              <option key={code} value={code}>
                {t.flags[code]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">{t.filters.grade}</span>
          <select value={state.grade ?? ""} onChange={(event) => onChange({ grade: event.target.value || null, page: 0 })}>
            <option value="">{t.filters.anyGrade}</option>
            {GRADE_VALUES.map((value) => (
              <option key={value} value={value}>
                {value === "bad" ? t.filters.badGrades : t.grades[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">{t.filters.status}</span>
          <select value={state.status ?? ""} onChange={(event) => onChange({ status: event.target.value || null, page: 0 })}>
            <option value="">{t.filters.anyStatus}</option>
            {STATUS_VALUES.map((value) => (
              <option key={value} value={value}>
                {value === "full" ? t.overview.full.label : value === "partial" ? t.overview.partial.label : t.overview.notAnalysed.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">{t.filters.sort}</span>
          <select value={state.sort} onChange={(event) => onChange({ sort: event.target.value as AnalysisSort, page: 0 })}>
            {ANALYSIS_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {t.filters.sorts[sort]}
              </option>
            ))}
          </select>
        </label>
        {anyFilter ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => onChange({ ...EMPTY_LIST_STATE, gameFormat: state.gameFormat, position: state.position, potType: state.potType })}
          >
            {t.filters.clear}
          </button>
        ) : null}
      </div>

      {error ? <p className="notice notice--error">{error}</p> : null}

      {!loading && rows.length === 0 ? (
        <p className="muted">{t.list.empty}</p>
      ) : (
        <div className="stats-table-wrap">
          <table className="stats-table" aria-busy={loading}>
            <thead>
              <tr>
                <th scope="col">{t.list.hand}</th>
                <th scope="col">{t.list.when}</th>
                <th scope="col">{t.list.pot}</th>
                <th scope="col">{t.list.actions}</th>
                <th scope="col">{t.list.grade}</th>
                <th scope="col" className="num">
                  {t.list.score}
                </th>
                <th scope="col" className="num">
                  {t.list.evLoss}
                </th>
                <th scope="col" className="num">
                  {t.list.evLossPot}
                </th>
                <th scope="col">{t.list.flags}</th>
                <th scope="col" className="num">
                  {t.list.result}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const cards = row.heroCards.join(" ");
                return (
                  <tr key={row.handId}>
                    <th scope="row">
                      <Link
                        href={paths.analysisHand(row.handId, query)}
                        className={styles.handLink}
                        aria-label={t.list.open(cards || row.handClass || row.handId)}
                      >
                        {row.heroCards.length ? <CardRow cards={row.heroCards} size="xs" /> : null}
                        <span className={styles.handCards}>{row.handClass ?? ""}</span>
                        {row.position ? <span className={styles.muted}>{row.position}</span> : null}
                      </Link>
                    </th>
                    <td>
                      {when(row.playedAt)}
                      <br />
                      <span className={styles.muted}>
                        {getParser(row.site)?.name ?? row.site}
                        {row.stakesLabel ? ` · ${row.stakesLabel}` : ""}
                      </span>
                    </td>
                    <td>{row.potType ? (en.stats.breakdown.potTypes[row.potType] ?? row.potType) : "—"}</td>
                    <td>
                      {row.status === "not-analysed" ? (
                        <span className={styles.muted}>{t.reasons[row.reason ?? ""] ?? row.reason}</span>
                      ) : (
                        <ActionStrip decisions={row.decisions} />
                      )}
                    </td>
                    <td>
                      {row.grade ? (
                        <span className={`${styles.gradeTag} ${styles[row.grade] ?? ""}`}>
                          <GradeIcon grade={row.grade} />
                          {t.grades[row.grade] ?? row.grade}
                        </span>
                      ) : (
                        <span className={styles.muted}>—</span>
                      )}
                    </td>
                    <td className="num">{row.score === null ? "—" : Math.round(row.score)}</td>
                    <td className="num">{row.evLossBb === null ? "—" : fixed2.format(row.evLossBb)}</td>
                    <td className="num">{row.evLossPot === null ? "—" : pctFormat.format(row.evLossPot)}</td>
                    <td>
                      {row.flagCount > 0 && row.worstFlag ? (
                        <span className={`${styles.tag} ${styles[row.worstFlag]}`}>
                          {row.flagCount} · {t.severity[row.worstFlag]}
                        </span>
                      ) : (
                        <span className={styles.muted}>—</span>
                      )}
                    </td>
                    <td className={`num ${row.netBb === null ? "" : row.netBb >= 0 ? styles.up : styles.down}`}>
                      {row.netBb === null ? "—" : en.stats.common.bb(signed.format(row.netBb))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE ? (
        <div className={styles.pager}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={state.page === 0}
            onClick={() => onChange({ page: Math.max(0, state.page - 1) })}
          >
            {t.list.previous}
          </button>
          <span className="muted">{t.list.page(from, to, total)}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={to >= total}
            onClick={() => onChange({ page: state.page + 1 })}
          >
            {t.list.next}
          </button>
        </div>
      ) : null}
    </section>
  );
}
