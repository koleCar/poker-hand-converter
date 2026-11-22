/**
 * Analytics (docs/ANALYTICS.md Step 4; the screen that was Reports,
 * guideline §6 "Izvještaji"), on both surfaces (R4.5c). One filter row - the
 * Hands screen's chips, with the groups a report sums by, and the screen's
 * own saved filters where the surface keeps them - over a row of tabs:
 *
 * - **Overview**: the figures row and the win-rate graph
 *   (`stats/WinrateGraph`: total, showdown, non-showdown and all-in EV,
 *   cumulative over hands, in big blinds or in money), then the findings
 *   (Step 7, `analytics/Overview.tsx`).
 * - **Streets** (Step 6, `analytics/Streets.tsx`): preflop to river in
 *   blocks, from the same checker result as All stats.
 * - **Pool** (Step 10): one quiet line until then.
 * - **All stats** (Step 5, `analytics/AllStats.tsx`): the catalogue's stats
 *   against their targets, from the surface's checker (`AnalyticsChecker`).
 * - **A stat's drill-down** (Step 8, `analytics/Drill.tsx`) instead of the
 *   tabs, when the surface's route names one (`drill`): spots, bet sizes,
 *   hand classes and hands; "By bet size and hand →" under a stat's spots
 *   leads there through the surface's `drillNav`.
 * - **Breakdown** (open question 1's default): what Reports showed - the
 *   statistics as matrices (`ReportStats.tsx`) and the breakdowns
 *   (`Breakdown.tsx`), then the surface's footer.
 *
 * The figures row (`analytics/FiguresRow.tsx`: hands, won, all-in EV,
 * showdown, non-showdown, bb | $) is shared by the first three tabs; its unit
 * is the graph's.
 *
 * Every number is the surface's `ReportSource`'s (the desktop's store, the
 * web's server summaries), in the R2.4 `Shown` shape; money is refused as
 * the web always refused it (chips with cash: no result; two currencies: big
 * blinds only). On a library with both cash and tournaments the report
 * shows one kind - the Cash / Tournaments toggle's, else the one with more
 * hands (`hands/gameKind.ts`) - so there is always a result and a graph. A
 * surface that keeps the kind itself (the desktop's sidebar) passes it as
 * `kind`, and the screen has no toggle of its own.
 *
 * The desktop app's screen (R2.7b, `app/src/screens/Reports.tsx` before
 * R4.5c), lifted out of it: the filter, the tabs and where they live (the
 * app's route and memory, the web's page state) are the surface's, and so
 * are the notices, the empty text, the states' look and the Pro locks; the
 * web adds its own panels in the footer (`footer`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { AllStats, AllStatsControls } from "../analytics/AllStats";
import an from "../analytics/Analytics.module.css";
import { Drill, DrillNavContext, type DrillHandLinkProps, type DrillNav } from "../analytics/Drill";
import { FiguresRow } from "../analytics/FiguresRow";
import type { AnalyticsChecker, CheckerExampleQuery } from "../analytics/model";
import { Overview } from "../analytics/Overview";
import { Streets, StreetsKey } from "../analytics/Streets";
import { useChecker } from "../analytics/useChecker";
import {
  ANALYTICS_VIEWS,
  codedForChecker,
  codedOf,
  hasFigures,
  isAnalyticsView,
  type AllStatsOrder,
  type AllStatsShow,
  type AnalyticsView,
} from "../analytics/view";

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
import { WinrateGraph, type WinrateGraphMoney } from "../stats/WinrateGraph";
import { Breakdown, isTab, needsBreakdowns, type Tab } from "./Breakdown";
import type { Definition, Report, ReportSource, Units } from "./model";
import styles from "./Reports.module.css";
import { ReportStats } from "./ReportStats";
import { useReport } from "./useReport";

export { isTab, type Tab };
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

export interface ReportsScreenProps {
  source: ReportSource;
  /** The definitions every `stats` list is matched to; `null` while they load. */
  definitions: readonly Definition[] | null;
  /** The reader's filter; `null` until they set one. */
  chosen: FilterState | null;
  onChoose: (filter: FilterState) => void;
  /** The open tab of the screen (Overview, Streets, All stats, Pool, Breakdown). */
  view: AnalyticsView;
  onView: (view: AnalyticsView) => void;
  /** The Breakdown tab's split (position, stake...). */
  tab: Tab;
  onTab: (tab: Tab) => void;
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
  /** The loading, empty and error states, in the surface's own look. */
  renderState: (kind: "loading" | "empty" | "error", text: string) => ReactNode;
  /** Hide the starting hands (the desktop while a poker table is open). */
  hideHandChart?: boolean;
  /**
   * (R6.4) The breakdowns by situation are held back (full reports are Pro):
   * this shows in their tabs instead, and they are never asked for.
   */
  situationsLock?: ReactNode;
  /** All stats' data: the checker's sums over the screen's filter. Absent: the player's numbers only. */
  checker?: AnalyticsChecker;
  /**
   * (Pro) Targets, gaps and costs are held back: this one line shows above
   * All stats instead, the player's own numbers stay, and the checker is
   * never asked.
   */
  checkerLock?: ReactNode;
  /**
   * The Trainer's link for an Overview finding's "Practise this ▸", from its
   * query (`practiseQuery`: `from=analytics&stat=…&spot=…&classes=…`, Step
   * 9's). Absent: no link.
   */
  practiseHref?: (query: string) => string;
  /**
   * The drill-down (Step 8) of this stat instead of the tabs: the surface's
   * route (`#/reports/stat/<id>`, `/stats/<id>`). Null or absent: the tabs.
   */
  drill?: string | null;
  /** The routes into a stat's drill-down and back; absent: no "By bet size and hand →". */
  drillNav?: DrillNav;
  /** How a drill-down hand opens (the surface's replayer). */
  renderHandLink?: (props: DrillHandLinkProps) => ReactNode;
  /** Around the drill-down's hands (the desktop's `HandTable`). */
  wrapHands?: (children: ReactNode, resetKey: string) => ReactNode;
  /** After the breakdowns: the surface's own panels over the same filter (the web's sessions and opponents). */
  footer?: (query: HandFilter, report: Report | null) => ReactNode;
  /** A new value reads everything again (the web's rebuild finishing). */
  reloadToken?: unknown;
}

