/**
 * Analytics (docs/ANALYTICS.md), the Analysis screen's section at
 * `#/analysis/stats`: the shared screen (`@rail/ui/analytics/AnalyticsScreen`)
 * over the store, its checker (`lib/checkerSource.ts`) and the pool
 * (`rail_store::pool`). Its tabs and a stat's drill-down live in the address
 * (`stats?view=streets`, `stats?stat=<id>`; `view.ts`); a drill-down hand
 * opens in the replayer's window and is chosen as in any hand table.
 *
 * Reports (`screens/Reports.tsx`) stays its own screen, as in 0.12.0 (the
 * owner, 2026-11-23). The filter here is kept while the app runs, apart from
 * Reports' own. Only the hands of the kind of game chosen in the sidebar
 * (`lib/gameKind.ts`).
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { AnalyticsScreen, type DrillHandLinkProps, type DrillNav } from "@rail/ui/analytics/AnalyticsScreen";
import type { AnalyticsChecker, AnalyticsPool } from "@rail/ui/analytics/model";
import { poolFiltersOf } from "@rail/ui/analytics/poolView";
import { checkerFiltersOf, type AnalyticsView } from "@rail/ui/analytics/view";
import type { FilterState } from "@rail/ui/hands/filter";
import styles from "@rail/ui/reports/Reports.module.css";

import { ChosenLink, HandTable } from "../../components/HandTable";
import { ProLockView } from "../../components/ProLock";
import { RecomputeNotice, useRecompute } from "../../components/RecomputeNotice";
import { StateMessage } from "../../components/StateMessage";
import { useT } from "../../i18n";
import { screenOffered } from "../../lib/duringPlay";
import { useAppKind } from "../../lib/gameKind";
import { checkerSource } from "../../lib/checkerSource";
import { ipc } from "../../lib/ipc";
import { storeReportSource } from "../../lib/reportSource";
import { replaceParam, screenHref } from "../../lib/router";
import { useEntitlements } from "../../lib/useEntitlements";
import { useStatDefinitions } from "../../lib/useStatDefinitions";
import { useTablesOpen } from "../../lib/useTablesOpen";
import { openInReplayer } from "./openHand";
import { viewParam } from "./view";

/** The filter, kept while the app runs (leaving Analytics and coming back keeps it). */
let lastFilter: FilterState | null = null;

/**
 * All stats' sums from the store: the dates, the kind or one format, one
 * position and one pot type (`rail_store::checker::CheckerFilters`); other
 * groups are left out, and the screen says so.
 */
const storeChecker: AnalyticsChecker = {
  sums: (query) => checkerSource.checker(checkerFiltersOf(query).filters),
  partial: (query) => checkerFiltersOf(query).partial,
  examples: (query, example) => checkerSource.examples(checkerFiltersOf(query).filters, example),
};

/**
 * The Pool tab's sums from the store (`rail_store::pool`): the kind or one
 * format and the rooms. The store counts the opponents in its background
 * pass, so there is no backfill to run here.
 */
const storePool: AnalyticsPool = {
  sums: (query) => ipc.analyticsPool(poolFiltersOf(query)),
};

/** A drill-down hand opens in the replayer's window; several can be chosen (`HandTable`). */
function renderHandLink({ handId, label, className, children }: DrillHandLinkProps) {
  return (
    <ChosenLink handKey={handId} href={screenHref("hands", handId)} className={className} label={label} open={() => openInReplayer(handId)}>
      {children}
    </ChosenLink>
  );
}

/** The section's address for a tab and, optionally, a stat's drill-down. */
const paramOf = (view: AnalyticsView, stat: string | null) => viewParam({ kind: "stats", view, stat });

export function AnalyticsTab({ view, stat, nav }: { view: AnalyticsView; stat: string | null; nav: ReactNode }) {
  const t = useT();
  const r = t.reports;
  const words = t.analysis.analytics;
  // The drill-down's "← Analytics" goes back to the tab it was opened from.
  const drillNav = useMemo<DrillNav>(
    () => ({ href: (next) => screenHref("analysis", paramOf(view, next)) }),
    [view],
  );
  const wrapHands = useCallback((children: ReactNode, resetKey: string) => <HandTable resetKey={resetKey}>{children}</HandTable>, []);
  /** The reader's filter; `null` until they set one (this run of the app). */
  const [chosen, setChosen] = useState<FilterState | null>(() => lastFilter);
  const choose = (next: FilterState) => {
    lastFilter = next;
    setChosen(next);
  };
  const definitions = useStatDefinitions();
  const rebuild = useRecompute();
  const { kind } = useAppKind();
  const tablesOpen = useTablesOpen();
  // Targets, gaps and costs come from the analysis (Pro); the player's own numbers stay,
  // with one line above them (docs/ANALYTICS.md Step 12): the tab's line, the way to Pro.
  const plan = useEntitlements();
  const planStatus = plan.status;
  const checkerLock =
    planStatus !== null && plan.locked("analysis")
      ? (line: string) => (
          <ProLockView
            feature="analysis"
            status={planStatus}
            onSignIn={plan.signIn}
            onUpgrade={plan.upgrade}
            onCheck={plan.checkNow}
            checking={plan.checking}
            line={line}
            inline
          />
        )
      : undefined;

  if (kind === null) {
    return (
      <>
        {nav}
        <StateMessage kind="loading">{r.loading}</StateMessage>
      </>
    );
  }

  return (
    <>
      {nav}
      <AnalyticsScreen
        kind={kind}
        source={storeReportSource}
        definitions={definitions}
        chosen={chosen}
        onChoose={choose}
        view={view}
        onView={(next) => replaceParam("analysis", paramOf(next, null))}
        title={t.analysis.tabs.stats}
        hideTitle
        notice={<RecomputeNotice status={rebuild} filling={r.rebuilding} className={styles.notice} />}
        emptyText={words.empty}
        emptyLink={<a href={screenHref("import")}>{words.emptyLink}</a>}
        renderState={(state, text, action) =>
          state === "loading" ? (
            <StateMessage kind={state}>{text}</StateMessage>
          ) : (
            <StateMessage kind={state}>
              {text}
              {action ? <> {action}</> : null}
            </StateMessage>
          )
        }
        checker={storeChecker}
        pool={storePool}
        checkerLock={checkerLock}
        // Overview's "Practise this ▸": the Trainer with the finding's query (Step 9 reads it), not while it is hidden during play.
        practiseHref={screenOffered("trainer", tablesOpen) ? (query) => screenHref("trainer", query) : undefined}
        drill={stat}
        drillNav={drillNav}
        renderHandLink={renderHandLink}
        wrapHands={wrapHands}
      />
    </>
  );
}
