/**
 * The statistics screen (`/stats`).
 *
 * Since R4.5c the report itself is the shared Reports screen
 * (`@rail/ui/reports/ReportsScreen`, the desktop app's since R2.7b) over the
 * web's report summaries (`lib/db/reportSource.ts`): the filter chips, the
 * summary, the win-rate graph (with its all-in EV line, in big blinds or
 * money), every statistic by group and the breakdowns - by position, stake,
 * table size, room and game, and by pot type, stack depth, starting hand
 * (the 13 x 13 grid), players dealt in and street. Around it, this page's
 * own: the four ways of having nothing to show, the coverage line and its
 * rebuild, live arrivals, and its panels over the same filter - the HUD
 * tiles under the summary, the sessions and the opponents after the
 * breakdowns.
 *
 * Four ways of having nothing to show, and one rule running through all of
 * them: **say which nothing it is.** A blank screen is the same pixels
 * whether the user is signed out, has no hands, has a database without the
 * statistics migrations on it, or hit a real error — and those need four
 * different actions from the reader. PostgREST answers `PGRST202` for a
 * function missing from its schema cache; `isMissingSchemaError` is that
 * check, a code rather than a string match.
 *
 * Live arrival (Rail R1.10): hands synced by the desktop app while the screen
 * is open re-read the numbers in place, and the ones without statistics get
 * them derived (`/api/stats/rebuild`) without a click. One catch-up at a
 * time: batches that land during one fold into a single next round.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FilterState } from "@rail/ui/hands/filter";
import type { HandFilter } from "@rail/ui/hands/model";
import { ReportsScreen, type Tab } from "@rail/ui/reports/ReportsScreen";
import type { Report } from "@rail/ui/reports/model";
import {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  fetchStatsCoverage,
  isDatabaseConfigured,
  isMissingSchemaError,
  rebuildStats,
  type RebuildProgress,
  type StatsCoverage,
} from "../../lib/db";
import { reportTotals, WEB_DEFINITIONS, webReportSource } from "../../lib/db/reportSource";
import { useAuth } from "../../lib/auth";
import { useDict } from "../../lib/i18n/client";
import type { ArrivalBatch } from "../../lib/live/arrivals";
import { HudGrid } from "./HudGrid";
import { OpponentsPanel } from "./OpponentsPanel";
import { opponentsScope } from "./opponentsScope";
import { SessionsPanel } from "./SessionsPanel";
import { StatsNav } from "./StatsNav";
import "../../styles/stats.css";

interface StatsTabProps {
  /** Bumped by the shell after an upload lands, so the numbers follow it. */
  refreshToken?: number;
  /** The latest live batch from the shell (`AppFrame`, R1.10); null until one arrives. */
  arrival?: ArrivalBatch | null;
}

type Status = "ready" | "not-installed" | "error";

/** Identifiers in the "not set up" notice: names, not prose, so not translated. */
const STATS_TABLE = "hand_stats";
const STATS_MIGRATION = "supabase/migrations/20261005090000_hand_stats.sql";


