/**
 * The statistics screens: Reports at `/stats` (`mode: "reports"`, as it was
 * in 0.12.0) and Analytics at `/analysis/stats` (`mode: "analytics"`,
 * docs/ANALYTICS.md, a section of Analysis since 2026-11-23). Both read the
 * same report source and share this page's states, the "still being
 * processed" line and live arrivals; Analytics draws the shared Analytics
 * screen (`@rail/ui/analytics/AnalyticsScreen`) under the Analysis tabs.
 *
 * Since R4.5c the report itself is the shared Reports screen
 * (`@rail/ui/reports/ReportsScreen`, the desktop app's since R2.7b) over the
 * web's report summaries (`lib/db/reportSource.ts`): the filter chips, the
 * summary, the win-rate graph (with its all-in EV line, in big blinds or
 * money), every statistic by group and the breakdowns - by position, stake,
 * table size, room and game, and by pot type, stack depth, starting hand
 * (the 13 x 13 grid), players dealt in and street. It is laid out as the
 * desktop's Reports: no visible title (the bar already says Statistics), one
 * header row with the hand count on the left and Cash | Tournaments on the
 * right. Around it, this page's own: the four ways of having nothing to show,
 * the "still being processed" line, live arrivals, and its panels over the
 * same filter - the sessions and the opponents after the breakdowns.
 *
 * **This page never derives or counts** (docs/POOL.md P1). Hands are worked
 * out on the server when they arrive (`derive_queue`); while some are still
 * in the queue the page shows one line, "N hands still being processed",
 * read from a counter (`derive_pending`), and reads it again every few
 * seconds until it reaches zero, re-reading the numbers as it falls.
 *
 * Four ways of having nothing to show, and one rule running through all of
 * them: **say which nothing it is.** A blank screen is the same pixels
 * whether the user is signed out, has no hands, has a database without the
 * statistics migrations on it, or hit a real error — and those need four
 * different actions from the reader. PostgREST answers `PGRST202` for a
 * function missing from its schema cache; `isMissingSchemaError` is that
 * check, a code rather than a string match.
 *
 * A stat's drill-down (docs/ANALYTICS.md Step 8) is `/analysis/stats/<id>` on
 * the Analytics screen: the address says which (`drillOfPath`), and moving in and out is a
 * `history.pushState`, so the filter and the tab stay; its hands open on
 * their analysis page at the decision, with a way back to the stat.
 *
 * Live arrival (Rail R1.10): hands synced by the desktop app while the screen
 * is open re-read the numbers and the pending count in place; the server's
 * worker works them out.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FilterState } from "@rail/ui/hands/filter";
import type { HandFilter } from "@rail/ui/hands/model";
import type { AnalyticsChecker } from "@rail/ui/analytics/model";
import { useUiStrings } from "@rail/ui/i18n";
import { checkerFiltersOf, drillOfPath } from "@rail/ui/analytics/view";
import { AnalyticsScreen, type DrillHandLinkProps, type DrillNav } from "@rail/ui/analytics/AnalyticsScreen";
import type { AnalyticsView } from "@rail/ui/analytics/view";
import { ReportsScreen, type Tab } from "@rail/ui/reports/ReportsScreen";
import { encodePosition } from "@rail/ui/replayer/position";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import reportStyles from "@rail/ui/reports/Reports.module.css";
import { DATABASE_NOT_CONFIGURED_MESSAGE, isDatabaseConfigured, isMissingSchemaError } from "../../lib/db";
import { webPool } from "../../lib/db/analyticsPool";
import { checkerSource } from "../../lib/db/analyticsRows";
import { fetchDerivePending, useOpponentStats } from "../../lib/db/derive";
import { libraryFilter } from "../../lib/db/handsSource";
import { WEB_DEFINITIONS, webReportSource } from "../../lib/db/reportSource";
import { useAuth } from "../../lib/auth";
import { useEntitlements } from "../../lib/entitlements/context";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { ProLock, ProLockLine } from "../plan/ProLock";
import type { ArrivalBatch } from "../../lib/live/arrivals";
import { AnalysisNav } from "../analysis/AnalysisNav";
import { OpponentsPanel } from "./OpponentsPanel";
import { opponentsScope } from "./opponentsScope";
import { SessionsPanel } from "./SessionsPanel";
import { StatsNav } from "./StatsNav";
import "../../styles/stats.css";
import { Dismissible } from "@rail/ui/notice/Dismissible";

interface StatsTabProps {
  /** Bumped by the shell after an upload lands, so the numbers follow it. */
  refreshToken?: number;
  /** The latest live batch from the shell (`AppFrame`, R1.10); null until one arrives. */
  arrival?: ArrivalBatch | null;
  /** Reports (`/stats`, the default) or Analytics (`/analysis/stats`). */
  mode?: "reports" | "analytics";
}