export function ReportsScreen({
  source,
  definitions,
  chosen,
  onChoose,
  view,
  onView,
  tab,
  onTab,
  title,
  titleTag: Title = "h1",
  hideTitle = false,
  kind,
  notice,
  emptyText,
  renderState,
  hideHandChart = false,
  situationsLock,
  checker,
  checkerLock,
  practiseHref,
  drill = null,
  drillNav,
  renderHandLink,
  wrapHands,
  footer,
  reloadToken = 0,
}: ReportsScreenProps) {
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
  const { report, facets, wantBreakdowns } = state;
  if (facets !== null && facets !== facetsSeen) {
    setFacetsSeen(facets);
  }
  const [unit, setUnit] = useState<"bb" | "money">("bb");
  const [order, setOrder] = useState<AllStatsOrder>("street");
  const [show, setShow] = useState<AllStatsShow>("all");
  const loadFacets = useCallback((draft: HandFilter) => source.facets(draft), [source]);

  const situationsLocked = situationsLock !== undefined && situationsLock !== null;
  useEffect(() => {
    if (view === "breakdown" && needsBreakdowns(tab) && !situationsLocked) wantBreakdowns();
  }, [view, tab, wantBreakdowns, situationsLocked]);

  // Overview, Streets and All stats: the checker's sums, read while one of them is open (never on the Free plan).
  const checkerLocked = checkerLock !== undefined && checkerLock !== null;
  const drilling = drill !== null && drill !== "";
  const checks = drilling || view === "overview" || view === "streets" || view === "stats";
  const checked = useChecker(checker, query, checks && !checkerLocked && facetsSeen !== null, reloadToken);
  const checkerLoading = checker !== undefined && !checked.loaded && checked.error === null;
  const coded = useMemo(
    () => (report ? codedOf(ANALYTICS, report.summary.stats, report.summary.ids) : {}),
    [report],
  );
  const result = useMemo(
    () => (checked.sums ? checkStats(ANALYTICS, checked.sums, codedForChecker(ANALYTICS, coded)) : null),
    [checked.sums, coded],
  );
  const partial = useMemo(() => (checker ? checker.partial(query) : false), [checker, query]);
  const examples = useMemo(() => {
    const read = checker?.examples;
    return read ? (example: CheckerExampleQuery) => read.call(checker, query, example) : undefined;
  }, [checker, query]);

  const money = report ? moneyOf(report.units) : null;
  const shownUnit = unit === "money" && money ? "money" : "bb";
  const filtered = activeGroups(filter) > 0;

  // Another filter's report on its way: the previous one stays, dimmed.
  const refetching = (state.loading && report !== null) || (checked.loading && checked.sums !== null);
  const figures = !drilling && hasFigures(view);

  let body;
  if (state.error !== null && report === null) {
    body = renderState("error", r.storeError(state.error));
  } else if (report === null || definitions === null) {
    body = renderState("loading", r.loading);
  } else if (report.summary.hands === 0 && report.graph.hands === 0) {
    body = renderState("empty", filtered ? r.noMatch : emptyText);
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
            lock={checkerLocked ? checkerLock : undefined}
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
                lock={checkerLocked ? checkerLock : undefined}
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
            lock={checkerLocked ? checkerLock : undefined}
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
            lock={checkerLocked ? checkerLock : undefined}
            loading={checkerLoading}
            error={checked.error}
            partial={partial}
          />
        ) : view === "breakdown" ? (
          <>
            <section className={styles.card} aria-label={r.stats.heading}>
              <ReportStats report={report} definitions={definitions} />
              <p className={styles.muted}>{r.stats.note}</p>
            </section>
            <Breakdown
              report={report}
              breakdowns={state.breakdowns}
              loading={state.breakdownsLoading}
              definitions={definitions}
              facets={facets}
              tab={tab}
              onTab={onTab}
              hideHandChart={hideHandChart}
              situationsLock={situationsLocked ? situationsLock : undefined}
            />
          </>
        ) : (
          <p className={an.quiet}>{a.later[view]}</p>
        )}
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
      {report?.units.mixedKind ? <p className={styles.warning}>{r.units.mixedKind}</p> : null}
      {report && !report.units.mixedKind && report.units.mixedCurrency ? (
        <p className={styles.notice}>{r.units.mixedCurrency}</p>
      ) : null}
      {report && report.graph.allInEv.pending > 0 && view === "overview" && !drilling ? (
        <p className={styles.notice} role="status">
          {r.evPending(report.graph.allInEv.pending)}
        </p>
      ) : null}
      {drilling ? null : (
        <div className={an.bar}>
          <ViewTabs view={view} onView={onView} />
          <span className={an.spacer} />
          {view === "stats" && !checkerLocked ? <AllStatsControls order={order} onOrder={setOrder} show={show} onShow={setShow} /> : null}
          {view === "streets" && !checkerLocked ? <StreetsKey /> : null}
        </div>
      )}
      <div className={`${styles.results} rail-dims`} aria-busy={refetching}>
        {body}
      </div>
      {footer && view === "breakdown" && !drilling ? footer(query, report) : null}
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
