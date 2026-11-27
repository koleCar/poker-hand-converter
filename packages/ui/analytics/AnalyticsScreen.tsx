/**
 * Analytics (docs/ANALYTICS.md), a section of Analysis on both surfaces:
 * the desktop's `#/analysis/stats`, the web's `/analysis/stats`. One filter
 * row - the Hands screen's chips, with the groups a report sums by - over a
 * row of tabs:
 *
 * - **Overview**: the figures row and the win-rate graph
 *   (`stats/WinrateGraph`: total, showdown, non-showdown and all-in EV,
 *   cumulative over hands, in big blinds or in money), then the findings
 *   (Step 7, `analytics/Overview.tsx`).
 * - **Streets** (Step 6, `analytics/Streets.tsx`): preflop to river in
 *   blocks, from the same checker result as All stats.
 * - **All stats** (Step 5, `analytics/AllStats.tsx`): the catalogue's stats
 *   against their targets, from the surface's checker (`AnalyticsChecker`).
 * - **Pool** (Step 10, `analytics/Pool.tsx`): the regs and fish against the
 *   player's own targets, from the surface's `pool` (`AnalyticsPool`) and two
 *   reports over the "vs type" filter; Pro, behind `checkerLock`.
 * - **A stat's drill-down** (Step 8, `analytics/Drill.tsx`) instead of the
 *   tabs, when the surface's route names one (`drill`): spots, bet sizes,
 *   hand classes and hands; "By bet size and hand →" under a stat's spots
 *   leads there through the surface's `drillNav`.
 *
 * Reports (`reports/ReportsScreen.tsx`) stays its own screen, as it was in
 * 0.12.0 (the owner, 2026-11-23): the statistics as matrices and the
 * breakdowns live there, not here.
 *
 * The figures row (`analytics/FiguresRow.tsx`: hands, won, all-in EV,
 * showdown, non-showdown, bb | $) is shared by the first three tabs; its unit
 * is the graph's.
 *
 * Every number is the surface's `ReportSource`'s (the desktop's store, the
 * web's server summaries), in the R2.4 `Shown` shape; money is refused as
 * Reports refuses it. On a library with both cash and tournaments the screen
 * shows one kind - the Cash / Tournaments toggle's, else the one with more
 * hands (`hands/gameKind.ts`). A surface that keeps the kind itself (the
 * desktop's sidebar) passes it as `kind`, and the screen has no toggle of
 * its own. The filter, the tab and where they live are the surface's, and so
 * are the notices, the empty text, the states' look and the Pro locks.
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { AllStats, AllStatsControls } from "./AllStats";
import an from "./Analytics.module.css";
import { Drill, DrillNavContext, type DrillHandLinkProps, type DrillNav } from "./Drill";
import { FiguresRow } from "./FiguresRow";
import type { AnalyticsChecker, AnalyticsPool, CheckerExampleQuery } from "./model";
import { Overview } from "./Overview";
import { Pool, PoolControls } from "./Pool";
import type { PoolShow } from "./poolView";
import { usePool } from "./usePool";
import { Streets, StreetsKey } from "./Streets";
import { useChecker } from "./useChecker";
import {
  ANALYTICS_VIEWS,
  codedForChecker,
  codedOf,
  hasFigures,
  isAnalyticsView,
  withUncovered,
  type AllStatsOrder,
  type AllStatsShow,
  type AnalyticsView,
} from "./view";

import { FilterBar } from "../hands/FilterBar";
import { EMPTY_FILTER, activeGroups, toQuery, type FilterState } from "../hands/filter";
import { signedMoney, unitOf } from "../hands/format";
import { pinKind, type GameKind } from "../hands/gameKind";
import { groupsHiddenFor, holdSurfaceKind } from "../hands/groups";
import { KindToggle } from "../hands/KindToggle";
import type { HandFacets, HandFilter } from "../hands/model";
import { useUiStrings } from "../i18n";
import { RailLoader } from "../loader/RailLoader";
import { ANALYTICS, checkStats } from "../model/checker";
import type { Definition, ReportSource, Units } from "../reports/model";
import styles from "../reports/Reports.module.css";
import { useReport } from "../reports/useReport";
import { WinrateGraph, type WinrateGraphMoney } from "../stats/WinrateGraph";
import { Dismissible } from "../notice/Dismissible";

export { isAnalyticsView, type AnalyticsView };
export type { DrillHandLinkProps, DrillNav };

/** The money view's currency, when the sample has one. */
function moneyOf(units: Units): WinrateGraphMoney | null {
  if (units.mixedKind || units.mixedCurrency || units.currency === null || units.minorUnits === null) {
    return null;
  }
  const unit = unitOf({ currency: units.currency, currencySymbol: units.symbol ?? "", minorUnits: units.minorUnits });
  const minorUnits = units.minorUnits;
  return { minorUnits, format: (amount: number) => signedMoney(unit, Math.round(amount * minorUnits)) };
}

