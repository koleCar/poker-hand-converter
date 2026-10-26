/**
 * Analysis (R5.4): the web's analysis in the app, over the local store and
 * offline. Its sections are the shared package's screens with the app's
 * sources - the session review (R5.1, `packages/ui/review`), the user's own
 * charts and their comparison with the hands played (R5.3,
 * `packages/ui/charts`) - and one hand's decision-by-decision grades,
 * reached from Hands and from the lists. Above them, the background run's
 * status (how far it is, why it waits) with Pause / Resume.
 *
 * An analysis screen (A10): `duringPlay.ts` classifies the route, so the
 * shell shows "not during play" in its place while a poker table is open,
 * and the sidebar and the palette leave it out; the shared screens are also
 * told (`hiddenDuringPlay`: they read nothing).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChartHandLinkProps } from "@rail/ui/charts/ChartCompare";
import { ChartsScreen } from "@rail/ui/charts/ChartsScreen";
import type { ChartSet } from "@rail/ui/charts/model";
import { ownChartDeviations } from "@rail/ui/charts/sessionSource";
import type { ChartSummary } from "@rail/ui/charts/source";
import { useUiStrings } from "@rail/ui/i18n";
import { shippedChartDeviations, type SessionQuery } from "@rail/ui/review/model";
import { SessionReviewScreen, type HandLinkProps } from "@rail/ui/review/SessionReviewScreen";

import { StateMessage } from "../components/StateMessage";
import { useT } from "../i18n";
import { onAnalysisRows } from "../analysis/service";
import { storeChartsSource } from "../lib/chartsSource";
import { hiddenDuringPlay } from "../lib/duringPlay";
import { inApp } from "../lib/ipc";
import { storeReviewSource, storeSessionChartsSource } from "../lib/reviewSource";
import { replaceParam, screenHref, useRouteParam } from "../lib/router";
import { useTablesOpen } from "../lib/useTablesOpen";
import { AnalysisStatus } from "./analysis/AnalysisStatus";
import styles from "./analysis/Analysis.module.css";
import { HandAnalysis } from "./analysis/HandAnalysis";
import { TopLeaks } from "./analysis/TopLeaks";
import { ANALYSIS_TABS, parseView, tabOf, viewParam, type AnalysisView } from "./analysis/view";

const EMPTY_FILTER: SessionQuery["filter"] = {} as SessionQuery["filter"];

export function Analysis() {
  const t = useT();
  const view = parseView(useRouteParam());
  const tablesOpen = useTablesOpen();
  const hidden = hiddenDuringPlay("analysis", tablesOpen);
  const reload = useRowsWritten();

  if (!inApp) {
    return <StateMessage kind="empty">{t.analysis.unavailable}</StateMessage>;
  }
  if (view.kind === "hand") {
    return <HandAnalysis handKey={view.key} actionIndex={view.actionIndex} back={view.back} />;
  }
  const nav = <AnalysisNav current={tabOf(view)} />;
  if (view.kind === "charts") return <Charts view={view} nav={nav} hidden={hidden} />;
  if (view.kind === "leaks") {
    return (
      <div>
        <h1 className={styles.title}>{t.analysis.tabs.leaks}</h1>
        {nav}
        {hidden ? null : (
          <TopLeaks
            hidden={hidden}
            reload={reload}
            period={view.period}
            onPeriod={(period) => replaceParam("analysis", viewParam({ kind: "leaks", period }))}
          />
        )}
      </div>
    );
  }
  return <Session view={view} nav={nav} hidden={hidden} reload={reload} />;
}

/** A new value each time the background run writes rows: the screens read again. */
function useRowsWritten(): number {
  const [count, setCount] = useState(0);
  useEffect(() => onAnalysisRows(() => setCount((n) => n + 1)), []);
  return count;
}

/** The sections' tabs and the run's status. */
function AnalysisNav({ current }: { current: AnalysisView["kind"] }) {
  const t = useT();
  return (
    <div className={styles.nav}>
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
      <AnalysisStatus />
    </div>
  );
}

/** A hand's grades, at the decision a list names, with the way back. */
function handHref(handId: string, actionIndex: number | null, back: AnalysisView): string {
  return screenHref("analysis", viewParam({ kind: "hand", key: handId, actionIndex, back: viewParam(back) }));
}

