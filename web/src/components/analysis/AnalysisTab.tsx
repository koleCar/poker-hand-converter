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

import { KindSwitch } from "@rail/ui/hands/KindSwitch";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  fetchAnalysisCoverage,
  fetchAnalysisOverview,
  isDatabaseConfigured,
  isMissingSchemaError,
  runAnalysis,
  type AnalysisCoverage,
  type AnalysisOverview,
  type AnalysisProgress,
} from "../../lib/db";
import { ANALYSIS_VERSION } from "../../lib/analysis/types";
import { useAuth } from "../../lib/auth";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { AnalysisNav } from "./AnalysisNav";
import { useAnalysisKind } from "./analysisKind";
import { POSITION_VALUES, POT_VALUES, listQuery, parseListState, scopeFilters, type AnalysisListState } from "./listState";
import { EvHeatmap, HandsList, OverviewHead, TopLeaksMini, TrainMini } from "./overview/OverviewParts";
import styles from "./ui/an.module.css";

/** The migration the tab needs, named in the not-installed notice. An identifier, not prose. */
const ANALYSIS_MIGRATION = "supabase/migrations/20261228090000_analysis.sql";
/** At most this many new hands are analysed without asking. */
const AUTO_RUN_LIMIT = 300;
/**
 * "Start with your most recent hands" (A5a): offered when more than the
 * smallest of these are behind, each choice smaller than what is behind.
 */
