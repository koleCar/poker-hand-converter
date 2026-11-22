/**
 * Analytics (docs/ANALYTICS.md Step 4; Reports until then, guideline §6
 * "Izvještaji", R2.7b). Since R4.5c the screen itself is the shared
 * package's (`@rail/ui/reports/ReportsScreen`), which the web's `/stats`
 * renders too; this is the app's side of it: the store as its
 * `ReportSource` and its checker (`lib/checkerSource.ts`), the definitions
 * (the shipped ones and the user's own), the tab in the address
 * (`#/reports/<tab>`: `overview`, `streets`, `stats`, `pool`, or a
 * breakdown's split such as `position`, which opens Breakdown - how the
 * command palette opens one; `#/reports/stat/<id>`: a stat's drill-down,
 * docs/ANALYTICS.md Step 8, its hands opening in the replayer's window and
 * chosen as in any hand table), the filter kept while the app runs and the one
 * the palette hands over, the recompute notice, and the starting hands
 * hidden while a poker table is open (A10). Only the hands of the kind of
 * game chosen in the sidebar (`lib/gameKind.ts`).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { checkerFiltersOf, drillOfParam, drillParam } from "@rail/ui/analytics/view";
import type { AnalyticsChecker } from "@rail/ui/analytics/model";
import {
  ReportsScreen,
  isAnalyticsView,
  isTab,
  type AnalyticsView,
  type DrillHandLinkProps,
  type DrillNav,
  type Tab,
} from "@rail/ui/reports/ReportsScreen";
import styles from "@rail/ui/reports/Reports.module.css";

import { ChosenLink, HandTable } from "../components/HandTable";
import { ProLockView } from "../components/ProLock";
import { RecomputeNotice, useRecompute } from "../components/RecomputeNotice";
import { StateMessage } from "../components/StateMessage";
import { useT } from "../i18n";
import { hiddenDuringPlay, screenOffered } from "../lib/duringPlay";
import { useAppKind } from "../lib/gameKind";
import { checkerSource } from "../lib/checkerSource";
import { inApp } from "../lib/ipc";
import { storeReportSource } from "../lib/reportSource";
import { replaceParam, screenHref, useRouteParam } from "../lib/router";
import { useEntitlements } from "../lib/useEntitlements";
import { useStatDefinitions } from "../lib/useStatDefinitions";
import { useTablesOpen } from "../lib/useTablesOpen";
import { openInReplayer } from "./analysis/openHand";
import { onFilterRequested, takeRequestedFilter, type FilterState } from "./hands/filter";

/** The filter, kept while the app runs (leaving Reports and coming back keeps it). */
let lastFilter: FilterState | null = null;
/** The Breakdown tab's split, kept while another tab is open. */
let lastTab: Tab = "position";
/** The tab (or split) a drill-down's "← Analytics" goes back to: the last one open. */
let lastPlace: string = "overview";

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

/** A drill-down hand opens in the replayer's window; several can be chosen (`HandTable`). */
function renderHandLink({ handId, label, className, children }: DrillHandLinkProps) {
  return (
    <ChosenLink handKey={handId} href={screenHref("hands", handId)} className={className} label={label} open={() => openInReplayer(handId)}>
      {children}
    </ChosenLink>
  );
}

export function Reports() {
  const t = useT();
  const r = t.reports;
  const param = useRouteParam();
  // `#/reports/<view>`, or a breakdown's split (the palette's links): Breakdown at that split;
  // `#/reports/stat/<id>`: that stat's drill-down (Step 8), over the tab it was opened from.
  const drill = drillOfParam(param);
  const place = drill === null ? (param ?? "overview") : lastPlace;
  const tab: Tab = isTab(place) ? place : lastTab;
  useEffect(() => {
    if (isTab(param)) lastTab = param;
    if (drillOfParam(param) === null) lastPlace = param ?? "overview";
  }, [param]);
  const view: AnalyticsView = isAnalyticsView(place) ? place : isTab(place) ? "breakdown" : "overview";
  const drillNav = useMemo<DrillNav>(
    () => ({
      href: (stat) => (stat === null ? screenHref("reports", place) : `#/reports/${drillParam(encodeURIComponent(stat))}`),
    }),
    [place],
  );
  const wrapHands = useCallback((children: ReactNode, resetKey: string) => <HandTable resetKey={resetKey}>{children}</HandTable>, []);
  /** The reader's filter; `null` until they set one (this run of the app). */
  const [chosen, setChosen] = useState<FilterState | null>(() => {
    // A saved filter chosen in the palette (R2.8) replaces the kept one.
    const handed = takeRequestedFilter("reports");
    if (handed) lastFilter = handed;
    return lastFilter;
  });
  const choose = (next: FilterState) => {
    lastFilter = next;
    setChosen(next);
  };
  useEffect(
    () =>
      onFilterRequested((target) => {
        if (target !== "reports") return;
        const next = takeRequestedFilter("reports");
        if (next) {
          lastFilter = next;
          setChosen(next);
        }
      }),
    [],
  );
  const definitions = useStatDefinitions();
  const rebuild = useRecompute();
  const { kind } = useAppKind();
  const tablesOpen = useTablesOpen();
  // (R6.4) The breakdowns by situation are full reports (Pro); the rest of
  // the screen is the basic statistics, free on every plan.
  const plan = useEntitlements();
  const situationsLock =
    plan.status !== null && plan.locked("reportsFull") ? (
      <ProLockView
        feature="reportsFull"
        status={plan.status}
        onSignIn={plan.signIn}
        onUpgrade={plan.upgrade}
        onCheck={plan.checkNow}
        checking={plan.checking}
        compact
      />
    ) : undefined;
  // Targets, gaps and costs come from the analysis (Pro); the player's own numbers stay.
  const checkerLock =
    plan.status !== null && plan.locked("analysis") ? (
      <ProLockView
        feature="analysis"
        status={plan.status}
        onSignIn={plan.signIn}
        onUpgrade={plan.upgrade}
        onCheck={plan.checkNow}
        checking={plan.checking}
        compact
      />
    ) : undefined;

  if (!inApp) {
    return (
      <div className={styles.screen}>
        <h1 className={styles.title}>{t.screens.reports.title}</h1>
        <p className={styles.message}>{r.unavailable}</p>
      </div>
    );
  }

  if (kind === null) return <StateMessage kind="loading">{r.loading}</StateMessage>;

  return (
    <ReportsScreen
      kind={kind}
      source={storeReportSource}
      definitions={definitions}
      chosen={chosen}
      onChoose={choose}
      view={view}
      onView={(next) => replaceParam("reports", next === "breakdown" ? tab : next)}
      tab={tab}
      onTab={(next) => replaceParam("reports", next)}
      title={t.screens.reports.title}
      hideTitle
      notice={<RecomputeNotice status={rebuild} filling={r.rebuilding} className={styles.notice} />}
      emptyText={r.empty}
      renderState={(kind, text) => <StateMessage kind={kind}>{text}</StateMessage>}
      hideHandChart={hiddenDuringPlay("handChart", tablesOpen)}
      situationsLock={situationsLock}
      checker={storeChecker}
      checkerLock={checkerLock}
      // Overview's "Practise this ▸": the Trainer with the finding's query (Step 9 reads it), not while it is hidden during play.
      practiseHref={screenOffered("trainer", tablesOpen) ? (query) => screenHref("trainer", query) : undefined}
      drill={drill}
      drillNav={drillNav}
      renderHandLink={renderHandLink}
      wrapHands={wrapHands}
    />
  );
}