const SHIPPED = shippedChartDeviations.id;
const OWN = "own:";

function Session({
  view,
  nav,
  hidden,
  reload,
}: {
  view: Extract<AnalysisView, { kind: "session" }>;
  nav: ReactNode;
  hidden: boolean;
  reload: number;
}) {
  const t = useT();
  const ui = useUiStrings();
  const query: SessionQuery = useMemo(() => ({ at: view.at, gapMinutes: view.gap, filter: EMPTY_FILTER }), [view.at, view.gap]);
  const [charts, setCharts] = useState<ChartSummary[]>([]);
  const [choice, setChoice] = useState<string>(SHIPPED);
  const [own, setOwn] = useState<{ id: string; set: ChartSet } | null>(null);

  useEffect(() => {
    if (hidden) return;
    let live = true;
    storeChartsSource.list().then(
      (items) => live && setCharts(items),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [hidden]);

  const ownId = choice.startsWith(OWN) ? choice.slice(OWN.length) : null;
  useEffect(() => {
    if (!ownId) return;
    let live = true;
    storeChartsSource.load(ownId).then(
      (set) => live && setOwn({ id: ownId, set }),
      () => live && setChoice(SHIPPED),
    );
    return () => {
      live = false;
    };
  }, [ownId]);

  const deviationSource = useMemo(
    () => (own && ownId === own.id ? ownChartDeviations(storeSessionChartsSource, own.set) : shippedChartDeviations),
    [own, ownId],
  );
  const deviationChoices = useMemo(
    () =>
      charts.length > 0
        ? [{ id: SHIPPED, label: ui.review.deviationSource.shipped }, ...charts.map((c) => ({ id: `${OWN}${c.id}`, label: c.name }))]
        : undefined,
    [charts, ui],
  );

  const onQuery = useCallback((next: SessionQuery) => {
    replaceParam("analysis", viewParam({ kind: "session", at: next.at, gap: next.gapMinutes }));
  }, []);

  const renderHandLink = useCallback(
    ({ handId, actionIndex, sessionAt, label, className, children }: HandLinkProps) => (
      <a
        href={handHref(handId, actionIndex, { kind: "session", at: sessionAt, gap: view.gap })}
        className={className}
        aria-label={label}
      >
        {children}
      </a>
    ),
    [view.gap],
  );

  return (
    <SessionReviewScreen
      source={storeReviewSource}
      deviationSource={deviationSource}
      deviationChoices={deviationChoices}
      onDeviationSource={setChoice}
      query={query}
      onQuery={onQuery}
      renderHandLink={renderHandLink}
      title={t.analysis.tabs.session}
      notice={nav}
      reloadToken={reload}
      coverageAction={<span>{t.analysis.session.notAnalysed}</span>}
      hiddenDuringPlay={hidden}
      renderState={(kind, text) => <StateMessage kind={kind}>{text}</StateMessage>}
    />
  );
}

function Charts({
  view,
  nav,
  hidden,
}: {
  view: Extract<AnalysisView, { kind: "charts" }>;
  nav: ReactNode;
  hidden: boolean;
}) {
  const t = useT();
  const renderHandLink = useCallback(
    ({ handId, actionIndex, label, className, children }: ChartHandLinkProps) => (
      <a href={handHref(handId, actionIndex, view)} className={className} aria-label={label}>
        {children}
      </a>
    ),
    [view],
  );
  return (
    <ChartsScreen
      source={storeChartsSource}
      title={t.analysis.tabs.charts}
      notice={nav}
      selected={view.set}
      view={view.view}
      situation={view.situation}
      {...(view.period ? { period: view.period } : {})}
      onNavigate={(to) =>
        replaceParam(
          "analysis",
          viewParam({
            kind: "charts",
            set: to.selected,
            view: to.view,
            situation: to.situation ?? null,
            period: to.period ?? view.period,
          }),
        )
      }
      renderHandLink={renderHandLink}
      renderState={(kind, text) => <StateMessage kind={kind}>{text}</StateMessage>}
      hiddenDuringPlay={hidden}
    />
  );
}