type Status = "ready" | "not-installed" | "error";

/** Identifiers in the "not set up" notice: names, not prose, so not translated. */
const STATS_TABLE = "hand_stats";
const STATS_MIGRATION = "supabase/migrations/20261005090000_hand_stats.sql";

/**
 * All stats' sums (`analytics_checker`): the keys the checker reads, and the
 * Hands list's filter for every other group it sets - so All stats covers
 * the hands the list shows.
 */
const webChecker: AnalyticsChecker = {
  sums: (query) => {
    const { filters, hands } = checkerFiltersOf(query);
    return checkerSource.checker(hands ? { ...filters, hands: libraryFilter(query) } : filters);
  },
  partial: () => false,
  examples: (query, example) => {
    const { filters, hands } = checkerFiltersOf(query);
    return checkerSource.examples(hands ? { ...filters, hands: libraryFilter(query) } : filters, example);
  },
  // No `backfill`: the server writes the rows of an analysed hand
  // (docs/POOL.md P1); `pending` counts down as it does.
};

/** The Analytics lock as one line (the tab's words): the player's own numbers stay. */
const lockLine = (line: string) => <ProLockLine line={line} />;

/** How often the pending count is read again while hands are being processed. */
const PENDING_POLL_MS = 5_000;
/** The numbers are read again at most this often while the count falls (and once at zero). */
const RELOAD_EVERY_MS = 20_000;

/**
 * The drill-down's way in and out (docs/ANALYTICS.md Step 8):
 * `/analysis/stats/<id>` and back to `/analysis/stats`, as history entries of this one screen (Next keeps
 * `usePathname` in step with `history.pushState`), so the filter and the tab
 * stay as they were.
 */
const webDrillNav: DrillNav = {
  href: (stat) => (stat === null ? paths.analysisStats() : paths.analysisStat(stat)),
  go: (stat) => {
    window.history.pushState(null, "", stat === null ? paths.analysisStats() : paths.analysisStat(stat));
    window.scrollTo({ top: 0 });
  },
};