export function StatsTab({ refreshToken = 0, arrival = null }: StatsTabProps) {
  const dict = useDict();
  const t = dict.stats;
  const en = t.tab;
  const auth = useAuth();
  const [status, setStatus] = useState<Status>("ready");
  const [message, setMessage] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<StatsCoverage | null>(null);
  const [rebuild, setRebuild] = useState<RebuildState>({ status: "idle" });
  /** One automatic rebuild per visit; after that it is the button's job. */
  const autoRebuilt = useRef(false);
  /** Bumped when the numbers change under the screen (a rebuild, an arrival, an upload): it reads again. */
  const [generation, setGeneration] = useState(0);
  const [chosen, setChosen] = useState<FilterState | null>(null);
  const [tab, setTab] = useState<Tab>("position");

  const base = useMemo(() => webReportSource(dict.converter.library.standardFormat), [dict]);
  // A database without the summaries' readers (PGRST202) says "not set up", not a stack trace.
  const source = useMemo(
    () => ({
      ...base,
      report: (filter: HandFilter, points: number) =>
        base.report(filter, points).catch((error: unknown) => {
          if (isMissingSchemaError(error)) setStatus("not-installed");
          throw error;
        }),
    }),
    [base],
  );

  /** The coverage line: how much of the library the numbers are about. */
  const load = useCallback(async (): Promise<StatsCoverage | null> => {
    try {
      const next = await fetchStatsCoverage();
      setCoverage(next);
      return next;
    } catch (error) {
      if (isMissingSchemaError(error)) {
        setStatus("not-installed");
      } else {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : String(error));
      }
      return null;
    }
  }, []);

  const runRebuild = useCallback(async () => {
    setRebuild({
      status: "running",
      progress: { processed: 0, inserted: 0, failed: 0, pruned: 0 },
    });
    try {
      const progress = await rebuildStats((next) => setRebuild({ status: "running", progress: next }));
      setRebuild({ status: "done", progress });
      await load();
      setGeneration((value) => value + 1);
    } catch (error) {
      setRebuild({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [load]);

  // A library with hands the numbers do not cover yet — uploaded before
  // statistics existed, or left behind by a version bump — catches up on its
  // own the first time this screen sees it. It is idempotent and runs next to
  // the database, so there is nothing to ask permission for.
  useEffect(() => {
    if (!isDatabaseConfigured || !auth.isSignedIn) {
      return;
    }
    setGeneration((value) => value + 1);
    void load().then((loaded) => {
      if (loaded && loaded.missing + loaded.stale + loaded.evMissing > 0 && !autoRebuilt.current) {
        autoRebuilt.current = true;
        void runRebuild();
      }
    });
  }, [auth.isSignedIn, load, refreshToken, runRebuild]);

  // Live batches. A batch that lands while a catch-up runs only marks that
  // another round is needed, so a backfill streaming in costs one re-read
  // (and one rebuild, when hands lack statistics) per round, never per batch.
  const catchingUp = useRef(false);
  const catchUpAgain = useRef(false);
  const catchUp = useCallback(async () => {
    if (catchingUp.current) {
      catchUpAgain.current = true;
      return;
    }
    catchingUp.current = true;
    try {
      do {
        catchUpAgain.current = false;
        const loaded = await load();
        if (loaded && loaded.missing + loaded.stale + loaded.evMissing > 0) {
          await runRebuild();
        } else {
          setGeneration((value) => value + 1);
        }
      } while (catchUpAgain.current);
    } finally {
      catchingUp.current = false;
    }
  }, [load, runRebuild]);

  const handledArrival = useRef(0);
  useEffect(() => {
    if (!arrival || arrival.seq === handledArrival.current) {
      return;
    }
    handledArrival.current = arrival.seq;
    if (isDatabaseConfigured && auth.isSignedIn) {
      void catchUp();
    }
  }, [arrival, auth.isSignedIn, catchUp]);

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
          <h3>{en.signInHeading}</h3>
          <p className="muted">{en.signInBody}</p>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
            {en.signIn}
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
          <h3>{en.notInstalledHeading}</h3>
          <p className="muted">
            {en.notInstalledBody.beforeTable}
            <code>{STATS_TABLE}</code>
            {en.notInstalledBody.beforeFile}
            <code>{STATS_MIGRATION}</code>
            {en.notInstalledBody.afterFile}
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setStatus("ready");
              void load();
            }}
          >
            {t.common.tryAgain}
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
        <button
          type="button"
          className="btn"
          onClick={() => {
            setStatus("ready");
            void load();
          }}
        >
          {t.common.tryAgain}
        </button>
      </div>
    );
  }

  return (
    <div className="stats">
      <StatsNav current="reports" />
      <ReportsScreen
        key={auth.user?.id ?? ""}
        source={source}
        definitions={WEB_DEFINITIONS}
        chosen={chosen}
        onChoose={setChosen}
        tab={tab}
        onTab={setTab}
        title={en.heading}
        titleTag="h2"
        notice={<CoverageBar coverage={coverage} rebuild={rebuild} onRebuild={() => void runRebuild()} />}
        emptyText={rebuild.status === "running" ? en.loading : `${en.emptyHeading}. ${en.emptyBody}`}
        reloadToken={generation}
        renderState={(kind, text) => (
          <div
            className={kind === "error" ? "notice notice--error" : "card stats-empty"}
            role={kind === "error" ? "alert" : "status"}
          >
            {kind === "error" ? text : <p className="muted">{text}</p>}
          </div>
        )}
        afterSummary={(report) => <Tiles report={report} />}
        footer={(query) => {
          const opponents = opponentsScope(query);
          return (
            <>
              <SessionsPanel filter={query} refreshToken={generation} />
              <OpponentsPanel filters={opponents.filters} partial={opponents.partial} refreshToken={generation} />
            </>
          );
        }}
      />
    </div>
  );
}

