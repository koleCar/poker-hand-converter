/**
 * Reports (`/analysis/reports`, `docs/ANALYSIS-PLAN.md` §0.1 *Reports*, §6.3,
 * phase A3): your frequencies against the reference, with the hands where you
 * left it.
 *
 * The database counts (`analysis_node_actions`); the chart side — the whole
 * range's frequency at a node, the frequency for the hands you held, the
 * familiar stats rolled up from nodes, the uncertainty — is
 * `lib/analysis/reports.ts`, run here against the chart set that graded the
 * rows. Four sections:
 *
 * 1. **Stats** — RFI, steal, 3-bet, blind defence, fold to a steal, fold to a
 *    3-bet in and out of position, 4-bet, squeeze: yours, both references,
 *    the gap and a verdict; each row opens to its seats, its definition and
 *    the hands where you deviated.
 * 2. **Blind defence** against each opener: fold, call, 3-bet side by side.
 * 3. **Spot by spot** — the principled core: every chart node you have
 *    decisions at, every action against both references.
 * 4. **Postflop by role** — your own frequencies; no reference until A5.
 *
 * The verdict is never colour alone: a glyph and a word carry it too.
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ChartNode, ChartSet } from "../../../lib/charts";
import {
  POSTFLOP_ROLES,
  REPORT_STATS,
  defenceTable,
  nodeReport,
  nodeSamples,
  postflopRoles,
  statReport,
  walkLine,
  type Comparison,
  type DefenceRow,
  type NodeReport,
  type PostflopCount,
  type StatReport,
  type Verdict,
} from "../../../lib/analysis/reports";
import { preflopCharts } from "../../../lib/chartSet";
import {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  fetchAnalysisCoverage,
  isDatabaseConfigured,
  isMissingSchemaError,
  type AnalysisCoverage,
} from "../../../lib/db";
import type { AnalysisFilters } from "../../../lib/db/analysis";
import { fetchNodeActions, fetchNodeHands, type NodeActionsReport, type NodeHandRow } from "../../../lib/db/analysisReports";
import { useAuth } from "../../../lib/auth";
import { useDict } from "../../../lib/i18n/client";
import type { ConceptId } from "../../../lib/learn/concepts";
import { paths } from "../../../lib/routes";
import { getParser } from "../../../lib/phf";
import { CardRow } from "../../replayer/PlayingCard";
import { countIn, dateFormat, stakeLabel, useIntlLocale } from "../../stats/format";
import { AnalysisNav } from "../AnalysisNav";
import { GradeIcon } from "../GradeIcon";
import { LearnLink } from "../LearnLinks";
import { SPOT_CATEGORIES, categoriesOf, lineSteps, type SpotCategory } from "../chartSpots";
import analysisStyles from "../analysis.module.css";
import {
  EMPTY_REPORTS_STATE,
  REPORT_POSITIONS,
  parseReportsState,
  reportsFilters,
  reportsQuery,
  stakeKey,
  type ReportsState,
} from "./reportsState";
import styles from "./reports.module.css";
import "../../../styles/stats.css";

/** The migration the screen needs, named in the not-installed notice. An identifier, not prose. */
const REPORTS_MIGRATION = "supabase/migrations/20270111090000_analysis_reports.sql";
/** Spots shown before "show all". */
const NODE_PREVIEW = 8;
const HANDS_PAGE = 8;
const HOW_ID = "reports-how";

/** Each stat's concept page in the library. */
const STAT_CONCEPTS: Record<string, ConceptId> = {
  rfi: "rfi",
  steal: "steal",
  "three-bet": "three-bet",
  "blind-defence": "blind-defence",
  "fold-to-steal": "blind-defence",
  "fold-to-three-bet-ip": "three-bet",
  "fold-to-three-bet-oop": "three-bet",
  "four-bet": "three-bet",
  squeeze: "squeeze",
};

/** Glyphs, not words: the same in every language, beside the verdict's word. */
const VERDICT_GLYPH: Record<Verdict, string> = { "in-line": "✓", deviates: "!", "too-few": "·" };
const VERDICT_CLASS: Record<Verdict, string> = { "in-line": styles.inLine, deviates: styles.deviates, "too-few": styles.tooFew };

type Status = "loading" | "ready" | "not-installed" | "error";

interface Answer {
  key: string;
  status: Status;
  message: string | null;
}

