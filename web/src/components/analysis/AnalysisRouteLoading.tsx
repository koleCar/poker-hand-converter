"use client";

import { useDict } from "../../lib/i18n/client";
import { AppFrame } from "../shell/AppFrame";
import { AnalysisNav, type AnalysisSection } from "./AnalysisNav";
import { OverviewSkeleton } from "./overview/OverviewSkeleton";
import styles from "./ui/an.module.css";
import {
  ChartsSkeleton,
  KindSkeleton,
  LeaksTabSkeleton,
  PlanSkeleton,
  ProgressSkeleton,
  ReportsSkeleton,
  SessionSkeleton,
  SkStatus,
  TrainSkeleton,
} from "./ui/Skeleton";

type LoadingSection = Exclude<AnalysisSection, "learn">;

/**
 * What the Analysis tabs' `loading.tsx` boundaries render: the shell with the
 * Analysis tab lit, the Analysis sub-tabs with this one lit, and this tab's own
 * skeleton, the same one the tab draws while its first read is out. The wait
 * for the route and the wait for the data then read as one, and the page
 * never jumps from a centred mark to a full screen.
 *
 * The frame never holds for the plan (`feature={null}`), as in `RouteLoading`;
 * the screen's own frame does when it arrives.
 */
export function AnalysisRouteLoading({ section }: { section: LoadingSection }) {
  const label = useDict().loading.route.analysis;
  return (
    <AppFrame tab="analysis" feature={null}>
      {() =>
        section === "overview" ? (
          <div className={styles.page}>
            <AnalysisNav current="overview" />
            <OverviewSkeleton label={label} />
          </div>
        ) : (
          <div className={section === "charts" ? styles.page : "stats"}>
            <AnalysisNav current={section} />
            <SkStatus label={label}>{body(section)}</SkStatus>
          </div>
        )
      }
    </AppFrame>
  );
}

function body(section: Exclude<LoadingSection, "overview">) {
  switch (section) {
    case "session":
      return (
        <>
          <KindSkeleton />
          <SessionSkeleton />
        </>
      );
    case "leaks":
    case "multiway":
    case "bomb":
      return <LeaksTabSkeleton />;
    case "progress":
      return <ProgressSkeleton />;
    case "reports":
      return <ReportsSkeleton />;
    case "plan":
      return <PlanSkeleton />;
    case "charts":
      return <ChartsSkeleton />;
    case "train":
      return <TrainSkeleton />;
  }
}
