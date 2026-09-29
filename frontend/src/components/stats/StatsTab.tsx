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

import { useCallback, useEffect, useState } from "react";
import {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  fetchStatsGraph,
  fetchStatsSummary,
  isDatabaseConfigured,
  isMissingSchemaError,
  type StatsGraph,
  type StatsSummary,
} from "../../lib/db";
import { useAuth } from "../../lib/auth";
import { HudGrid } from "./HudGrid";
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

  const load = useCallback(async () => {
    setStatus("loading");
    setMessage(null);
    try {
      // In parallel: they read the same rows under the same filters, and a
      // sequential pair would make the page's slowest path the sum of two
      // aggregate scans for no reason.
      const [nextSummary, nextGraph] = await Promise.all([
        fetchStatsSummary(),
        fetchStatsGraph({}, GRAPH_BUCKETS),
      ]);
      setSummary(nextSummary);
      setGraph(nextGraph);
      setStatus("ready");
    } catch (error) {
      if (isMissingSchemaError(error)) {
        setStatus("not-installed");
        return;
      }
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    if (!isDatabaseConfigured || !auth.isSignedIn) {
      return;
    }
    void load();
  }, [auth.isSignedIn, load, refreshToken]);

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

  if (summary.hands === 0) {
    return (
      <div className="stats">
        <Header />
        <div className="card stats-empty">
          <h3>No hands with statistics yet</h3>
          <p className="muted">
            Statistics are derived when hands are saved. Upload a hand history and this
            screen fills in — or, if your library predates this feature, the numbers
            appear as you upload more.
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