const RECENT_CHOICES = [200, 500, 1000] as const;

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
  const dict = useDict();
  const t = dict.analysis;
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
  // Cash and tournament hands are never combined (`analysisKind.ts`): the
  // address's kind, else the visit's, else the one with more analysed hands.
  const kinds = useAnalysisKind(state.kind, isDatabaseConfigured && auth.isSignedIn, refreshToken);
  const kindReady = kinds.kind !== null;
  const shownState = useMemo(() => ({ ...state, kind: kinds.kind }), [state, kinds.kind]);

  const scope = useMemo(() => scopeFilters(shownState), [shownState]);
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
      const nextOverview = await fetchAnalysisOverview(JSON.parse(scopeKey) as typeof scope);
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
    async (behind: number, recent?: number) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const target = recent !== undefined ? Math.min(recent, behind) : behind;
      setRun({ status: "running", progress: { processed: 0, saved: 0, failed: 0, pruned: 0 }, target });
      try {
        const progress = await runAnalysis(
          (next) => setRun({ status: "running", progress: next, target }),
          controller.signal,
          { target, recent },
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
    if (!isDatabaseConfigured || !auth.isSignedIn || !kindReady) {
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
  }, [auth.isSignedIn, kindReady, load, refreshToken, startRun]);

  if (!isDatabaseConfigured) {
    return (
      <div className={styles.page}>
        <AnalysisNav current="overview" />
        <p className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</p>
      </div>
    );
  }

  if (!auth.isSignedIn) {
    return (
      <div className={styles.page}>
        <AnalysisNav current="overview" />
        <div className={`${styles.card} ${styles.center}`}>
          <strong>{t.tab.signInHeading}</strong>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
            {t.tab.signIn}
          </button>
        </div>
      </div>
    );
  }

  if (status === "not-installed") {
    return (
      <div className={styles.page}>
        <AnalysisNav current="overview" />
        <div className={`${styles.card} ${styles.center}`}>
          <strong>{t.tab.notInstalledHeading}</strong>
          <p className={styles.muted}>
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
      <div className={styles.page}>
        <AnalysisNav current="overview" />
        <p className="notice notice--error">{message}</p>
        <button type="button" className="btn" onClick={() => void load()}>
          {t.tab.tryAgain}
        </button>
      </div>
    );
  }

  if (status === "idle" || (status === "loading" && !coverage) || !coverage) {
    return (
      <div className={styles.page}>
        <AnalysisNav current="overview" />
        <RailLoader label={t.tab.loading} showLabel centered />
      </div>
    );
  }

  const runStatus = (
    <RunStatus
      coverage={coverage}
      run={run}
      onRun={(target, recent) => void startRun(target, recent)}
      onStop={() => abort.current?.abort()}
    />
  );

  if (coverage.hands === 0) {
    return (
      <div className={styles.page}>
        <AnalysisNav current="overview" />
        <div className={`${styles.card} ${styles.center}`}>
          <strong>{t.tab.noHandsHeading}</strong>
          <Link href={paths.convert()} className="btn btn--primary">
            {t.ui.empty.upload}
          </Link>
        </div>
      </div>
    );
  }

  if (coverage.atVersion === 0 && run.status !== "done") {
    return (
      <div className={styles.page}>
        <AnalysisNav current="overview" />
        <div className={`${styles.card} ${styles.center}`}>
          {/* A version bump is not "nothing analysed": say what changed. */}
          <strong>{coverage.stale > 0 ? t.tab.updatedHeading : t.tab.emptyHeading}</strong>
          {runStatus}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <AnalysisNav current="overview">
        <KindSwitch kind={kinds.kind} counts={kinds.counts} onChange={(kind) => updateState({ kind, page: 0 })} />
        <label className={styles.dd}>
          {t.ui.scope.position}
          <select value={state.position ?? ""} onChange={(event) => updateState({ position: event.target.value || null, page: 0 })}>
            <option value="">{t.ui.scope.any}</option>
            {POSITION_VALUES.map((position) => (
              <option key={position} value={position}>
                {position}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.dd}>
          {t.ui.scope.pot}
          <select value={state.potType ?? ""} onChange={(event) => updateState({ potType: event.target.value || null, page: 0 })}>
            <option value="">{t.ui.scope.any}</option>
            {POT_VALUES.map((pot) => (
              <option key={pot} value={pot}>
                {dict.stats.breakdown.potTypes[pot] ?? pot}
              </option>
            ))}
          </select>
        </label>
        {runStatus}
      </AnalysisNav>

      {overview ? (
        <OverviewHead overview={overview} grade={state.grade} onGrade={(grade) => updateState({ grade, page: 0 })} />
      ) : null}

      <div className={styles.mainSide}>
        <div className={styles.main}>
          <EvHeatmap
            kind={kinds.kind}
            generation={generation}
            position={state.position}
            potType={state.potType}
            street={state.street}
            onPick={updateState}
          />
        </div>
        <div className={styles.side}>
          <TopLeaksMini scopeKey={scopeKey} generation={generation} />
          <TrainMini kind={kinds.kind} generation={generation} />
        </div>
      </div>

      <HandsList state={shownState} onChange={updateState} generation={generation} flags={overview?.flags ?? []} />
    </div>
  );
}

/* ------------------------------------------------------------------ run - */

/**
 * The analysis run as one compact status on the tab row: what is behind and
 * the button, the progress while it runs, a failure as a short line.
 */
function RunStatus({
  coverage,
  run,
  onRun,
  onStop,
}: {
  coverage: AnalysisCoverage;
  run: RunState;
  onRun: (target: number, recent?: number) => void;
  onStop: () => void;
}) {
  const t = useDict().analysis;
  const ui = t.ui.run;
  const behind = coverage.missing + coverage.stale;
  const choices = RECENT_CHOICES.filter((count) => count < behind);
  // "" is the whole library; a number, the most recent that many hands.
  const [scope, setScope] = useState<string>("");
  const recent = scope === "" ? undefined : Number(scope);

  if (run.status === "running") {
    const eta = run.progress.etaSeconds;
    return (
      <span className={styles.status} role="status" aria-live="polite">
        <span className={styles.spinner} aria-hidden="true" />
        {ui.running(run.progress.processed, run.target)}
        {eta !== null && eta !== undefined ? ` ${t.run.eta(eta)}` : ""}
        <button type="button" className="btn btn--ghost btn--sm" onClick={onStop}>
          {ui.stop}
        </button>
      </span>
    );
  }
  if (run.status === "error") {
    return (
      <span className={`${styles.status} ${styles.neg}`} role="alert" title={run.message}>
        {ui.failed}
        {behind > 0 ? (
          <button type="button" className="btn btn--sm" onClick={() => onRun(behind, recent)}>
            {ui.analyse}
          </button>
        ) : null}
      </span>
    );
  }
  if (behind === 0) return null;
  return (
    <span className={styles.status} title={coverage.stale > 0 ? t.run.versionChanged(coverage.stale, ANALYSIS_VERSION) : undefined}>
      {coverage.stale > 0 ? ui.stale(coverage.stale) : ui.behind(coverage.missing)}
      {choices.length > 0 ? (
        <label className={styles.dd}>
          <select aria-label={t.run.scopeLabel} value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="">{ui.all}</option>
            {choices.map((count) => (
              <option key={count} value={String(count)}>
                {ui.recent(count)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button type="button" className="btn btn--primary btn--sm" onClick={() => onRun(behind, recent)}>
        {coverage.stale > 0 ? ui.update : ui.analyse}
      </button>
    </span>
  );
}