export interface AnalyticsScreenProps {
  source: ReportSource;
  /** The definitions every `stats` list is matched to; `null` while they load. */
  definitions: readonly Definition[] | null;
  /** The reader's filter; `null` until they set one. */
  chosen: FilterState | null;
  onChoose: (filter: FilterState) => void;
  /** The open tab of the screen (Overview, Streets, All stats, Pool). */
  view: AnalyticsView;
  onView: (view: AnalyticsView) => void;
  /** The heading's words, and its level on the surface's page. */
  title: string;
  titleTag?: "h1" | "h2";
  /**
   * The title for assistive technology only (the desktop, where the sidebar
   * names the screen): the header row is then the count on the left and the
   * Cash | Tournaments toggle on the right.
   */
  hideTitle?: boolean;
  /**
   * The kind of game the surface shows, chosen elsewhere (the desktop's
   * sidebar): the report holds to it and has no Cash / Tournaments toggle.
   */
  kind?: GameKind;
  /** Under the filters: the surface's lines (a recompute, a rebuild). */
  notice?: ReactNode;
  /** No hands at all, in the surface's words. */
  emptyText: string;
  /** No hands at all: the one way on (the web's upload, the desktop's import). */
  emptyLink?: ReactNode;
  /**
   * The loading, empty and error states, in the surface's own look; `action`
   * is the empty state's one link (Step 12: "Clear filters" when the filter
   * matches nothing, else `emptyLink`).
   */
  renderState: (kind: "loading" | "empty" | "error", text: string, action?: ReactNode) => ReactNode;
  /** All stats' data: the checker's sums over the screen's filter. Absent: the player's numbers only. */
  checker?: AnalyticsChecker;
  /**
   * (Pro) Targets, gaps and costs are held back: this one line shows above
   * the tab instead, the player's own numbers stay, and the checker is never
   * asked. A function is given the tab's line (`analytics.screen.lock`:
   * Overview, Streets, All stats, Pool, the drill-down).
   */
  checkerLock?: ReactNode | ((line: string) => ReactNode);
  /** The Pool tab's data (Step 10); absent: the tab says nothing. */
  pool?: AnalyticsPool;
  /**
   * The web with the opponents' statistics off: the link to the setting,
   * shown on the Pool tab when nobody can be typed (Step 12).
   */
  poolOff?: ReactNode;
  /**
   * The Trainer's link for an Overview finding's "Practise this ▸", from its
   * query (`practiseQuery`: `from=analytics&stat=…&spot=…&classes=…`, Step
   * 9's). Absent: no link.
   */
  practiseHref?: (query: string) => string;
  /**
   * The drill-down (Step 8) of this stat instead of the tabs: the surface's
   * route (`#/analysis/stats?stat=<id>`, `/analysis/stats/<id>`). Null or absent: the tabs.
   */
  drill?: string | null;
  /** The routes into a stat's drill-down and back; absent: no "By bet size and hand →". */
  drillNav?: DrillNav;
  /** How a drill-down hand opens (the surface's replayer). */
  renderHandLink?: (props: DrillHandLinkProps) => ReactNode;
  /** Around the drill-down's hands (the desktop's `HandTable`). */
  wrapHands?: (children: ReactNode, resetKey: string) => ReactNode;
  /** A new value reads everything again (the web's rebuild finishing). */
  reloadToken?: unknown;
}