interface ReportsTabProps {
  initialQuery: Record<string, string | string[] | undefined>;
  refreshToken?: number;
}

interface Built {
  nodes: NodeReport[];
  unmatched: number;
  stats: StatReport[];
  defence: DefenceRow[];
}

function build(charts: ChartSet, report: NodeActionsReport): Built {
  const samples = nodeSamples(report.actions, report.classes);
  const byKey = new Map(samples.map((sample) => [sample.key, sample]));
  const nodes: NodeReport[] = [];
  let unmatched = 0;
  for (const sample of samples) {
    const one = nodeReport(charts, sample);
    if (one) nodes.push(one);
    else unmatched += sample.decisions;
  }
  nodes.sort((a, b) => b.sample.decisions - a.sample.decisions || a.node.line.length - b.node.line.length || a.node.line.localeCompare(b.node.line));
  return {
    nodes,
    unmatched,
    stats: REPORT_STATS.map((id) => statReport(charts, byKey, id)),
    defence: defenceTable(charts, byKey),
  };
}

export function ReportsTab({ initialQuery, refreshToken = 0 }: ReportsTabProps) {
  const t = useDict().analysis.reports;
  const auth = useAuth();
  const [state, setState] = useState<ReportsState>(() => parseReportsState(initialQuery));
  // The latest answer, tagged with the request it answers: "loading" is
  // derived (the answer on screen is for an older request), so the effect
  // below never sets state before its fetch resolves.
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [data, setData] = useState<{ coverage: AnalysisCoverage | null; report: NodeActionsReport | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [charts, setCharts] = useState<ChartSet | null>(null);
  const [chartsError, setChartsError] = useState<string | null>(null);
  const [howOpen, setHowOpen] = useState(false);

  const filters = useMemo(() => reportsFilters(state), [state]);
  const filterKey = JSON.stringify(filters);

  const updateState = useCallback((patch: Partial<ReportsState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", paths.analysisReports(reportsQuery(next)));
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let live = true;
    preflopCharts()
      .then((loaded) => {
        if (live) setCharts(loaded);
      })
      .catch((error: unknown) => {
        if (live) setChartsError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, []);

  const requestKey = `${filterKey}|${refreshToken}|${attempt}`;
  useEffect(() => {
    if (!isDatabaseConfigured || !auth.isSignedIn) return;
    let live = true;
    Promise.all([fetchAnalysisCoverage(), fetchNodeActions(JSON.parse(filterKey) as AnalysisFilters)])
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

  const loading = answer?.key !== requestKey;
  const status = answer?.status ?? "loading";
  const message = answer?.message ?? null;
  const coverage = data?.coverage ?? null;
  const report = data?.report ?? null;
  const built = useMemo(() => (charts && report ? build(charts, report) : null), [charts, report]);

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
            <code>{REPORTS_MIGRATION}</code>
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
        <p className="notice notice--error">{message}</p>
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
      <Header sample={t.sample(report.decisions, report.hands)} />
      <div className={`notice notice--info ${styles.intro}`}>
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
      <HowToRead open={howOpen} />

      <FilterBar state={state} facets={report.facets} onChange={updateState} />

      {chartsError ? <p className="notice notice--error">{t.chartsFailed(chartsError)}</p> : null}
      {loading ? (
        <p className={styles.busy} role="status">
          {t.loading}
        </p>
      ) : null}
      {!built && !chartsError ? (
        <p className="muted" role="status">
          {t.loadingCharts}
        </p>
      ) : null}
      {built && built.unmatched > 0 ? <p className="notice notice--warn">{t.unmatched(built.unmatched)}</p> : null}

      {built && report.decisions === 0 ? <p className="card muted">{t.noneInScope}</p> : null}

      {built && report.decisions > 0 && charts ? (
        <>
          <StatsSection stats={built.stats} filters={filters} onHow={() => setHowOpen(true)} />
          <DefenceSection rows={built.defence} />
          <NodesSection nodes={built.nodes} filters={filters} onHow={() => setHowOpen(true)} />
        </>
      ) : null}

      <PostflopSection rows={report.postflop} />
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
  const t = useDict().analysis;
  return (
    <>
      <header className="stats__head">
        <h2>{t.reports.heading}</h2>
        {sample ? <span className="stats__sample">{sample}</span> : null}
      </header>
      <AnalysisNav current="reports" />
    </>
  );
}

function HowToRead({ open }: { open: boolean }) {
  const t = useDict().analysis.reports.how;
  return (
    <section id={HOW_ID} className={`card ${styles.how}`} hidden={!open} aria-label={t.title}>
      <h3 className={styles.howTitle}>{t.title}</h3>
      <p>{t.range}</p>
      <p>{t.adjusted}</p>
      <p>{t.verdict}</p>
      <p>{t.sample}</p>
      <p>{t.mixed}</p>
      <p className={styles.muted}>{t.model}</p>
    </section>
  );
}

/* --------------------------------------------------------------- filters - */

/** The report filters (dates, room, stake, seat); shared with Leaks and Progress (A6), which take the same keys. */
export function FilterBar({
  state,
  facets,
  onChange,
}: {
  state: ReportsState;
  facets: NodeActionsReport["facets"];
  onChange: (patch: Partial<ReportsState>) => void;
}) {
  const t = useDict().analysis.reports.filters;
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : undefined);
  const any = state.from || state.to || state.room || state.stake || state.position;
  return (
    <div className={styles.filters} role="group" aria-label={t.ariaLabel}>
      <label className="field">
        <span className="field__label">{t.from}</span>
        <input
          type="date"
          value={state.from ?? ""}
          min={day(facets.first)}
          max={state.to ?? day(facets.last)}
          onChange={(event) => onChange({ from: event.target.value || null })}
        />
      </label>
      <label className="field">
        <span className="field__label">{t.to}</span>
        <input
          type="date"
          value={state.to ?? ""}
          min={state.from ?? day(facets.first)}
          max={day(facets.last)}
          onChange={(event) => onChange({ to: event.target.value || null })}
        />
      </label>
      <label className="field">
        <span className="field__label">{t.room}</span>
        <select value={state.room ?? ""} onChange={(event) => onChange({ room: event.target.value || null })}>
          <option value="">{t.anyRoom}</option>
          {facets.sites.map((site) => (
            <option key={site.site} value={site.site}>
              {t.stakeOption(getParser(site.site)?.name ?? site.site, site.hands)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field__label">{t.stake}</span>
        <select value={state.stake ?? ""} onChange={(event) => onChange({ stake: event.target.value || null })}>
          <option value="">{t.anyStake}</option>
          {facets.stakes.map((stake) => (
            <option key={stakeKey(stake.currency, stake.bigBlind)} value={stakeKey(stake.currency, stake.bigBlind)}>
              {t.stakeOption(stakeLabel(stake, t.unknownStake), stake.hands)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field__label">{t.position}</span>
        <select value={state.position ?? ""} onChange={(event) => onChange({ position: event.target.value || null })}>
          <option value="">{t.anyPosition}</option>
          {REPORT_POSITIONS.map((position) => (
            <option key={position} value={position}>
              {position}
            </option>
          ))}
        </select>
      </label>
      {any ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange(EMPTY_REPORTS_STATE)}>
          {t.clear}
        </button>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- comparisons - */

function VerdictTag({ verdict }: { verdict: Verdict }) {
  const t = useDict().analysis.reports;
  return (
    <span className={`${styles.verdict} ${VERDICT_CLASS[verdict]}`}>
      <span aria-hidden="true" className={styles.glyph}>
        {VERDICT_GLYPH[verdict]}
      </span>
      {t.verdicts[verdict]}
    </span>
  );
}

/** You (with the interval), the reference, your hands' reference, the gap and the verdict, as table cells. */
function ComparisonCells({ c }: { c: Comparison }) {
  const t = useDict().analysis.reports;
  const dash = "—";
  return (
    <>
      <td className="num">
        {c.yours === null ? (
          dash
        ) : (
          <>
            <span className={c.verdict === "deviates" ? styles.deviates : undefined}>{t.pct(c.yours)}</span>
            {c.low !== null && c.high !== null ? <span className={styles.interval}>{t.interval(c.low, c.high)}</span> : null}
          </>
        )}
      </td>
      <td className="num">{c.reference === null ? dash : t.pct(c.reference)}</td>
      <td className="num">{c.adjusted === null ? dash : t.pct(c.adjusted)}</td>
      <td className="num">{c.diff === null ? dash : t.points(c.diff)}</td>
      <td>{c.decisions > 0 ? <VerdictTag verdict={c.verdict} /> : <span className={styles.muted}>{t.noDecisions}</span>}</td>
    </>
  );
}

function ComparisonHead({ first, onHow }: { first: string; onHow: () => void }) {
  const t = useDict().analysis.reports.columns;
  return (
    <tr>
      <th scope="col">{first}</th>
      <th scope="col" className="num">
        {t.decisions}
      </th>
      <th scope="col" className="num">
        {t.yours}
      </th>
      <th scope="col" className="num">
        {t.reference}
      </th>
      <th scope="col" className="num">
        <span className={styles.headWithHelp}>
          {t.adjusted}
          <button
            type="button"
            className={styles.help}
            aria-label={t.whatIsAdjusted}
            aria-controls={HOW_ID}
            onClick={() => {
              onHow();
              if (typeof document !== "undefined") document.getElementById(HOW_ID)?.scrollIntoView({ block: "nearest" });
            }}
          >
            ?
          </button>
        </span>
      </th>
      <th scope="col" className="num">
        {t.diff}
      </th>
      <th scope="col">{t.verdict}</th>
    </tr>
  );
}

/* ------------------------------------------------------------------ stats - */

function StatsSection({ stats, filters, onHow }: { stats: StatReport[]; filters: AnalysisFilters; onHow: () => void }) {
  const t = useDict().analysis.reports;
  return (
    <section className="card stats-group" aria-labelledby="reports-stats">
      <h3 id="reports-stats" className={styles.cardTitle}>
        {t.stats.heading}
      </h3>
      <p className={styles.muted}>{t.stats.note}</p>
      <div className="stats-table-wrap">
        <table className={`stats-table ${styles.table}`}>
          <thead>
            <ComparisonHead first={t.columns.stat} onHow={onHow} />
          </thead>
          {stats.map((stat) => (
            <StatRow key={stat.id} stat={stat} filters={filters} />
          ))}
        </table>
      </div>
    </section>
  );
}

function StatRow({ stat, filters }: { stat: StatReport; filters: AnalysisFilters }) {
  const t = useDict().analysis.reports;
  const count = countIn(useIntlLocale());
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const name = t.stats.names[stat.id] ?? stat.id;
  return (
    <tbody className={styles.group}>
      <tr>
        <th scope="row">
          <button
            type="button"
            className={styles.expand}
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((value) => !value)}
          >
            <span aria-hidden="true" className={styles.chevron}>
              {open ? "▾" : "▸"}
            </span>
            <span>{name}</span>
          </button>
        </th>
        <td className="num">{count(stat.total.decisions)}</td>
        <ComparisonCells c={stat.total} />
      </tr>
      <tr id={detailId} hidden={!open} className={styles.detailRow}>
        <td colSpan={7}>
          {open ? (
            <div className={styles.detail}>
              <p>{t.stats.definitions[stat.id]}</p>
              <p className={styles.muted}>{t.stats.tips[stat.id]}</p>
              {STAT_CONCEPTS[stat.id] ? <LearnLink concept={STAT_CONCEPTS[stat.id]} /> : null}
              <SplitTable stat={stat} />
              {stat.nodes.length > 0 ? <NodeHands nodes={stat.nodes} filters={filters} /> : null}
            </div>
          ) : null}
        </td>
      </tr>
    </tbody>
  );
}

function SplitTable({ stat }: { stat: StatReport }) {
  const t = useDict().analysis.reports;
  const count = countIn(useIntlLocale());
  return (
    <div className="stats-table-wrap">
      <table className={`stats-table ${styles.table} ${styles.inner}`}>
        <caption className={styles.caption}>{t.stats.bySplit}</caption>
        <thead>
          <tr>
            <th scope="col">{t.columns.split}</th>
            <th scope="col" className="num">
              {t.columns.decisions}
            </th>
            <th scope="col" className="num">
              {t.columns.yours}
            </th>
            <th scope="col" className="num">
              {t.columns.reference}
            </th>
            <th scope="col" className="num">
              {t.columns.adjusted}
            </th>
            <th scope="col" className="num">
              {t.columns.diff}
            </th>
            <th scope="col">{t.columns.verdict}</th>
          </tr>
        </thead>
        <tbody>
          {stat.splits.map((split) => (
            <tr key={`${split.key.position}|${split.key.versus ?? ""}`}>
              <th scope="row">{t.splitLabel(split.key.position, split.key.versus)}</th>
              <td className="num">{count(split.comparison.decisions)}</td>
              <ComparisonCells c={split.comparison} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- defence - */

function DefenceSection({ rows }: { rows: DefenceRow[] }) {
  const t = useDict().analysis.reports;
  const count = countIn(useIntlLocale());
  const cell = (label: string, c: Comparison) => {
    const yours = c.yours === null ? "—" : t.pct(c.yours);
    const reference = c.reference === null ? "—" : t.pct(c.reference);
    return (
      <td className="num" aria-label={t.defence.cellLabel(label, yours, reference, t.verdicts[c.verdict])}>
        <span className={c.decisions > 0 ? VERDICT_CLASS[c.verdict] : undefined}>
          {c.decisions > 0 && c.verdict === "deviates" ? (
            <span aria-hidden="true" className={styles.glyph}>
              {VERDICT_GLYPH.deviates}
            </span>
          ) : null}
          {yours}
        </span>
        <span className={styles.refInline}>{reference}</span>
      </td>
    );
  };
  return (
    <section className="card stats-group" aria-labelledby="reports-defence">
      <h3 id="reports-defence" className={styles.cardTitle}>
        {t.defence.heading}
      </h3>
      <p className={styles.muted}>{t.defence.note}</p>
      <div className="stats-table-wrap">
        <table className={`stats-table ${styles.table}`}>
          <thead>
            <tr>
              <th scope="col">{t.columns.spot}</th>
              <th scope="col" className="num">
                {t.columns.decisions}
              </th>
              <th scope="col" className="num">
                {t.defence.fold}
              </th>
              <th scope="col" className="num">
                {t.defence.call}
              </th>
              <th scope="col" className="num">
                {t.defence.threeBet}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.key.position}|${row.key.versus ?? ""}`}>
                <th scope="row">{t.splitLabel(row.key.position, row.key.versus)}</th>
                <td className="num">{count(row.fold.decisions)}</td>
                {cell(t.defence.fold, row.fold)}
                {cell(t.defence.call, row.call)}
                {cell(t.defence.threeBet, row.threeBet)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ nodes - */

function useSpotLabel() {
  const t = useDict().analysis.charts;
  return useCallback(
    (node: ChartNode) =>
      t.spotLabel(
        node.actor,
        lineSteps(node.line).map((step) => ({ position: step.position, verb: t.verbs[step.verb] ?? step.verb })),
      ),
    [t],
  );
}

function NodesSection({ nodes, filters, onHow }: { nodes: NodeReport[]; filters: AnalysisFilters; onHow: () => void }) {
  const en = useDict().analysis;
  const t = en.reports;
  const [category, setCategory] = useState<SpotCategory | "">("");
  const [all, setAll] = useState(false);
  const shown = category ? nodes.filter((report) => categoriesOf(report.node).includes(category)) : nodes;
  const visible = all ? shown : shown.slice(0, NODE_PREVIEW);
  return (
    <section className="card stats-group" aria-labelledby="reports-nodes">
      <div className={styles.sectionHead}>
        <h3 id="reports-nodes" className={styles.cardTitle}>
          {t.nodes.heading}
        </h3>
        <label className="field">
          <span className="field__label">{t.nodes.category}</span>
          <select value={category} onChange={(event) => setCategory(event.target.value as SpotCategory | "")}>
            <option value="">{t.nodes.allCategories}</option>
            {SPOT_CATEGORIES.map((id) => (
              <option key={id} value={id}>
                {en.charts.categories[id]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={styles.muted}>{t.nodes.note}</p>
      {visible.length === 0 ? <p className="muted">{t.nodes.noneInCategory}</p> : null}
      <ul className={styles.nodes}>
        {visible.map((report) => (
          <li key={report.sample.key}>
            <NodeItem report={report} filters={filters} onHow={onHow} />
          </li>
        ))}
      </ul>
      {shown.length > NODE_PREVIEW ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAll((value) => !value)}>
          {all ? t.nodes.showFewer : t.nodes.showAll(shown.length)}
        </button>
      ) : null}
    </section>
  );
}

function NodeItem({ report, filters, onHow }: { report: NodeReport; filters: AnalysisFilters; onHow: () => void }) {
  const t = useDict().analysis.reports;
  const label = useSpotLabel()(report.node);
  const [open, setOpen] = useState(false);
  // The line the summary quotes: the widest gap among the actions that
  // deviate, so "Deviates" never sits next to a gap that does not.
  const deviating = report.rows.filter((row) => row.comparison.verdict === "deviates");
  const widest =
    deviating.length > 0
      ? deviating.reduce((a, b) => (Math.abs(b.comparison.diff ?? 0) > Math.abs(a.comparison.diff ?? 0) ? b : a))
      : report.widest
        ? (report.rows.find((row) => row.action === report.widest?.action) ?? null)
        : null;
  const verdict: Verdict =
    deviating.length > 0 ? "deviates" : report.rows.some((row) => row.comparison.verdict === "in-line") ? "in-line" : "too-few";
  return (
    <details className={styles.node} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary className={styles.nodeSummary}>
        <span className={styles.nodeLabel}>{label}</span>
        <span className={styles.muted}>{t.nodes.decisions(report.sample.decisions)}</span>
        {widest && widest.comparison.yours !== null && widest.comparison.reference !== null ? (
          <span className={styles.nodeGap}>
            {t.nodes.widest(t.actions[widest.action], t.pct(widest.comparison.yours), t.pct(widest.comparison.reference))}
          </span>
        ) : null}
        <VerdictTag verdict={verdict} />
      </summary>
      {open ? (
        <div className={styles.detail}>
          <div className="stats-table-wrap">
            <table className={`stats-table ${styles.table} ${styles.inner}`}>
              <thead>
                <ComparisonHead first={t.columns.action} onHow={onHow} />
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.action}>
                    <th scope="row">{t.actions[row.action]}</th>
                    <td className="num">{row.comparison.made}</td>
                    <ComparisonCells c={row.comparison} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Link href={paths.analysisCharts(report.node.line)} className={analysisStyles.learnInline}>
            {t.nodes.study}
          </Link>
          <NodeHands nodes={[report.sample.key]} filters={filters} single />
        </div>
      ) : null}
    </details>
  );
}

/* ------------------------------------------------------------------ hands - */

/** The chart's most frequent option, as a chart action name. */
function bestOf(row: NodeHandRow): { action: string; freq: number } | null {
  let best: { action: string; freq: number } | null = null;
  for (const option of row.options) {
    const action = option.allIn ? "allin" : option.action;
    if (!best || option.freq > best.freq) best = { action, freq: option.freq };
  }
  return best;
}

function NodeHands({ nodes, filters, single = false }: { nodes: string[]; filters: AnalysisFilters; single?: boolean }) {
  const en = useDict().analysis;
  const t = en.reports;
  const locale = useIntlLocale();
  const nodeKey = nodes.join(",");
  const filterKey = JSON.stringify(filters);
  const [pages, setPages] = useState(1);
  const [data, setData] = useState<{ key: string; total: number; rows: NodeHandRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestKey = `${nodeKey}|${filterKey}|${pages}`;
  const loading = data?.key !== requestKey && !error;

  useEffect(() => {
    let live = true;
    fetchNodeHands(JSON.parse(filterKey) as AnalysisFilters, {
      nodes: nodeKey.split(","),
      limit: HANDS_PAGE * pages,
      offset: 0,
    })
      .then((page) => {
        if (live) setData({ key: requestKey, total: page.total, rows: page.rows });
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
    };
  }, [nodeKey, filterKey, pages, requestKey]);

  const when = (iso: string | null) =>
    iso ? dateFormat(locale, { day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(iso)) : "";
  const spotLabel = (row: NodeHandRow) =>
    en.charts.spotLabel(
      walkLine(row.line).next ?? "",
      lineSteps(row.line).map((step) => ({ position: step.position, verb: en.charts.verbs[step.verb] ?? step.verb })),
    );

  return (
    <div className={styles.hands}>
      <h4 className={styles.subhead}>{t.hands.heading}</h4>
      <p className={styles.muted}>{t.hands.note}</p>
      {error ? <p className="notice notice--error">{t.hands.failed(error)}</p> : null}
      {loading && !data ? <p className={styles.muted}>{t.hands.loading}</p> : null}
      {data && data.rows.length === 0 ? <p className={styles.muted}>{t.hands.empty}</p> : null}
      {data && data.rows.length > 0 ? (
        <ul className={styles.handList} aria-busy={loading}>
          {data.rows.map((row) => {
            const best = bestOf(row);
            const cards = row.heroCards.join(" ");
            return (
              <li key={`${row.handId}-${row.ord}`} className={styles.handRow}>
                <Link
                  href={paths.analysisHand(row.handId)}
                  className={styles.handLink}
                  aria-label={t.hands.open(cards || row.handClass || row.handId)}
                >
                  {row.heroCards.length ? <CardRow cards={row.heroCards} size="xs" /> : null}
                  <span className={styles.handClass}>{row.handClass ?? ""}</span>
                  <span className={styles.muted}>{row.position ?? ""}</span>
                </Link>
                <span className={styles.handWhat}>
                  {single ? null : <span className={styles.handSpot}>{spotLabel(row)}</span>}
                  <span>{t.hands.took(t.actions[row.action] ?? row.action)}</span>
                  {best ? <span className={styles.muted}>{t.hands.better(t.actions[best.action] ?? best.action, t.pct(best.freq))}</span> : null}
                </span>
                <span className={styles.handGrade}>
                  {row.grade ? (
                    <span className={`${analysisStyles.gradeTag} ${analysisStyles[row.grade] ?? ""}`}>
                      <GradeIcon grade={row.grade} />
                      {en.grades[row.grade] ?? row.grade}
                    </span>
                  ) : null}
                  {row.evLossBb !== null && row.evLossBb > 0 ? <span className="num">{t.hands.evLoss(row.evLossBb)}</span> : null}
                  <span className={styles.muted}>{when(row.playedAt)}</span>
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
      {data && data.total > 0 ? <p className={styles.muted}>{t.hands.total(data.total)}</p> : null}
    </div>
  );
}

/* --------------------------------------------------------------- postflop - */

const STREETS = ["flop", "turn", "river"] as const;

function PostflopSection({ rows }: { rows: PostflopCount[] }) {
  const t = useDict().analysis.reports.postflop;
  const r = useDict().analysis.reports;
  const [street, setStreet] = useState<(typeof STREETS)[number]>("flop");
  const roles = postflopRoles(rows, street);
  const any = roles.some((role) => role.first.decisions + role.vsBet.decisions > 0);
  const share = (made: number, of: number) =>
    of > 0 ? (
      <>
        {r.pct(made / of)}
        <span className={styles.interval}>{t.of(of)}</span>
      </>
    ) : (
      "—"
    );
  const hint = (role: string) =>
    role === "pfr-ip" || role === "pfr-oop" ? t.betFirstHint.pfr : role === "caller-ip" ? t.betFirstHint.callerIp : t.betFirstHint.callerOop;
  const concept = (role: string): ConceptId => (role === "caller-oop" ? "donk-bet" : "continuation-bet");
  return (
    <section className="card stats-group" aria-labelledby="reports-postflop">
      <div className={styles.sectionHead}>
        <h3 id="reports-postflop" className={styles.cardTitle}>
          {t.heading}
        </h3>
        <div className="stats-scope__formats" role="group" aria-label={t.streetLabel}>
          {STREETS.map((id) => (
            <button
              key={id}
              type="button"
              className={`btn btn--sm${street === id ? " btn--primary" : ""}`}
              aria-pressed={street === id}
              onClick={() => setStreet(id)}
            >
              {t.streets[id]}
            </button>
          ))}
        </div>
      </div>
      <p className={styles.muted}>{t.note}</p>
      <p className={`notice notice--info ${styles.placeholder}`}>{t.placeholder}</p>
      {any ? (
        <div className="stats-table-wrap">
          <table className={`stats-table ${styles.table}`}>
            <thead>
              <tr>
                <th scope="col">{t.role}</th>
                <th scope="col" className="num">
                  {t.betFirst}
                </th>
                <th scope="col" className="num">
                  {t.foldVsBet}
                </th>
                <th scope="col" className="num">
                  {t.callVsBet}
                </th>
                <th scope="col" className="num">
                  {t.raiseVsBet}
                </th>
              </tr>
            </thead>
            <tbody>
              {POSTFLOP_ROLES.map((id) => {
                const role = roles.find((entry) => entry.role === id);
                if (!role) return null;
                return (
                  <tr key={id}>
                    <th scope="row">
                      {t.roles[id]}
                      <span className={styles.interval}>{hint(id)}</span>
                      <LearnLink concept={concept(id)} />
                    </th>
                    <td className="num">{share(role.first.bet, role.first.decisions)}</td>
                    <td className="num">{share(role.vsBet.fold, role.vsBet.decisions)}</td>
                    <td className="num">{share(role.vsBet.call, role.vsBet.decisions)}</td>
                    <td className="num">{share(role.vsBet.raise, role.vsBet.decisions)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">{t.empty}</p>
      )}
    </section>
  );
}
