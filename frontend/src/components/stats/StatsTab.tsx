/**
 * The statistics screen.
 *
 * Two RPCs, four ways of having nothing to show, and one rule running through
 * all of them: **say which nothing it is.** A blank HUD is the same pixels
 * whether the user is signed out, has no hands, has a database without the
 * statistics migration on it, or hit a real error — and those need four
 * different actions from the reader. A page that renders identically for all
 * four is a page that turns a two-second fix into a support thread.
 *
 * The one worth naming is the schema case. `hand_stats` arrives in its own
 * migration, so there is a real window in which a deployed client is talking to
 * a database that does not have it. PostgREST answers `PGRST202` for a function
 * missing from its schema cache; `isMissingSchemaError` is that check, and it is
 * a code rather than a string match so the first PostgREST rewording does not
 * turn a clear explanation back into a stack trace.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  fetchStatsCoverage,
  fetchStatsGraph,
  fetchStatsSummary,
  isDatabaseConfigured,
  isMissingSchemaError,
  rebuildStats,
  type RebuildProgress,
  type StakeVolume,
  type StatsCoverage,
  type StatsFilters,
  type StatsGraph,
  type StatsSummary,
} from "../../lib/db";
import { useAuth } from "../../lib/auth";
import { BreakdownPanel } from "./BreakdownPanel";
import { HandMatrix } from "./HandMatrix";
import { HudGrid } from "./HudGrid";
import { OpponentsPanel } from "./OpponentsPanel";
import { stakeLabel } from "./format";
import { WinrateGraph } from "./WinrateGraph";
import "../../styles/stats.css";

interface StatsTabProps {
  /** Bumped by the shell after an upload lands, so the numbers follow it. */
  refreshToken?: number;
}

type Status = "idle" | "loading" | "ready" | "not-installed" | "error";

/**
 * Resolution of the graph. Sixty is chosen against the narrow case rather than
 * the wide one: on a 390px phone the plot is ~310px across, so sixty buckets is
 * about five pixels a point — dense enough to look continuous, sparse enough
 * that the hover target is still hittable with a thumb.
 */
const GRAPH_BUCKETS = 60;