export function StatsTab({ refreshToken = 0, arrival = null, mode = "reports" }: StatsTabProps) {
  const dict = useDict();
  const ui = useUiStrings();
  const t = dict.stats;
  const en = t.tab;
  const auth = useAuth();
  // Pool's types come from the opponents' statistics; off, it links to the setting (Players).
  const opponentsOn = useOpponentStats(auth.isSignedIn ? (auth.user?.id ?? null) : null) ?? true;
  const { locked, status: planStatus } = useEntitlements();
  const planPending = planStatus === "loading";
  const [status, setStatus] = useState<Status>("ready");
  const [message, setMessage] = useState<string | null>(null);
  /** The caller's hands still being processed (`derive_pending`); null until read. */
  const [pending, setPending] = useState<number | null>(null);
  /** Bumped when the numbers change under the screen (hands processed, an arrival, an upload): it reads again. */
  const [generation, setGeneration] = useState(0);
  const [chosen, setChosen] = useState<FilterState | null>(null);
  const [view, setView] = useState<AnalyticsView>("overview");
  const [tab, setTab] = useState<Tab>("position");
  // `/analysis/stats/<id>`: that stat's drill-down (Step 8), over the tab it was opened from.
  const pathname = usePathname();
  const drill = mode === "analytics" ? drillOfPath(pathname) : null;
  // A drill-down hand opens on its analysis page, at the decision; its Back returns to the stat.
  const renderHandLink = useCallback(
    ({ handId, actionIndex, label, className, children }: DrillHandLinkProps) => {
      const back = drill === null ? "" : `&from=stats&stat=${encodeURIComponent(drill)}`;
      const position = encodeURIComponent(encodePosition({ kind: "action", actionIndex }));
      return (
        <Link href={paths.analysisHand(handId, `t=${position}${back}`)} className={className} aria-label={label}>
          {children}
        </Link>
      );
    },
    [drill],
  );

  const base = useMemo(() => webReportSource(dict.converter.library.standardFormat), [dict]);
  // Full reports (situations, sessions, opponents) are Pro (R6.2); basic
  // statistics - the report, the graph, the chips - are not. Locked only
  // while enforcement is on and the plan lacks them; the server refuses
  // them on its own (PT402) either way.
  const fullLocked = locked("reports_full");
  // All stats' targets, gaps and costs come from the analysis (Pro); the player's own numbers stay.
  const analysisLocked = locked("analysis");
  // A database without the summaries' readers (PGRST202) says "not set up", not a stack trace.
  const source = useMemo(
    () => ({
      ...base,
      report: (filter: HandFilter, points: number) =>
        base.report(filter, points).catch((error: unknown) => {
          if (isMissingSchemaError(error)) setStatus("not-installed");
          throw error;
        }),
      breakdowns: (filter: HandFilter) =>
        fullLocked ? Promise.reject(new Error(dict.plan.lock.body.reports_full)) : base.breakdowns(filter),
    }),
    [base, fullLocked, dict],
  );

  /** Reads the pending count; a database without the queue says "not set up". */
  const readPending = useCallback(
    (): Promise<number | null> =>
      fetchDerivePending().then(
        (next) => {
          setPending(next);
          return next;
        },
        (error: unknown) => {
          if (isMissingSchemaError(error)) {
            setStatus("not-installed");
          } else {
            setStatus("error");
            setMessage(error instanceof Error ? error.message : String(error));
          }
          return null;
        },
      ),
    [],
  );

  // On sign-in, an upload (`refreshToken`) or a live batch: the numbers
  // (`reloadKey`) and the count are read again. Nothing is derived here.
  const arrivalSeq = arrival?.seq ?? 0;
  const reloadKey = `${generation}|${refreshToken}|${arrivalSeq}`;
  useEffect(() => {
    if (!isDatabaseConfigured || !auth.isSignedIn) {
      return;
    }
    void readPending();
  }, [auth.isSignedIn, readPending, refreshToken, arrivalSeq]);

  // While hands are being processed: the count is read again every few
  // seconds, and the numbers as it falls (at most every RELOAD_EVERY_MS, and
  // once when it reaches zero).
  const lastReload = useRef(0);
  const processing = pending !== null && pending > 0;
  useEffect(() => {
    if (!processing) return;
    let previous: number | null = null;
    const timer = window.setInterval(() => {
      void readPending().then((next) => {
        if (next === null || next === previous) return;
        const first = previous === null;
        previous = next;
        const now = Date.now();
        if (next === 0 || (!first && now - lastReload.current >= RELOAD_EVERY_MS)) {
          lastReload.current = now;
          setGeneration((value) => value + 1);
        }
      });
    }, PENDING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [processing, readPending]);

  if (!isDatabaseConfigured) {
    return (
      <div className="stats">
        <Header mode={mode} />
        <Dismissible className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</Dismissible>
      </div>
    );
  }

  if (!auth.isSignedIn) {
    // The session restoring is not "signed out": the loader, not the gate.
    if (auth.status === "loading") {
      return (
        <div className="stats">
          <Header mode={mode} />
          <RailLoader label={dict.settings.loading} centered />
        </div>
      );
    }
    return (
      <div className="stats">
        <Header mode={mode} />
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
        <Header mode={mode} />
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
              void readPending();
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
        <Header mode={mode} />
        <Dismissible className="notice notice--error">{message}</Dismissible>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setStatus("ready");
            void readPending();
          }}
        >
          {t.common.tryAgain}
        </button>
      </div>
    );
  }

  if (mode === "analytics") {
    return (
      <div className="stats">
        <AnalysisNav current="stats" />
        <AnalyticsScreen
          key={auth.user?.id ?? ""}
          source={source}
          definitions={WEB_DEFINITIONS}
          chosen={chosen}
          onChoose={setChosen}
          view={view}
          onView={setView}
          title={dict.analysis.ui.nav.stats}
          titleTag="h2"
          hideTitle
          notice={<PendingLine pending={pending} />}
          emptyText={processing ? en.loading : `${en.emptyHeading}.`}
          emptyLink={<Link href={paths.convert()}>{en.emptyLink}</Link>}
          reloadToken={reloadKey}
          renderState={(kind, text, action) =>
            // Nothing to show while hands are being processed is still loading.
            kind === "loading" || (kind === "empty" && processing) ? (
              <RailLoader label={kind === "empty" ? en.loading : text} showLabel centered />
            ) : (
              kind === "error" ? (
                <Dismissible as="div" className="notice notice--error rail-fade" role="alert">
                  {text}
                </Dismissible>
              ) : (
                <div className="card stats-empty rail-fade" role="status">
                  <p className="muted">
                    {text}
                    {action ? <> {action}</> : null}
                  </p>
                </div>
              )
            )
          }
          checker={webChecker}
          pool={webPool}
          poolOff={opponentsOn ? undefined : <Link href={paths.players()}>{ui.analytics.screen.pool.offLink}</Link>}
          checkerLock={analysisLocked ? lockLine : undefined}
          practiseHref={paths.analysisTrain}
          drill={drill}
          drillNav={webDrillNav}
          renderHandLink={renderHandLink}
        />
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
        hideTitle
        notice={<PendingLine pending={pending} />}
        emptyText={processing ? en.loading : `${en.emptyHeading}. ${en.emptyBody}`}
        reloadToken={reloadKey}
        renderState={(kind, text) =>
          // Nothing to show while hands are being processed is still loading.
          kind === "loading" || (kind === "empty" && processing) ? (
            <RailLoader label={kind === "empty" ? en.loading : text} showLabel centered />
          ) : (
            kind === "error" ? (
              <Dismissible as="div" className="notice notice--error rail-fade" role="alert">
                {text}
              </Dismissible>
            ) : (
              <div className="card stats-empty rail-fade" role="status">
                <p className="muted">{text}</p>
              </div>
            )
          )
        }
        // (R6.4) The situation tabs and the footer (sessions, opponents)
        // show the Pro teaser instead of an error.
        situationsLock={fullLocked ? <ProLock feature="reports_full" compact /> : undefined}
        footer={(query) => {
          if (fullLocked) {
            return <ProLock feature="reports_full" compact />;
          }
          if (planPending) {
            return null;
          }
          const opponents = opponentsScope(query);
          return (
            <>
              <SessionsPanel filter={query} refreshToken={reloadKey} />
              <OpponentsPanel filters={opponents.filters} partial={opponents.partial} refreshToken={reloadKey} />
            </>
          );
        }}
      />
    </div>
  );
}

/**
 * The states' heading: for assistive technology only, like the report's own
 * (`hideTitle`); Analytics' under the Analysis tabs.
 */
function Header({ mode }: { mode: "reports" | "analytics" }) {
  const dict = useDict();
  if (mode === "analytics") {
    return (
      <>
        <AnalysisNav current="stats" />
        <h2 className={reportStyles.visuallyHidden}>{dict.analysis.ui.nav.stats}</h2>
      </>
    );
  }
  return <h2 className={reportStyles.visuallyHidden}>{dict.stats.tab.heading}</h2>;
}

/**
 * The one line while hands are being processed: "N hands still being
 * processed", from the counter. Silent at zero.
 */
function PendingLine({ pending }: { pending: number | null }) {
  const t = useDict().stats.coverage;
  if (pending === null || pending <= 0) {
    return null;
  }
  const text = t.processing(pending);
  // The paragraph is the live region; the mark beside it is only the look.
  return (
    <Dismissible className="notice notice--info stats-coverage rail-fade" role="status" aria-live="polite" messageKey="processing">
      <span aria-hidden="true">
        <RailLoader size="inline" label={text} delay={0} />
      </span>{" "}
      {text}
    </Dismissible>
  );
}
