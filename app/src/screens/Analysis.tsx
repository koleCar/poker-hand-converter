/**
 * Analysis (R5.4): the web's analysis in the app, over the local store and
 * offline. Its sections are the shared package's screens with the app's
 * sources - the session review (R5.1, `packages/ui/review`) and the top
 * leaks - and one hand's decision-by-decision grades,
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
 */
import { BombPotsTab, MultiwayTab } from "./analysis/PotKinds";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { kindFormats } from "@rail/ui/hands/gameKind";
import { useUiStrings } from "@rail/ui/i18n";
import { shippedChartDeviations, type SessionQuery } from "@rail/ui/review/model";
import { SessionReviewScreen, type HandLinkProps } from "@rail/ui/review/SessionReviewScreen";

import { ChosenLink, HandTable } from "../components/HandTable";
import { StateMessage } from "../components/StateMessage";
import { useT } from "../i18n";
import { onAnalysisRows } from "../analysis/service";
import { hiddenDuringPlay } from "../lib/duringPlay";
import { inApp } from "../lib/ipc";
import { useAppKind } from "../lib/gameKind";
import { storeReviewSource } from "../lib/reviewSource";
import { replaceParam, screenHref, useRouteParam } from "../lib/router";
import { useTablesOpen } from "../lib/useTablesOpen";
import { AnalysisStatus, ShowAnalysisProgress } from "./analysis/AnalysisStatus";
import { useProgressHidden } from "./analysis/progressHidden";
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
  return <Session view={view} nav={nav} hidden={hidden} reload={reload} />;
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
  const progressHidden = useProgressHidden();
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
        {end || progressHidden ? (
          <div className={styles.navEnd}>
            {end}
            {progressHidden ? <ShowAnalysisProgress /> : null}
          </div>
        ) : null}
      </div>
      {progressHidden ? null : <AnalysisStatus />}
    </div>
  );
}

function Session({
  view,
  nav,
  hidden,
  reload,
}: {
  view: Extract<AnalysisView, { kind: "session" }>;
  nav: (end?: ReactNode) => ReactNode;
  hidden: boolean;
  reload: number;
}) {
  const t = useT();
  const ui = useUiStrings();
  // One kind of game at a time: the sidebar's (`lib/gameKind.ts`).
  const { kind } = useAppKind();
  const query: SessionQuery | null = useMemo(
    () => (kind === null ? null : { at: view.at, gapMinutes: view.gap, filter: { formats: kindFormats(kind) } }),
    [view.at, view.gap, kind],
  );
  const onQuery = useCallback((next: SessionQuery) => {
    replaceParam("analysis", viewParam({ kind: "session", at: next.at, gap: next.gapMinutes }));
  }, []);

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

  if (query === null) {
    return (
      <>
        {nav()}
        <StateMessage kind="loading">{ui.review.loading}</StateMessage>
      </>
    );
  }

  return (
    <HandTable resetKey={`${view.at ?? ""}|${kind ?? ""}`}>
      <SessionReviewScreen
        source={storeReviewSource}
        deviationSource={shippedChartDeviations}
        query={query}
        onQuery={onQuery}
        renderHandLink={renderHandLink}
        title={t.analysis.tabs.session}
        hideTitle
        notice={nav()}
        reloadToken={reload}
        coverageAction={<span>{t.analysis.session.notAnalysed}</span>}
        hiddenDuringPlay={hidden}
        intro={false}
        layout="table"
        renderState={(kind, text) => <StateMessage kind={kind}>{text}</StateMessage>}
      />
    </HandTable>
  );
}