export function StatsTab({ refreshToken = 0 }: StatsTabProps) {
  const auth = useAuth();
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [graph, setGraph] = useState<StatsGraph | null>(null);
  const [coverage, setCoverage] = useState<StatsCoverage | null>(null);
  const [rebuild, setRebuild] = useState<RebuildState>({ status: "idle" });
  /** One automatic rebuild per visit; after that it is the button's job. */
  const autoRebuilt = useRef(false);
  /** What the reader picked; null until they pick, which means "the default". */
  const chosen = useRef<Scope | null>(null);
  const [scope, setScope] = useState<Scope>(ALL);
  /** Bumped on every successful load, so the panels below reload with the numbers. */
  const [generation, setGeneration] = useState(0);

  const load = useCallback(async (): Promise<StatsCoverage | null> => {
    setStatus("loading");
    setMessage(null);
    try {
      // Coverage first: it is one small grouped count, and it is what decides
      // the default scope. Then the two reports in parallel — they read the
      // same rows under the same filters, and a sequential pair would make the
      // slowest path the sum of two aggregate scans for no reason.
      //
      // Coverage arrived in a later migration than the numbers; a database
      // without it still shows the numbers, just without the badge or filter.
      const nextCoverage = await fetchStatsCoverage().catch(() => null);
      const nextScope = chosen.current ?? defaultScope(nextCoverage?.stakes ?? []);
      const filters = scopeFilters(nextScope, nextCoverage?.stakes ?? []);
      const [nextSummary, nextGraph] = await Promise.all([
        fetchStatsSummary(filters),
        fetchStatsGraph(filters, GRAPH_BUCKETS),
      ]);
      setSummary(nextSummary);
      setGraph(nextGraph);
      setCoverage(nextCoverage);
      setScope(nextScope);
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
  }, []);

  const runRebuild = useCallback(async () => {
    setRebuild({
      status: "running",
      progress: { processed: 0, inserted: 0, failed: 0, pruned: 0 },
    });
    try {
      const progress = await rebuildStats((next) =>
        setRebuild({ status: "running", progress: next }),
      );
      setRebuild({ status: "done", progress });
      await load();
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
    void load().then((loaded) => {
      if (loaded && loaded.missing + loaded.stale + loaded.evMissing > 0 && !autoRebuilt.current) {
        autoRebuilt.current = true;
        void runRebuild();
      }
    });
  }, [auth.isSignedIn, load, refreshToken, runRebuild]);

  const behind = coverage ? coverage.missing + coverage.stale + coverage.evMissing : 0;
  const filters = useMemo(() => scopeFilters(scope, coverage?.stakes ?? []), [scope, coverage]);

  const pickScope = useCallback(
    (next: Scope) => {
      chosen.current = next;
      void load();
    },
    [load],
  );

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
          <h3>Sign in to see your statistics</h3>
          <p className="muted">
            Statistics are derived from the hands in your library, so they need an
            account to belong to. Converting, previewing and downloading never do.
          </p>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
            Sign in
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
          <h3>Statistics are not set up on this database yet</h3>
          <p className="muted">
            Your hands are safe — this screen reads a separate table,{" "}
            <code>hand_stats</code>, which arrives with its own migration. Apply{" "}
            <code>supabase/migrations/20261005090000_hand_stats.sql</code> and reload.
            Nothing else on Rail is affected: uploading, browsing, replaying and sharing
            all work without it.
          </p>
          <button type="button" className="btn" onClick={() => void load()}>
            Try again
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
          Try again
        </button>
      </div>
    );
  }

  if (status === "idle" || status === "loading" || !summary || !graph) {
    return (
      <div className="stats">
        <Header />
        <p className="muted">Reading your hands…</p>
      </div>
    );
  }

  const coverageBar = (
    <CoverageBar coverage={coverage} rebuild={rebuild} onRebuild={() => void runRebuild()} />
  );

  if (summary.hands === 0) {
    if (rebuild.status === "running" || behind > 0) {
      return (
        <div className="stats">
          <Header />
          {coverageBar}
        </div>
      );
    }
    return (
      <div className="stats">
        <Header />
        <div className="card stats-empty">
          <h3>No hands with statistics yet</h3>
          <p className="muted">
            Statistics are derived from the hands in your library, on the server, as they are saved.
            Upload a hand history and this screen fills in.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="stats">
      <Header
        sample={`${summary.hands.toLocaleString("en-GB")} hands · ${summary.statsVersion}`}
      />

      {coverageBar}

      <ScopeBar stakes={coverage?.stakes ?? []} scope={scope} onChange={pickScope} />

      <HudGrid
        counters={summary.counters}
        money={summary.money}
        moneyHands={summary.moneyHands}
        currency={summary.currency}
        currencyMinorUnits={summary.currencyMinorUnits}
        mixedCurrency={summary.mixedCurrency}
        mixedUnitKind={summary.mixedUnitKind}
      />

      <section className="card stats-group">
        <div className="card__head">
          <h3>Win rate</h3>
          <p className="muted">
            Cumulative big blinds, bucketed by hand count rather than by date — a break
            between sessions is not worth any of the x-axis.
          </p>
        </div>
        <WinrateGraph graph={graph} />
      </section>

      <BreakdownPanel filters={filters} stakes={coverage?.stakes ?? []} refreshToken={generation} />

      <HandMatrix filters={filters} refreshToken={generation} />

      <OpponentsPanel filters={filters} refreshToken={generation} />
    </div>
  );
}

function Header({ sample }: { sample?: string }) {
  return (
    <header className="stats__head">
      <h2>Statistics</h2>
      {sample ? <span className="stats__sample">{sample}</span> : null}
    </header>
  );
}

type RebuildState =
  | { status: "idle" }
  | { status: "running"; progress: RebuildProgress }
  | { status: "done"; progress: RebuildProgress }
  | { status: "error"; message: string };

const count = (value: number) => value.toLocaleString("en-GB");

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
  if (rebuild.status === "running") {
    const target = coverage ? coverage.missing + coverage.stale + coverage.evMissing : 0;
    const done = rebuild.progress.processed;
    return (
      <p className="notice notice--info stats-coverage" role="status" aria-live="polite">
        Updating statistics…{" "}
        {target > 0
          ? `${count(Math.min(done, target))} of ${count(target)} hands`
          : `${count(done)} hands`}
      </p>
    );
  }
  if (rebuild.status === "error") {
    return (
      <p className="notice notice--error stats-coverage">
        Statistics could not be brought up to date: {rebuild.message}{" "}
        <button type="button" className="btn btn--sm" onClick={onRebuild}>
          Try again
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
      {behind > 0
        ? `${count(behind)} of ${count(coverage.hands)} hands are not in these numbers yet.`
        : null}
      {failed > 0
        ? ` ${count(failed)} could not be read — that is a converter bug, not your file.`
        : null}{" "}
      {behind > 0 ? (
        <button type="button" className="btn btn--sm" onClick={onRebuild}>
          Rebuild statistics
        </button>
      ) : null}
    </p>
  );
}

/* ----------------------------------------------------------------- scope - */

/**
 * Which slice of the library the screen is about.
 *
 * Only two dimensions, on purpose: format and, for cash, the stake. Those are
 * the two that change what a number *means* — chips are not money, so a cash
 * and tournament sample together has no win rate at all, and a bb/100 across
 * stakes is an average of different games. Every other filter `stats_summary`
 * accepts is a refinement; these two decide whether the headline exists.
 */
interface Scope {
  /** null = every format. */
  gameFormat: string | null;
  /** `stakeKey()` of one cash stake; null = every stake in the format. */
  stake: string | null;
}

const ALL: Scope = { gameFormat: null, stake: null };

function stakeKey(stake: StakeVolume): string {
  return `${stake.currency}:${stake.smallBlind ?? ""}:${stake.bigBlind ?? ""}`;
}

/**
 * The scope a first visit opens on: everything, unless everything mixes
 * formats — then the format with the most hands, so the win rate the reader
 * came for is on screen instead of a note explaining why it is not.
 */
function defaultScope(stakes: StakeVolume[]): Scope {
  const formats = new Set(stakes.map((stake) => stake.gameFormat));
  if (formats.size <= 1) {
    return ALL;
  }
  return { gameFormat: stakes[0].gameFormat, stake: null };
}

function scopeFilters(scope: Scope, stakes: StakeVolume[]): StatsFilters {
  const filters: StatsFilters = {};
  if (scope.gameFormat) {
    filters.gameFormat = scope.gameFormat;
  }
  const stake = scope.stake ? stakes.find((entry) => stakeKey(entry) === scope.stake) : null;
  if (stake) {
    filters.currency = stake.currency;
    if (stake.bigBlind !== null) {
      filters.bigBlind = stake.bigBlind;
    }
  }
  return filters;
}

const FORMAT_LABEL: Record<string, string> = {
  cash: "Cash games",
  tournament: "Tournaments",
  "sit-and-go": "Sit & Go",
  spin: "Spins",
};

/**
 * The format and stake picker. Renders nothing for a library with a single
 * stake — there is no choice to offer, and an inert control is clutter.
 */
function ScopeBar({
  stakes,
  scope,
  onChange,
}: {
  stakes: StakeVolume[];
  scope: Scope;
  onChange: (scope: Scope) => void;
}) {
  if (stakes.length <= 1) {
    return null;
  }

  const formats = new Map<string, number>();
  for (const stake of stakes) {
    formats.set(stake.gameFormat, (formats.get(stake.gameFormat) ?? 0) + stake.hands);
  }
  // Only cash has stakes worth splitting by: a tournament's blinds rise every
  // level, so "hands at 400/800" is a slice of one tournament, not a game.
  const cashStakes =
    scope.gameFormat === "cash" ? stakes.filter((stake) => stake.gameFormat === "cash") : [];

  return (
    <div className="stats-scope" role="group" aria-label="Which hands">
      {formats.size > 1 ? (
        <div className="stats-scope__formats">
          <ScopeButton
            active={scope.gameFormat === null}
            onClick={() => onChange(ALL)}
            label="All formats"
            count={stakes.reduce((sum, stake) => sum + stake.hands, 0)}
          />
          {[...formats.entries()].map(([format, hands]) => (
            <ScopeButton
              key={format}
              active={scope.gameFormat === format}
              onClick={() => onChange({ gameFormat: format, stake: null })}
              label={FORMAT_LABEL[format] ?? format}
              count={hands}
            />
          ))}
        </div>
      ) : null}
      {cashStakes.length > 1 ? (
        <label className="field">
          <span className="field__label">Stakes</span>
          <select
            value={scope.stake ?? ""}
            onChange={(event) =>
              onChange({
                gameFormat: "cash",
                stake: event.target.value || null,
              })
            }
          >
            <option value="">All stakes</option>
            {cashStakes.map((stake) => (
              <option key={stakeKey(stake)} value={stakeKey(stake)}>
                {stakeLabel(stake)} · {count(stake.hands)} hands
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function ScopeButton({
  active,
  onClick,
  label,
  count: hands,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      className={`btn btn--sm${active ? " btn--primary" : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {label} <span className="stats-scope__count">{count(hands)}</span>
    </button>
  );
}
