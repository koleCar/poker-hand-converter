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
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { kindFormats, kindOf, type GameKind } from "@rail/ui/hands/gameKind";
import { KindSwitch } from "@rail/ui/hands/KindSwitch";
import { useUiStrings } from "@rail/ui/i18n";
import { shippedChartDeviations, type SessionQuery } from "@rail/ui/review/model";
import { SessionReviewScreen, type HandLinkProps } from "@rail/ui/review/SessionReviewScreen";

import headerStyles from "../components/ScreenHeader.module.css";
import { StateMessage } from "../components/StateMessage";
import { useT } from "../i18n";
import { onAnalysisRows } from "../analysis/service";
import { hiddenDuringPlay } from "../lib/duringPlay";
import { inApp } from "../lib/ipc";
import { useAppKind } from "../lib/gameKind";
import { storeReviewSource } from "../lib/reviewSource";
import { replaceParam, screenHref, useRouteParam } from "../lib/router";
import { useTablesOpen } from "../lib/useTablesOpen";
import { AnalysisStatus } from "./analysis/AnalysisStatus";
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
  if (view.kind === "leaks") {
    return (
      <div>
        <h1 className={styles.visuallyHidden}>{t.analysis.tabs.leaks}</h1>
        {nav()}
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

/**
 * The header row (2026-11-07): the sections' tabs on the left, the
 * section's own toggle on the right (the session's Cash | Tournaments);
 * the run's status under it.
 */
function AnalysisNav({ current, end }: { current: AnalysisView["kind"]; end?: ReactNode }) {
  const t = useT();
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
        {end ? <div className={styles.navEnd}>{end}</div> : null}
      </div>
      <AnalysisStatus />
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
  // One kind of game at a time (`lib/gameKind.ts`): the switch's, else the
  // last shown, else the one with more hands.
  const [askedKind, setAskedKind] = useState<GameKind | null>(null);
  const kinds = useAppKind(askedKind, inApp && !hidden, reload);
  const query: SessionQuery | null = useMemo(
    () => (kinds.kind === null ? null : { at: view.at, gapMinutes: view.gap, filter: { formats: kindFormats(kinds.kind) } }),
    [view.at, view.gap, kinds.kind],
  );
  const onQuery = useCallback((next: SessionQuery) => {
    setAskedKind(kindOf(next.filter.formats ?? []));
    replaceParam("analysis", viewParam({ kind: "session", at: next.at, gap: next.gapMinutes }));
  }, []);

  const renderHandLink = useCallback(
    ({ handId, label, className, children }: HandLinkProps) => (
      <a
        href={screenHref("hands", handId)}
        className={className}
        aria-label={label}
        onClick={(event) => {
          event.preventDefault();
          openInReplayer(handId);
        }}
      >
        {children}
      </a>
    ),
    [],
  );

  // The Cash | Tournaments switch, in the header row (the review's own is not shown).
  const kindSwitch = hidden ? null : (
    <KindSwitch
      kind={kinds.kind}
      counts={kinds.counts}
      className={headerStyles.toggle}
      onChange={(kind) =>
        query === null
          ? setAskedKind(kind)
          : onQuery({ ...query, at: null, filter: { ...query.filter, formats: kindFormats(kind) } })
      }
    />
  );

  if (query === null) {
    return (
      <>
        {nav(kindSwitch)}
        <StateMessage kind="loading">{ui.review.loading}</StateMessage>
      </>
    );
  }

  return (
    <SessionReviewScreen
      source={storeReviewSource}
      deviationSource={shippedChartDeviations}
      query={query}
      onQuery={onQuery}
      renderHandLink={renderHandLink}
      title={t.analysis.tabs.session}
      hideTitle
      notice={nav(kindSwitch)}
      reloadToken={reload}
      coverageAction={<span>{t.analysis.session.notAnalysed}</span>}
      hiddenDuringPlay={hidden}
      intro={false}
      layout="table"
      renderState={(kind, text) => <StateMessage kind={kind}>{text}</StateMessage>}
    />
  );
}