export function AnalyticsScreen({
  source,
  definitions,
  chosen,
  onChoose,
  view,
  onView,
  title,
  titleTag: Title = "h1",
  hideTitle = false,
  kind,
  notice,
  emptyText,
  emptyLink,
  renderState,
  checker,
  checkerLock,
  pool,
  poolOff,
  practiseHref,
  drill = null,
  drillNav,
  renderHandLink,
  wrapHands,
  reloadToken = 0,
}: AnalyticsScreenProps) {
  const ui = useUiStrings();
  const r = ui.reports;
  const a = ui.analytics.screen;
  const [facetsSeen, setFacetsSeen] = useState<HandFacets | null>(null);
  // Cash and tournaments never add up: a filter that does not pick one kind
  // shows the one with more hands, and the toggle says which (the Game
  // chip's counts, which leave its own choice out, decide).
  const filter = useMemo(
    () =>
      kind === undefined
        ? pinKind(chosen ?? EMPTY_FILTER, facetsSeen).filter
        : holdSurfaceKind(chosen ?? EMPTY_FILTER, kind, facetsSeen),
    [chosen, kind, facetsSeen],
  );
  const query = useMemo(() => toQuery(filter), [filter]);
  // The first report waits for the counts that pick its kind.
  const state = useReport(source, query, facetsSeen !== null, reloadToken);
  const { report, facets } = state;
  if (facets !== null && facets !== facetsSeen) {
    setFacetsSeen(facets);
  }
  const [unit, setUnit] = useState<"bb" | "money">("bb");
  const [order, setOrder] = useState<AllStatsOrder>("street");
  const [show, setShow] = useState<AllStatsShow>("all");
  const [poolShow, setPoolShow] = useState<PoolShow>("all");
  const loadFacets = useCallback((draft: HandFilter) => source.facets(draft), [source]);

  // Overview, Streets and All stats: the checker's sums, read while one of them is open (never on the Free plan).
  const checkerLocked = checkerLock !== undefined && checkerLock !== null;
  const lockOf = (place: string): ReactNode =>
    !checkerLocked ? undefined : typeof checkerLock === "function" ? checkerLock(a.lock[place] ?? "") : checkerLock;
  const drilling = drill !== null && drill !== "";
  const checks = drilling || view === "overview" || view === "streets" || view === "stats" || view === "pool";
  const checked = useChecker(checker, query, checks && !checkerLocked && facetsSeen !== null, reloadToken);
  const checkerLoading = checker !== undefined && !checked.loaded && checked.error === null;
  const coded = useMemo(
    () => (report ? codedOf(ANALYTICS, report.summary.stats, report.summary.ids) : {}),
    [report],
  );
  // "No target yet" rows carry the player's number from every decision (Step 12).
  const result = useMemo(
    () => (checked.sums ? withUncovered(checkStats(ANALYTICS, checked.sums, codedForChecker(ANALYTICS, coded))) : null),
    [checked.sums, coded],
  );
  const partial = useMemo(() => (checker ? checker.partial(query) : false), [checker, query]);
  // Pool: the opponents' sums and the player's two figures, read while it is open (never on the Free plan).
  const pooled = usePool(pool, source, query, !drilling && view === "pool" && !checkerLocked && facetsSeen !== null, reloadToken);
  const examples = useMemo(() => {
    const read = checker?.examples;
    return read ? (example: CheckerExampleQuery) => read.call(checker, query, example) : undefined;
  }, [checker, query]);

  const money = report ? moneyOf(report.units) : null;
  const shownUnit = unit === "money" && money ? "money" : "bb";
  // The reader's own choices (not the kind the screen pins on its own): what "Clear filters" would clear.
  const filtered = activeGroups(chosen ?? EMPTY_FILTER) > 0;

  // Another filter's report on its way: the previous one stays, dimmed.
  const refetching =
    (state.loading && report !== null) || (checked.loading && checked.sums !== null) || (pooled.loading && pooled.sums !== null);
  const figures = !drilling && hasFigures(view);

  let body;
  if (state.error !== null && report === null) {
    body = renderState("error", r.storeError(state.error));
  } else if (report === null || definitions === null) {
    body = renderState("loading", r.loading);
  } else if (report.summary.hands === 0 && report.graph.hands === 0) {
    // One line and one way on: clear the filter that matches nothing, else the surface's (an upload, an import).
    body = renderState(
      "empty",
      filtered ? r.noMatch : emptyText,
      filtered ? (
        <button type="button" className={an.link} onClick={() => onChoose(EMPTY_FILTER)}>
          {a.clearFilters}
        </button>
      ) : (
        emptyLink
      ),
    );
  } else {
    body = (
      <>
        {figures ? <FiguresRow report={report} unit={shownUnit} money={money} onUnit={setUnit} /> : null}
        {drilling ? (
          <Drill
            key={drill}
            catalogue={ANALYTICS}
            statId={drill}
            sums={checked.sums}
            result={result}
            lock={lockOf("drill")}
            loading={checkerLoading}
            error={checked.error}
            partial={partial}
            examples={examples}
            examplesKey={`${JSON.stringify(query)}#${String(reloadToken)}`}
            renderHandLink={renderHandLink}
            wrapHands={wrapHands}
            practiseHref={practiseHref}
          />
        ) : view === "overview" ? (
          <>
            <section className={an.graph} aria-label={a.graph}>
              <WinrateGraph graph={report.graph} unit={shownUnit} money={money} />
            </section>
            {checker !== undefined || checkerLocked ? (
              <Overview
                catalogue={ANALYTICS}
                result={result}
                lock={lockOf("overview")}
                loading={checkerLoading}
                error={checked.error}
                partial={partial}
                onView={onView}
                practiseHref={practiseHref}
              />
            ) : null}
          </>
        ) : view === "streets" ? (
          <Streets
            catalogue={ANALYTICS}
            result={result}
            coded={coded}
            lock={lockOf("streets")}
            loading={checkerLoading}
            error={checked.error}
            partial={partial}
          />
        ) : view === "stats" ? (
          <AllStats
            catalogue={ANALYTICS}
            result={result}
            coded={coded}
            order={order}
            show={show}
            lock={lockOf("stats")}
            loading={checkerLoading}
            error={checked.error}
            partial={partial}
          />
        ) : view === "pool" && (pool !== undefined || checkerLocked) ? (
          <Pool
            catalogue={ANALYTICS}
            result={result}
            sums={pooled.sums}
            you={pooled.you}
            show={poolShow}
            lock={lockOf("pool")}
            loading={pooled.loading && !pooled.loaded}
            error={pooled.error}
            onAllStats={() => onView("stats")}
            off={poolOff}
          />
        ) : null}
      </>
    );
  }

  const screen = (
    <div className={styles.screen} aria-busy={state.loading}>
      <header className={hideTitle ? `${styles.top} ${styles.row}` : styles.top}>
        <Title className={hideTitle ? styles.visuallyHidden : styles.title}>{title}</Title>
        {report && !(figures && report.graph.hands > 0) ? (
          <span className={styles.count} aria-live="polite">
            {r.count(report.graph.hands)}
          </span>
        ) : null}
        {refetching ? <RailLoader size="inline" label={r.loading} /> : null}
        {hideTitle ? <span className={styles.spacer} /> : null}
        {kind === undefined ? <KindToggle filter={filter} facets={facetsSeen} onChange={onChoose} /> : null}
      </header>
      <FilterBar
        filter={filter}
        facets={facets}
        onChange={onChoose}
        features={source.filters}
        hideGroups={groupsHiddenFor(kind)}
        screen="reports"
        saved={source.savedFilters}
        loadFacets={loadFacets}
      />
      {notice}
      {report?.units.mixedKind ? <Dismissible className={styles.warning}>{r.units.mixedKind}</Dismissible> : null}
      {report && !report.units.mixedKind && report.units.mixedCurrency ? (
        <Dismissible className={styles.notice}>{r.units.mixedCurrency}</Dismissible>
      ) : null}
      {report && report.graph.allInEv.pending > 0 && view === "overview" && !drilling ? (
        <Dismissible className={styles.notice} role="status" messageKey="ev-pending">
          {r.evPending(report.graph.allInEv.pending)}
        </Dismissible>
      ) : null}
      {drilling ? null : (
        <div className={an.bar}>
          <ViewTabs view={view} onView={onView} />
          <span className={an.spacer} />
          {view === "stats" && !checkerLocked ? <AllStatsControls order={order} onOrder={setOrder} show={show} onShow={setShow} /> : null}
          {view === "streets" && !checkerLocked ? <StreetsKey /> : null}
          {view === "pool" && !checkerLocked && pool !== undefined ? <PoolControls show={poolShow} onShow={setPoolShow} /> : null}
        </div>
      )}
      <div className={`${styles.results} rail-dims`} aria-busy={refetching}>
        {body}
      </div>
    </div>
  );
  return drillNav ? <DrillNavContext.Provider value={drillNav}>{screen}</DrillNavContext.Provider> : screen;
}

/** The screen's tabs (the ARIA tabs pattern: arrow keys move between them). */
function ViewTabs({ view, onView }: { view: AnalyticsView; onView: (view: AnalyticsView) => void }) {
  const a = useUiStrings().analytics.screen;
  const row = useRef<HTMLDivElement>(null);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = ANALYTICS_VIEWS.indexOf(view);
    const last = ANALYTICS_VIEWS.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % ANALYTICS_VIEWS.length
        : event.key === "ArrowLeft"
          ? (index + last) % ANALYTICS_VIEWS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    const chosen = next === null ? undefined : ANALYTICS_VIEWS[next];
    if (next === null || !chosen) return;
    event.preventDefault();
    onView(chosen);
    row.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  };
  return (
    <div className={an.tabs} role="tablist" aria-label={a.tabsLabel} ref={row} onKeyDown={onKey}>
      {ANALYTICS_VIEWS.map((entry) => (
        <button
          key={entry}
          type="button"
          role="tab"
          aria-selected={entry === view}
          tabIndex={entry === view ? 0 : -1}
          className={`chip-btn${entry === view ? " is-active" : ""}`}
          onClick={() => onView(entry)}
        >
          {a.tabs[entry]}
        </button>
      ))}
    </div>
  );
}
