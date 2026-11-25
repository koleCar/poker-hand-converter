/**
 * Analysis (R5.4): the web's analysis in the app, over the local store and
 * offline. Its sections are the shared package's screens with the app's
 * sources - the session review (R5.1, `packages/ui/review`), the top
 * leaks and Analytics (docs/ANALYTICS.md, `analysis/AnalyticsTab.tsx`) - and
 * one hand's decision-by-decision grades,
 * reached from Hands and from the lists. Above them, the background run's
 * status (how far it is, why it waits) with Pause / Resume.
 *
 * An analysis screen (A10): `duringPlay.ts` classifies the route, so the
 * shell shows "not during play" in its place while a poker table is open,
 * and the sidebar and the palette leave it out; the shared screens are also
 * told (`hiddenDuringPlay`: they read nothing).
 *
 * Every section shows the kind of game chosen in the sidebar
 * (`lib/gameKind.ts`); none has a Cash | Tournaments switch of its own.
 *
 * The review (#425) is of every hand the filter row matches - the Hands
 * and Reports filters - not of one session: no session picker, and
 * "Analysed hands only" while some of them are not analysed yet. Once every
 * hand is, the run's line goes too.
 */
import { BombPotsTab, MultiwayTab } from "./analysis/PotKinds";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FilterBar } from "@rail/ui/hands/FilterBar";
import { EMPTY_FILTER, toQuery, type FilterState } from "@rail/ui/hands/filter";
import { groupsHiddenFor, holdSurfaceKind } from "@rail/ui/hands/groups";
import type { HandFacets, HandFilter } from "@rail/ui/hands/model";
import { useUiStrings } from "@rail/ui/i18n";
import { shippedChartDeviations, type SessionQuery } from "@rail/ui/review/model";
import { SessionReviewScreen, type HandLinkProps } from "@rail/ui/review/SessionReviewScreen";

import { ChosenLink, HandTable } from "../components/HandTable";
import { StateMessage } from "../components/StateMessage";
import { useT } from "../i18n";
import { onAnalysisRows, useAnalysisStatus } from "../analysis/service";
import { hiddenDuringPlay } from "../lib/duringPlay";
import { inApp } from "../lib/ipc";
import { useAppKind } from "../lib/gameKind";
import { storeReportSource } from "../lib/reportSource";
import { storeHandsReviewSource } from "../lib/reviewSource";
import { replaceParam, screenHref, useRouteParam } from "../lib/router";
import { useTablesOpen } from "../lib/useTablesOpen";
import { AnalysisStatus, ShowAnalysisProgress } from "./analysis/AnalysisStatus";
import { AnalyticsTab } from "./analysis/AnalyticsTab";
import { useProgressHidden } from "./analysis/progressHidden";
import { allAnalysed } from "./analysis/status";
import styles from "./analysis/Analysis.module.css";
import { HandAnalysis } from "./analysis/HandAnalysis";
import { openInReplayer } from "./analysis/openHand";
import { TopLeaks } from "./analysis/TopLeaks";
import { ANALYSIS_TABS, parseView, tabOf, viewParam, type AnalysisView } from "./analysis/view";

export function Analysis() {
  const view = parseView(useRouteParam());
  // Another section (a tab, a hand's grades) fades in, as another screen does.
  return (
    <div key={view.kind} className="rail-fade">
      <AnalysisSection view={view} />
    </div>
  );
}

