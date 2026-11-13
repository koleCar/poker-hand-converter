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
 * not drilled yet counts as due, since the trainer's first sync makes it so),
 * both on the leak's own table (`handsTable`; `drill_due_by_spot`'s `tables`,
 * `drill_queue_on_table`): a heads-up leak's keys also hold the 6-max blinds'.
 */

"use client";

import { RailLoader } from "@rail/ui/loader/RailLoader";
import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  LEAK_SORTS,
  LEAK_STREETS,
  groupLeaks,
  leakConcepts,
  leakKind,
  sortLeaks,
  type Leak,
} from "../../../lib/analysis/leaks";
import { drillsOn, handsPot, handsTable, lineSeats, type SpotDrills } from "../../../lib/analysis/leaks";
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
import { useAnalysisKind } from "../analysisKind";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import { CardRow } from "@rail/ui/cards/PlayingCard";
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
import an from "../ui/an.module.css";
import "../../../styles/stats.css";

/** The migration the screen needs, named in the not-installed notice. An identifier, not prose. */
const LEAKS_MIGRATION = "supabase/migrations/20270201090000_analysis_leaks.sql";
const PREVIEW = 10;
const HANDS_PAGE = 8;
const HOW_ID = "leaks-how";

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
  const [drills, setDrills] = useState<Map<string, SpotDrills> | null>(null);
  // Only a leak named by the address on arrival is scrolled to; one opened here stays put.
  const arrivedOn = useRef(state.leak);

  // One kind of game, never both (`analysisKind.ts`): nothing is read until it is known.
  const kinds = useAnalysisKind(state.kind, isDatabaseConfigured && auth.isSignedIn, refreshToken);
  const shownState = useMemo(() => ({ ...state, kind: kinds.kind }), [state, kinds.kind]);
  const kindReady = kinds.kind !== null;
  const filters = useMemo(() => reportsFilters(shownState), [shownState]);
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
    if (!isDatabaseConfigured || !auth.isSignedIn || !kindReady) return;
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
  }, [auth.isSignedIn, kindReady, filterKey, requestKey]);

  // Drills per spot: the trainer's counts, for "Drill this". Quiet when the
  // drills are not installed (the trainer's migration) or anything fails.
  useEffect(() => {
    if (!isDatabaseConfigured || !auth.isSignedIn || kinds.kind === null) return;
    let live = true;
    fetchDrillsBySpot(kinds.kind)
      .then((map) => {
        if (live) setDrills(map);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [auth.isSignedIn, kinds.kind, refreshToken]);

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
        <RailLoader label={t.loading} showLabel centered />
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
      <Header
        tools={
          <>
            <FilterBar
              state={shownState}
              kinds={kinds}
              facets={report.facets}
              onChange={(patch) => updateState({ ...patch, leak: null })}
            />
            <button
              type="button"
              className={an.chip}
              aria-expanded={howOpen}
              aria-controls={HOW_ID}
              onClick={() => setHowOpen((open) => !open)}
            >
              {t.how.toggle}
            </button>
          </>
        }
      />
      <HowItWorks open={howOpen} />

      <Controls state={state} onChange={updateState} />

      {loading ? (
        <p className={reportStyles.busy}>
          <RailLoader size="inline" label={t.loading} showLabel />
        </p>
      ) : null}

      {report.graded === 0 ? <p className="card muted">{t.noneInScope}</p> : null}
      {report.graded > 0 && shown.length === 0 ? <p className="card muted">{t.noLeaks}</p> : null}

      {shown.length > 0 ? (
        <section className={`${an.card} rail-dims`} style={{ padding: 8, gap: 2 }} aria-label={t.heading} aria-busy={loading}>
          <p className={`${an.cardHead} ${an.xs} ${an.dim}`} style={{ padding: "6px 12px 8px", margin: 0 }}>
            {t.total(totalEv, report.hands > 0 ? (totalEv / report.hands) * 100 : 0, shown.length)}
          </p>
          {/* Re-keyed on the answered filters and the ranking, so a new list arrives row by row. */}
          <ol key={`${answer?.key.split("|")[0]}|${state.street ?? ""}|${state.sort}`} className={`${styles.leaksList} rail-stagger`}>
            {visible.map((leak) => (
              <LeakItem
                key={leak.id}
                leak={leak}
                rank={shown.indexOf(leak) + 1}
                open={state.leak === leak.id}
                filters={filters}
                drills={drills}
                max={Math.max(0, ...shown.map((entry) => entry.evLossBb))}
                onToggle={() => updateState({ leak: state.leak === leak.id ? null : leak.id })}
              />
            ))}
          </ol>
          {shown.length > PREVIEW ? (
            <button type="button" className="btn btn--ghost btn--sm" style={{ alignSelf: "center" }} onClick={() => setAll((value) => !value)}>
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

function Header({ tools }: { tools?: ReactNode }) {
  return <AnalysisNav current="leaks">{tools}</AnalysisNav>;
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
    <div className={an.sub} role="group" aria-label={t.heading}>
      <div className={an.tools}>
        <button type="button" className={an.chip} aria-pressed={state.street === null} onClick={() => onChange({ street: null, leak: null })}>
          {t.controls.anyStreet}
        </button>
        {LEAK_STREETS.map((street) => (
          <button
            key={street}
            type="button"
            className={an.chip}
            aria-pressed={state.street === street}
            onClick={() => onChange({ street: state.street === street ? null : street, leak: null })}
          >
            <i className={an.dot} style={{ background: STREET_COLOURS[street] ?? "var(--text-secondary)" }} aria-hidden="true" />
            {t.streets[street]}
          </button>
        ))}
      </div>
      <span className={an.grow} />
      <span className={`${an.xs} ${an.dim}`}>{t.controls.sort}</span>
      <div className={an.seg} role="group" aria-label={t.controls.sort}>
        {LEAK_SORTS.map((sort) => (
          <button key={sort} type="button" aria-pressed={state.sort === sort} onClick={() => onChange({ sort })}>
            {t.controls.sorts[sort]}
          </button>
        ))}
      </div>
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

/** A leak's drills: how many there are and how many are due today, summed over its spots on its table. */
function drillCount(leak: Leak, drills: Map<string, SpotDrills> | null) {
  if (!drills) return null;
  return drillsOn(drills, leak.keys, handsTable(leak.attrs, leak.level), handsPot(leak.attrs));
}

function LeakItem({
  leak,
  rank,
  open,
  filters,
  drills,
  max,
  onToggle,
}: {
  leak: Leak;
  rank: number;
  open: boolean;
  filters: AnalysisFilters;
  drills: Map<string, SpotDrills> | null;
  /** The list's largest EV loss: the bars' full length. */
  max: number;
  onToggle: () => void;
}) {
  const t = useDict().analysis.leaks;
  const train = useDict().analysis.train.leak;
  const words = useLeakWords()(leak);
  const panelId = useId();
  const count = drillCount(leak, drills);
  const level = { low: 1, medium: 2, high: 3 } as const;
  return (
    <li id={`leak-${leak.id}`} className={styles.leakRow} data-open={open || undefined}>
      <h4 className={styles.leakHeading}>
        <button type="button" className={`${an.lrow} ${styles.leakLine}`} aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
          <span className={`${an.xs} ${an.dim} ${styles.leakRank}`}>{rank}</span>
          <i className={an.dot} style={{ background: STREET_COLOURS[leak.attrs.street] ?? "var(--text-secondary)" }} aria-hidden="true" />
          <span className={styles.leakNames}>
            <span className={an.strong}>{words.title}</span>
            <span className={`${an.xs} ${an.dim}`}>
              {words.context} · {words.street}
            </span>
          </span>
          <span className={`${an.hbar} ${styles.leakBar}`} aria-hidden="true">
            <i style={{ inlineSize: `${max > 0 ? (leak.evLossBb / max) * 100 : 0}%` }} />
          </span>
          <span className={`${an.xs} ${an.dim} ${styles.leakCount}`}>{t.spotTimes(leak.mistakes, leak.spotDecisions)}</span>
          <span className={an.conf} title={t.confidence[leak.confidence]} aria-label={t.confidence[leak.confidence]}>
            {[1, 2, 3].map((n) => (
              <i key={n} data-on={n <= level[leak.confidence]} />
            ))}
          </span>
          <span className={styles.leakDue}>{count && count.due > 0 ? <span className={`${an.chip} ${an.chipOn}`}>{train.badge(count.due)}</span> : null}</span>
          <span className={`${an.strong} ${an.neg} ${styles.leakValue}`}>{t.evLost(leak.evLossBb)}</span>
          <span aria-hidden="true" className={styles.leakChevron} data-open={open || undefined}>
            ›
          </span>
        </button>
      </h4>
      <div id={panelId} hidden={!open} className={`${styles.leakPanelNew} rail-fade`}>
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
    <div className={styles.detailNew}>
      {leak.confidence === "low" ? <p className="notice notice--warn">{t.detail.lowNote}</p> : null}
      <div className={styles.detailTop}>
        <MixBars you={leak.taken} reference={leak.best} youLabel={t.detail.youDid} refLabel={t.detail.referenceDoes} />
        <div className={an.kpis} style={{ columnGap: 24 }}>
          <dl className={an.kpi}>
            <dt>{t.columns.evLost}</dt>
            <dd className={an.neg} style={{ fontSize: 18 }}>
              {t.bb(leak.evLossBb)}
            </dd>
          </dl>
          <dl className={an.kpi}>
            <dt>{t.columns.spot}</dt>
            <dd style={{ fontSize: 18 }}>{leak.spotDecisions}</dd>
          </dl>
          <dl className={an.kpi}>
            <dt>{t.columns.mistakes}</dt>
            <dd style={{ fontSize: 18 }}>{leak.mistakes}</dd>
          </dl>
          <dl className={an.kpi}>
            <dt>{t.detail.perMistake(leak.perMistake)}</dt>
            <dd className={an.xs} style={{ fontSize: 12, fontWeight: 500 }}>
              {t.detail.per100(leak.per100)}
            </dd>
          </dl>
        </div>
      </div>
      {leak.level > 0 ? (
        <p className={`${an.xs} ${an.dim}`}>
          {t.detail.merged(leak.situationKeys.length)} {leak.partial ? t.detail.partial : null}
        </p>
      ) : null}

      <LearnLinks concepts={leakConcepts(leak.attrs)} />

      <div className={styles.drill}>
        <Link href={paths.analysisTrain(drillQuery(leak.keys, handsTable(leak.attrs, leak.level), handsPot(leak.attrs)))} className="btn btn--sm" aria-describedby={drills ? drillId : undefined}>
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

/** One colour per street, for the leak rows' dots. */
const STREET_COLOURS: Record<string, string> = {
  preflop: "var(--text-secondary)",
  flop: "var(--accent)",
  turn: "var(--chart-check)",
  river: "var(--ev-fg)",
};

const MIX_COLOURS: Record<keyof Leak["taken"], string> = {
  fold: "var(--chart-fold)",
  check: "var(--chart-check)",
  call: "var(--chart-call)",
  bet: "var(--chart-bet-medium)",
  raise: "var(--chart-raise)",
};

/** What you did and what the reference does here, as two stacked bars with the gap per action. */
function MixBars({
  you,
  reference,
  youLabel,
  refLabel,
}: {
  you: Leak["taken"];
  reference: Leak["best"];
  youLabel: string;
  refLabel: string;
}) {
  const t = useDict().analysis.leaks;
  const keys = (Object.keys(MIX_COLOURS) as Array<keyof Leak["taken"]>).filter((key) => you[key] + reference[key] > 0);
  const total = (mix: Leak["taken"]) => keys.reduce((sum, key) => sum + mix[key], 0) || 1;
  const yt = total(you);
  const rt = total(reference);
  const bar = (mix: Leak["taken"], whole: number) => (
    <span className={an.mbar} style={{ flex: 1, blockSize: 14 }}>
      {keys.map((key) =>
        mix[key] > 0 ? <i key={key} style={{ inlineSize: `${(mix[key] / whole) * 100}%`, background: MIX_COLOURS[key] }} /> : null,
      )}
    </span>
  );
  return (
    <div className={styles.mixBars}>
      <div className={styles.mixLine}>
        <span className={`${an.xs} ${an.dim}`}>{youLabel}</span>
        {bar(you, yt)}
      </div>
      <div className={styles.mixLine}>
        <span className={`${an.xs} ${an.dim}`}>{refLabel}</span>
        {bar(reference, rt)}
      </div>
      <div className={styles.mixKeys}>
        {keys.map((key) => {
          const gap = Math.round((you[key] / yt - reference[key] / rt) * 100);
          return (
            <span key={key} className={an.xs}>
              <i className={an.dot} style={{ background: MIX_COLOURS[key], borderRadius: 2 }} aria-hidden="true" /> {t.actions[key] ?? key}{" "}
              <b style={{ color: Math.abs(gap) >= 10 ? "var(--grade-mistake)" : "var(--text-secondary)" }}>
                {gap > 0 ? "+" : gap < 0 ? "−" : "±"}
                {Math.abs(gap)}%
              </b>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function LeakHands({ leak, filters }: { leak: Leak; filters: AnalysisFilters }) {
  const en = useDict().analysis;
  const t = en.leaks;
  const locale = useIntlLocale();
  const keys = leak.keys.join(",");
  // Its own table's decisions only: a spot key names no table.
  const table = handsTable(leak.attrs, leak.level);
  // ... and, postflop, its own pot's (a 3-bet pot leak's keys also hold the single-raised pots').
  const pot = handsPot(leak.attrs);
  const filterKey = JSON.stringify(filters);
  const [pages, setPages] = useState(1);
  const [data, setData] = useState<{ key: string; total: number; rows: LeakHandRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestKey = `${keys}|${table ?? ""}|${pot ?? ""}|${filterKey}|${pages}`;
  const loading = data?.key !== requestKey && !error;

  useEffect(() => {
    let live = true;
    fetchLeakHands(JSON.parse(filterKey) as AnalysisFilters, { keys: keys.split(","), table, pot, limit: HANDS_PAGE * pages })
      .then((page) => {
        if (live) setData({ key: requestKey, total: page.total, rows: page.rows });
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
    };
  }, [keys, table, pot, filterKey, pages, requestKey]);

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
      {loading && !data ? <RailLoader size="small" label={t.hands.loading} showLabel /> : null}
      {data && data.rows.length === 0 ? <p className={reportStyles.muted}>{t.hands.empty}</p> : null}
      {data && data.rows.length > 0 ? (
        <ul className={`${reportStyles.handList} rail-stagger rail-dims`} aria-busy={loading}>
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
          {loading ? <RailLoader size="inline" label={t.hands.loading} showLabel delay={0} /> : t.hands.more}
        </button>
      ) : null}
      {data && data.total > 0 ? <p className={reportStyles.muted}>{t.hands.total(data.total)}</p> : null}
    </div>
  );
}