/** The HUD tiles (the web's own panel) over the report's sums. */
function Tiles({ report }: { report: Report }) {
  const totals = reportTotals(report);
  if (!totals) return null;
  return (
    <HudGrid
      counters={totals.counters}
      money={report.units.mixedKind ? null : totals.money}
      moneyHands={totals.moneyHands}
      currency={report.units.mixedCurrency || report.units.mixedKind ? null : report.units.currency}
      currencyMinorUnits={report.units.mixedCurrency || report.units.mixedKind ? null : report.units.minorUnits}
      mixedCurrency={report.units.mixedCurrency}
      mixedUnitKind={report.units.mixedKind}
    />
  );
}

function Header() {
  const en = useDict().stats.tab;
  return (
    <header className="stats__head">
      <h2>{en.heading}</h2>
    </header>
  );
}

type RebuildState =
  | { status: "idle" }
  | { status: "running"; progress: RebuildProgress }
  | { status: "done"; progress: RebuildProgress }
  | { status: "error"; message: string };

/**
 * The line that says how much of the library the numbers cover.
 *
 * Silent when there is nothing to say — every hand covered, nothing running,
 * nothing failed — because a permanent "100% of your hands" badge is noise.
 */
function CoverageBar({
  coverage,
  rebuild,
  onRebuild,
}: {
  coverage: StatsCoverage | null;
  rebuild: RebuildState;
  onRebuild: () => void;
}) {
  const t = useDict().stats;
  const en = t.coverage;
  if (rebuild.status === "running") {
    const target = coverage ? coverage.missing + coverage.stale + coverage.evMissing : 0;
    const done = rebuild.progress.processed;
    return (
      <p className="notice notice--info stats-coverage" role="status" aria-live="polite">
        {en.running(target > 0 ? Math.min(done, target) : done, target)}
      </p>
    );
  }
  if (rebuild.status === "error") {
    return (
      <p className="notice notice--error stats-coverage">
        {en.failedRebuild(rebuild.message)}{" "}
        <button type="button" className="btn btn--sm" onClick={onRebuild}>
          {t.common.tryAgain}
        </button>
      </p>
    );
  }
  if (!coverage) {
    return null;
  }
  const behind = coverage.missing + coverage.stale;
  const failed = rebuild.status === "done" ? rebuild.progress.failed : 0;
  if (behind === 0 && failed === 0) {
    return null;
  }
  return (
    <p className="notice notice--warn stats-coverage">
      {behind > 0 ? en.behind(behind, coverage.hands) : null}
      {failed > 0 ? ` ${en.unreadable(failed)}` : null}{" "}
      {behind > 0 ? (
        <button type="button" className="btn btn--sm" onClick={onRebuild}>
          {en.rebuild}
        </button>
      ) : null}
    </p>
  );
}