function AnalysisSection({ view }: { view: AnalysisView }) {
  const t = useT();
  const tablesOpen = useTablesOpen();
  const hidden = hiddenDuringPlay("analysis", tablesOpen);
  const reload = useRowsWritten();

  if (!inApp) {
    return <StateMessage kind="empty">{t.analysis.unavailable}</StateMessage>;
  }
  if (view.kind === "hand") {
    return <HandAnalysis handKey={view.key} actionIndex={view.actionIndex} back={view.back} />;
  }
  const nav = (end?: ReactNode) => <AnalysisNav current={tabOf(view)} end={end} />;
  if (view.kind === "bomb") {
    return (
      <div>
        <h1 className={styles.visuallyHidden}>{t.analysis.tabs.bomb}</h1>
        {nav()}
        <BombPotsTab hidden={hidden} reload={reload} />
      </div>
    );
  }
  if (view.kind === "multiway") {
    return (
      <div>
        <h1 className={styles.visuallyHidden}>{t.analysis.tabs.multiway}</h1>
        {nav()}
        <MultiwayTab hidden={hidden} reload={reload} spots={hidden ? null : <MultiwaySpots reload={reload} />} />
      </div>
    );
  }
  if (view.kind === "stats") {
    return hidden ? nav() : <AnalyticsTab view={view.view} stat={view.stat} nav={nav()} />;
  }
  if (view.kind === "leaks") {
    return (
      <div>
        <h1 className={styles.visuallyHidden}>{t.analysis.tabs.leaks}</h1>
        {nav()}
        {hidden ? null : (
          <TopLeaks
            hidden={hidden}
            reload={reload}
            potKind="hu"
            period={view.period}
            onPeriod={(period) => replaceParam("analysis", viewParam({ kind: "leaks", period }))}
          />
        )}
      </div>
    );
  }
  return <Session nav={nav} hidden={hidden} reload={reload} />;
}

/** The multiway spots ranked among themselves (analysis/45): the top leaks with `potKind: "mw"`. */
function MultiwaySpots({ reload }: { reload: number }) {
  const [period, setPeriod] = useState<"30d" | "all">("all");
  return <TopLeaks hidden={false} reload={reload} period={period} potKind="mw" onPeriod={setPeriod} />;
}

/** A new value each time the background run writes rows: the screens read again. */
function useRowsWritten(): number {
  const [count, setCount] = useState(0);
  useEffect(() => onAnalysisRows(() => setCount((n) => n + 1)), []);
  return count;
}

/**
 * The header row (2026-11-07): the sections' tabs on the left, the
 * section's own controls on the right; the run's status under it, or
 * (hidden, 2026-11-18) the button that shows it again at the row's end.
 */
function AnalysisNav({ current, end }: { current: AnalysisView["kind"]; end?: ReactNode }) {
  const t = useT();
  // Every hand analysed (#425): no line, and nothing to show again.
  const done = allAnalysed(useAnalysisStatus());
  const progressHidden = useProgressHidden();
  const showAgain = progressHidden && !done;
  return (
    <div className={styles.nav}>
      <div className={styles.navRow}>
        <nav className={styles.tabs} aria-label={t.analysis.tabsLabel}>
          {ANALYSIS_TABS.map((tab) => (
            <a
              key={tab}
              className={styles.tab}
              href={screenHref("analysis", tab)}
              aria-current={tab === current ? "page" : undefined}
            >
              {t.analysis.tabs[tab]}
            </a>
          ))}
        </nav>
        {end || showAgain ? (
          <div className={styles.navEnd}>
            {end}
            {showAgain ? <ShowAnalysisProgress /> : null}
          </div>
        ) : null}
      </div>
      {progressHidden || done ? null : <AnalysisStatus />}
    </div>
  );
}

/** How often at most the review reads every hand again while the background run writes rows. */
const RELOAD_MS = 30_000;

/** `value`, changing at most once per `ms`; the last change always lands. */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const timer = setTimeout(
      () => {
        last.current = Date.now();
        setShown(value);
      },
      Math.max(0, last.current + ms - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

/** The review's filter and "Analysed hands only", kept while the app runs (leaving Analysis and coming back keeps them). */
let lastFilter: FilterState | null = null;
let lastAnalysedOnly = false;

/**
 * The review of every hand of the filter (#425): the shared screen with
 * `scope: "hands"` under the filter row (Hands' and Reports' groups, the
 * sidebar's kind of game held), read from the store (`hands_review`).
 */
function Session({
  nav,
  hidden,
  reload,
}: {
  nav: (end?: ReactNode) => ReactNode;
  hidden: boolean;
  reload: number;
}) {
  const t = useT();
  const ui = useUiStrings();
  // One kind of game at a time: the sidebar's (`lib/gameKind.ts`).
  const { kind } = useAppKind();
  const [chosen, setChosen] = useState<FilterState | null>(() => lastFilter);
  const [analysedOnly, setAnalysedOnly] = useState(() => lastAnalysedOnly);
  // The chips' counts; the first review waits for them (they settle the kind's formats).
  const [facets, setFacets] = useState<{ value: HandFacets | null } | null>(null);
  const seen = facets?.value ?? null;
  const filter = useMemo(
    () => (kind === null ? null : holdSurfaceKind(chosen ?? EMPTY_FILTER, kind, seen)),
    [chosen, kind, seen],
  );
  const handFilter = useMemo(() => (filter === null ? null : toQuery(filter)), [filter]);
  const filterKey = handFilter === null ? null : JSON.stringify(handFilter);
  useEffect(() => {
    if (hidden || filterKey === null) return;
    let live = true;
    storeReportSource.facets(JSON.parse(filterKey) as HandFilter).then(
      (value) => {
        if (live) setFacets({ value });
      },
      () => {
        // The counts are a convenience: the review is read without them.
        if (live) setFacets((current) => current ?? { value: null });
      },
    );
    return () => {
      live = false;
    };
  }, [filterKey, hidden]);
  // Every hand is read again as the background run writes rows, at most twice a minute.
  const reloadEvery = useThrottled(reload, RELOAD_MS);

  const query: SessionQuery | null = useMemo(
    () => (handFilter === null ? null : { at: null, gapMinutes: 30, filter: handFilter, analysedOnly }),
    [handFilter, analysedOnly],
  );
  const choose = useCallback((next: FilterState) => {
    lastFilter = next;
    setChosen(next);
  }, []);
  const onQuery = useCallback((next: SessionQuery) => {
    lastAnalysedOnly = next.analysedOnly ?? false;
    setAnalysedOnly(lastAnalysedOnly);
  }, []);
  const loadFacets = useCallback((draft: HandFilter) => storeReportSource.facets(draft), []);

  // Each hand chooses as a Hands row does (`HandTable`): several replayed or tagged at once.
  const renderHandLink = useCallback(
    ({ handId, label, className, children }: HandLinkProps) => (
      <ChosenLink
        handKey={handId}
        href={screenHref("hands", handId)}
        className={className}
        label={label}
        open={() => openInReplayer(handId)}
      >
        {children}
      </ChosenLink>
    ),
    [],
  );

  if (filter === null || query === null || (facets === null && !hidden)) {
    return (
      <>
        {nav()}
        <StateMessage kind="loading">{ui.review.hands.loading}</StateMessage>
      </>
    );
  }

  const top = (
    <>
      {nav()}
      {hidden ? null : (
        <FilterBar
          filter={filter}
          facets={seen}
          onChange={choose}
          features={storeReportSource.filters}
          hideGroups={kind === null ? undefined : groupsHiddenFor(kind)}
          screen="reports"
          saved={storeReportSource.savedFilters}
          loadFacets={loadFacets}
        />
      )}
    </>
  );

  return (
    <HandTable resetKey={`${filterKey ?? ""}|${analysedOnly ? 1 : 0}`}>
      <SessionReviewScreen
        source={storeHandsReviewSource}
        deviationSource={shippedChartDeviations}
        query={query}
        onQuery={onQuery}
        renderHandLink={renderHandLink}
        title={t.analysis.tabs.session}
        hideTitle
        notice={top}
        reloadToken={reloadEvery}
        hiddenDuringPlay={hidden}
        intro={false}
        layout="table"
        scope="hands"
        renderState={(state, text) => <StateMessage kind={state}>{text}</StateMessage>}
      />
    </HandTable>
  );
}
